/**
 * DSHM DSH 宿主（libdsh_host.so）
 *
 * 被 ArkTS 层通过 startNativeChildProcess("libdsh_host.so:Main") 拉起：
 *   fork 子进程 → 本文件 Main() → 注入 busybox/Linux 环境 → dlopen(libnode.so) →
 *   node::Start() → 启动 DSH
 *
 * DSH 运行目录解析顺序：
 *   1. 环境变量 DSHM_DSH_DIR（若子进程继承）
 *   2. 硬编码标准沙箱路径 /data/storage/el2/base/haps/entry/files/dsh
 *      （DshBootstrap 将 DSH 运行环境解压到 context.filesDir/dsh）
 *
 * busybox 目录解析顺序（提供 dsh bash/Linux 命令环境）：
 *   1. 环境变量 DSHM_BUSYBOX_DIR
 *   2. DSH 目录同级 /data/storage/el2/base/haps/entry/files/busybox
 *      （DshBootstrap.ensureBusybox 解压 rawfile/busybox 到 context.filesDir/busybox）
 */
#include <signal.h>
#include <ucontext.h>
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

/** 崩溃诊断：node 静默退出（SIGSYS/SIGSEGV 等）时输出信号与崩溃点偏移。 */
#ifdef __aarch64__
static void DumpAarch64Stack(uintptr_t fp, uintptr_t lr) {
    // 简易 fp 链回溯：abort 未优化帧 [fp+8]=返回地址，[fp]=上一帧 fp。
    fprintf(stderr, "=== stack lr=%#lx ===\n", lr);
    for (int i = 0; i < 24 && fp != 0 && (fp & 7) == 0; ++i) {
        uintptr_t nextFp = *reinterpret_cast<const uintptr_t*>(fp);
        uintptr_t ret = *reinterpret_cast<const uintptr_t*>(fp + 8);
        if (ret != 0 && ret >= 0x1000 && ret < 0x7f0000000000UL) {
            fprintf(stderr, "===   #%02d ret=%#lx ===", i, ret);
            fflush(stderr);
        }
        if (nextFp <= fp) break;  // 链回退或越界即终止
        fp = nextFp;
    }
}
#endif

static void CrashSignalHandler(int sig, siginfo_t* info, void* ctx) {
    ucontext_t* uc = static_cast<ucontext_t*>(ctx);
    fprintf(stderr, "=== SIGNAL %d (%s) si_code=%d addr=%p ===\n",
            sig, strsignal(sig), info->si_code, info->si_addr);
#ifdef __aarch64__
    fprintf(stderr, "=== aarch64 x8=%lu pc=%#lx x0=%lu ===\n",
            uc->uc_mcontext.regs[8], uc->uc_mcontext.pc, uc->uc_mcontext.regs[0]);
    fprintf(stderr, "=== aarch64 fp=%#lx lr=%#lx sp=%#lx ===\n",
            uc->uc_mcontext.regs[29], uc->uc_mcontext.regs[30], uc->uc_mcontext.sp);
    fprintf(stderr, "=== prev_inst=0x%08x cur_inst=0x%08x next_inst=0x%08x ===\n",
            *reinterpret_cast<const uint32_t*>(uc->uc_mcontext.pc - 4),
            *reinterpret_cast<const uint32_t*>(uc->uc_mcontext.pc),
            *reinterpret_cast<const uint32_t*>(uc->uc_mcontext.pc + 4));
    DumpAarch64Stack(uc->uc_mcontext.regs[29], uc->uc_mcontext.regs[30]);
    // musl dladdr 对 dlopen 的 PIE 解析有限，改由 /proc/self/maps 定位基址；
    // 崩溃时打印全量 maps，便于把 pc/lr 换算成 ELF 内偏移做符号化。
    FILE* fm = fopen("/proc/self/maps", "r");
    if (fm != nullptr) {
        char line[512];
        while (fgets(line, sizeof(line), fm) != nullptr) {
            fprintf(stderr, "=== map %s", line);
        }
        fclose(fm);
    }
#endif
    fflush(stderr);
    _exit(128 + sig);
}

/** Main() 内安装崩溃信号处理器（必须在 node::Start 之前）。 */
static void InstallCrashDiagnostics() {
    struct sigaction sa = {};
    sa.sa_sigaction = CrashSignalHandler;
    sa.sa_flags = SA_SIGINFO;
    for (int sig : {SIGSEGV, SIGBUS, SIGILL, SIGTRAP, SIGSYS, SIGABRT, SIGFPE}) {
        sigaction(sig, &sa, nullptr);
    }
}


/** node::Start(int argc, char** argv) 符号（libnode.so 导出）。 */
typedef int (*NodeStartFn)(int argc, char** argv);

/**
 * Main() 里算出的 filesDir，供 RunEmbeddedNode 写「node 已退出」标记。
 * 用文件级静态变量传递，避免改动 RunEmbeddedNode 的签名与所有调用点。
 */
static std::string g_filesDir;

/**
 * 本 native 库所在目录（鸿蒙 el1 bundle 库目录）。
 *
 * 沙箱只允许从该目录 dlopen 原生模块：el2 用户数据区（rawfile 解压产物）加载会报
 * ERR_DLOPEN_FAILED "No error information"。koffi.node 因此随 native 库分发，
 * 由这里算出绝对路径并通过 DSHM_KOFFI_PATH 告知 koffi 加载器。
 */
static std::string NativeLibDir() {
    Dl_info info = {};
    if (dladdr(reinterpret_cast<void*>(&NativeLibDir), &info) != 0 && info.dli_fname != nullptr) {
        std::string path = info.dli_fname;
        const std::string::size_type slash = path.rfind('/');
        if (slash != std::string::npos) {
            return path.substr(0, slash);
        }
    }
    // 兜底：鸿蒙应用 bundle 库目录的固定位置
    return "/data/storage/el1/bundle/libs/arm64";
}

/**
 * koffi 原生模块（libkoffi.so）的构建要求 —— 记录在此避免复发。
 *
 * 2026-09-11 设备端曾因 koffi 加载失败导致 dsh 插件树起不来、应用白屏：
 *   Error relocating .../libkoffi.so: _ZN1K16PrintAssertErrorEPKciS1_: symbol not found
 *   Error relocating .../libkoffi.so: napi_fatal_error: symbol not found（早期 RTLD_LAZY 先撞上的）
 *
 * 根因：随包分发的 tools/prebuilt/koffi-3.2.1-ohos-arm64.node 是无构建配方的黑盒产物，
 * 链接时**漏掉了 koffi 自己的基础库** `koffi/lib/native/base/base.cc`（上游
 * `koffi/src/koffi/CMakeLists.txt` 的 KOFFI_SRC 明确包含它），导致 18 个 K:: 符号
 * （K::PrintAssertError / K::DefaultAllocator / K::LogFmt / ...）为 UND。
 *
 * 另一条实测结论：OHOS/musl 链接器对 dlopen 的对象**只在该对象自身的 DT_NEEDED 闭包内
 * 解析符号，不查全局作用域**。所以「先用 RTLD_GLOBAL 预加载一个提供这些符号的 .so」无效
 * （已实测：符号在全局作用域 dlsym 可见，但重定位依然报 symbol not found）。这也解释了
 * 为什么同目录的 libpty_host.so 能正常加载 —— 它的 DT_NEEDED 里有 libnode.so.137。
 *
 * 因此 koffi 必须**自包含**：用 `scripts/build-koffi-ohos.ps1` 从包内源码完整重建
 * libkoffi.so（含 base.cc），脚本内置自检，会拒绝产出仍带 K:: 未定义符号的产物。
 */

/** dlopen libnode.so 并以给定 argv 启动嵌入式 Node。返回 0 成功，负值失败。 */
static int RunEmbeddedNode(const std::vector<char*>& argv) {
    fprintf(stderr, "=== dlopen libnode.so.137 ... ===\n");
    fflush(stderr);
    // M1 瘦身：CMake target_link_libraries 的 DT_NEEDED 即 libnode.so.137
    //（库内 SONAME），dlopen 同名返回已装载句柄。entry/libs 下曾并存
    // libnode.so 与 libnode.so.137 两个 md5 完全相同的实体，HAP 各打一份
    // 126MB；删掉无 SONAME 用途的 .so 副本，只留 .so.137 一个实体。
    void* handle = dlopen("libnode.so.137", RTLD_NOW | RTLD_GLOBAL);
    if (handle == nullptr) {
        fprintf(stderr, "=== dlopen failed: %s ===\n", dlerror());
        fflush(stderr);
        return -1;
    }
    fprintf(stderr, "=== dlsym node::Start ... ===\n");
    fflush(stderr);
    NodeStartFn startFn = reinterpret_cast<NodeStartFn>(dlsym(handle, "_ZN4node5StartEiPPc"));
    if (startFn == nullptr) {
        fprintf(stderr, "=== dlsym failed: %s ===\n", dlerror());
        fflush(stderr);
        return -2;
    }
    fprintf(stderr, "=== calling node::Start (%zu args) ===\n", argv.size());
    fflush(stderr);
    const int startResult = startFn(static_cast<int>(argv.size()), const_cast<char**>(argv.data()));
    fprintf(stderr, "=== node::Start returned %d ===\n", startResult);
    fflush(stderr);
    // 退出标记：ArkTS 侧据此**确定性地**判定「旧 node 已退出、3080 已释放」，再拉起新实例。
    // 为什么必须有：ArkTS 侧 http 探测 loopback 不可靠（服务在跑也可能判失败），据此判断
    // 端口已释放会误判，导致新旧 node 抢 3080（EADDRINUSE，见 bug-log 2026-09-11）。
    // 放在 node::Start 返回**之后**：此时 node 已关闭其监听套接字，端口必然可复用。
    if (!g_filesDir.empty()) {
        const std::string exitedFlag = g_filesDir + "/node-exited";
        FILE* fe = fopen(exitedFlag.c_str(), "w");
        if (fe != nullptr) {
            fprintf(fe, "%d\n", startResult);
            fclose(fe);
        }
    }
    return startResult;
}

/**
 * 注入 busybox/Linux 环境变量，供 dsh 的 bash 工具（tool-bash）使用：
 *   PATH   = <busyboxDir>:$PATH    —— 软链 sh/bash 直接可调
 *   SHELL  = <busyboxDir>/sh       —— 默认 shell（dsh 据此定位 shell）
 *   HOME   = <filesDir>/home       —— 可写家目录（dsh 会话与配置）
 *   TERM   = xterm                 —— 多数 CLI 工具需要 TERM 才不报错
 * busybox 目录不存在时静默跳过（不阻塞 DSH 启动，仅 bash 工具不可用）。
 */
static void InjectBusyboxEnv(const std::string& dshDir) {
    std::string busyboxDir;
    const char* envDir = std::getenv("DSHM_BUSYBOX_DIR");
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
    if (access(busyboxBin.c_str(), F_OK) != 0) {
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

    // PATH：仅保留沙箱实测可 exec 的目录，hnp（Harmonybrew）存在时优先。
    // filesDir 下 busybox ELF 可读但不可 exec，塞进 PATH 只会产生误导性的
    // EACCES/EPERM；/data/service/hnp/bin 是 Harmonybrew 的安装根，
    // 设备未装 brew 时该路径不存在，需回退到系统目录。
    const char* hnpBash = "/data/service/hnp/bin/bash";
    const bool hnpUsable = (access(hnpBash, X_OK) == 0);
    std::string path = hnpUsable ? "/data/service/hnp/bin:/system/bin:/system/xbin"
                                 : "/system/bin:/system/xbin";
    const char* oldPath = std::getenv("PATH");
    if (oldPath != nullptr && *oldPath != '\0') {
        path = path + ":" + oldPath;
    }
    setenv("PATH", path.c_str(), 1);
    // SHELL：优先 hnp bash（Harmonybrew，语义最完整）；未装时回退 /system/bin/sh。
    // M0 实测：/system/bin/sh 在本沙箱域可 fork+exec（SYS_SH_OK），足以支撑
    // tool-bash 的 -c 单命令执行；若两者都不可 exec，SHELL 仍指向回退项，
    // dsh 的 bash 工具会在运行时报错，但不阻塞 DSH 核心启动。
    setenv("SHELL", hnpUsable ? hnpBash : "/system/bin/sh", 1);
    setenv("TERM", "xterm", 1);

    // HOME：filesDir/home，可写且与 DSH 数据同区
    std::string filesDir = dshDir;
    std::string::size_type pos = filesDir.rfind('/');
    if (pos != std::string::npos) {
        filesDir = filesDir.substr(0, pos);
    }
    std::string home = filesDir + "/home";
    mkdir(home.c_str(), 0700);
    setenv("HOME", home.c_str(), 1);
}

/**
 * 启动自检：fork+execv 验证默认 SHELL 与系统二进制在沙箱内可执行。
 * 输出写入 stderr（已重定向到 node-*.log），供 ArkTS dumpNodeLogs 回读确认。
 */
static void RunSelfCheck() {
    // 记录实际生效的 SHELL（M0.5：非 hnp 设备回退 /system/bin/sh）
    const char* shell = std::getenv("SHELL");
    fprintf(stderr, "=== selfcheck active SHELL=%s ===\n", shell ? shell : "(unset)");
    fflush(stderr);
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
    if (shell != nullptr && shell[0] != '\0' && std::string(shell) != "/data/service/hnp/bin/bash") {
        // 回退场景：验证回退 shell 真实可用，而非仅 access 探测通过
        runCmd(shell, {"-c", "echo ACTIVE_SHELL_SELFTEST_OK"});
    }
    // 对照：pid1 装入 host 侧的 bash/python/brew，能否从应用沙箱 exec？
    // hnp（Harmonybrew）未安装时这些应 MISSING；system 侧仅 toybox 系列在。
    runCmd("/data/service/hnp/bin/bash", {"-c", "echo HNP_BASH_SELFTEST_OK"});
    runCmd("/system/bin/toybox", {"--version"});
    runCmd("/system/bin/sh", {"-c", "echo SYS_SH_OK"});
}

/** 工具探测：列出 PATH 候选工具的 access(X_OK) 结果，用于确认沙箱 exec 面。 */
static void ProbeHostTools() {
    auto probe = [](const char* tool, const char* p) {
        fprintf(stderr, "=== probe %-10s %s %s ===\n",
                tool, p, (access(p, X_OK) == 0) ? "EXEC_OK" : "missing/noexec");
        fflush(stderr);
    };
    // shell 候选
    probe("bash", "/system/bin/bash");
    probe("mksh", "/system/bin/mksh");
    // host 工具（Harmonybrew 安装根 /data/service/hnp）
    probe("brew", "/data/service/hnp/bin/brew");
    probe("zsh", "/data/service/hnp/bin/zsh");
    probe("python3", "/data/service/hnp/bin/python3");
    // host 工具（系统）
    probe("busybox", "/system/bin/busybox");
    probe("curl", "/system/bin/curl");
    // M2 busybox 去留评估：tool-bash（$SHELL -c）常用命令是否由系统 /system/bin 直接提供。
    // 若这些都可 exec，则可从 filesDir 移除 busybox 的 87 份 applet 复制（每份 ~1MB）。
    struct { const char* name; } cmds[] = {
        {"ls"}, {"cat"}, {"echo"}, {"printf"}, {"pwd"}, {"mkdir"}, {"cp"}, {"mv"}, {"rm"},
        {"chmod"}, {"touch"}, {"ln"}, {"readlink"}, {"stat"}, {"dd"}, {"grep"}, {"sed"},
        {"awk"}, {"find"}, {"xargs"}, {"head"}, {"tail"}, {"wc"}, {"sort"}, {"uniq"},
        {"tr"}, {"cut"}, {"test"}, {"true"}, {"false"}, {"sleep"}, {"date"}, {"env"},
        {"uname"}, {"id"}, {"whoami"}, {"ps"}, {"kill"}, {"nohup"}, {"seq"}, {"expr"},
        {"basename"}, {"dirname"}, {"which"}, {"tee"}, {"tar"}, {"gzip"}, {"unzip"},
        {"diff"}, {"sha256sum"}, {"md5sum"}, {"du"}, {"df"}, {"mount"}, {"sync"}
    };
    for (auto& c : cmds) {
        std::string p = std::string("/system/bin/") + c.name;
        probe(c.name, p.c_str());
    }
}

/** startNativeChildProcess 的子进程入口（无参，签名与鸿蒙约定一致）。 */
extern "C" __attribute__((visibility("default"))) void Main() {
    std::string dshDir;
    const char* envDir = std::getenv("DSHM_DSH_DIR");
    if (envDir != nullptr && *envDir != '\0') {
        dshDir = envDir;
    } else {
        // 标准鸿蒙应用沙箱路径：<el2 base>/haps/entry/files/dsh
        dshDir = "/data/storage/el2/base/haps/entry/files/dsh";
    }

    InjectBusyboxEnv(dshDir);

    // ── 清理残留 dsh web 进程 ─────────────────────────────────────
    // 必须在 InjectBusyboxEnv 之后：此前 PATH 上只有 toybox，无 awk → 管道断，
    // kill 不执行，2>/dev/null 吞掉报错，且无条件白等 400ms。
    // 改用 busybox ps + C 内 kill(pid, SIGKILL)，不依赖 awk/xargs；
    // 仅在实际 kill 了进程时才短暂等待。
    {
        FILE* pp = popen("ps -ef 2>/dev/null | grep 'bin\\.js web' | grep -v grep", "r");
        if (pp != nullptr) {
            char line[256];
            bool killed = false;
            while (fgets(line, sizeof(line), pp) != nullptr) {
                // ps -ef: UID PID PPID ... — 解析第二列 PID
                char* p = line;
                while (*p == ' ' || *p == '\t') p++;
                while (*p && *p != ' ' && *p != '\t') p++;
                while (*p == ' ' || *p == '\t') p++;
                int pid = atoi(p);
                if (pid > 1 && pid != getpid()) {
                    if (kill(pid, SIGKILL) == 0) {
                        killed = true;
                        fprintf(stderr, "=== killed stale dsh web pid=%d ===\n", pid);
                    }
                }
            }
            pclose(pp);
            if (killed) {
                usleep(200000);
            }
        }
    }

    // 鸿蒙沙箱 seccomp 过滤器禁止 io_uring（aarch64 syscall 425），
    // libuv 在 uv_loop_init 中调用 io_uring_setup 会触发 SIGSYS 崩溃。
    // 通过环境变量让 libuv 回退到 epoll 事件循环（与标准 Linux 行为一致）。
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
    // 默认工作区：鸿蒙"个人"文件夹（/storage/Users/currentUser，全盘授权后沙箱内可读写，
    // 数据外置于系统个人目录，卸载/重置不丢；pick 文件、终端默认进入该目录）。
    // 未授权或路径不可用时回退到应用可写根 <filesDir>。
    std::string wsDir = "/storage/Users/currentUser";
    if (access(wsDir.c_str(), R_OK | W_OK | X_OK) != 0) {
        fprintf(stderr, "=== libdsh_host 个人文件夹 %s 不可用（可能未授权），回退 %s ===\n",
                wsDir.c_str(), filesDirTmp.c_str());
        fflush(stderr);
        wsDir = filesDirTmp;
    }
    if (chdir(wsDir.c_str()) != 0) {
        fprintf(stderr, "=== libdsh_host chdir %s failed ===\n", wsDir.c_str());
        fflush(stderr);
        if (chdir(filesDirTmp.c_str()) != 0) {
            fprintf(stderr, "=== libdsh_host chdir fallback %s failed ===\n", filesDirTmp.c_str());
            fflush(stderr);
        }
    } else {
        fprintf(stderr, "=== libdsh_host workspace root = %s ===\n", wsDir.c_str());
        fflush(stderr);
    }

    // 权限预设：bash sandboxMode 声明为 danger-full-access（DSHM 适配），
    // 须让 approval 策略同为 never，否则 permission-presets 的默认组合
    // （sandbox=danger-full-access + approval=ask）匹配不到任何预设而报错。
    setenv("DSH_PERMISSION_MODE", "danger-full-access", 1);

    // 诊断：重定向 stdout/stderr 到 <filesDir>/log/node-<pid>.log。
    // startNativeChildProcess 不提供子进程 stdio 管道，node 的报错输出无处可查；
    // 落盘后可通过 hdc 拉取 <sandbox>/files/log/node-*.log 定位退出原因。
    std::string filesDir = dshDir;
    std::string::size_type slash = filesDir.rfind('/');
    if (slash != std::string::npos) {
        filesDir = filesDir.substr(0, slash);
    }
    std::string logDir = filesDir + "/log";
    // 供 RunEmbeddedNode 写 node-exited 标记（ArkTS 侧靠它确定性等待旧 node 退出）
    g_filesDir = filesDir;
    mkdir(logDir.c_str(), 0755);
    std::string logFile = logDir + "/node-" + std::to_string(getpid()) + ".log";
    freopen(logFile.c_str(), "a", stdout);
    freopen(logFile.c_str(), "a", stderr);
    fprintf(stderr, "=== libdsh_host Main() pid=%d dshDir=%s ===\n", getpid(), dshDir.c_str());
    fflush(stderr);

    // koffi（真 FFI）原生模块随 native 库分发在 el1 bundle 库目录，只有那里能 dlopen；
    // 放在日志重定向之后输出，便于 hdc 拉日志核对。
    {
        // 以 .so 命名：hvigor 只把 libs/<abi>/ 下的 *.so* 打进 el1 bundle 库目录
        // （.node 不会被扫描），koffi 加载器对 .so 走 process.dlopen。
        const std::string koffiPath = NativeLibDir() + "/libkoffi.so";
        if (access(koffiPath.c_str(), R_OK) == 0) {
            setenv("DSHM_KOFFI_PATH", koffiPath.c_str(), 1);
            fprintf(stderr, "=== koffi native module: %s ===\n", koffiPath.c_str());
        } else {
            fprintf(stderr, "=== koffi native module missing at %s（FFI 将不可用）===\n", koffiPath.c_str());
        }
        fflush(stderr);
    }

    InstallCrashDiagnostics();

    // V8 FATAL（如 jitless 下内存权限异常）时落盘 report，便于定位原生层崩溃。
    // 启动自检：只验证设备允许执行的系统 shell，避免把 filesDir ELF
    // 的系统级拒绝误报为应用启动错误。
    RunSelfCheck();
    // 工具面探测（M0.5）：host 侧候选（bash/python3/brew/zsh）实际 access 结果。
    ProbeHostTools();

    // ── 运行模式：固定内嵌运行时（宿主模式已剥离）──────────────────────
    {
        FILE* f = fopen((filesDir + "/runtime-mode-active.txt").c_str(), "w");
        if (f != nullptr) {
            fprintf(f, "embedded\n");
            fclose(f);
        }
    }
    // ── 启用 dshmarket 的「同进程 pnpm 桥接」────────────────────
    // dshmarket 的安装链路默认走 node:child_process spawn pnpm / corepack / dsh CLI，
    // 而鸿蒙沙箱里 ①PATH 上没有 pnpm/npm/corepack；②filesDir 内的可执行文件
    // spawn/execv 一律 EACCES。壳侧补丁把安装改走 dsh 自带的同进程 worker + 内置 pnpm，
    // 由两个环境变量双重门控：
    //   DSHM_FILES_DIR      —— 定位内置 pnpm.cjs 与 @deepseek-ai/dsh/lib/plugin-*.js
    //   DSHM_INPROCESS_PNPM=1 —— 开关
    setenv("DSHM_FILES_DIR", filesDir.c_str(), 1);
    setenv("DSHM_INPROCESS_PNPM", "1", 1);
    fprintf(stderr, "=== in-process pnpm bridge: DSHM_FILES_DIR=%s ===\n", filesDir.c_str());
    fflush(stderr);

std::string bin = dshDir + "/node_modules/@deepseek-ai/dsh/lib/bin.js";
    // argv: node --jitless --expose-internals <dsh bin> web
    //
    // --jitless: HarmonyOS 沙箱 W^X 禁止 app 创建可执行内存（mprotect PROT_EXEC），
    //   V8 初始化时 SetPermissions 触发 V8_Fatal → 必须 jitless（无 JIT，语义不变）。
    // 代价：jitless 下无 WebAssembly，node 内建 undici fetch 首次使用即崩溃
    //   （ReferenceError: WebAssembly is not defined → llhttp WASM parser）。
    // 解决：-r 预加载 _fetch-shim.cjs，在 dsh 代码触碰任何 undici 依赖全局
    //   （fetch/Headers/Request/Response/FormData/EventSource/WebSocket/...）之前，
    //   用纯 node:http（C++ llhttp，无 WASM）实现覆盖这些全局。
    //   曾试过 -r 预加载但在 AllowHeapAllocationInRelease 上 Fatal —— 那是 load 期
    //   TLS 未初始化的老问题，已由 libnode 的 DT_NEEDED 链接修复，-r 现在安全。
    // 探针开关（文件存在即启用，由 hdc shell touch 控制，免重建切换模式）：
    //   node_probe_naked       -> argv=["node"]（无 --jitless 无脚本）
    //   node_probe_jitless     -> argv=["node","--jitless"]（无脚本）
    // 用于区分 AllowHeapAllocationInRelease Fatal 与 --jitless/模块加载的关系。
    // 注意：hdc shell 无写用户 app 沙箱权限，探针文件无法由外部创建；该段保留
    // 用于 ArkTS 侧（DshBootstrap 解压）创建时切换调试模式。
    std::string filesDirProbe = dshDir;
    std::string::size_type slashPos = filesDirProbe.rfind('/');
    if (slashPos != std::string::npos) filesDirProbe = filesDirProbe.substr(0, slashPos);
    if (access((filesDirProbe + "/log/node_probe_naked").c_str(), F_OK) == 0) {
        std::vector<char*> argv;
        argv.push_back(const_cast<char*>("node"));
        const int nodeExitCode = RunEmbeddedNode(argv);
        fprintf(stderr, "=== libdsh_host node(probe_naked) exit=%d ===\n", nodeExitCode);
        fflush(stderr);
        return;
    }
    if (access((filesDirProbe + "/log/node_probe_jitless").c_str(), F_OK) == 0) {
        std::vector<char*> argv;
        argv.push_back(const_cast<char*>("node"));
        argv.push_back(const_cast<char*>("--jitless"));
        const int nodeExitCode = RunEmbeddedNode(argv);
        fprintf(stderr, "=== libdsh_host node(probe_jitless) exit=%d ===\n", nodeExitCode);
        fflush(stderr);
        return;
    }

    // PROBE: argv=["node"] 无参数 —— 探针构建（用于定位 AllowHeapAllocation Fatal）
    std::vector<char*> argv;
    argv.push_back(const_cast<char*>("node"));
#if 1 // 正常构建时启用完整参数；探针构建时改 0
    argv.push_back(const_cast<char*>("--jitless"));
    argv.push_back(const_cast<char*>("--expose-internals"));
    const std::string shim = dshDir + "/node_modules/@deepseek-ai/dsh/lib/_fetch-shim.cjs";
    argv.push_back(const_cast<char*>("-r"));
    argv.push_back(const_cast<char*>(shim.c_str()));
    argv.push_back(const_cast<char*>(bin.c_str()));
    argv.push_back(const_cast<char*>("web"));
#endif
    const int nodeExitCode = RunEmbeddedNode(argv);
    fprintf(stderr, "=== libdsh_host node exit=%d ===\n", nodeExitCode);
    fflush(stderr);
}
