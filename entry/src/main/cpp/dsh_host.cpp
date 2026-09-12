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

/**
 * 宿主模式（Plan A）：直接执行 Harmonybrew 安装的 dsh。
 *
 * brew 的 `bin/dsh` 是 `#!/bin/sh` 包装脚本，内部 exec 的是 brew 自带的
 * HarmonyOS 移植版 node（原生 V8，非 --jitless），且 koffi/node-pty 是宿主编译
 * 好的真原生模块 —— 因此插件能力完整，不需要任何 DSHM 适配补丁。
 * 本进程 fork 出 /bin/sh 执行它并作为父进程守候，stdout/stderr 已由 Main()
 * 重定向到 <filesDir>/log/node-<pid>.log，ArkTS 侧沿用 `dsh web:` 就绪判定。
 */
static int RunHostDsh(const std::string& dshPath, const std::string& home, const std::string& filesDir) {
    fprintf(stderr, "=== host mode: exec %s (HOME=%s) ===\n", dshPath.c_str(), home.c_str());
    fflush(stderr);
    // 从包装脚本里提取 Cellar 版本号（脚本内含 Cellar/deepseek-harness/<ver>/...），
    // 供 ArkTS「关于版本」与更新检查展示，无需额外起进程。
    std::string dshVersion;
    {
        FILE* fw = fopen(dshPath.c_str(), "r");
        if (fw != nullptr) {
            std::string content;
            char chunk[512];
            size_t n = 0;
            while ((n = fread(chunk, 1, sizeof(chunk), fw)) > 0) {
                content.append(chunk, n);
                if (content.size() > 8192) break;
            }
            fclose(fw);
            const std::string marker = "Cellar/deepseek-harness/";
            const std::string::size_type at = content.find(marker);
            if (at != std::string::npos) {
                const std::string::size_type from = at + marker.size();
                const std::string::size_type to = content.find('/', from);
                if (to != std::string::npos && to > from) {
                    dshVersion = content.substr(from, to - from);
                }
            }
        }
    }
    // 记录当前生效模式，供 ArkTS「关于版本」展示。
    // 顺带取一次 brew node 版本（宿主模式下的真实运行时版本）。
    std::string nodeVersion;
    {
        const std::string nodeBin = home + "/.harmonybrew/opt/node/bin/node";
        if (access(nodeBin.c_str(), X_OK) == 0) {
            FILE* pp = popen((nodeBin + " --version 2>/dev/null").c_str(), "r");
            if (pp != nullptr) {
                char buf[64] = {0};
                if (fgets(buf, sizeof(buf), pp) != nullptr) {
                    nodeVersion = buf;
                    while (!nodeVersion.empty() &&
                           (nodeVersion.back() == '\n' || nodeVersion.back() == '\r')) {
                        nodeVersion.pop_back();
                    }
                }
                pclose(pp);
            }
        }
    }
    {
        FILE* f = fopen((filesDir + "/runtime-mode-active.txt").c_str(), "w");
        if (f != nullptr) {
            fprintf(f, "host\n");
            fprintf(f, "dsh=%s\n", dshPath.c_str());
            fprintf(f, "version=%s\n", dshVersion.c_str());
            fprintf(f, "node=%s\n", nodeVersion.c_str());
            fprintf(f, "home=%s\n", home.c_str());
            fclose(f);
        }
    }
    if (!nodeVersion.empty()) {
        fprintf(stderr, "=== host node %s ===\n", nodeVersion.c_str());
        fflush(stderr);
    }
    // 宿主 dsh 没有 /dshm-admin/* 端点可用来请求退出，重启改为文件信号：
    // ArkTS 侧创建 <filesDir>/restart-request，本进程守候到它即结束子进程并重启。
    const std::string restartFlag = filesDir + "/restart-request";
    int lastStatus = 0;
    for (;;) {
        pid_t pid = fork();
        if (pid < 0) {
            fprintf(stderr, "=== host mode fork failed: %s ===\n", strerror(errno));
            fflush(stderr);
            return -1;
        }
        if (pid == 0) {
            setenv("HOME", home.c_str(), 1);
            // brew formula 在包装脚本里设置的 OpenSSL 移植开关，这里保持一致。
            setenv("OPENSSL_armcap", "0", 1);
            const std::string cmd = dshPath + " web --no-open";
            execl("/bin/sh", "sh", "-c", cmd.c_str(), static_cast<char*>(nullptr));
            fprintf(stderr, "=== host mode exec failed: %s ===\n", strerror(errno));
            fflush(stderr);
            _exit(127);
        }
        fprintf(stderr, "=== host dsh started pid=%d ===\n", pid);
        fflush(stderr);
        bool restartRequested = false;
        for (;;) {
            int status = 0;
            const pid_t done = waitpid(pid, &status, WNOHANG);
            if (done == pid) {
                lastStatus = status;
                fprintf(stderr, "=== host dsh exited: status=%d ===\n", status);
                fflush(stderr);
                break;
            }
            if (done < 0) {
                fprintf(stderr, "=== host mode waitpid failed: %s ===\n", strerror(errno));
                fflush(stderr);
                lastStatus = -1;
                break;
            }
            if (access(restartFlag.c_str(), F_OK) == 0) {
                unlink(restartFlag.c_str());
                fprintf(stderr, "=== restart requested: stopping host dsh pid=%d ===\n", pid);
                fflush(stderr);
                kill(pid, SIGTERM);
                usleep(400 * 1000);
                if (waitpid(pid, &status, WNOHANG) == 0) {
                    kill(pid, SIGKILL);
                    waitpid(pid, &status, 0);
                }
                restartRequested = true;
                break;
            }
            usleep(400 * 1000);
        }
        if (!restartRequested) {
            break;
        }
        fprintf(stderr, "=== host dsh restarting ===\n");
        fflush(stderr);
    }
    return lastStatus;
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
 * JIT 能力探测：fork 一个子进程，在其中 dlopen libnode + 跑 node -e <probe>。
 *
 * 为什么必须 fork：无 JIT 权限时 V8 Fatal → CrashSignalHandler 会 _exit(128+sig)
 * 直接终止当前进程。若在主进程内探测，整个 native 进程（连同回退逻辑）一起死掉
 * （2026-09-11 实测）。fork 后子进程崩溃只影响子进程：
 *   - 子进程退出码 0       → JIT 可用（且 WASM 可用）
 *   - 非 0 / 被信号杀死     → 无 JIT 权限，调用方回退 --jitless
 * 子进程的 stderr 重定向到 <filesDir>/log/jit-probe.log，便于诊断。
 *
 * 注意：子进程继承主进程已加载的全部页（COW），再 dlopen libnode 是同一次映射，
 * 成本极低；探测脚本本身 <10ms（无权限时崩溃也只损失一次 SIGTRAP 处理）。
 */
static int RunEmbeddedNodeForked(const std::string& filesDir, const char* probeScript) {
    const std::string probeLog = filesDir + "/log/jit-probe.log";
    const pid_t pid = fork();
    if (pid < 0) {
        fprintf(stderr, "=== jit probe fork failed: errno=%d ===\n", errno);
        fflush(stderr);
        return -1;
    }
    if (pid == 0) {
        // ── 子进程：重定向 stderr 到 jit-probe.log，跑探测 ──
        FILE* lf = fopen(probeLog.c_str(), "w");
        if (lf != nullptr) {
            dup2(fileno(lf), STDERR_FILENO);
            fclose(lf);
        }
        std::vector<char*> argv;
        argv.push_back(const_cast<char*>("node"));
        argv.push_back(const_cast<char*>("-e"));
        argv.push_back(const_cast<char*>(probeScript));
        const int rc = RunEmbeddedNode(argv);
        // RunEmbeddedNode 正常返回时 rc 即退出码；崩溃时 handler 已 _exit，到不了这里
        _exit(rc);
    }
    // ── 主进程：等待子进程结束 ──
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        fprintf(stderr, "=== jit probe waitpid failed: errno=%d ===\n", errno);
        fflush(stderr);
        return -1;
    }
    if (WIFEXITED(status)) {
        return WEXITSTATUS(status);
    }
    if (WIFSIGNALED(status)) {
        fprintf(stderr, "=== jit probe child killed by signal %d (no JIT permission) ===\n",
                WTERMSIG(status));
        fflush(stderr);
        return 128 + WTERMSIG(status);
    }
    return -1;
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
    // Harmonybrew 用户级安装（/storage/Users/currentUser/.harmonybrew/bin）：
    // 2026-09-11 实测该目录下 node（v26.8.1）在 embedded 沙箱内可 exec 且
    // 网络可达（npm registry 200）——为插件安装（pnpm.cjs）提供 node 运行时。
    const char* brewBin = "/storage/Users/currentUser/.harmonybrew/bin";
    const bool brewNodeUsable = (access((std::string(brewBin) + "/node").c_str(), X_OK) == 0);
    std::string path;
    if (hnpUsable) {
        path = "/data/service/hnp/bin:";
    } else if (brewNodeUsable) {
        path = std::string(brewBin) + ":";
    }
    // filesDir/bin：DshBootstrap 生成的 pnpm/node wrapper 所在目录
    std::string filesDirTmp = dshDir;
    {
        std::string::size_type pos = filesDirTmp.rfind('/');
        if (pos != std::string::npos) filesDirTmp = filesDirTmp.substr(0, pos);
    }
    path += filesDirTmp + "/bin:";
    path += filesDirTmp + "/busybox:";
    path += "/system/bin:/system/xbin";
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
    if (brewNodeUsable) {
        fprintf(stderr, "=== brew node available: %s/node ===\n", brewBin);
    }

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

    // ── 运行模式选择 ────────────────────────────────────────────────
    // 模式由 <filesDir>/runtime-mode.txt 控制（内容 auto | host | embedded，
    // 由 ArkTS 侧菜单写入，缺省 auto）：
    //   host     优先宿主 dsh，没有则回退内嵌并打印原因
    //   embedded 强制内嵌运行时（libnode + --jitless + 适配环境）
    //   auto     有宿主 dsh 就用宿主，否则内嵌
    std::string mode = "auto";
    {
        FILE* fm = fopen((filesDir + "/runtime-mode.txt").c_str(), "r");
        if (fm != nullptr) {
            char buf[64] = {0};
            if (fgets(buf, sizeof(buf), fm) != nullptr) {
                mode = buf;
                while (!mode.empty() && (mode.back() == '\n' || mode.back() == '\r' || mode.back() == ' ')) {
                    mode.pop_back();
                }
            }
            fclose(fm);
        }
    }
    // 宿主 dsh 候选路径：Harmonybrew 是**用户级绝对安装根**，与工作区（wsDir）无关。
    //
    // 修 Bug（2026-09-12）：此前写成 `wsDir + "/.harmonybrew/bin/dsh"`，当个人文件夹
    // 未授权时 wsDir 会回退到 filesDir，宿主路径被错误拼成
    // `<filesDir>/.harmonybrew/bin/dsh`（必然 missing），日志表现为
    // `hostDsh=.../files/.harmonybrew/bin/dsh (missing)` —— 宿主模式在此设备永远不可用。
    // 现改为按「用户级根优先、filesDir 兜底」的顺序逐个探测绝对路径。
    const std::string kUserBrewDsh = "/storage/Users/currentUser/.harmonybrew/bin/dsh";
    const std::string kFilesBrewDsh = filesDirTmp + "/.harmonybrew/bin/dsh";
    std::string hostDsh = kUserBrewDsh;
    if (access(kUserBrewDsh.c_str(), X_OK) == 0) {
        hostDsh = kUserBrewDsh;
    } else if (access(kFilesBrewDsh.c_str(), X_OK) == 0) {
        hostDsh = kFilesBrewDsh;
    }
    const bool hostAvailable = (access(hostDsh.c_str(), X_OK) == 0);
    fprintf(stderr, "=== runtime mode=%s hostDsh=%s (%s) ===\n",
            mode.c_str(), hostDsh.c_str(), hostAvailable ? "executable" : "missing");
    fflush(stderr);
    if (mode != "embedded" && hostAvailable) {
        RunHostDsh(hostDsh, wsDir, filesDir);
        return;
    }
    if (mode == "host" && !hostAvailable) {
        fprintf(stderr, "=== 请求宿主模式但没有可执行的 %s，回退内嵌运行时 ===\n", hostDsh.c_str());
        fflush(stderr);
    }
    {
        FILE* f = fopen((filesDir + "/runtime-mode-active.txt").c_str(), "w");
        if (f != nullptr) {
            fprintf(f, "embedded\n");
            fclose(f);
        }
    }

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
    //
    // JIT 探测 + 自动回退（方案 A，2026-09-11）：
    //   签名 profile 持有 ohos.permission.kernel.ALLOW_EXECUTABLE_FORT_MEMORY 时，
    //   V8 可创建 W+X 内存 → 裸启动（无 --jitless）可用，且 WebAssembly/undici 原生 fetch 回归；
    //   没有该权限时（其它签名/其它设备），裸启动会 V8 Fatal → 自动回退 --jitless（shim 照常垫全局）。
    //   判据：跑一次最小 JIT+WASM 探测（-e），退出码 0 = JIT 可用；非 0（崩溃/abort）= 回退 jitless。
    //   结果缓存在 <filesDir>/log/jit-capability.txt（jit | jitless），避免每次启动付一次崩溃代价；
    //   删除该文件即重测。
    std::string jitMode = "jitless";
    bool jitKnown = false;
    {
        FILE* fc = fopen((filesDir + "/log/jit-capability.txt").c_str(), "r");
        if (fc != nullptr) {
            char jbuf[32] = {0};
            if (fgets(jbuf, sizeof(jbuf), fc) != nullptr) {
                std::string v = jbuf;
                while (!v.empty() && (v.back() == '\n' || v.back() == '\r' || v.back() == ' ')) {
                    v.pop_back();
                }
                if (v == "jit" || v == "jitless") {
                    jitMode = v;
                    jitKnown = true;
                }
            }
            fclose(fc);
        }
    }
    if (!jitKnown) {
        // 最小探测：要求 V8 JIT 真分配可执行内存（3e6 次循环触发优化编译）且 WebAssembly 可用。
        // jitless 下 WebAssembly 为 undefined → 退出码 3；无权限 → V8 Fatal/SIGNAL（非 0）。
        //
        // ⚠️ 必须 **fork 子进程** 探测，不能在主进程内直接跑：
        //   无 JIT 权限时 V8 Fatal 会触发我们安装的 CrashSignalHandler（_exit(128+sig)）——
        //   那会把**整个 native 进程**带走，RunEmbeddedNode 永不返回，回退逻辑永远没机会跑
        //   （2026-09-11 实测：首启 130s 全卡在探测崩溃上，应用起不来）。
        //   fork 出的子进程崩溃只影响子进程，主进程 waitpid 拿到非 0 退出码即可安全回退。
        const char* probe =
            "try{if(typeof WebAssembly==='undefined'){process.exit(3);}"
            "new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));"
            "let s=0;for(let i=0;i<3000000;i++){s+=i%7;}"
            "process.exit(s>0?0:2);}catch(e){process.exit(2);}";
        const int probeExit = RunEmbeddedNodeForked(filesDir, probe);
        jitMode = (probeExit == 0) ? "jit" : "jitless";
        FILE* fw = fopen((filesDir + "/log/jit-capability.txt").c_str(), "w");
        if (fw != nullptr) {
            fprintf(fw, "%s\n", jitMode.c_str());
            fclose(fw);
        }
        fprintf(stderr, "=== jit probe exit=%d -> %s ===\n", probeExit, jitMode.c_str());
        fflush(stderr);
    } else {
        fprintf(stderr, "=== jit capability cached: %s ===\n", jitMode.c_str());
        fflush(stderr);
    }
    if (jitMode == "jitless") {
        argv.push_back(const_cast<char*>("--jitless"));
    }
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
