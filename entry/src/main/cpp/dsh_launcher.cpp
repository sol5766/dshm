/**
 * libdsh_launcher.so — 启动外部 dsh web 服务并捕获端口。
 *
 * 由 ArkTS 层通过 childProcessManager.startNativeChildProcess 启动。
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
#include <sys/stat.h>
#include <sys/wait.h>
#include <cerrno>
#include <cerrno>
#include <signal.h>
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

extern "C" __attribute__((visibility("default"))) void Main() {
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

    // Get requested port from environment (default 0 for auto)
    const char* portEnv = std::getenv("DSH_PORT");
    std::string port = (portEnv != nullptr && *portEnv != '\0') ? portEnv : "0";

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
