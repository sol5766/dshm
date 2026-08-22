/**
 * libbrew_installer.so — 执行 brew install deepseek-harness。
 *
 * 由 ArkTS 层通过 childProcessManager.startNativeChildProcess 启动。
 * 安装过程日志写入 <filesDir>/log/brew-install-<pid>.log，
 * 安装结果写入 <filesDir>/tmp/brew-install-result.json。
 *
 * 流程：
 *   1. 检测 brew 是否已安装，未安装则先安装 harmonybrew
 *   2. 执行 brew install deepseek-harness
 *   3. 写入结果 JSON
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
#include "common/child_process_utils.h"

static int RunBrewInstall(std::string& output) {
    std::string home = GetHomeDir();
    std::string brewBin = home + "/.harmonybrew/bin/brew";

    // Install brew if missing
    if (!FileExists(brewBin)) {
        // Try to install harmonybrew via the official install script
        // We need zsh + curl for this
        pid_t pid = fork();
        if (pid == 0) {
            std::string filesDir = GetFilesDir();
            std::string logDir = filesDir + "/log";
            EnsureDir(logDir);
            std::string logFile = logDir + "/brew-install-" + std::to_string(getppid()) + ".log";
            FILE* lf = fopen(logFile.c_str(), "a");
            if (lf) { dup2(fileno(lf), STDOUT_FILENO); dup2(fileno(lf), STDERR_FILENO); fclose(lf); }

            fprintf(stdout, "=== Installing Harmonybrew ===\n");
            fflush(stdout);

            // Set up environment
            std::string pathEnv = home + "/.harmonybrew/bin:/usr/bin:/bin:/system/bin:/system/xbin";
            setenv("PATH", pathEnv.c_str(), 1);
            setenv("HOME", home.c_str(), 1);

            // Try the install script
            std::vector<char*> argv;
            argv.push_back(const_cast<char*>("/system/bin/sh"));
            argv.push_back(const_cast<char*>("-c"));
            argv.push_back(const_cast<char*>("curl -fsSL https://harmonybrew.atomgit.com/install.sh | zsh"));
            argv.push_back(nullptr);
            execv("/system/bin/sh", argv.data());

            // If sh not at /system/bin, try alternatives
            fprintf(stderr, "execv /system/bin/sh failed: %s\n", strerror(errno));
            _exit(127);
        }
        if (pid > 0) {
            int status = 0;
            waitpid(pid, &status, 0);
            if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
                output = "Harmonybrew installation failed";
                return 1;
            }
        }
    }

    // Now run brew install deepseek-harness
    if (!FileExists(brewBin)) {
        output = "brew binary not found after installation attempt";
        return 2;
    }

    // Make brew executable (sandbox may need this)
    chmod(brewBin.c_str(), 0755);

    std::string filesDir = GetFilesDir();
    std::string logDir = filesDir + "/log";
    EnsureDir(logDir);
    std::string installLog = logDir + "/brew-install-" + std::to_string(getpid()) + ".log";

    pid_t pid = fork();
    if (pid == 0) {
        FILE* lf = fopen(installLog.c_str(), "a");
        if (lf) { dup2(fileno(lf), STDOUT_FILENO); dup2(fileno(lf), STDERR_FILENO); fclose(lf); }

        fprintf(stdout, "=== brew install deepseek-harness ===\n");
        fflush(stdout);

        std::string pathEnv = home + "/.harmonybrew/bin:/usr/bin:/bin:/system/bin:/system/xbin:/data/service/hnp/bin";
        setenv("PATH", pathEnv.c_str(), 1);
        setenv("HOME", home.c_str(), 1);

        std::vector<char*> argv;
        argv.push_back(const_cast<char*>(brewBin.c_str()));
        argv.push_back(const_cast<char*>("install"));
        argv.push_back(const_cast<char*>("deepseek-harness"));
        argv.push_back(nullptr);
        execv(brewBin.c_str(), argv.data());

        fprintf(stderr, "execv %s failed: %s\n", brewBin.c_str(), strerror(errno));
        _exit(127);
    }

    if (pid > 0) {
        int status = 0;
        waitpid(pid, &status, 0);
        if (WIFEXITED(status)) {
            int code = WEXITSTATUS(status);
            output = "brew install exited with code " + std::to_string(code);
            return code;
        }
    }

    output = "brew install failed (unknown error)";
    return -1;
}

extern "C" __attribute__((visibility("default"))) void Main() {
    std::string filesDir = GetFilesDir();
    std::string logDir = filesDir + "/log";
    EnsureDir(logDir);

    // Redirect stdout/stderr to log file for diagnostics
    std::string logFile = logDir + "/brew-installer-" + std::to_string(getpid()) + ".log";
    freopen(logFile.c_str(), "a", stdout);
    freopen(logFile.c_str(), "a", stderr);

    fprintf(stderr, "=== libbrew_installer Main() pid=%d ===\n", getpid());
    fflush(stderr);

    std::string output;
    int exitCode = RunBrewInstall(output);

    std::string json = "{";
    json += "\"success\":" + std::string(exitCode == 0 ? "true" : "false") + ",";
    json += "\"exitCode\":" + std::to_string(exitCode) + ",";
    json += "\"message\":\"" + output + "\"";
    json += "}";

    WriteResultFile("brew-install-result.json", json);

    fprintf(stderr, "=== libbrew_installer done exitCode=%d ===\n", exitCode);
    fflush(stderr);
}
