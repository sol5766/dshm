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
#include <pthread.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <cerrno>
#include <signal.h>
#include "napi/native_api.h"
#include "common/child_process_utils.h"

static std::string gDshPidFilePath;

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

    // Find dsh binary
    std::string dshBin = home + "/.harmonybrew/bin/dsh";
    if (!FileExists(dshBin)) {
        WriteLaunchError("dsh binary not found at " + dshBin);
        return;
    }

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
        // Keep stderr going to the launcher log
        close(pipefd[1]);

        // Detach from parent process group so dsh survives launcher exit
        setsid();

          // CUSTOM_SANDBOX + 用户目录全盘读写后，优先用用户安装的 zsh 拉起 dsh。
          // zsh 会加载用户 shell 环境（HOME/PATH），因此 dsh 及插件中的
          // 用户 ELF（brew/node/pnpm 等）都能直接执行。
          std::string shell = home + "/.harmonybrew/bin/zsh";
          if (access(shell.c_str(), X_OK) != 0) {
            shell = "/data/service/hnp/bin/bash";
          }
          std::string command = "exec \"" + dshBin + "\" web --port " + port;
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

    // If we get here, we didn't find the readiness line
    // Check if dsh is still running (might be using a fixed port)
    int status = 0;
    pid_t wp = waitpid(dshPid, &status, WNOHANG);
    if (wp == 0) {
        // dsh is still running, might have started on a known port
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
    } else {
        // dsh has exited
        WriteLaunchError("dsh process exited prematurely");
        fprintf(stderr, "=== dsh process exited, status=%d ===\n", WEXITSTATUS(status));
        fflush(stderr);
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
    std::string* cmd = new std::string("brew\ncurl -fsSL https://harmonybrew.atomgit.com/install.sh | zsh");
    pthread_t tid;
    if (pthread_create(&tid, nullptr, InstallThread, cmd) == 0) {
        pthread_detach(tid);
    }
    napi_value result;
    napi_create_int32(env, 0, &result);
    return result;
}

static napi_value NapiInstallDsh(napi_env env, napi_callback_info info) {
    std::string* cmd = new std::string(
        "dsh\nexport PATH=\"$HOME/.harmonybrew/bin:$PATH\"; if ! command -v brew >/dev/null 2>&1 && [ ! -x \"$HOME/.harmonybrew/bin/brew\" ]; then curl -fsSL https://harmonybrew.atomgit.com/install.sh | zsh; fi; export PATH=\"$HOME/.harmonybrew/bin:$PATH\"; brew install deepseek-harness");
    pthread_t tid;
    if (pthread_create(&tid, nullptr, InstallThread, cmd) == 0) {
        pthread_detach(tid);
    }
    napi_value result;
    napi_create_int32(env, 0, &result);
    return result;
}

static napi_value NapiInit(napi_env env, napi_value exports) {
    napi_property_descriptor desc[] = {
        { "launchDsh", nullptr, NapiLaunchDsh, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "installBrew", nullptr, NapiInstallBrew, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "installDsh", nullptr, NapiInstallDsh, nullptr, nullptr, nullptr, napi_default, nullptr },
    };
    napi_define_properties(env, exports, 3, desc);
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, NapiInit)
