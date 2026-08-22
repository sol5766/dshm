/**
 * DSHM DSH 宿主（libdsh_host.so）
 *
 * 移植自 dsh-OHDSH/HDSH（MIT）：https://gitcode.com/MakeBlackSheepGreat/dsh-OHDSH
 * 由 ArkTS 层通过 childProcessManager.startNativeChildProcess("libdsh_host.so:Main") 拉起：
 *   fork 子进程 → 本文件 Main() → 注入 busybox/Linux 环境 → dlopen(libnode.so) →
 *   node::Start() → 启动 DSH web server (127.0.0.1:3080)
 *
 * 依赖: libnode.so 随 HAP 分发（entry/libs/arm64-v8a/），由 scripts/build-libnode.sh
 *       用 harmonybrew OHOS SDK clang 从标准 node 22 LTS 源码以 --shared 构建。
 *
 * DSH 运行目录解析顺序：
 *   1. 环境变量 HDSH_DSH_DIR（若子进程继承）
 *   2. 硬编码标准沙箱路径 /data/storage/el2/base/haps/entry/files/dsh
 *      （DshBootstrap 将 DSH 运行环境解压到 context.filesDir/dsh）
 *
 * busybox 目录解析顺序（提供 dsh bash/Linux 命令环境）：
 *   1. 环境变量 HDSH_BUSYBOX_DIR
 *   2. DSH 目录同级 /data/storage/el2/base/haps/entry/files/busybox
 *      （DshBootstrap.ensureBusybox 解压 rawfile/busybox 到 context.filesDir/busybox）
 */
#include <dlfcn.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <unistd.h>
#include <dirent.h>
#include <cerrno>
#include <sys/stat.h>
#include <sys/wait.h>
#include <pty.h>
#include <poll.h>
#include <sys/ioctl.h>

/** node::Start(int argc, char** argv) 符号（libnode.so 导出）。 */
typedef int (*NodeStartFn)(int argc, char** argv);

/** dlopen libnode.so 并以给定 argv 启动嵌入式 Node。返回 0 成功，负值失败。 */
static int RunEmbeddedNode(const std::vector<char*>& argv) {
    void* handle = dlopen("libnode.so", RTLD_NOW | RTLD_GLOBAL);
    if (handle == nullptr) {
        return -1;
    }
    NodeStartFn startFn = reinterpret_cast<NodeStartFn>(dlsym(handle, "_ZN4node5StartEiPPc"));
    if (startFn == nullptr) {
        return -2;
    }
    return startFn(static_cast<int>(argv.size()), const_cast<char**>(argv.data()));
}

/**
 * 注入 busybox/Linux 环境变量，供 dsh 的 bash 工具（tool-bash）使用：
 *   PATH   = /data/service/hnp/bin:/system/bin:/system/xbin —— 鸿蒙沙箱允许执行的系统目录
 *   SHELL  = /data/service/hnp/bin/bash —— 默认 shell（沙箱内唯一可 exec 的 bash）
 *   HOME   = <filesDir>/home —— 可写家目录（dsh 会话与配置）
 *   TERM   = xterm —— 多数 CLI 工具需要 TERM 才不报错
 * busybox 目录不存在时静默跳过（不阻塞 DSH 启动，仅 bash 工具不可用）。
 *
 * 注意: filesDir 下的 busybox ELF 可读但不可 exec（沙箱 MAC），故不放入 PATH。
 */
static void InjectBusyboxEnv(const std::string& dshDir) {
    std::string busyboxDir;
    const char* envDir = std::getenv("HDSH_BUSYBOX_DIR");
    if (envDir != nullptr && *envDir != '\0') {
        busyboxDir = envDir;
    } else {
        // DSH 目录同级：<filesDir>/busybox
        std::string filesDir = dshDir;
        std::string::size_type pos = filesDir.rfind('/');
        if (pos != std::string::npos) {
            filesDir = filesDir.substr(0, pos);
        }
        busyboxDir = filesDir + "/busybox";
    }

    std::string busyboxBin = busyboxDir + "/busybox";
    if (false && access(busyboxBin.c_str(), F_OK) != 0) {
        // busybox 未解压（首次启动/解压失败）：跳过，DSH 核心功能仍可用
        return;
    }

    // ArkTS 侧 @ohos.file.fs 无 chmod API，可执行权限在此补齐（0755）。
    // 沙箱禁止 symlink，DshBootstrap 以复制方式创建 applet（sh/bash/...），
    // 复制产物同样需要可执行权限，统一对 busybox 目录内所有文件 chmod 0755。
    chmod(busyboxBin.c_str(), 0755);
    DIR* dir = opendir(busyboxDir.c_str());
    if (dir != nullptr) {
        struct dirent* entry;
        while ((entry = readdir(dir)) != nullptr) {
            std::string name = entry->d_name;
            if (name == "." || name == "..") {
                continue;
            }
            std::string appletPath = busyboxDir + "/" + name;
            chmod(appletPath.c_str(), 0755);
        }
        closedir(dir);
    }

    // PATH：仅使用鸿蒙沙箱允许执行的系统目录。
    // filesDir 下的 busybox ELF 可读但不可 exec，放入 PATH 会产生误导性的
    // EACCES/EPERM；dsh-bash-local 已固定使用 hnp bash，pnpm 插件走同进程 JS。
    const char* userHomeEnv = std::getenv("HDSH_USER_HOME");
    std::string userHome = (userHomeEnv != nullptr && *userHomeEnv != '\0') ? userHomeEnv : "/storage/Users/currentUser";
    std::string path = userHome + "/.harmonybrew/bin:" + userHome + "/.local/bin:" + userHome + "/bin:/data/service/hnp/bin:/system/bin:/system/xbin";
    const char* oldPath = std::getenv("PATH");
    if (oldPath != nullptr && *oldPath != '\0') {
        path = path + ":" + oldPath;
    }
    setenv("PATH", path.c_str(), 1);
    // SHELL：hnp bash 可 exec（HDSH 实测：系统 /bin/sh 在沙箱域无 MAC
    // 执行权，failed to spawn shell: Permission denied os error 13；
    // /data/service/hnp/bin/bash 在 hnp_file:s0 域可 exec 且语义完整）
    // SHELL：优先探测用户目录里的 zsh（CUSTOM_SANDBOX + 用户目录读写后，
    // 用户安装的 zsh/bash ELF 可被 forkpty 直接执行）；找不到再回退到 hnp bash。
    std::string shellPath = userHome + "/.harmonybrew/bin/zsh";
    if (access(shellPath.c_str(), X_OK) != 0) {
        shellPath = userHome + "/.local/bin/zsh";
    }
    if (access(shellPath.c_str(), X_OK) != 0) {
        shellPath = "/bin/zsh";
    }
    if (access(shellPath.c_str(), X_OK) != 0) {
        shellPath = "/data/service/hnp/bin/bash";
    }
    setenv("SHELL", shellPath.c_str(), 1);
    setenv("TERM", "xterm", 1);

    // HOME：CUSTOM_SANDBOX + 用户目录全盘读写后优先使用用户目录，
    // 这样 zsh/子进程能直接运行用户安装的 ELF（brew、dsh、node 等）。
    // 用户目录不可写时回退到 filesDir/home，保证会话/配置仍可落盘。
    std::string filesDir = dshDir;
    std::string::size_type pos = filesDir.rfind('/');
    if (pos != std::string::npos) {
        filesDir = filesDir.substr(0, pos);
    }
    std::string home = userHome;
    if (access(home.c_str(), W_OK) != 0) {
        home = filesDir + "/home";
        mkdir(home.c_str(), 0700);
    }
    setenv("HOME", home.c_str(), 1);
}

static void RunForkptyShellCheck();


/**
 * 启动自检：fork+execv 验证沙箱内可执行的 shell。
 * 输出写入 stderr（已重定向到 node-*.log），供 ArkTS dumpNodeLogs 回读确认。
 */
static void RunSelfCheck() {
    auto runCmd = [](const std::string& exe, const std::vector<std::string>& args) {
        pid_t pid = fork();
        if (pid == 0) {
            std::vector<char*> argv;
            argv.push_back(const_cast<char*>(exe.c_str()));
            for (const auto& a : args) argv.push_back(const_cast<char*>(a.c_str()));
            argv.push_back(nullptr);
            execv(exe.c_str(), argv.data());
            fprintf(stderr, "=== selfcheck exec failed: %s (%s) ===\n", exe.c_str(), strerror(errno));
            fflush(stderr);
            _exit(127);
        }
        if (pid > 0) {
            int status = 0;
            waitpid(pid, &status, 0);
            if (WIFEXITED(status)) {
                fprintf(stderr, "=== selfcheck %s exit=%d ===\n", exe.c_str(), WEXITSTATUS(status));
            } else {
                fprintf(stderr, "=== selfcheck %s signaled ===\n", exe.c_str());
            }
            fflush(stderr);
        }
    };
    runCmd("/data/service/hnp/bin/bash", {"-c", "echo HNP_BASH_SELFTEST_OK"});
    runCmd(std::getenv("SHELL") ? std::getenv("SHELL") : "/data/service/hnp/bin/bash", {"-c", "echo USER_SHELL_SELFTEST_OK; id; pwd"});
    RunForkptyShellCheck();
}

/**
 * forkpty zsh/custom-sandbox 自检：CUSTOM_SANDBOX + 用户目录权限正确时，
 * 通过 forkpty 直接拉起一个用户 shell（优先 zsh），该子进程继承当前应用
 * 进程的 mount namespace，从而可以执行用户目录里的 ELF。结果写入 stderr，
 * 由 ArkTS dumpNodeLogs 回读。
 */
static void RunForkptyShellCheck() {
    const char* shellEnv = std::getenv("SHELL");
    std::string shell = (shellEnv != nullptr && *shellEnv != '\0') ? shellEnv : "/data/service/hnp/bin/bash";
    int masterFd = -1;
    pid_t childPid = forkpty(&masterFd, nullptr, nullptr, nullptr);
    if (childPid == 0) {
        execl(shell.c_str(), shell.c_str(), "-lc",
              "echo DSH_FORKPTY_SHELL_OK; echo SHELL=$0; echo HOME=$HOME; id; pwd; command -v zsh || true",
              (char*)nullptr);
        fprintf(stderr, "forkpty exec failed: %s (%s)\n", shell.c_str(), strerror(errno));
        _exit(127);
    }
    if (childPid < 0) {
        fprintf(stderr, "=== forkpty selfcheck failed: %s ===\n", strerror(errno));
        fflush(stderr);
        return;
    }
    char output[4096] = {};
    int total = 0;
    while (true) {
        struct pollfd pfd;
        pfd.fd = masterFd;
        pfd.events = POLLIN;
        int pr = poll(&pfd, 1, 1000);
        if (pr > 0 && (pfd.revents & POLLIN) && total < (int)sizeof(output) - 1) {
            ssize_t n = read(masterFd, output + total, sizeof(output) - 1 - total);
            if (n > 0) total += (int)n;
        }
        int status = 0;
        pid_t w = waitpid(childPid, &status, WNOHANG);
        if (w == childPid) {
            fprintf(stderr, "=== forkpty selfcheck exit=%d ===\n%s\n",
                    WIFEXITED(status) ? WEXITSTATUS(status) : -1,
                    output[0] ? output : "(empty output)");
            fflush(stderr);
            break;
        }
    }
    close(masterFd);
}


/** startNativeChildProcess 的子进程入口（无参，签名与鸿蒙约定一致）。 */
extern "C" __attribute__((visibility("default"))) void Main() {
    std::string dshDir;
    const char* envDir = std::getenv("HDSH_DSH_DIR");
    if (envDir != nullptr && *envDir != '\0') {
        dshDir = envDir;
    } else {
        // 标准鸿蒙应用沙箱路径：<el2 base>/haps/entry/files/dsh
        dshDir = "/data/storage/el2/base/haps/entry/files/dsh";
    }

    InjectBusyboxEnv(dshDir);

    // 鸿蒙沙箱 seccomp 过滤器禁止 io_uring（aarch64 syscall 425），
    // libuv 在 uv_loop_init 中调用 io_uring_setup 会触发 SIGSYS 崩溃。
    // 通过环境变量让 libuv 回退到 epoll 事件循环（与标准 Linux 行为一致）。
    // 自建的标准 libnode.so（build-libnode.sh）尊重该环境变量，无需字节补丁。
    setenv("UV_USE_IO_URING", "0", 1);

    // 鸿蒙沙箱没有 /tmp（dsh-spill-local 等插件 mkdtemp('/tmp/...') 会 ENOENT），
    // 把 TMPDIR 指到沙箱内可写目录 <filesDir>/tmp，node 的 mkdtemp 优先读 TMPDIR。
    std::string filesDirTmp = dshDir;
    std::string::size_type posTmp = filesDirTmp.rfind('/');
    if (posTmp != std::string::npos) {
        filesDirTmp = filesDirTmp.substr(0, posTmp);
    }
    std::string tmpDir = filesDirTmp + "/tmp";
    mkdir(tmpDir.c_str(), 0755);
    setenv("TMPDIR", tmpDir.c_str(), 1);
    setenv("TMP", tmpDir.c_str(), 1);
    setenv("TEMP", tmpDir.c_str(), 1);

    // 工作区根目录：dsh 的 workspaceRoot 取 process.cwd()（见 dsh-base/cordis.patch.yml），
    // 沙箱内默认 cwd 不可写会导致 workspace-write 模式全部拒绝。
    // 显式 chdir 到 <filesDir>（应用可写根），并保持与 HOME/TMPDIR 同区。
    if (chdir(filesDirTmp.c_str()) != 0) {
        fprintf(stderr, "=== libdsh_host chdir %s failed ===\n", filesDirTmp.c_str());
        fflush(stderr);
    }

    // 权限预设：bash sandboxMode 声明为 danger-full-access（HDSH 适配），
    // 须让 approval 策略同为 never，否则 permission-presets 的默认组合
    // （sandbox=danger-full-access + approval=ask）匹配不到任何预设而报错。
    setenv("DSH_PERMISSION_MODE", "danger-full-access", 1);

    // 诊断：重定向 stdout/stderr 到 <filesDir>/log/node-<pid>.log。
    // startNativeChildProcess 不提供子进程 stdio 管道，node 的报错输出无处可查；
    // 落盘后由 ArkTS readNodeLogTail 回读展示根因。
    std::string filesDir = dshDir;
    std::string::size_type slash = filesDir.rfind('/');
    if (slash != std::string::npos) {
        filesDir = filesDir.substr(0, slash);
    }
    std::string logDir = filesDir + "/log";
    mkdir(logDir.c_str(), 0755);
    std::string logFile = logDir + "/node-" + std::to_string(getpid()) + ".log";
    freopen(logFile.c_str(), "a", stdout);
    freopen(logFile.c_str(), "a", stderr);
    fprintf(stderr, "=== libdsh_host Main() pid=%d dshDir=%s ===\n", getpid(), dshDir.c_str());
    fflush(stderr);

    // 启动自检：只验证设备允许执行的系统 shell
    RunSelfCheck();

    std::string bin = dshDir + "/node_modules/@deepseek-ai/dsh/lib/bin.js";
    // argv: node --jitless --expose-internals <dsh bin> web
    // (--expose-internals 为 HMR 插件所需)
    //
    // --jitless: HarmonyOS 沙箱 W^X 策略禁止 app 创建可执行内存（mprotect PROT_EXEC），
    //   V8 初始化时 OS::SetPermissions 触发 V8_Fatal → SIGTRAP 崩溃。
    //   jitless 模式不生成可执行代码，规避 execmem 需求。代价：无 JIT，纯 JS 语义不变。
    std::vector<char*> argv;
    argv.push_back(const_cast<char*>("node"));
    argv.push_back(const_cast<char*>("--jitless"));
    argv.push_back(const_cast<char*>("--expose-internals"));
    argv.push_back(const_cast<char*>(bin.c_str()));
    argv.push_back(const_cast<char*>("web"));
    const int nodeExitCode = RunEmbeddedNode(argv);
    fprintf(stderr, "=== libdsh_host node exit=%d ===\n", nodeExitCode);
    fflush(stderr);
}
