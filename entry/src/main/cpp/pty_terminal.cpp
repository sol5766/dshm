/**
 * pty_host —— dshm-terminal 的真 pty 支撑（NAPI addon）。
 *
 * 背景：沙箱内 node/JS 无法创建 pty；本模块按 PtyDiagnostic demo 验证过的
 * posix_openpt 路径（demo 证实第三方 HAP 沙箱内 posix_openpt/grantpt/unlockpt
 * 可用）创建 pty 并把 master 通过 socketpair 泵给 JS 侧 net.Socket。
 *
 * API（同步函数，供 node 侧 dshm-terminal 使用）：
 *   start(opts)  -> { fd, pid }
 *       opts: { shell: string, args: [..], cols, rows }   —— spawn pty 会话
 *   resize(fd, cols, rows)  -> bool     （fd = JS 侧 socket fd）
 *   kill(fd)      -> bool              （SIGKILL 会话进程）
 *
 * 内部：每个会话一个泵线程，master <-> socket 双向搬运；socket 端关闭或
 * pty 端 EIO（slave 关闭）时回收会话与子进程，并从全局表清理自身。
 * 线程在创建后立即 detach，生命周期由 Session 的 shared_ptr 持有（泵线程
 * 自己持有一份），避免可 join 的 std::thread 在对象析构时触发 terminate。
 */
#define _GNU_SOURCE
#include <node_api.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <map>
#include <memory>
#include <mutex>
#include <thread>
#include <unistd.h>
#include <fcntl.h>
#include <termios.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <poll.h>
#include <signal.h>
#include <errno.h>

namespace {

struct Session {
  int masterFd = -1;   // pty master
  int sockFd = -1;     // socketpair 的 C++ 端（sv[1]）
  int keyFd = -1;      // JS 端 fd（sv[0]），g_sessions 的 key
  pid_t pid = -1;
};

std::mutex g_mu;
std::map<int, std::shared_ptr<Session>> g_sessions;  // key: JS socket fd

static int SetNonBlock(int fd) {
  int fl = fcntl(fd, F_GETFL, 0);
  if (fl < 0) return -1;
  return fcntl(fd, F_SETFL, fl | O_NONBLOCK);
}

/** 阻塞式写完一段数据（短写/EAGAIN 时 poll POLLOUT 重试）。 */
static bool WriteAll(int fd, const char* buf, size_t n) {
  size_t off = 0;
  while (off < n) {
    ssize_t w = write(fd, buf + off, n - off);
    if (w > 0) { off += (size_t)w; continue; }
    if (w < 0 && (errno == EINTR || errno == EAGAIN)) {
      struct pollfd p;
      p.fd = fd;
      p.events = POLLOUT;
      if (poll(&p, 1, 2000) <= 0) return false;
      continue;
    }
    return false;   // EPIPE/EIO 等：对端关闭
  }
  return true;
}

static void PumpLoop(std::shared_ptr<Session> s) {
  int masterFd = s->masterFd;
  int sockFd = s->sockFd;
  char buf[65536];
  struct pollfd fds[2];
  fds[0].fd = masterFd; fds[0].events = POLLIN;
  fds[1].fd = sockFd;   fds[1].events = POLLIN;
  bool masterOpen = true;
  bool sockOpen = true;
  while (masterOpen && sockOpen) {
    int pr = poll(fds, 2, 1000);
    if (pr < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (pr == 0) continue;  // 超时保活（会话存活期间无 IO 也挂住）
    if (fds[0].revents & (POLLIN | POLLHUP)) {
      ssize_t n = read(masterFd, buf, sizeof(buf));
      if (n > 0) {
        if (!WriteAll(sockFd, buf, (size_t)n)) sockOpen = false;
      } else if (n == 0 || (n < 0 && errno == EIO)) {
        masterOpen = false;  // slave 侧关闭
      } else if (n < 0 && errno != EAGAIN && errno != EINTR) {
        masterOpen = false;
      }
    }
    if (fds[1].revents & (POLLIN | POLLHUP)) {
      ssize_t n = read(sockFd, buf, sizeof(buf));
      if (n > 0) {
        if (!WriteAll(masterFd, buf, (size_t)n)) masterOpen = false;
      } else {
        sockOpen = false;  // JS 侧关闭连接
      }
    }
  }
  // 收尾：确保子进程终止，避免僵尸
  if (s->pid > 0) {
    kill(s->pid, SIGKILL);
    int st = 0;
    waitpid(s->pid, &st, WNOHANG);
  }
  shutdown(sockFd, SHUT_RDWR);
  close(sockFd);
  close(masterFd);
  // 从全局表清理（key = JS 端 fd）；泵线程持有一份 shared_ptr 保证自身安全
  {
    std::lock_guard<std::mutex> lk(g_mu);
    g_sessions.erase(s->keyFd);
  }
}

static std::shared_ptr<Session> FindByKey(int keyFd) {
  std::lock_guard<std::mutex> lk(g_mu);
  auto it = g_sessions.find(keyFd);
  if (it == g_sessions.end()) return nullptr;
  return it->second;
}

static void ReadString(napi_env env, napi_value v, std::string& out) {
  size_t len = 0;
  napi_get_value_string_utf8(env, v, nullptr, 0, &len);
  if (len == 0) { out.clear(); return; }
  std::vector<char> buf(len + 1);
  napi_get_value_string_utf8(env, v, buf.data(), len + 1, &len);
  out.assign(buf.data(), len);
}

static napi_value Start(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "pty.start(opts)");
    return nullptr;
  }
  napi_valuetype t;
  napi_typeof(env, argv[0], &t);
  if (t != napi_object) { napi_throw_type_error(env, nullptr, "opts must be object"); return nullptr; }

  std::string shell;
  napi_value shellVal;
  if (napi_get_named_property(env, argv[0], "shell", &shellVal) != napi_ok ||
      napi_typeof(env, shellVal, &t) != napi_ok || t != napi_string) {
    napi_throw_type_error(env, nullptr, "shell required");
    return nullptr;
  }
  ReadString(env, shellVal, shell);

  std::vector<std::string> args;
  napi_value arr;
  if (napi_get_named_property(env, argv[0], "args", &arr) == napi_ok) {
    bool isArr = false;
    napi_is_array(env, arr, &isArr);
    if (isArr) {
      uint32_t n = 0;
      napi_get_array_length(env, arr, &n);
      for (uint32_t i = 0; i < n; ++i) {
        napi_value e;
        napi_get_element(env, arr, i, &e);
        if (napi_typeof(env, e, &t) == napi_ok && t == napi_string) {
          std::string s;
          ReadString(env, e, s);
          args.push_back(s);
        }
      }
    }
  }

  int cols = 120, rows = 32;
  napi_value cv, rv;
  int32_t c = 0, r = 0;
  if (napi_get_named_property(env, argv[0], "cols", &cv) == napi_ok &&
      napi_get_value_int32(env, cv, &c) == napi_ok && c > 0) cols = c;
  if (napi_get_named_property(env, argv[0], "rows", &rv) == napi_ok &&
      napi_get_value_int32(env, rv, &r) == napi_ok && r > 0) rows = r;

  int masterFd = posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC);
  if (masterFd < 0) { napi_throw_error(env, nullptr, strerror(errno)); return nullptr; }
  if (grantpt(masterFd) != 0) { close(masterFd); napi_throw_error(env, nullptr, "grantpt"); return nullptr; }
  if (unlockpt(masterFd) != 0) { close(masterFd); napi_throw_error(env, nullptr, "unlockpt"); return nullptr; }
  char slavePath[256] = {};
  if (ptsname_r(masterFd, slavePath, sizeof(slavePath)) != 0) { close(masterFd); napi_throw_error(env, nullptr, "ptsname"); return nullptr; }

  int slaveFd = open(slavePath, O_RDWR | O_NOCTTY);
  if (slaveFd < 0) { close(masterFd); napi_throw_error(env, nullptr, "open slave"); return nullptr; }

  // 窗口尺寸：TIOCSWINSZ 必须在 exec 前设置好，zsh 才能以正确 cols/rows 启动
  struct winsize ws;
  memset(&ws, 0, sizeof(ws));
  ws.ws_col = static_cast<unsigned short>(cols);
  ws.ws_row = static_cast<unsigned short>(rows);
  ioctl(masterFd, TIOCSWINSZ, &ws);

  int sv[2];
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK, 0, sv) != 0) {
    close(masterFd); close(slaveFd);
    napi_throw_error(env, nullptr, "socketpair");
    return nullptr;
  }

  pid_t pid = fork();
  if (pid < 0) {
    close(masterFd); close(slaveFd); close(sv[0]); close(sv[1]);
    napi_throw_error(env, nullptr, "fork");
    return nullptr;
  }
  if (pid == 0) {
    // child: 成为会话组长并接管 tty
    close(masterFd);
    close(sv[0]); close(sv[1]);
    setsid();
    if (ioctl(slaveFd, TIOCSCTTY, 0) != 0) _exit(127);
    dup2(slaveFd, 0); dup2(slaveFd, 1); dup2(slaveFd, 2);
    if (slaveFd > 2) close(slaveFd);
    // raw：禁用 icanon/echo，保留 ISIG 让 Ctrl+C/Ctrl+Z 产生信号
    struct termios raw;
    tcgetattr(0, &raw);
    raw.c_lflag &= ~(ICANON | ECHO);
    raw.c_lflag |= ISIG;
    raw.c_cc[VMIN] = 1;
    raw.c_cc[VTIME] = 0;
    tcsetattr(0, TCSANOW, &raw);
    // 构建 argv：[shell, args..., nullptr]
    std::vector<char*> argv;
    argv.push_back(const_cast<char*>(shell.c_str()));
    for (auto& a : args) argv.push_back(const_cast<char*>(a.c_str()));
    argv.push_back(nullptr);
    setenv("TERM", "xterm-256color", 1);
    execvpe(shell.c_str(), argv.data(), environ);
    _exit(127);
  }
  close(slaveFd);

  SetNonBlock(masterFd);
  auto sess = std::make_shared<Session>();
  sess->masterFd = masterFd;
  sess->sockFd = sv[1];
  sess->keyFd = sv[0];
  sess->pid = pid;
  {
    std::lock_guard<std::mutex> lk(g_mu);
    g_sessions[sv[0]] = sess;
  }
  // 泵线程持有一份 shared_ptr；创建后立即 detach，Session 析构时没有 joinable 线程
  std::thread([sess]() { PumpLoop(sess); }).detach();

  napi_value out;
  napi_create_object(env, &out);
  napi_value fdVal, pidVal;
  napi_create_int32(env, sv[0], &fdVal);   // JS 拿 socketpair 的 socket 端
  napi_create_int32(env, static_cast<int32_t>(pid), &pidVal);
  napi_set_named_property(env, out, "fd", fdVal);
  napi_set_named_property(env, out, "pid", pidVal);
  return out;
}

static napi_value Resize(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 3) { napi_throw_type_error(env, nullptr, "resize(fd, cols, rows)"); return nullptr; }
  int32_t fd = 0, cols = 0, rows = 0;
  napi_get_value_int32(env, argv[0], &fd);
  napi_get_value_int32(env, argv[1], &cols);
  napi_get_value_int32(env, argv[2], &rows);
  auto s = FindByKey(fd);
  napi_value okv;
  napi_get_boolean(env, s != nullptr, &okv);
  if (s) {
    struct winsize ws;
    memset(&ws, 0, sizeof(ws));
    ws.ws_col = static_cast<unsigned short>(cols);
    ws.ws_row = static_cast<unsigned short>(rows);
    ioctl(s->masterFd, TIOCSWINSZ, &ws);
  }
  return okv;
}

static napi_value Kill(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) { napi_throw_type_error(env, nullptr, "kill(fd)"); return nullptr; }
  int32_t fd = 0;
  napi_get_value_int32(env, argv[0], &fd);
  auto s = FindByKey(fd);
  napi_value okv;
  bool ok = false;
  if (s) {
    kill(s->pid, SIGKILL);
    ok = true;
  }
  napi_get_boolean(env, ok, &okv);
  return okv;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor descs[] = {
    {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"resize", nullptr, Resize, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"kill", nullptr, Kill, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 3, descs);
  return exports;
}

}  // namespace

NAPI_MODULE(pty_host, Init)