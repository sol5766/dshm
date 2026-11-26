// dshhost —— 端侧 Node 运行时的 NAPI 引导模块（阶段二）
//
// 角色：把 libnode.so 里的 Node 在同一进程内起起来，供 ArkTS 侧调用。
// 它**只做引导**，不做协议、不碰 dsh：dsh 的 Host 由 Node 侧脚本
// （hostcore/app/main.js）在 loopback 上起，ArkTS 仍按既有 HTTP/WS 协议说话。
// 这样"运行时载体"换了，上面的客户端一行都不用改。
//
// 为什么同进程而不是 fork/exec：
//   鸿蒙手机**禁止三方应用 fork/创建进程**（D6 E15，childProcessManager 仅平板/PC-2in1）。
//   同进程加载 libnode.so 是四条形态唯一共同可行的路径。
//
// 已知边界（不要以为已经解决）：
//   1. **无法从外部线程安全停止进程内 Node**。node::Start 是阻塞的，唯一的正路是在
//      Node 线程内部持一个 uv_async 句柄并调用 node::Stop(env)。那需要先拿到 env，
//      属于下一步；现在 stopHost() 如实返回"做不到"，不假装成功。
//   2. node::Start 会走 uv_setup_args 并尝试确定 process.execPath。鸿蒙沙箱下
//      /proc/self/exe 未必可用，process.execPath 可能为空——**必须上设备验证**。
//   3. libnode.so 必须随 HAP 打包且已签名（D6 E14），热更新的 .so 会被系统拦截。
//   4. 本项目统一 jitless（不申请 ALLOW_WRITABLE_CODE_MEMORY），因此 argv 里必须带
//      --jitless；否则 V8 会在初始化时申请可写可执行内存而被拦。
//
// 编译验证：`bash tools/node-runtime/build-dshhost.sh --compile-only`
//   （只编译不链接，因此不需要 libnode.so 存在）

#include <node_api.h>
// 【为什么**不** include <node.h>】（2026-09-20 实测）
//   `node.h` 会拉进 v8 全套头文件；Node 26.x 的 `v8.h` 依赖 C++20 库头 <source_location>，
//   而 OHOS SDK 的 libc++ 不提供它 ⇒ `fatal error: 'source_location' file not found`。
//   本文件**只**通过 dlsym 取 `node::Start`（mangled `_ZN4node5StartEiPPc`），
//   不引用任何 `node::` / `v8::` 类型或符号，因此不需要 node.h 的类型声明。
//   需要的宏（NODE_VERSION_STRING）由 <node_version.h> 提供，它不依赖 v8。
#include <node_version.h>
#include <hilog/log.h>

#include <atomic>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <dlfcn.h>
#include <fcntl.h>
#include <mutex>
#include <string>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>
#include <vector>

/*
 * 【诊断/候选修复】由本 .so 提供 `napi_fatal_error` 的定义。
 *
 * 背景（真机读数）：koffi 的 .node 加载时报
 *     Error relocating …/libs/arm64/libkoffi.so: napi_fatal_error: symbol not found
 * 而 libkoffi.so 需要 84 个 `napi_*`，**只有这一个**解析不到 ⇒ 进程全局作用域里确实有一个
 * `napi_*` 提供者（其余 83 个都来自它），但它缺这一个符号。
 *
 * 本定义同时充当**探针**：构造函数里的 diag1 会 `dlsym(RTLD_DEFAULT, "napi_fatal_error")`
 * 并用 `dladdr` 打印提供者路径。据此可一次判别三种可能：
 *   · 提供者 = libdshhost.so → 本 .so 的符号在全局作用域 ⇒ 在这里补齐缺失符号即可修好 koffi；
 *   · 提供者 = libnode.so.127 → libnode 已全局可见，失败另有原因（需再查加载标志）；
 *   · 返回 null            → 本 .so 与 libnode 都不在全局作用域，只能靠依赖闭包（DT_NEEDED）解决。
 * 语义与 Node 一致：打印后 abort（`napi_fatal_error` 本就是不可恢复错误）。
 */
extern "C" __attribute__((visibility("default"))) void napi_fatal_error(
    const char* location, size_t location_len, const char* message, size_t message_len) {
  (void)location_len;
  (void)message_len;
  OH_LOG_Print(LOG_APP, LOG_FATAL, 0x0000, "DSHM-SHIM",
               "napi_fatal_error: %{public}s | %{public}s",
               location != nullptr ? location : "(null)",
               message != nullptr ? message : "(null)");
  ::abort();
}

namespace {

// Node 线程与它的 argv。argv 必须活到线程结束，所以放静态存储。
std::thread g_nodeThread;
std::atomic<bool> g_running{false};
std::atomic<bool> g_started{false};
std::vector<std::string> g_argStore;
std::vector<char*> g_argv;

/*
 * libnode 的句柄与 `node::Start` 的函数指针。
 *
 * 【为什么要 dlsym 而不是直接调 `node::Start`】见构造函数里的说明：为了让 libnode 的符号
 * 从一开始就进**全局作用域**（后续 dlopen 的 `.node` 模块要解析 `napi_*`），libdshhost
 * **不能**在 `DT_NEEDED` 里带 libnode —— 一旦带了，它就会被动态加载器以**局部作用域**先载入，
 * 之后再 dlopen 提升为 RTLD_GLOBAL 在 musl 上无效（实测：返回 ok 但符号依然解析不到）。
 */
void* g_libnode = nullptr;
using NodeStartFn = int (*)(int, char*[]);
NodeStartFn g_nodeStart = nullptr;

void SetString(napi_env env, napi_value obj, const char* key, const std::string& value) {
  napi_value v = nullptr;
  napi_create_string_utf8(env, value.c_str(), value.length(), &v);
  napi_set_named_property(env, obj, key, v);
}

void SetBool(napi_env env, napi_value obj, const char* key, bool value) {
  napi_value v = nullptr;
  napi_get_boolean(env, value, &v);
  napi_set_named_property(env, obj, key, v);
}

/**
 * runtimeVersion(): 返回编译进 libnode.so 的 Node 版本。
 * 只要这个函数返回了非空字符串，就证明"模块加载成功且与 libnode 链接在一起了"——
 * 这是端侧"运行时是否真的可用"的第一条可观测证据（第二条是 Host 真的起来）。
 */
napi_value RuntimeVersion(napi_env env, napi_callback_info info) {
  napi_value out = nullptr;
  /*
   * 构造函数加载 libnode 失败时，编译期 NODE_VERSION_STRING 仍然存在；
   * 此时返回 "26.7.0" 会把"模块文件存在"误报成"运行时可用"。
   */
  if (g_nodeStart == nullptr) {
    napi_value empty = nullptr;
    napi_create_string_utf8(env, "", 0, &empty);
    return empty;
  }
  napi_create_string_utf8(env, NODE_VERSION_STRING, NAPI_AUTO_LENGTH, &out);
  return out;
}

/**
 * startHost(argv: string[], envPairs: string[]): { started: boolean, note: string }
 *
 * 在独立线程里跑 node::Start（阻塞）。**同一个进程只能起一次**：第二次调用返回
 * started=false 并说明原因，而不是偷偷再起一个（那样会有两个 Host 抢同一个端口）。
 *
 * 【为什么需要 envPairs】端侧 Host 的配置通道**是环境变量，不是 argv**：
 * hostcore/app/main.js 读的是 DSHM_CORE_DIR / DSHM_HOME / DSHM_SANDBOX_HOME /
 * DSHM_PORT / DSHM_PROFILE，而 ArkTS 侧**没有任何办法设置原生进程的环境变量**。
 * 所以必须由这里在 node::Start 之前 setenv()。
 * 取"KEY=VALUE"字符串数组而不是两个平行数组：无需在两端各自维护下标对应关系，
 * 少一类"键值错位"的错法（键值错位会静默把 Host 指向错误的目录）。
 */
/* ── 进程级崩溃留痕 + 输出轮转（2026-10-18 内测闪退报告的 P0 落点）────────────
 *
 * 【为什么加】2in1 内测出现"Host 进程无任何日志地消失"：node-output.log 每次启动被
 * `"w"` 截断，崩溃现场必丢；native 段错误/abort 也没有任何记录，事后只能靠心跳断档猜。
 * 启动轮转与崩溃留痕分开处理：
 *   ① 进程首次启动前把上一次的 node-output.log 轮转成 `.1/.2/.3`（保留最近 3 份）；
 *   ② 安装 SIGSEGV/SIGABRT/SIGBUS/SIGILL/SIGFPE 处理器：先用 ::write 落一行
 *      `host-crash.log`（**不用 printf/iostream**，避免在崩溃上下文里再死锁），
 *      再恢复默认动作并重新 raise（保留系统 faultlog / abort 语义）。
 * 正常退出（node::Start 返回）另写 `host-exit.log`；两份日志拼起来即可区分
 * "被信号带走" 与 "自己退出"，这是此前完全缺失的证据。
 */
static int g_crashFd = -1;

static const char* DshmSignalName(int signo) {
  switch (signo) {
    case SIGSEGV: return "SIGSEGV";
    case SIGABRT: return "SIGABRT";
    case SIGBUS: return "SIGBUS";
    case SIGILL: return "SIGILL";
    case SIGFPE: return "SIGFPE";
    default: return "SIG?";
  }
}

extern "C" void DshmCrashHandler(int signo) {
  if (g_crashFd >= 0) {
    char buf[256];
    int n = ::snprintf(buf, sizeof(buf), "fatal signal %d (%s) pid=%d at=%lld\n",
                       signo, DshmSignalName(signo), static_cast<int>(::getpid()),
                       static_cast<long long>(::time(nullptr)));
    if (n > 0) {
      ssize_t ignored = ::write(g_crashFd, buf, static_cast<size_t>(n));
      (void)ignored;
    }
  }
  ::signal(signo, SIG_DFL);
  ::raise(signo);
}

static void InstallCrashHandlers(const std::string& homeDir) {
  if (homeDir.empty()) return;
  const std::string marker = homeDir + "/host-crash.log";
  g_crashFd = ::open(marker.c_str(), O_CREAT | O_WRONLY | O_APPEND, 0664);
  if (g_crashFd < 0) {
    OH_LOG_Print(LOG_APP, LOG_WARN, 0x0000, "DSHM-SHIM",
                 "host-crash.log 打不开：%{public}s", marker.c_str());
  }
  const int sigs[] = {SIGSEGV, SIGABRT, SIGBUS, SIGILL, SIGFPE};
  for (int sig : sigs) {
    ::signal(sig, DshmCrashHandler);
  }
}

/** 启动留档：node-output.log → .1，.1 → .2，.2 → .3（.3 丢弃）；运行期容量另行治理。 */
static void RotateNodeOutput(const std::string& logPath) {
  if (logPath.empty()) return;
  const std::string p1 = logPath + ".1";
  const std::string p2 = logPath + ".2";
  const std::string p3 = logPath + ".3";
  ::unlink(p3.c_str());
  ::rename(p2.c_str(), p3.c_str());
  ::rename(p1.c_str(), p2.c_str());
  ::rename(logPath.c_str(), p1.c_str());
}

// 原生组件也直接 write(1/2)，不能靠 stdio 锁拦住它们；O_APPEND 是截断后不留大洞的前提。
// 这是运行期治理阈值而非逐次 write 的硬限：最多额外积累一次检查间隔内的突发输出。
constexpr off_t kNodeOutputLimit = 4 * 1024 * 1024;
constexpr int kNodeOutputCheckMs = 250;
std::mutex g_outputMutex;
int g_outputFd = -1;
std::string g_outputPath;

static bool LimitNodeOutput(int fd) {
  struct stat st {};
  if (::fstat(fd, &st) != 0) return false;
  if (st.st_size <= kNodeOutputLimit) return true;
  // 不做保尾复制：并发 native write 不参与锁，复制再截断会吞掉复制期间的新错误。
  // 旧历史在容量阈值处淘汰；signal / Node 退出证据仍分别写 host-crash / host-exit。
  if (::ftruncate(fd, 0) != 0) return false;
  static const char marker[] = "[DSHM] node-output capacity reset; older output expired (4 MiB threshold)\n";
  size_t offset = 0;
  while (offset < sizeof(marker) - 1) {
    const ssize_t n = ::write(fd, marker + offset, sizeof(marker) - 1 - offset);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) break;
    offset += static_cast<size_t>(n);
  }
  // 清理已成功；标记写失败不把容量治理误报为失败。
  return true;
}

static bool CaptureNodeOutput(const std::string& logPath) {
  std::lock_guard<std::mutex> lock(g_outputMutex);
  if (g_outputFd >= 0) return true;
  if (logPath.empty()) return false;
  // 进程内只轮转一次。重启 Node 时 ArkWeb 仍可能写旧 fd，不能 rename 后把监控移到新 inode。
  RotateNodeOutput(logPath);
  int fd = ::open(logPath.c_str(), O_CREAT | O_WRONLY | O_APPEND | O_CLOEXEC, 0664);
  if (fd < 0) return false;
  const int savedOut = ::dup(STDOUT_FILENO);
  if (savedOut < 0) { ::close(fd); return false; }
  ::flockfile(stdout);
  ::flockfile(stderr);
  ::fflush(stdout);
  ::fflush(stderr);
  bool ok = ::dup2(fd, STDOUT_FILENO) >= 0;
  if (ok && ::dup2(fd, STDERR_FILENO) < 0) {
    ::dup2(savedOut, STDOUT_FILENO);
    ok = false;
  }
  if (ok) ::setvbuf(stdout, nullptr, _IOLBF, 0);
  ::funlockfile(stderr);
  ::funlockfile(stdout);
  ::close(savedOut);
  if (!ok) { ::close(fd); return false; }
  g_outputFd = fd;
  g_outputPath = logPath;
  std::thread([fd]() {
    bool failed = false;
    for (;;) {
      std::this_thread::sleep_for(std::chrono::milliseconds(kNodeOutputCheckMs));
      const bool ok = LimitNodeOutput(fd);
      // 只报状态转变，磁盘错误不能再变成每拍刷屏。
      if (!ok && !failed) {
        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x0000, "DSHM-SHIM", "node-output 容量治理失败，需检查存储状态");
      }
      failed = !ok;
    }
  }).detach();
  return true;
}

/** 正常退出留痕（node::Start 返回后调用；崩溃路径由信号处理器负责）。 */
static void AppendLifecycle(const std::string& homeDir, const std::string& line) {
  if (homeDir.empty()) return;
  const std::string file = homeDir + "/host-exit.log";
  int fd = ::open(file.c_str(), O_CREAT | O_WRONLY | O_APPEND, 0664);
  if (fd < 0) return;
  ssize_t ignored = ::write(fd, line.c_str(), line.size());
  (void)ignored;
  ::close(fd);
}

napi_value StartHost(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2] = {nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  napi_value out = nullptr;
  napi_create_object(env, &out);

  if (g_started.load()) {
    SetBool(env, out, "started", false);
    SetString(env, out, "note", "运行时已经启动过；同一进程只允许一个 Node 实例");
    return out;
  }
  /*
   * 不能先把 started=true 再让工作线程发现 node::Start 缺失。模拟器无 libnode 时，
   * 那会把确定失败伪装成成功，调用方只能等端口超时。
   */
  if (g_nodeStart == nullptr) {
    SetBool(env, out, "started", false);
    napi_value applied = nullptr;
    napi_create_uint32(env, 0, &applied);
    napi_set_named_property(env, out, "envApplied", applied);
    SetString(env, out, "note", "libnode 未加载或 node::Start 不可用");
    return out;
  }

  // argv：第 0 位是程序名（node::Start 要求），其余由 ArkTS 侧给出。
  g_argStore.clear();
  g_argStore.emplace_back("node");
  uint32_t len = 0;
  if (argc >= 1 && napi_get_array_length(env, args[0], &len) == napi_ok) {
    for (uint32_t i = 0; i < len; i++) {
      napi_value el = nullptr;
      if (napi_get_element(env, args[0], i, &el) != napi_ok) {
        continue;
      }
      size_t n = 0;
      if (napi_get_value_string_utf8(env, el, nullptr, 0, &n) != napi_ok) {
        continue;  // 非字符串项直接跳过，不猜
      }
      std::string s(n, '\0');
      napi_get_value_string_utf8(env, el, &s[0], n + 1, &n);
      g_argStore.push_back(s);
    }
  }

  // 环境变量：必须在 node::Start 之前生效——Node 启动时就会读 process.env 初始化，
  // 之后再 setenv 对已启动的 Host 没有任何作用。
  uint32_t envCount = 0;
  int envBad = 0;
  if (argc >= 2 && napi_get_array_length(env, args[1], &envCount) == napi_ok) {
    for (uint32_t i = 0; i < envCount; i++) {
      napi_value el = nullptr;
      if (napi_get_element(env, args[1], i, &el) != napi_ok) {
        continue;
      }
      size_t n = 0;
      if (napi_get_value_string_utf8(env, el, nullptr, 0, &n) != napi_ok) {
        continue;
      }
      std::string pair(n, '\0');
      napi_get_value_string_utf8(env, el, &pair[0], n + 1, &n);
      const size_t eq = pair.find('=');
      if (eq == std::string::npos || eq == 0) {
        envBad++;  // 没有 "=" 或键为空：不猜，计数后如实报告
        continue;
      }
      setenv(pair.substr(0, eq).c_str(), pair.substr(eq + 1).c_str(), 1);
    }
  }

  /*
   * 【io_uring 兜底（Node 26 起）】libuv 会读 `UV_USE_IO_URING` 关闭 io_uring；
   * OHOS 上 io_uring 曾出现挂起。24.x 时期靠给 libnode 打二进制补丁禁用，26.x 的
   * libnode 是外部预编译件、补丁偏移不适用，改在 node::Start 之前用环境变量兜底
   * （libnode 内确有该字符串，libuv 初始化时会读）。放在 ArkTS 传入的 env 之后，
   * 保证不会被调用方覆盖成开启。
   */
  ::setenv("UV_USE_IO_URING", "0", 1);

  g_argv.clear();
  for (std::string& s : g_argStore) {
    g_argv.push_back(&s[0]);
  }

  g_started.store(true);
  g_running.store(true);
  // 先启用进程级输出捕获与容量治理，再启动 Node，避免遗漏启动错误。
  std::string homeDir;
  const char* homeEnv = ::getenv("DSHM_SANDBOX_HOME");
  if (homeEnv != nullptr && homeEnv[0] != '\0') {
    homeDir = std::string(homeEnv);
  }
  std::string logPath = homeDir.empty() ? std::string() : homeDir + "/node-output.log";
  InstallCrashHandlers(homeDir);
  const bool outputCaptured = CaptureNodeOutput(logPath);
  const std::string outputPath = outputCaptured ? g_outputPath : std::string();
  if (!outputCaptured) {
    OH_LOG_Print(LOG_APP, LOG_ERROR, 0x0000, "DSHM-SHIM", "原生输出捕获未启用：%{public}s", logPath.c_str());
  }
  g_nodeThread = std::thread([outputPath, homeDir]() {
    if (g_nodeStart == nullptr) {
      OH_LOG_Print(LOG_APP, LOG_ERROR, 0x0000, "DSHM-SHIM",
                   "node::Start 未解析到（libnode 未首载成功），无法启动 Node");
      g_running.store(false);
      // 【E119】启动失败也要把"已启动"标记复位，否则这一次失败会把此后所有启动永久拒掉
      g_started.store(false);
      return;
    }
    int rc = g_nodeStart(static_cast<int>(g_argv.size()), g_argv.data());
    {
      char line[192];
      int n = ::snprintf(line, sizeof(line), "node::Start returned rc=%d pid=%d at=%lld\n",
                         rc, static_cast<int>(::getpid()), static_cast<long long>(::time(nullptr)));
      if (n > 0) {
        AppendLifecycle(homeDir, std::string(line, static_cast<size_t>(n)));
      }
    }
    g_running.store(false);
    /*
     * 【E119：切换/重启失败的根因就在这里】`g_started` 是 `startHost` 的守卫
     * （"同一进程只允许一个 Node 实例"），但此前**置真之后从未复位**：
     * 第一次启动成功后，任何后续 `startHost` 都会被拒，报
     * 「运行时已经启动过；同一进程只允许一个 Node 实例」——真机上表现为
     * **核心版本切换、重启核心全部失败**（而旧核心明明已经退出了：
     * `isHostRunning()` 读的是 `g_running`，它是准的）。
     * 语义应当是"当前**有**一个 Node 线程在跑"，因此线程一退出就复位；
     * 这样它仍然拦住真正的并发启动，而不拦住"停掉之后再起"。
     */
    g_started.store(false);

    // 原始内容只留文件，避免 ArkWeb 输出经 hilog 二次放大；退出状态仍立即可见。
    ::fflush(stdout);
    ::fflush(stderr);
    OH_LOG_Print(LOG_APP, LOG_ERROR, 0x0000, "DSHM-SHIM",
                 "node::Start returned rc=%{public}d, output=%{public}s", rc,
                 outputPath.empty() ? "(not captured)" : outputPath.c_str());
  });
  // **必须 detach**：全局 std::thread 若在进程退出时仍是 joinable，它的析构函数会调用
  // std::terminate —— 表现为"退出时崩溃"。而 node::Start 是永不返回的阻塞调用
  // （Host 正常运行时它就是一直跑），所以这个线程在退出时**一定**是 joinable 的。
  // 不 join 的理由：join 会阻塞调用方直到 Host 结束，而 Host 按设计是要一直跑的。
  g_nodeThread.detach();

  SetBool(env, out, "started", true);
  napi_value applied = nullptr;
  napi_create_uint32(env, envCount - static_cast<uint32_t>(envBad), &applied);
  napi_set_named_property(env, out, "envApplied", applied);
  // 环境变量格式不对必须说出来：静默忽略会让 Host 用上默认目录，
  // 表面上"起来了"，实际指向了错的 $DSH_HOME。
  SetString(env, out, "note",
            envBad > 0
                ? ("Node 线程已启动，但有 " + std::to_string(envBad) +
                   " 条环境变量格式不合法（缺少 KEY=）已被忽略")
                : "Node 线程已启动（node::Start 阻塞运行）");
  return out;
}

napi_value IsHostRunning(napi_env env, napi_callback_info info) {
  napi_value out = nullptr;
  napi_get_boolean(env, g_running.load(), &out);
  return out;
}

/**
 * stopHost(): { ok: boolean, note: string }
 *
 * **如实返回做不到**。进程内 Node 无法从外部线程安全停止：node::Start 阻塞，
 * 唯一正路是在 Node 线程内持 uv_async 并调用 node::Stop(env)。在拿到 env 之前，
 * 假装停成功会让上层以为核心已经停了（而它还在监听回环端口）——那比报错更糟。
 */
napi_value StopHost(napi_env env, napi_callback_info info) {
  napi_value out = nullptr;
  napi_create_object(env, &out);
  SetBool(env, out, "ok", false);
  SetString(env, out, "note",
            "进程内 Node 暂不支持从外部线程停止（需在 Node 线程内用 uv_async + node::Stop）。"
            "当前只能随应用退出而结束。");
  return out;
}

napi_value Init(napi_env env, napi_value exports) {
  // 这条日志是二分的关键：构造器日志已证明 `.so` 被加载且注册调用返回，
  // 而四种名字口径全试过仍绑不到我们（E25/E26 + 本轮）。
  // 于是只剩两种可能，且修法完全不同：
  //   ① Init 从未被调用 ⇒ 运行时**没有用我们的模块**去实例化（查找/映射问题）；
  //   ② Init 被调用了，但 ArkTS 那边仍拿到别的对象 ⇒ 绑定侧问题。
  OH_LOG_Print(LOG_APP, LOG_INFO, 0x0000, "DSHM-SHIM", "Init called: creating exports object");
  napi_property_descriptor desc[] = {
      {"runtimeVersion", nullptr, RuntimeVersion, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"startHost", nullptr, StartHost, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"isHostRunning", nullptr, IsHostRunning, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stopHost", nullptr, StopHost, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
  return exports;
}

napi_module g_dshHostModule = {
    1,          // nm_version
    0,          // nm_flags
    // 【必须非空】Node 的 NODE_MODULE 宏与 DevEco 样例都传 __FILE__，我们原先传 nullptr。
    // 实测症状（E28）：构造器执行、napi_module_register 返回，但 Init **从未被调用**
    // ⇒ 注册很可能没被真正收下。这一栏就是与规范写法唯一的差异，先试它。
    __FILE__,   // nm_filename
    Init,       // nm_register_func
    "dshhost",  // nm_modname：见下方"注册两个名字"的说明
    nullptr,    // nm_priv
    {nullptr},  // reserved
};

/*
 * 同一个模块再注册一次，名字用**完整的导入说明符** `libdshhost.so`。
 *
 * 【为什么两个都要注册】实测（真机 hilog）：
 *     DSHM-RUNTIME 调用原生模块失败：runtimeVersion is not callable, runtimeVersion is undefined
 * 也就是 `.so` 加载成功、`import` 没报错，但**模块注册没被认到**，导出全是 undefined。
 * 而 `nm_modname` 到底该写 `<name>` 还是 `<name>.so` 取决于运行时的匹配口径：
 * 官方样例是 `libentry.so` 配 `nm_modname = "entry"`，但那条规则在不同版本上并不一致，
 * 且**写错不会报错**——只会得到一个空模块（正是我们遇到的症状）。
 * 注册两份的成本是几十字节，换来的是不必靠猜：两者命中其一即可。
 */
napi_module g_dshHostModuleFull = {
    1,
    0,
    __FILE__,
    Init,
    "libdshhost.so",
    nullptr,
    {nullptr},
};

/*
 * 再补两种名字口径：`libdshhost`（带 lib 前缀、不带扩展名）与 `dshhost.so`。
 *
 * 【为什么把四种都注册上】真机实测已确认：`.so` 被 `dlopen`、构造器执行、
 * `napi_module_register` 返回（见构造器里那条 `DSHM-SHIM` 日志），
 * 但 ArkTS 的 `import … from 'libdshhost.so'` 拿到的仍是 ArkUI 的节点模块（E25/E26）
 * ⇒ 只剩"运行时用哪个名字查表"这一个变量，而**查错名字不会报错**，
 * 只会返回一个别的模块。与其一轮一轮猜（每轮一次构建+安装≈3 分钟），
 * 不如把四种合理口径一次全覆盖：命中哪一种，看日志即可反推规则。
 */
napi_module g_dshHostModuleNoExt = {
    1,
    0,
    __FILE__,
    Init,
    "libdshhost",
    nullptr,
    {nullptr},
};

napi_module g_dshHostModuleBareDotSo = {
    1,
    0,
    __FILE__,
    Init,
    "dshhost.so",
    nullptr,
    {nullptr},
};

}  // namespace

// 模块注册：OHOS 的 NAPI 也是靠 constructor 把模块挂上去的（与 Node 原生模块一致）。
//
// 【为什么构造器里要打一条 hilog】这是本轮做的一次**二分**：真机上 ArkTS 侧
// `import dshhost from 'libdshhost.so'` 拿到的是 ArkUI 的节点 API（E25/E26），
// 而 `.so` 本身已被逐项排除（INIT_ARRAY 有我们的构造器、NEEDED 齐全、strip 前后一致）。
// 于是只剩两种可能，且它们需要完全不同的修法：
//   ① `.so` 被 dlopen 了、构造器跑了，但模块名查找没命中 → 改名字/注册方式；
//   ② `.so` **根本没被加载** → 问题在运行时如何决定加载哪个 .so（命名/映射）。
// 一条日志就能区分。用 OH_LOG_Print 而不是 printf：应用进程的 stdout 在设备上看不见（E23）。
extern "C" __attribute__((constructor)) void RegisterDshHostModule() {
  /*
   * 把 libnode 提升到**全局符号作用域**。
   *
   * 【为什么必须做】真机实测：把 koffi 的 .node 放到 HAP 的 libs/ 下加载后（见入口脚本里的
   * "原生库重定向"），`dlopen` 通过了沙箱限制，但接着报
   *     Error relocating …/libs/arm64/libkoffi.so: napi_fatal_error: symbol not found
   * 原因是：Node 在这里是**共享库**（libnode.so.127），它由应用的加载器以 RTLD_LOCAL 载入，
   * 符号不在全局作用域；而原生模块（koffi/node-pty/sharp）要解析 `napi_*` 符号，
   * 靠的正是"Node 的符号全局可见"。可执行文件形式的 node 天然满足这一点，共享库形式不满足。
   * 再 dlopen 一次并带 RTLD_GLOBAL，就把 libnode 的符号提升进全局表，后续的 .node 才能解析。
   * 失败也不致命（只是回到原来的症状），所以只记录、不中止。
   */
  /*
   * 用**绝对路径**首载 libnode。
   *
   * 【为什么不能只写 soname】去掉 DT_NEEDED 之后（见 CMakeLists 的说明），没有任何东西
   * 会把 libnode 拉进来，而 bundle 的 libs 目录未必在加载器的默认搜索路径里 —— 实测症状是
   * 应用连一条自己的日志都打不出来（很可能 libdshhost 因解析失败而加载不了）。
   * 用 `dladdr` 问出**本 .so 自己**的路径，同目录下的 libnode.so.XXX 就是同一个包里的那份，
   * 既不硬编码路径，也不受搜索路径影响。
   *
   * 【候选文件名】本机实际的 Node 是 26.7.0（`libnode.so.137`，真机已跑通于 DSHM），
   * 而早期基线是 24.x（`libnode.so.127`）。soname 随 NODE_MODULE_VERSION 走，
   * 因此这里按候选顺序逐个 dlopen，命中即用，避免换 Node 版本时改代码。
   */
  static const char* kLibnodeCandidates[] = {
      "libnode.so.147",  // Node 26.13.x（当前资产）
      "libnode.so.137",  // Node 24.x（回滚基线）
      "libnode.so.127",  // Node 22.x（历史基线）
  };
  std::string libsDir;
  Dl_info selfInfo;
  if (::dladdr(reinterpret_cast<void*>(&RegisterDshHostModule), &selfInfo) != 0 &&
      selfInfo.dli_fname != nullptr) {
    std::string selfPath(selfInfo.dli_fname);
    const size_t slash = selfPath.find_last_of('/');
    if (slash != std::string::npos) {
      libsDir = selfPath.substr(0, slash + 1);
    }
  }
  void* handle = nullptr;
  std::string libnodePath;
  for (const char* candidate : kLibnodeCandidates) {
    const std::string p = libsDir + candidate;
    void* h = ::dlopen(p.c_str(), RTLD_NOW | RTLD_GLOBAL);
    if (h != nullptr) {
      handle = h;
      libnodePath = p;
      break;
    }
  }
  if (handle == nullptr) {
    // 兜底：不写目录，交给加载器按搜索路径解析
    for (const char* candidate : kLibnodeCandidates) {
      void* h = ::dlopen(candidate, RTLD_NOW | RTLD_GLOBAL);
      if (h != nullptr) {
        handle = h;
        libnodePath = candidate;
        break;
      }
    }
  }
  if (handle != nullptr) {
    g_libnode = handle;
    // mangled 名由 `nm -D libdshhost.so` 里那条未定义符号确认过
    g_nodeStart = reinterpret_cast<NodeStartFn>(::dlsym(handle, "_ZN4node5StartEiPPc"));
  }
  OH_LOG_Print(LOG_APP, LOG_INFO, 0x0000, "DSHM-SHIM",
               "first-load %{public}s (RTLD_GLOBAL): handle=%{public}s node::Start=%{public}s",
               libnodePath.c_str(), handle != nullptr ? "ok" : "failed",
               g_nodeStart != nullptr ? "ok" : "missing");
  /*
   * ── 诊断块（定位 koffi 的 `napi_fatal_error: symbol not found`）─────────────
   * 与本 .so 顶部那个 `napi_fatal_error` 定义配合使用，见那里的说明。
   * 三个读数：
   *   diag1 = 全局作用域里 napi_fatal_error 的提供者（判别本 .so / libnode 是否全局可见）
   *   diag2 = 全局作用域里 napi_get_undefined 的提供者（找出其余 83 个符号来自谁）
   *   diag3 = 我们自己 dlopen 一次 libkoffi.so 的结果（复现 Node 的加载，且可验证修复）
   */
  {
    std::string libsDir = ".";
    Dl_info selfInfo2;
    if (::dladdr(reinterpret_cast<void*>(&RegisterDshHostModule), &selfInfo2) != 0 &&
        selfInfo2.dli_fname != nullptr) {
      std::string selfPath(selfInfo2.dli_fname);
      const size_t slash = selfPath.find_last_of('/');
      if (slash != std::string::npos) {
        libsDir = selfPath.substr(0, slash + 1);
      }
    }
    auto providerOf = [](const char* name) -> std::string {
      void* sym = ::dlsym(RTLD_DEFAULT, name);
      if (sym == nullptr) {
        return std::string("(null)");
      }
      Dl_info info;
      if (::dladdr(sym, &info) != 0 && info.dli_fname != nullptr) {
        return std::string(info.dli_fname);
      }
      return std::string("(unknown)");
    };
    const std::string fatalProvider = providerOf("napi_fatal_error");
    const std::string undefProvider = providerOf("napi_get_undefined");
    OH_LOG_Print(LOG_APP, LOG_INFO, 0x0000, "DSHM-SHIM",
                 "diag1 RTLD_DEFAULT napi_fatal_error <- %{public}s", fatalProvider.c_str());
    OH_LOG_Print(LOG_APP, LOG_INFO, 0x0000, "DSHM-SHIM",
                 "diag2 RTLD_DEFAULT napi_get_undefined <- %{public}s", undefProvider.c_str());
    const std::string koffiPath = libsDir + "libkoffi.so";
    ::dlerror();
    void* koffiHandle = ::dlopen(koffiPath.c_str(), RTLD_NOW | RTLD_LOCAL);
    std::string koffiErr = "(no-error)";
    if (koffiHandle == nullptr) {
      const char* raw = ::dlerror();
      koffiErr = raw != nullptr ? std::string(raw) : std::string("(no-dlerror-text)");
    }
    OH_LOG_Print(LOG_APP, LOG_INFO, 0x0000, "DSHM-SHIM",
                 "diag3 dlopen %{public}s = %{public}s", koffiPath.c_str(),
                 koffiHandle != nullptr ? "ok" : koffiErr.c_str());
  }
  OH_LOG_Print(LOG_APP, LOG_INFO, 0x0000, "DSHM-SHIM",
               "constructor ran: registering 4 name forms (dshhost / libdshhost.so / libdshhost / dshhost.so)");
  napi_module_register(&g_dshHostModule);
  napi_module_register(&g_dshHostModuleFull);
  napi_module_register(&g_dshHostModuleNoExt);
  napi_module_register(&g_dshHostModuleBareDotSo);
  OH_LOG_Print(LOG_APP, LOG_INFO, 0x0000, "DSHM-SHIM", "registration calls returned");
}
