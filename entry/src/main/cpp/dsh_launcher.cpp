/**
 * libdsh_launcher.so — 启动外部 dsh web 服务并捕获端口。
 *
 * 两种调用方式：
 * 1. childProcessManager.startNativeChildProcess 拉起（child 子进程模式）
 * 2. NAPI launchDsh：应用主进程内 fork+exec dsh（继承主进程网络命名空间，
 *    使 dsh 监听的 127.0.0.1:3080 对 ArkWeb 可见——child 子进程在独立 netns 连不上）
 *
 * fork+exec `dsh web --port <port>` 并监控 stdout 中的 readiness line，
 * 将服务 URL 写入 <filesDir>/tmp/dsh-service-result.json。
 *
 * 生命周期：
 *   - dsh 进程作为独立子进程运行（setsid），不会随 libdsh_launcher 退出
 *   - PID 记录在 <filesDir>/dsh-service.json 供后续管理
 *   - ArkTS 侧通过 EntryAbility.onDestroy TERM dsh 进程
 *
 * 参考 dsh-gui: spawns `dsh web --port 0`，解析 readiness line 获取实际端口
 */
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <unistd.h>
#include <fcntl.h>
#include <pthread.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <cerrno>
#include <signal.h>
#include "napi/native_api.h"
#include "common/child_process_utils.h"

static std::string gDshPidFilePath;

// 把诊断行镜像到物理机用户目录日志（best-effort；主进程可能无写权限，失败静默）。
// 子进程（自定义沙箱）可写物理 home，故子进程内的日志一定能落盘。
static void PhysLog(const std::string& line) {
    std::string path = GetHomeDir() + "/dshm-launcher.log";
    int fd = open(path.c_str(), O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (fd < 0) {
        return;
    }
    std::string msg = line + "\n";
    (void)write(fd, msg.c_str(), msg.size());
    close(fd);
}

static void WriteServiceInfo(const std::string& pid, const std::string& url, const std::string& port, bool selfStarted) {
    std::string json = "{";
    json += "\"pid\":" + pid + ",";
    json += "\"url\":\"" + url + "\",";
    json += "\"port\":" + port + ",";
    json += "\"selfStarted\":" + std::string(selfStarted ? "true" : "false");
    json += "}";
    WriteResultFile("dsh-service-result.json", json);

    // Also write persistent service info for later management
    std::string filesDir = GetFilesDir();
    EnsureDir(filesDir + "/dsh");
    FILE* f = fopen(gDshPidFilePath.c_str(), "w");
    if (f != nullptr) {
        fprintf(f, "%s\n", json.c_str());
        fclose(f);
    }
}

static void WriteLaunchError(const std::string& message) {
    std::string json = "{";
    json += "\"success\":false,";
    json += "\"message\":\"" + message + "\"";
    json += "}";
    WriteResultFile("dsh-service-result.json", json);
}

/**
 * Parse the readiness line from dsh stdout.
 * dsh outputs: "dsh web: http://127.0.0.1:<port>" when ready.
 * Returns the port string, or empty if not found.
 */
static std::string ParsePortFromOutput(const std::string& output) {
    std::string marker = "dsh web: http://127.0.0.1:";
    size_t pos = output.find(marker);
    if (pos == std::string::npos) {
        // Also try "DSH web server running at"
        marker = "running at http://127.0.0.1:";
        pos = output.find(marker);
    }
    if (pos == std::string::npos) {
        return "";
    }
    size_t portStart = pos + marker.length();
    std::string port;
    for (size_t i = portStart; i < output.length() && output[i] >= '0' && output[i] <= '9'; i++) {
        port += output[i];
    }
    return port;
}

static void LaunchDshInternal() {
    std::string home = GetHomeDir();
    std::string filesDir = GetFilesDir();
    std::string logDir = filesDir + "/log";
    EnsureDir(logDir);
    EnsureDir(filesDir + "/dsh");

    gDshPidFilePath = filesDir + "/dsh/dsh-service.json";

    std::string logFile = logDir + "/dsh-launcher-" + std::to_string(getpid()) + ".log";
    freopen(logFile.c_str(), "a", stdout);
    freopen(logFile.c_str(), "a", stderr);

    fprintf(stderr, "=== libdsh_launcher Main() pid=%d ===\n", getpid());
    fflush(stderr);
    PhysLog("=== libdsh_launcher pid=" + std::to_string(getpid()) + " HOME=" + home + " dshBin=" + home + "/.harmonybrew/bin/dsh");

    // 注意：不能在主进程做 FileExists 预检——主进程与 fork 子进程
    // （自定义沙箱上下文）看到的 /storage/Users 视图不同，预检会误判。
    // dsh 缺失时由子进程 exec 失败体现（日志可见，readiness 超时兜底）。
    std::string dshBin = home + "/.harmonybrew/bin/dsh";
    fprintf(stderr, "[diag] HOME=%s dshBin=%s main-view-exists=%d\n",
            home.c_str(), dshBin.c_str(), FileExists(dshBin) ? 1 : 0);
    fflush(stderr);

    // Get requested port from environment (default 3080, dsh 固定端口)
    const char* portEnv = std::getenv("DSH_PORT");
    std::string port = (portEnv != nullptr && *portEnv != '\0') ? portEnv : "3080";

    // Set up environment for dsh
    std::string pathEnv = home + "/.harmonybrew/bin:/usr/bin:/bin:/system/bin:/system/xbin:/data/service/hnp/bin";
    setenv("PATH", pathEnv.c_str(), 1);
    setenv("HOME", home.c_str(), 1);

    // Create pipe to capture dsh stdout for readiness line
    int pipefd[2];
    if (pipe(pipefd) != 0) {
        WriteLaunchError("pipe() failed: " + std::string(strerror(errno)));
        return;
    }

    // Fork dsh web process
    pid_t dshPid = fork();
    if (dshPid == 0) {
        // Child: redirect stdout/stderr to log + pipe
        close(pipefd[0]); // Close read end

        // Also write to a persistent log
        std::string dshLog = logDir + "/dsh-web-" + port + ".log";
        // We'll dup pipe to stdout, and also tee to log file

        // Redirect stdout to pipe write end
        dup2(pipefd[1], STDOUT_FILENO);
        close(pipefd[1]);

        // dsh 的 stderr 镜像到物理机用户目录（子进程在自定义沙箱，可写物理 home），
        // 便于终端侧排查 EADDRINUSE / node 报错；写失败则保持 launcher 日志。
        int physLogFd = open((home + "/dshm-dsh-web.log").c_str(), O_WRONLY | O_CREAT | O_APPEND, 0644);
        if (physLogFd >= 0) {
            dup2(physLogFd, STDERR_FILENO);
            close(physLogFd);
        }

        // Detach from parent process group so dsh survives launcher exit
        setsid();

          // CUSTOM_SANDBOX + 用户目录全盘读写后，优先用用户安装的 zsh 拉起 dsh。
          // zsh 会加载用户 shell 环境（HOME/PATH），因此 dsh 及插件中的
          // 用户 ELF（brew/node/pnpm 等）都能直接执行。
          std::string shell = home + "/.harmonybrew/bin/zsh";
          if (access(shell.c_str(), X_OK) != 0) {
            shell = "/data/service/hnp/bin/bash";
          }
          std::string command = "cd \"$HOME\" && exec \"" + dshBin + "\" web --port " + port;
          execl(shell.c_str(), shell.c_str(), "-lc", command.c_str(), (char*)nullptr);
          fprintf(stderr, "zsh exec failed: %s (%s)\n", command.c_str(), strerror(errno));
          // 不直接 _exit，保留原有 execv(dshBin) 作为回退路径

        std::vector<char*> argv;
        argv.push_back(const_cast<char*>(dshBin.c_str()));
        argv.push_back(const_cast<char*>("web"));
        argv.push_back(const_cast<char*>("--port"));
        argv.push_back(const_cast<char*>(port.c_str()));
        argv.push_back(nullptr);
        execv(dshBin.c_str(), argv.data());

        fprintf(stderr, "execv %s failed: %s\n", dshBin.c_str(), strerror(errno));
        _exit(127);
    }

    // Parent: read from pipe to capture readiness line
    close(pipefd[1]); // Close write end

    std::string dshOutput;
    char buf[4096];
    ssize_t n;
    // Read with timeout (up to 30 seconds)
    int attempts = 0;
    while (attempts < 150) { // 150 * 200ms = 30s
        n = read(pipefd[0], buf, sizeof(buf) - 1);
        if (n > 0) {
            buf[n] = '\0';
            dshOutput += std::string(buf);
            // Check if we got the readiness line
            std::string detectedPort = ParsePortFromOutput(dshOutput);
            if (!detectedPort.empty()) {
                close(pipefd[0]);
                std::string url = "http://127.0.0.1:" + detectedPort;
                WriteServiceInfo(std::to_string(dshPid), url, detectedPort, true);

                fprintf(stderr, "=== dsh web ready at %s pid=%d ===\n", url.c_str(), dshPid);
                fflush(stderr);
                PhysLog("=== dsh web ready at " + url + " pid=" + std::to_string(dshPid));
                return;
            }
        } else if (n == 0) {
            break; // EOF
        }
        // Wait a bit before reading more
        usleep(200000); // 200ms
        attempts++;
    }
    close(pipefd[0]);

    // 诊断：把捕获到的 dsh 输出落日志，便于排查 readiness 未命中/假启动
    fprintf(stderr, "[diag] dsh captured output (len=%zu): %s\n", dshOutput.size(), dshOutput.c_str());
    fflush(stderr);

    // If we get here, we didn't find the readiness line
    // Check if dsh is still running (might be using a fixed port)
    int status = 0;
    pid_t wp = waitpid(dshPid, &status, WNOHANG);
    if (wp == 0) {
        // dsh is still running, might have started on a known port
        // （无输出也可能是 stdout 全缓冲，不能据此判死）
        // Try default ports as fallback
        std::string detectedPort = ParsePortFromOutput(dshOutput);
        if (detectedPort.empty()) {
            // Use the requested port or default 3080
            detectedPort = (port == "0") ? "3080" : port;
        }
        std::string url = "http://127.0.0.1:" + detectedPort;
        WriteServiceInfo(std::to_string(dshPid), url, detectedPort, true);

        fprintf(stderr, "=== dsh web started (no readiness line detected), assuming port %s pid=%d ===\n",
                detectedPort.c_str(), dshPid);
        fflush(stderr);
        PhysLog("=== dsh web started (no readiness line), assuming port " + detectedPort + " pid=" + std::to_string(dshPid));
    } else {
        // dsh has exited
        WriteLaunchError("dsh process exited prematurely");
        fprintf(stderr, "=== dsh process exited, status=%d ===\n", WEXITSTATUS(status));
        fflush(stderr);
        PhysLog("=== dsh process exited, status=" + std::to_string(WEXITSTATUS(status)));
    }
}

extern "C" __attribute__((visibility("default"))) void Main() {
    LaunchDshInternal();
}

// ---- NAPI：应用主进程内 fork+exec dsh（继承主进程网络命名空间）----
static void* LauncherThread(void*) {
    LaunchDshInternal();
    return nullptr;
}

static napi_value NapiLaunchDsh(napi_env env, napi_callback_info info) {
    PhysLog("=== launchDsh NAPI invoked (ArkTS) ===");
    pthread_t tid;
    if (pthread_create(&tid, nullptr, LauncherThread, nullptr) == 0) {
        pthread_detach(tid);
    }
    napi_value result;
    napi_create_int32(env, 0, &result);
    return result;
}

// ---- NAPI：安装 Harmonybrew / DeepSeek Harness（主进程 fork 执行安装命令）----
// 输出写入 <filesDir>/log/install-<name>-<pid>.log（ArkTS 轮询显示进度），
// 结果写入 <filesDir>/tmp/install-<name>-result.json {"success":bool,"exitCode":n,"log":"..."}
static void RunInstall(const std::string& name, const std::string& cmd) {
    std::string home = GetHomeDir();
    std::string filesDir = GetFilesDir();
    std::string logDir = filesDir + "/log";
    EnsureDir(logDir);
    EnsureDir(filesDir + "/tmp");

    std::string logFile = logDir + "/install-" + name + "-" + std::to_string(getpid()) + ".log";
    std::string resultPath = filesDir + "/tmp/install-" + name + "-result.json";
    unlink(resultPath.c_str());

    pid_t pid = fork();
    if (pid == 0) {
        FILE* f = fopen(logFile.c_str(), "a");
        if (f != nullptr) {
            dup2(fileno(f), STDOUT_FILENO);
            dup2(fileno(f), STDERR_FILENO);
            fclose(f);
        }
        std::string pathEnv = home + "/.harmonybrew/bin:/usr/bin:/bin:/system/bin:/system/xbin:/data/service/hnp/bin";
        setenv("PATH", pathEnv.c_str(), 1);
        setenv("HOME", home.c_str(), 1);
        std::string shell = home + "/.harmonybrew/bin/zsh";
        if (access(shell.c_str(), X_OK) != 0) {
            shell = "/data/service/hnp/bin/bash";
        }
        execl(shell.c_str(), shell.c_str(), "-lc", cmd.c_str(), (char*)nullptr);
        fprintf(stderr, "install shell exec failed: %s\n", strerror(errno));
        fflush(stderr);
        _exit(127);
    }
    if (pid > 0) {
        int status = 0;
        waitpid(pid, &status, 0);
        bool success = WIFEXITED(status) && WEXITSTATUS(status) == 0;
        int exitCode = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
        std::string json = "{\"success\":" + std::string(success ? "true" : "false") +
                           ",\"exitCode\":" + std::to_string(exitCode) +
                           ",\"log\":\"" + logFile + "\"}";
        FILE* rf = fopen(resultPath.c_str(), "w");
        if (rf != nullptr) {
            fwrite(json.c_str(), 1, json.size(), rf);
            fclose(rf);
        }
        fprintf(stderr, "=== install %s finished exit=%d ===\n", name.c_str(), exitCode);
        fflush(stderr);
    }
}

static void* InstallThread(void* arg) {
    std::string* cmd = static_cast<std::string*>(arg);
    // cmd 格式: <name>\n<shell command>
    size_t nl = cmd->find('\n');
    RunInstall(cmd->substr(0, nl), cmd->substr(nl + 1));
    delete cmd;
    return nullptr;
}

static napi_value NapiInstallBrew(napi_env env, napi_callback_info info) {
    // 诊断信息写入日志（进度区可见），成功以 brew 可执行文件真实存在为准，
    // 避免“退出码 0 但实际没装上”的假成功。
    // 日志同时镜像到物理机用户目录（子进程已验证可写），便于终端侧排查。
    // cd $HOME：子进程继承主进程 cwd（/ 或 /data），brew 会因 cwd 不可读而拒绝运行。
    std::string* cmd = new std::string(
        "brew\ncd \"$HOME\" && export HOMEBREW_NO_AUTO_UPDATE=1 && "
        "exec > >(tee -a \"$HOME/dshm-install-brew.log\") 2>&1; "
        "echo \"[diag] HOME=$HOME\"; echo \"[diag] id=$(id 2>&1)\"; "
        "curl -fsSL https://harmonybrew.atomgit.com/install.sh | zsh && "
        "[ -x \"$HOME/.harmonybrew/bin/brew\" ] && echo \"[diag] brew OK: $($HOME/.harmonybrew/bin/brew --version 2>&1 | head -1)\"; "
        "echo \"[diag] CMD_EXIT=$?\"");
    pthread_t tid;
    if (pthread_create(&tid, nullptr, InstallThread, cmd) == 0) {
        pthread_detach(tid);
    }
    napi_value result;
    napi_create_int32(env, 0, &result);
    return result;
}

static napi_value NapiInstallDsh(napi_env env, napi_callback_info info) {
    // install 失败时尝试 reinstall（覆盖“部分安装残留”状态）；
    // 最终以 $HOME/.harmonybrew/bin/dsh 真实存在为成功标准。
    // 写探针：确认子进程视图是否为物理机真实用户目录（终端侧可验证标记文件）。
    // cd $HOME：子进程继承主进程 cwd，brew 因 cwd 不可读拒绝运行（实测复现）。
    std::string* cmd = new std::string(
        "dsh\ncd \"$HOME\" && export HOMEBREW_NO_AUTO_UPDATE=1 && export PATH=\"$HOME/.harmonybrew/bin:$PATH\" && "
        "exec > >(tee -a \"$HOME/dshm-install-dsh.log\") 2>&1; "
        "echo \"[diag] HOME=$HOME\"; echo \"[diag] id=$(id 2>&1)\"; "
        "echo \"[diag] mount=$(cat /proc/self/mountinfo 2>/dev/null | grep ' /storage/Users/currentUser ' | head -1)\"; "
        "if ! command -v brew >/dev/null 2>&1 && [ ! -x \"$HOME/.harmonybrew/bin/brew\" ]; then "
        "curl -fsSL https://harmonybrew.atomgit.com/install.sh | zsh; fi; "
        "export PATH=\"$HOME/.harmonybrew/bin:$PATH\"; "
        "echo \"[diag] brew=$(command -v brew)\"; "
        "(brew install deepseek-harness || brew reinstall deepseek-harness) && "
        "[ -x \"$HOME/.harmonybrew/bin/dsh\" ] && echo \"[diag] dsh OK\"; "
        "echo \"[diag] CMD_EXIT=$?\"");
    pthread_t tid;
    if (pthread_create(&tid, nullptr, InstallThread, cmd) == 0) {
        pthread_detach(tid);
    }
    napi_value result;
    napi_create_int32(env, 0, &result);
    return result;
}

// ---- NAPI：安装状态检测（fork 子进程上下文，与安装/拉起同一视图）----
// 主进程与 fork 子进程（自定义沙箱）看到的 /storage/Users 视图不同：
// 主进程 access() 真实路径会误报未安装。检测必须与安装走同一上下文——
// fork + exec shell 判断，结果经 pipe 回传。
// 返回 JSON 字符串：{"brewInstalled":bool,"dshInstalled":bool,"dshPath":"..."}
static napi_value NapiCheckInstall(napi_env env, napi_callback_info info) {
    std::string home = GetHomeDir();
    std::string brewBin = home + "/.harmonybrew/bin/brew";
    std::string dshBin = home + "/.harmonybrew/bin/dsh";
    bool brewInstalled = false;
    bool dshInstalled = false;

    int pipefd[2];
    if (pipe(pipefd) == 0) {
        pid_t pid = fork();
        if (pid == 0) {
            close(pipefd[0]);
            dup2(pipefd[1], STDOUT_FILENO);
            close(pipefd[1]);
            std::string pathEnv = home + "/.harmonybrew/bin:/usr/bin:/bin:/system/bin:/system/xbin:/data/service/hnp/bin";
            setenv("PATH", pathEnv.c_str(), 1);
            setenv("HOME", home.c_str(), 1);
            std::string shell = home + "/.harmonybrew/bin/zsh";
            if (access(shell.c_str(), X_OK) != 0) {
                shell = "/data/service/hnp/bin/bash";
            }
            std::string cmd = "b=0; d=0; " \
                "[ -x \"$HOME/.harmonybrew/bin/brew\" ] && b=1; " \
                "[ -x \"$HOME/.harmonybrew/bin/dsh\" ] && d=1; " \
                "echo \"CHECK_RESULT b=$b d=$d\"";
            execl(shell.c_str(), shell.c_str(), "-c", cmd.c_str(), (char*)nullptr);
            _exit(127);
        }
        close(pipefd[1]);
        // 最多等 5 秒读子进程输出
        std::string output;
        char buf[256];
        for (int i = 0; i < 50; i++) {
            ssize_t n = read(pipefd[0], buf, sizeof(buf) - 1);
            if (n > 0) {
                buf[n] = '\0';
                output += buf;
                if (output.find("CHECK_RESULT") != std::string::npos) {
                    break;
                }
            } else if (n == 0) {
                break;
            } else {
                usleep(100000); // 100ms
            }
        }
        close(pipefd[0]);
        int status = 0;
        waitpid(pid, &status, 0);
        brewInstalled = output.find("CHECK_RESULT b=1") != std::string::npos;
        dshInstalled = output.find("d=1") != std::string::npos;
    }

    std::string json = "{";
    json += "\"brewInstalled\":" + std::string(brewInstalled ? "true" : "false") + ",";
    json += "\"dshInstalled\":" + std::string(dshInstalled ? "true" : "false") + ",";
    json += "\"dshPath\":\"" + (dshInstalled ? dshBin : "") + "\"";
    json += "}";

    napi_value result;
    napi_create_string_utf8(env, json.c_str(), json.size(), &result);
    return result;
}

// ---- NAPI：停止自启动的 dsh 进程（主进程 kill，同 uid 可杀自定义沙箱子进程）----
// dsh 经 setsid 脱离进程组，应用退出后可能残留占着 3080，必须显式 TERM。
static napi_value NapiStopDsh(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    int pid = -1;
    if (argc >= 1) {
        napi_get_value_int32(env, args[0], &pid);
    }
    int ret = -1;
    if (pid > 0) {
        ret = kill(pid, SIGTERM);
    }
    napi_value result;
    napi_create_int32(env, ret, &result);
    return result;
}

// ---- NAPI：ArkTS 侧物理日志追踪（best-effort，写到 $HOME/dshm-launcher.log）----
// 用于冷启动流程的端到端定位：ArkTS 每步调一次，终端可直接读。
static napi_value NapiPhysTrace(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc >= 1) {
        size_t len = 0;
        napi_get_value_string_utf8(env, args[0], nullptr, 0, &len);
        std::string msg(len, '\0');
        if (len > 0) {
            napi_get_value_string_utf8(env, args[0], &msg[0], len + 1, &len);
        }
        PhysLog("ARKTS: " + msg);
    }
    napi_value result;
    napi_get_undefined(env, &result);
    return result;
}

static napi_value NapiInit(napi_env env, napi_value exports) {
    napi_property_descriptor desc[] = {
        { "launchDsh", nullptr, NapiLaunchDsh, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "installBrew", nullptr, NapiInstallBrew, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "installDsh", nullptr, NapiInstallDsh, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "checkInstall", nullptr, NapiCheckInstall, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "stopDsh", nullptr, NapiStopDsh, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "physTrace", nullptr, NapiPhysTrace, nullptr, nullptr, nullptr, napi_default, nullptr },
    };
    napi_define_properties(env, exports, 6, desc);
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, NapiInit)
