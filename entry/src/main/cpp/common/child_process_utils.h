#ifndef DSHM_CHILD_PROCESS_UTILS_H
#define DSHM_CHILD_PROCESS_UTILS_H

#include <string>
#include <vector>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <cerrno>
#include <dirent.h>

struct ChildResult {
    int exitCode;
    std::string output;
};

static std::string GetFilesDir() {
    const char* env = std::getenv("HDSH_FILES_DIR");
    if (env != nullptr && *env != '\0') {
        return std::string(env);
    }
    return "/data/storage/el2/base/haps/entry/files";
}

static std::string GetHomeDir() {
    // 用户域 home 固定为 /storage/Users/currentUser：
    // 不能信 getenv("HOME")——应用主进程的 HOME 可能指向应用沙箱，
    // 会导致 brew/dsh 被安装/检测到沙箱副本（出现“安装成功但真机没有”）。
    return "/storage/Users/currentUser";
}

static void EnsureDir(const std::string& dir) {
    if (access(dir.c_str(), F_OK) != 0) {
        mkdir(dir.c_str(), 0755);
    }
}

static std::string WriteResultFile(const std::string& name, const std::string& content) {
    std::string filesDir = GetFilesDir();
    std::string dir = filesDir + "/tmp";
    EnsureDir(dir);
    std::string path = dir + "/" + name;
    FILE* f = fopen(path.c_str(), "w");
    if (f != nullptr) {
        fwrite(content.c_str(), 1, content.size(), f);
        fclose(f);
    }
    return path;
}

static ChildResult RunCommand(const std::string& exe, const std::vector<std::string>& args, int timeoutSec = 120) {
    ChildResult result;
    result.exitCode = -1;

    std::string filesDir = GetFilesDir();
    std::string logDir = filesDir + "/log";
    EnsureDir(logDir);

    std::string tmpOut = logDir + "/cmd-stdout-" + std::to_string(getpid()) + ".tmp";
    std::string tmpErr = logDir + "/cmd-stderr-" + std::to_string(getpid()) + ".tmp";

    pid_t pid = fork();
    if (pid == 0) {
        // Child
        FILE* outf = fopen(tmpOut.c_str(), "w");
        FILE* errf = fopen(tmpErr.c_str(), "w");
        if (outf) { dup2(fileno(outf), STDOUT_FILENO); fclose(outf); }
        if (errf) { dup2(fileno(errf), STDERR_FILENO); fclose(errf); }

        std::vector<char*> argv;
        argv.push_back(const_cast<char*>(exe.c_str()));
        for (const auto& a : args) {
            argv.push_back(const_cast<char*>(a.c_str()));
        }
        argv.push_back(nullptr);
        execv(exe.c_str(), argv.data());
        fprintf(stderr, "execv failed: %s (%s)\n", exe.c_str(), strerror(errno));
        fflush(stderr);
        _exit(127);
    }

    if (pid > 0) {
        int status = 0;
        pid_t wp = waitpid(pid, &status, 0);
        if (wp > 0 && WIFEXITED(status)) {
            result.exitCode = WEXITSTATUS(status);
        } else {
            result.exitCode = -1;
        }
    }

    // Read stdout
    FILE* rf = fopen(tmpOut.c_str(), "r");
    if (rf != nullptr) {
        char buf[4096];
        size_t n = fread(buf, 1, sizeof(buf) - 1, rf);
        buf[n] = '\0';
        result.output = std::string(buf);
        fclose(rf);
        unlink(tmpOut.c_str());
    }

    // Clean stderr
    unlink(tmpErr.c_str());

    return result;
}

static bool FileExists(const std::string& path) {
    struct stat st;
    return stat(path.c_str(), &st) == 0;
}

#endif // DSHM_CHILD_PROCESS_UTILS_H
