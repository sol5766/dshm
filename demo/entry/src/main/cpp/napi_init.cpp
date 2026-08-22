#ifndef _GNU_SOURCE
#define _GNU_SOURCE  // For gettid(), posix_openpt, etc. on musl libc
#endif

#include "pty_diagnostic.h"
#include "napi/native_api.h"
#include "hilog/log.h"

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdarg>
#include <ctime>
#include <cinttypes>
#include <chrono>
#include <thread>
#include <mutex>
#include <atomic>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <signal.h>
#include <poll.h>
#include <fcntl.h>
#include <stdlib.h>
#include <unistd.h>
#include <termios.h>
#include <pty.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <thread>
#include <dirent.h>
#include <usb/usb_ddk_api.h>
#include <usb/usb_ddk_types.h>
#include <linux/usb/ch9.h>
#include <linux/usbdevice_fs.h>

// HiLog configuration
#undef LOG_DOMAIN
#undef LOG_TAG
#define LOG_DOMAIN 0x0500
#define LOG_TAG "PTY_DIAG"

// ── Global crash context ──────────────────────────────────────────
// volatile prevents compiler from optimizing away; magic helps locate in crash dumps
volatile PtyCrashContext g_crashContext = {};

// ── Global continuous test state ──────────────────────────────────
static ContinuousTestState g_continuousState;
static std::mutex g_continuousMutex;

// ── Global log dir ────────────────────────────────────────────────
static char g_logDir[512] = {};
static bool g_logInitialized = false;

// ── Step name / description helpers ───────────────────────────────
const char* stepName(PtyTestStep step) {
    switch (step) {
        case PtyTestStep::NONE:               return "NONE";
        case PtyTestStep::PRECHECK:           return "PRECHECK";
        case PtyTestStep::STAT_DEV:           return "STAT_DEV";
        case PtyTestStep::STAT_PTMX:          return "STAT_PTMX";
        case PtyTestStep::STAT_DEV_PTS:       return "STAT_DEV_PTS";
        case PtyTestStep::STAT_DEV_PTS_PTMX:  return "STAT_DEV_PTS_PTMX";
        case PtyTestStep::POSIX_OPENPT:       return "POSIX_OPENPT";
        case PtyTestStep::GRANTPT:            return "GRANTPT";
        case PtyTestStep::UNLOCKPT:           return "UNLOCKPT";
        case PtyTestStep::PTSNAME_R:          return "PTSNAME_R";
        case PtyTestStep::OPEN_SLAVE:         return "OPEN_SLAVE";
        case PtyTestStep::TCGETATTR_MASTER:   return "TCGETATTR_MASTER";
        case PtyTestStep::TCGETATTR_SLAVE:    return "TCGETATTR_SLAVE";
        case PtyTestStep::STEP_TIOCGWINSZ:         return "TIOCGWINSZ";
        case PtyTestStep::STEP_TIOCSWINSZ:         return "TIOCSWINSZ";
        case PtyTestStep::WRITE_MASTER:       return "WRITE_MASTER";
        case PtyTestStep::READ_SLAVE:         return "READ_SLAVE";
        case PtyTestStep::WRITE_SLAVE:        return "WRITE_SLAVE";
        case PtyTestStep::READ_MASTER:        return "READ_MASTER";
        case PtyTestStep::CLOSE_SLAVE:        return "CLOSE_SLAVE";
        case PtyTestStep::CLOSE_MASTER:       return "CLOSE_MASTER";
        case PtyTestStep::FD_LEAK_CHECK:      return "FD_LEAK_CHECK";
        case PtyTestStep::COLLECT_SYSTEM_STATE: return "COLLECT_SYSTEM_STATE";
        case PtyTestStep::CHILD_FORKPTY_RECOVERY: return "CHILD_FORKPTY_RECOVERY";
        case PtyTestStep::PTMX_ATTR_CHECK: return "PTMX_ATTR_CHECK";
        case PtyTestStep::BATCH_OPEN: return "BATCH_OPEN";
        case PtyTestStep::HOLD_OPEN: return "HOLD_OPEN";
        case PtyTestStep::COMPLETED:          return "COMPLETED";
        default: return "UNKNOWN";
    }
}

const char* stepDescription(PtyTestStep step) {
    switch (step) {
        case PtyTestStep::NONE:               return "No step executed yet";
        case PtyTestStep::PRECHECK:           return "Preliminary capability checks";
        case PtyTestStep::STAT_DEV:           return "stat(/dev)";
        case PtyTestStep::STAT_PTMX:          return "stat(/dev/ptmx) + lstat";
        case PtyTestStep::STAT_DEV_PTS:       return "stat(/dev/pts) + lstat";
        case PtyTestStep::STAT_DEV_PTS_PTMX:  return "stat(/dev/pts/ptmx) + lstat";
        case PtyTestStep::POSIX_OPENPT:       return "posix_openpt(O_RDWR|O_NOCTTY|O_CLOEXEC)";
        case PtyTestStep::GRANTPT:            return "grantpt(masterFd)";
        case PtyTestStep::UNLOCKPT:           return "unlockpt(masterFd)";
        case PtyTestStep::PTSNAME_R:          return "ptsname_r(masterFd, ...)";
        case PtyTestStep::OPEN_SLAVE:         return "open(slavePath, O_RDWR|O_NOCTTY|O_CLOEXEC)";
        case PtyTestStep::TCGETATTR_MASTER:   return "tcgetattr(masterFd)";
        case PtyTestStep::TCGETATTR_SLAVE:    return "tcgetattr(slaveFd)";
        case PtyTestStep::STEP_TIOCGWINSZ:         return "ioctl(TIOCGWINSZ) - get window size";
        case PtyTestStep::STEP_TIOCSWINSZ:         return "ioctl(TIOCSWINSZ) - set window size";
        case PtyTestStep::WRITE_MASTER:       return "write(masterFd) -> read(slaveFd)";
        case PtyTestStep::READ_SLAVE:         return "read slave after master write";
        case PtyTestStep::WRITE_SLAVE:        return "write(slaveFd) -> read(masterFd)";
        case PtyTestStep::READ_MASTER:        return "read master after slave write";
        case PtyTestStep::CLOSE_SLAVE:        return "close(slaveFd)";
        case PtyTestStep::CLOSE_MASTER:       return "close(masterFd)";
        case PtyTestStep::FD_LEAK_CHECK:      return "File descriptor leak detection";
        case PtyTestStep::COLLECT_SYSTEM_STATE: return "Collect system state snapshot";
        case PtyTestStep::CHILD_FORKPTY_RECOVERY: return "Child process forkpty recovery attempt";
        case PtyTestStep::COMPLETED:          return "Test completed";
        default: return "Unknown step";
    }
}

void saveErrnoImmediately(int& savedErrno) {
    savedErrno = errno;
}

int64_t timeNowUs() {
    auto now = std::chrono::steady_clock::now();
    return std::chrono::duration_cast<std::chrono::microseconds>(
        now.time_since_epoch()).count();
}

void getTimestamp(char* buf, size_t size) {
    auto now = std::chrono::system_clock::now();
    auto t = std::chrono::system_clock::to_time_t(now);
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        now.time_since_epoch()) % 1000;
    struct tm tm_info;
    localtime_r(&t, &tm_info);
    snprintf(buf, size, "%04d-%02d-%02dT%02d:%02d:%02d.%03lld",
        tm_info.tm_year + 1900, tm_info.tm_mon + 1, tm_info.tm_mday,
        tm_info.tm_hour, tm_info.tm_min, tm_info.tm_sec,
        (long long)ms.count());
}

int countOpenFds() {
    int count = 0;
    DIR* dir = opendir("/proc/self/fd");
    if (dir) {
        struct dirent* entry;
        while ((entry = readdir(dir)) != nullptr) {
            if (entry->d_name[0] != '.') count++;
        }
        closedir(dir);
    }
    return count;
}

// ── FileLogger implementation ─────────────────────────────────────
FileLogger& FileLogger::instance() {
    static FileLogger logger;
    return logger;
}

void FileLogger::init(const char* logDir) {
    std::lock_guard<std::mutex> lock(mutex_);
    strncpy(logDir_, logDir, sizeof(logDir_) - 1);
    snprintf(latestPath_, sizeof(latestPath_), "%s/pty_diagnostic_latest.log", logDir);
    snprintf(historyPath_, sizeof(historyPath_), "%s/pty_diagnostic_history.log", logDir);
    snprintf(crashPath_, sizeof(crashPath_), "%s/pty_crash_context.log", logDir);

    // Open latest (overwrite), history (append)
    latestFile_ = fopen(latestPath_, "w");
    historyFile_ = fopen(historyPath_, "a");
    if (historyFile_) {
        fseek(historyFile_, 0, SEEK_END);
        historyBytesWritten_ = ftell(historyFile_);
    }
    g_logInitialized = true;
}

void FileLogger::log(const char* level, const char* format, ...) {
    if (!g_logInitialized) return;
    std::lock_guard<std::mutex> lock(mutex_);

    char timestamp[64];
    getTimestamp(timestamp, sizeof(timestamp));
    char buffer[4096];

    va_list args;
    va_start(args, format);
    int len = vsnprintf(buffer, sizeof(buffer), format, args);
    va_end(args);

    // Write to latest log
    if (latestFile_) {
        fprintf(latestFile_, "[%s] [%s] %s\n", timestamp, level, buffer);
    }

    // Write to history log
    if (historyFile_) {
        int written = fprintf(historyFile_, "[%s] [%s] %s\n", timestamp, level, buffer);
        if (written > 0) historyBytesWritten_ += written;
    }
}

void FileLogger::logStep(int testId, const PtyStepResult& step, const char* mode) {
    if (!g_logInitialized) return;
    std::lock_guard<std::mutex> lock(mutex_);

    char timestamp[64];
    getTimestamp(timestamp, sizeof(timestamp));

    const char* resultStr = step.success ? "OK" : "FAIL";
    char line[2048];
    int len = snprintf(line, sizeof(line),
        "[%s] testId=%d mode=%s step=%s result=%s ret=%d errno=%d errmsg=%s detail=%s durUs=%lld",
        timestamp, testId, mode, step.stepName, resultStr, step.result,
        step.savedErrno, step.errnoMessage, step.details, (long long)step.durationUs);

    if (latestFile_) {
        fprintf(latestFile_, "%s\n", line);
        if (!step.success) {
            fflush(latestFile_);
            fsync(fileno(latestFile_));
        }
    }
    if (historyFile_) {
        fprintf(historyFile_, "%s\n", line);
        if (len > 0) historyBytesWritten_ += len + 1;
        // Flush on failure
        if (!step.success) {
            fflush(historyFile_);
            fsync(fileno(historyFile_));
        }
    }
}

void FileLogger::flush() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (latestFile_) fflush(latestFile_);
    if (historyFile_) fflush(historyFile_);
}

void FileLogger::fsyncLatest() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (latestFile_) {
        fflush(latestFile_);
        fsync(fileno(latestFile_));
    }
    if (historyFile_) {
        fflush(historyFile_);
        fsync(fileno(historyFile_));
    }
}

void FileLogger::rotate() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (historyBytesWritten_ >= kMaxHistorySize) {
        if (historyFile_) fclose(historyFile_);
        // Rename old, start new
        char backup[640];
        snprintf(backup, sizeof(backup), "%s.old", historyPath_);
        rename(historyPath_, backup);
        historyFile_ = fopen(historyPath_, "w");
        historyBytesWritten_ = 0;
    }
}

void FileLogger::createReport(const PtyTestResult& result, char* outPath, size_t size) {
    std::lock_guard<std::mutex> lock(mutex_);
    char timestamp[64];
    getTimestamp(timestamp, sizeof(timestamp));
    // Sanitize timestamp for filename
    for (char* p = timestamp; *p; p++) {
        if (*p == ':' || *p == 'T') *p = '_';
        if (*p == '.') *p = '-';
    }
    snprintf(outPath, size, "%s/pty_report_%s.txt", logDir_, timestamp);

    FILE* f = fopen(outPath, "w");
    if (!f) return;

    fprintf(f, "=== PTY Diagnostic Report ===\n");
    fprintf(f, "Test ID: %d\n", result.testId);
    fprintf(f, "Overall Result: %s\n", result.success ? "SUCCESS" : "FAILURE");
    fprintf(f, "Crash On Failure: %s\n", result.crashOnFailure ? "yes" : "no");
    fprintf(f, "Failed Step: %s\n", stepName(result.failedStep));
    fprintf(f, "Errno: %d (%s)\n", result.errno_, result.errnoMessage);
    fprintf(f, "Master FD: %d\n", result.masterFd);
    fprintf(f, "Slave FD: %d\n", result.slaveFd);
    fprintf(f, "Slave Path: %s\n", result.slavePath);
    fprintf(f, "Started: %s\n", result.startedAt);
    fprintf(f, "Finished: %s\n", result.finishedAt);
    fprintf(f, "Duration: %lld us\n\n", (long long)result.durationUs);

    fprintf(f, "=== Step-by-step Results ===\n");
    for (const auto& s : result.steps) {
        fprintf(f, "  [%s] %s: ret=%d errno=%d msg=%s detail=%s dur=%lldus\n",
            s.success ? "PASS" : "FAIL", s.stepName, s.result, s.savedErrno,
            s.errnoMessage, s.details, (long long)s.durationUs);
    }

    fprintf(f, "\n=== System State (Before) ===\n");
    const auto& sb = result.stateBefore;
    fprintf(f, "PID: %d  PPID: %d  TID: %d\n", sb.pid, sb.ppid, sb.tid);
    fprintf(f, "UID: %d  EUID: %d  GID: %d  EGID: %d\n", sb.uid, sb.euid, sb.gid, sb.egid);
    fprintf(f, "FD Count: %d\n", sb.fdCount);
    fprintf(f, "CWD: %s\n", sb.cwd);
    fprintf(f, "--- /proc/self/status ---\n%s\n", sb.procStatus);
    fprintf(f, "--- /proc/self/cmdline ---\n%s\n", sb.procCmdline);
    fprintf(f, "--- /proc/self/limits ---\n%s\n", sb.procLimits);
    fprintf(f, "--- /proc/sys/kernel/pty/nr ---\n%s\n", sb.ptyNr);
    fprintf(f, "--- /proc/sys/kernel/pty/max ---\n%s\n", sb.ptyMax);
    fprintf(f, "--- /proc/sys/kernel/pty/reserve ---\n%s\n", sb.ptyReserve);
    fprintf(f, "--- SELinux current ---\n%s\n", sb.selinuxCurrent);
    fprintf(f, "--- /dev ---\n  stat: %s\n  lstat: %s\n  access: R=%d W=%d X=%d\n",
        sb.devStat, sb.devLstat, sb.devAccessR, sb.devAccessW, sb.devAccessX);
    fprintf(f, "--- /dev/ptmx ---\n  stat: %s\n  lstat: %s\n  readlink: %s\n  access: R=%d W=%d X=%d\n",
        sb.ptmxStat, sb.ptmxLstat, sb.ptmxReadlink, sb.ptmxAccessR, sb.ptmxAccessW, sb.ptmxAccessX);
    fprintf(f, "--- /dev/pts ---\n  stat: %s\n  lstat: %s\n  access: R=%d W=%d X=%d\n",
        sb.devPtsStat, sb.devPtsLstat, sb.devPtsAccessR, sb.devPtsAccessW, sb.devPtsAccessX);
    fprintf(f, "--- /dev/pts/ptmx ---\n  stat: %s\n  lstat: %s\n",
        sb.devPtsPtmxStat, sb.devPtsPtmxLstat);
    fprintf(f, "--- /proc/self/mountinfo ---\n%s\n", sb.mountInfo);
    fprintf(f, "--- /proc/self/mounts ---\n%s\n", sb.mounts);

    fprintf(f, "\n=== System State (After) ===\n");
    const auto& sa = result.stateAfter;
    fprintf(f, "PID: %d  PPID: %d  FD Count: %d\n", sa.pid, sa.ppid, sa.fdCount);
    fprintf(f, "--- SELinux current ---\n%s\n", sa.selinuxCurrent);
    fprintf(f, "--- /proc/sys/kernel/pty/nr ---\n%s\n", sa.ptyNr);
    fprintf(f, "--- /proc/self/mountinfo ---\n%s\n", sa.mountInfo);
    fprintf(f, "--- /dev/ptmx stat ---\n%s\n", sa.ptmxStat);

    fclose(f);
}

// ── Read file helper ──────────────────────────────────────────────
static int readFile(const char* path, char* buf, size_t size) {
    int fd = open(path, O_RDONLY);
    if (fd < 0) return -errno;
    ssize_t n = read(fd, buf, size - 1);
    int savedErrno = errno;
    close(fd);
    if (n < 0) return -savedErrno;
    if (n > 0 && buf[n-1] == '\n') n--; // trim trailing newline
    buf[n] = '\0';
    return (int)n;
}

static int readFileToBuf(const char* path, char* buf, size_t size) {
    int ret = readFile(path, buf, size);
    if (ret < 0) {
        snprintf(buf, size, "(error: %s)", strerror(-ret));
    }
    return ret;
}

// ── Collect system state ──────────────────────────────────────────
void collectSystemState(SystemStateSnapshot& state, bool collectMount, bool collectSelinux) {
    memset(&state, 0, sizeof(state));

    state.pid = getpid();
    state.ppid = getppid();
    state.uid = getuid();
    state.euid = geteuid();
    state.gid = getgid();
    state.egid = getegid();
    state.tid = gettid();
    state.fdCount = countOpenFds();

    // cwd
    if (getcwd(state.cwd, sizeof(state.cwd) - 1) == nullptr) {
        snprintf(state.cwd, sizeof(state.cwd), "(getcwd failed: %s)", strerror(errno));
    }

    // /proc files
    readFileToBuf("/proc/self/status", state.procStatus, sizeof(state.procStatus));
    readFileToBuf("/proc/self/cmdline", state.procCmdline, sizeof(state.procCmdline));
    readFileToBuf("/proc/self/limits", state.procLimits, sizeof(state.procLimits));

    // PTY counts
    readFileToBuf("/proc/sys/kernel/pty/nr", state.ptyNr, sizeof(state.ptyNr));
    readFileToBuf("/proc/sys/kernel/pty/max", state.ptyMax, sizeof(state.ptyMax));
    readFileToBuf("/proc/sys/kernel/pty/reserve", state.ptyReserve, sizeof(state.ptyReserve));

    // /dev node stat info
    struct stat st;
    struct stat lst;
    char buf[1024];

    // /dev
    errno = 0;
    if (lstat("/dev", &lst) == 0) {
        snprintf(state.devLstat, sizeof(state.devLstat),
            "lstat: mode=%o uid=%d gid=%d dev=%lu rdev=%lu ino=%lu size=%ld",
            lst.st_mode, lst.st_uid, lst.st_gid,
            (unsigned long)lst.st_dev, (unsigned long)lst.st_rdev,
            (unsigned long)lst.st_ino, (long)lst.st_size);
    } else {
        snprintf(state.devLstat, sizeof(state.devLstat), "lstat failed: errno=%d (%s)", errno, strerror(errno));
    }
    errno = 0;
    if (stat("/dev", &st) == 0) {
        snprintf(state.devStat, sizeof(state.devStat),
            "stat: mode=%o uid=%d gid=%d dev=%lu rdev=%lu ino=%lu",
            st.st_mode, st.st_uid, st.st_gid,
            (unsigned long)st.st_dev, (unsigned long)st.st_rdev,
            (unsigned long)st.st_ino);
    } else {
        snprintf(state.devStat, sizeof(state.devStat), "stat failed: errno=%d (%s)", errno, strerror(errno));
    }
    state.devAccessR = access("/dev", R_OK);
    state.devAccessW = access("/dev", W_OK);
    state.devAccessX = access("/dev", X_OK);

    // /dev/ptmx
    errno = 0;
    if (lstat("/dev/ptmx", &lst) == 0) {
        snprintf(state.ptmxLstat, sizeof(state.ptmxLstat),
            "lstat: mode=%o uid=%d gid=%d dev=%lu rdev=%lu ino=%lu size=%ld",
            lst.st_mode, lst.st_uid, lst.st_gid,
            (unsigned long)lst.st_dev, (unsigned long)lst.st_rdev,
            (unsigned long)lst.st_ino, (long)lst.st_size);
        // readlink
        ssize_t rl = readlink("/dev/ptmx", state.ptmxReadlink, sizeof(state.ptmxReadlink) - 1);
        if (rl >= 0) state.ptmxReadlink[rl] = '\0';
        else snprintf(state.ptmxReadlink, sizeof(state.ptmxReadlink), "(readlink failed: errno=%d)", errno);
    } else {
        snprintf(state.ptmxLstat, sizeof(state.ptmxLstat), "lstat failed: errno=%d (%s)", errno, strerror(errno));
        state.ptmxReadlink[0] = '\0';
    }
    errno = 0;
    if (stat("/dev/ptmx", &st) == 0) {
        snprintf(state.ptmxStat, sizeof(state.ptmxStat),
            "stat: mode=%o uid=%d gid=%d dev=%lu rdev=%lu ino=%lu",
            st.st_mode, st.st_uid, st.st_gid,
            (unsigned long)st.st_dev, (unsigned long)st.st_rdev,
            (unsigned long)st.st_ino);
    } else {
        snprintf(state.ptmxStat, sizeof(state.ptmxStat), "stat failed: errno=%d (%s)", errno, strerror(errno));
    }
    state.ptmxAccessR = access("/dev/ptmx", R_OK);
    state.ptmxAccessW = access("/dev/ptmx", W_OK);
    state.ptmxAccessX = access("/dev/ptmx", X_OK);

    // /dev/pts
    errno = 0;
    if (lstat("/dev/pts", &lst) == 0) {
        snprintf(state.devPtsLstat, sizeof(state.devPtsLstat),
            "lstat: mode=%o uid=%d gid=%d dev=%lu rdev=%lu ino=%lu",
            lst.st_mode, lst.st_uid, lst.st_gid,
            (unsigned long)lst.st_dev, (unsigned long)lst.st_rdev,
            (unsigned long)lst.st_ino);
    } else {
        snprintf(state.devPtsLstat, sizeof(state.devPtsLstat), "lstat failed: errno=%d (%s)", errno, strerror(errno));
    }
    errno = 0;
    if (stat("/dev/pts", &st) == 0) {
        snprintf(state.devPtsStat, sizeof(state.devPtsStat),
            "stat: mode=%o uid=%d gid=%d dev=%lu rdev=%lu ino=%lu",
            st.st_mode, st.st_uid, st.st_gid,
            (unsigned long)st.st_dev, (unsigned long)st.st_rdev,
            (unsigned long)st.st_ino);
    } else {
        snprintf(state.devPtsStat, sizeof(state.devPtsStat), "stat failed: errno=%d (%s)", errno, strerror(errno));
    }
    state.devPtsAccessR = access("/dev/pts", R_OK);
    state.devPtsAccessW = access("/dev/pts", W_OK);
    state.devPtsAccessX = access("/dev/pts", X_OK);

    // /dev/pts/ptmx
    errno = 0;
    if (lstat("/dev/pts/ptmx", &lst) == 0) {
        snprintf(state.devPtsPtmxLstat, sizeof(state.devPtsPtmxLstat),
            "lstat: mode=%o uid=%d gid=%d dev=%lu rdev=%lu ino=%lu",
            lst.st_mode, lst.st_uid, lst.st_gid,
            (unsigned long)lst.st_dev, (unsigned long)lst.st_rdev,
            (unsigned long)lst.st_ino);
    } else {
        snprintf(state.devPtsPtmxLstat, sizeof(state.devPtsPtmxLstat), "lstat failed: errno=%d (%s)", errno, strerror(errno));
    }
    errno = 0;
    if (stat("/dev/pts/ptmx", &st) == 0) {
        snprintf(state.devPtsPtmxStat, sizeof(state.devPtsPtmxStat),
            "stat: mode=%o uid=%d gid=%d dev=%lu rdev=%lu ino=%lu",
            st.st_mode, st.st_uid, st.st_gid,
            (unsigned long)st.st_dev, (unsigned long)st.st_rdev,
            (unsigned long)st.st_ino);
    } else {
        snprintf(state.devPtsPtmxStat, sizeof(state.devPtsPtmxStat), "stat failed: errno=%d (%s)", errno, strerror(errno));
    }

    // Mount info
    if (collectMount) {
        readFileToBuf("/proc/self/mountinfo", state.mountInfo, sizeof(state.mountInfo));
        readFileToBuf("/proc/self/mounts", state.mounts, sizeof(state.mounts));
    }

    // SELinux
    if (collectSelinux) {
        readFileToBuf("/proc/self/attr/current", state.selinuxCurrent, sizeof(state.selinuxCurrent));
    }
}

// ── Fill crash context ────────────────────────────────────────────
static void fillCrashContext(const PtyTestResult& result) {
    memset((void*)&g_crashContext, 0, sizeof(g_crashContext)); // cast away volatile
    g_crashContext.magic = PTY_CRASH_MAGIC;
    g_crashContext.testId = result.testId;
    g_crashContext.failedStep = static_cast<int>(result.failedStep);
    g_crashContext.result = -1;
    g_crashContext.savedErrno = result.errno_;
    g_crashContext.masterFd = result.masterFd;
    g_crashContext.slaveFd = result.slaveFd;
    g_crashContext.pid = getpid();
    g_crashContext.uid = getuid();
    g_crashContext.gid = getgid();
    strncpy((char*)g_crashContext.failedStepName, stepName(result.failedStep), sizeof(g_crashContext.failedStepName) - 1);
    strncpy((char*)g_crashContext.errnoMessage, result.errnoMessage, sizeof(g_crashContext.errnoMessage) - 1);
    strncpy((char*)g_crashContext.slavePath, result.slavePath, sizeof(g_crashContext.slavePath) - 1);
    // Copy mount/ptmx summaries from system state
    strncpy((char*)g_crashContext.mountInfoSummary, result.stateBefore.mountInfo, sizeof(g_crashContext.mountInfoSummary) - 1);
    strncpy((char*)g_crashContext.ptmxStatSummary, result.stateBefore.ptmxStat, sizeof(g_crashContext.ptmxStatSummary) - 1);
}

// ── Record a step result ──────────────────────────────────────────
static void recordStep(PtyTestResult& result, PtyTestStep step, bool success,
                       int ret, int savedErrno, const char* detail, int64_t startUs) {
    PtyStepResult sr;
    memset(&sr, 0, sizeof(sr));
    sr.step = step;
    sr.success = success;
    sr.result = ret;
    sr.savedErrno = savedErrno;
    strncpy(sr.stepName, stepName(step), sizeof(sr.stepName) - 1);
    strncpy(sr.errnoMessage, strerror(savedErrno), sizeof(sr.errnoMessage) - 1);
    if (detail) strncpy(sr.details, detail, sizeof(sr.details) - 1);
    sr.durationUs = timeNowUs() - startUs;
    result.steps.push_back(sr);

    // HiLog output
    if (success) {
        OH_LOG_INFO(LOG_APP, "step=%{public}s result=%{public}d errno=%{public}d msg=%{public}s detail=%{public}s",
            sr.stepName, sr.result, sr.savedErrno, sr.errnoMessage, sr.details);
    } else {
        OH_LOG_ERROR(LOG_APP, "step=%{public}s result=%{public}d errno=%{public}d msg=%{public}s detail=%{public}s",
            sr.stepName, sr.result, sr.savedErrno, sr.errnoMessage, sr.details);
    }

    // File log
    FileLogger::instance().logStep(result.testId, sr, result.crashOnFailure ? "crash" : "normal");
}

// ── Run single PTY test step ──────────────────────────────────────
// Returns true if step passed
static bool doStep(PtyTestResult& result, PtyTestStep step,
                   int ret, int savedErrno, const char* detail, int64_t startUs,
                   bool failStopsTest = true) {
    bool success = (ret >= 0);
    recordStep(result, step, success, ret, savedErrno, detail, startUs);
    if (!success && failStopsTest) {
        result.success = false;
        result.failedStep = step;
        result.errno_ = savedErrno;
        strncpy(result.errnoMessage, strerror(savedErrno), sizeof(result.errnoMessage) - 1);
    }
    return success;
}

// ── Main PTY test execution ───────────────────────────────────────
// ── Log key system state to file ─────────────────────────────
static void logKeySystemState(const SystemStateSnapshot& state) {
    FileLogger::instance().log("INFO", "SYS: selinux=%s ptyNr=%s ptyMax=%s fdCount=%d",
        state.selinuxCurrent, state.ptyNr, state.ptyMax, state.fdCount);
    FileLogger::instance().log("INFO", "SYS: ptmxStat=%s", state.ptmxStat);
    FileLogger::instance().log("INFO", "SYS: ptmxLstat=%s", state.ptmxLstat);
    FileLogger::instance().log("INFO", "SYS: ptmxReadlink=%s", state.ptmxReadlink);
    FileLogger::instance().log("INFO", "SYS: access ptmx R=%d W=%d X=%d",
        state.ptmxAccessR, state.ptmxAccessW, state.ptmxAccessX);
    const char* mi = state.mountInfo;
    const char* ls = mi;
    while (*ls) {
        const char* le = strchr(ls, '\n');
        if (!le) le = ls + strlen(ls);
        if (strstr(ls, "devpts") || strstr(ls, " /dev ")) {
            char b[256]; size_t l = le - ls;
            if (l > sizeof(b)-1) l = sizeof(b)-1;
            memcpy(b, ls, l); b[l] = 0;
            FileLogger::instance().log("INFO", "SYS: mount=%s", b);
        }
        ls = *le ? le + 1 : le;
    }
}

void runFullPtyTest(const PtyTestOptions& options, PtyTestResult& result) {
    // Initialize result
    memset(&result, 0, sizeof(result));
    result.testId = static_cast<int>(time(nullptr)) * 1000 + (getpid() % 1000);
    result.success = true;
    result.crashOnFailure = options.crashOnFailure;
    result.masterFd = -1;
    result.slaveFd = -1;
    result.failedStep = PtyTestStep::NONE;

    int64_t testStartUs = timeNowUs();
    getTimestamp(result.startedAt, sizeof(result.startedAt));

    // Collect pre-test system state
    int64_t stepStart = timeNowUs();
    collectSystemState(result.stateBefore, options.collectMountInfo, options.collectSelinuxInfo);
    recordStep(result, PtyTestStep::COLLECT_SYSTEM_STATE, true, 0, 0,
        "Pre-test system state collected", stepStart);
    logKeySystemState(result.stateBefore);

    int fdCountBefore = countOpenFds();

    // ── Step: PRECHECK ────────────────────────────────────────────
    stepStart = timeNowUs();
    bool canOpenDev = (access("/dev", F_OK) == 0);
    bool canOpenPtmx = (access("/dev/ptmx", F_OK) == 0);
    bool canOpenPts = (access("/dev/pts", F_OK) == 0);
    char precheckDetail[512];
    snprintf(precheckDetail, sizeof(precheckDetail),
        "access(/dev)=%d access(/dev/ptmx)=%d access(/dev/pts)=%d",
        canOpenDev, canOpenPtmx, canOpenPts);
    errno = 0;
    doStep(result, PtyTestStep::PRECHECK, canOpenDev && canOpenPtmx ? 0 : -1,
        canOpenDev && canOpenPtmx ? 0 : ENOENT, precheckDetail, stepStart, false);

    // ── Step: STAT_DEV ────────────────────────────────────────────
    stepStart = timeNowUs();
    struct stat devStat;
    errno = 0;
    int ret = stat("/dev", &devStat);
    int savedErrno = errno;
    char statDetail[512];
    if (ret == 0) {
        snprintf(statDetail, sizeof(statDetail),
            "/dev: mode=%o uid=%d gid=%d dev=%lu rdev=%lu ino=%lu",
            devStat.st_mode, devStat.st_uid, devStat.st_gid,
            (unsigned long)devStat.st_dev, (unsigned long)devStat.st_rdev,
            (unsigned long)devStat.st_ino);
    } else {
        snprintf(statDetail, sizeof(statDetail), "stat(/dev) failed: errno=%d", savedErrno);
    }
    doStep(result, PtyTestStep::STAT_DEV, ret, savedErrno, statDetail, stepStart, false);

    // ── Step: STAT_PTMX (lstat + stat) ────────────────────────────
    stepStart = timeNowUs();
    struct stat ptmxLstat, ptmxStat;
    char ptmxDetail[1024];
    errno = 0;
    int lstatRet = lstat("/dev/ptmx", &ptmxLstat);
    int lstatErr = errno;
    errno = 0;
    int statRet = stat("/dev/ptmx", &ptmxStat);
    int statErr = errno;
    snprintf(ptmxDetail, sizeof(ptmxDetail),
        "lstat: ret=%d errno=%d | stat: ret=%d errno=%d mode=%o uid=%d gid=%d",
        lstatRet, lstatErr, statRet, statErr,
        (statRet == 0) ? ptmxStat.st_mode : 0,
        (statRet == 0) ? ptmxStat.st_uid : -1,
        (statRet == 0) ? ptmxStat.st_gid : -1);
    doStep(result, PtyTestStep::STAT_PTMX, (lstatRet == 0 || statRet == 0) ? 0 : -1,
        statRet != 0 ? statErr : 0, ptmxDetail, stepStart, false);

    // ── Step: STAT_DEV_PTS ────────────────────────────────────────
    stepStart = timeNowUs();
    struct stat ptsStat;
    errno = 0;
    ret = stat("/dev/pts", &ptsStat);
    savedErrno = errno;
    if (ret == 0) {
        snprintf(statDetail, sizeof(statDetail),
            "/dev/pts: mode=%o uid=%d gid=%d dev=%lu rdev=%lu ino=%lu",
            ptsStat.st_mode, ptsStat.st_uid, ptsStat.st_gid,
            (unsigned long)ptsStat.st_dev, (unsigned long)ptsStat.st_rdev,
            (unsigned long)ptsStat.st_ino);
    } else {
        snprintf(statDetail, sizeof(statDetail), "stat(/dev/pts) failed: errno=%d", savedErrno);
    }
    doStep(result, PtyTestStep::STAT_DEV_PTS, ret, savedErrno, statDetail, stepStart, false);

    // ── Step: STAT_DEV_PTS_PTMX ───────────────────────────────────
    stepStart = timeNowUs();
    struct stat ptsPtmxStat;
    errno = 0;
    ret = stat("/dev/pts/ptmx", &ptsPtmxStat);
    savedErrno = errno;
    if (ret == 0) {
        snprintf(statDetail, sizeof(statDetail),
            "/dev/pts/ptmx: mode=%o uid=%d gid=%d dev=%lu rdev=%lu ino=%lu",
            ptsPtmxStat.st_mode, ptsPtmxStat.st_uid, ptsPtmxStat.st_gid,
            (unsigned long)ptsPtmxStat.st_dev, (unsigned long)ptsPtmxStat.st_rdev,
            (unsigned long)ptsPtmxStat.st_ino);
    } else {
        snprintf(statDetail, sizeof(statDetail), "stat(/dev/pts/ptmx) failed: errno=%d", savedErrno);
    }
    doStep(result, PtyTestStep::STAT_DEV_PTS_PTMX, ret, savedErrno, statDetail, stepStart, false);

    // ── Core PTY steps: use do-while(0) + break for clean error bail-out ─
    int masterFd = -1;
    int slaveFd = -1;
    char slavePath[256] = {};

    do {
        // ── Step: POSIX_OPENPT ────────────────────────────────────
        stepStart = timeNowUs();
        errno = 0;
        masterFd = posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC);
        savedErrno = errno;
        char openptDetail[256];
        snprintf(openptDetail, sizeof(openptDetail), "masterFd=%d", masterFd);
        bool openptOk = doStep(result, PtyTestStep::POSIX_OPENPT, masterFd,
            savedErrno, openptDetail, stepStart, true);
        result.masterFd = masterFd;
        if (!openptOk) break;

        // ── Step: GRANTPT ─────────────────────────────────────────
        stepStart = timeNowUs();
        errno = 0;
        ret = grantpt(masterFd);
        savedErrno = errno;
        doStep(result, PtyTestStep::GRANTPT, ret, savedErrno,
            ret == 0 ? "grantpt succeeded" : "grantpt failed", stepStart, true);
        if (ret != 0) break;

        // ── Step: UNLOCKPT ────────────────────────────────────────
        stepStart = timeNowUs();
        errno = 0;
        ret = unlockpt(masterFd);
        savedErrno = errno;
        doStep(result, PtyTestStep::UNLOCKPT, ret, savedErrno,
            ret == 0 ? "unlockpt succeeded" : "unlockpt failed", stepStart, true);
        if (ret != 0) break;

        // ── Step: PTSNAME_R ───────────────────────────────────────
        stepStart = timeNowUs();
        errno = 0;
        ret = ptsname_r(masterFd, slavePath, sizeof(slavePath));
        savedErrno = errno;
        char ptsnameDetail[512];
        if (ret == 0) {
            snprintf(ptsnameDetail, sizeof(ptsnameDetail), "slavePath=%s", slavePath);
            strncpy(result.slavePath, slavePath, sizeof(result.slavePath) - 1);
        } else {
            snprintf(ptsnameDetail, sizeof(ptsnameDetail), "ptsname_r failed");
        }
        doStep(result, PtyTestStep::PTSNAME_R, ret, savedErrno, ptsnameDetail, stepStart, true);
        if (ret != 0) break;

        // ── Step: OPEN_SLAVE ──────────────────────────────────────
        stepStart = timeNowUs();
        errno = 0;
        slaveFd = open(slavePath, O_RDWR | O_NOCTTY | O_CLOEXEC);
        savedErrno = errno;
        char openSlaveDetail[256];
        snprintf(openSlaveDetail, sizeof(openSlaveDetail), "slaveFd=%d path=%s", slaveFd, slavePath);
        bool slaveOk = doStep(result, PtyTestStep::OPEN_SLAVE, slaveFd,
            savedErrno, openSlaveDetail, stepStart, true);
        result.slaveFd = slaveFd;
        if (!slaveOk) break;

        // ── Step: isatty checks ───────────────────────────────────
        stepStart = timeNowUs();
        int masterIsAtty = isatty(masterFd);
        int slaveIsAtty = isatty(slaveFd);
        char isattyDetail[256];
        snprintf(isattyDetail, sizeof(isattyDetail),
            "isatty(master=%d)=%d isatty(slave=%d)=%d",
            masterFd, masterIsAtty, slaveFd, slaveIsAtty);
        {
            PtyStepResult sr;
            memset(&sr, 0, sizeof(sr));
            sr.step = PtyTestStep::TCGETATTR_MASTER;
            sr.success = (masterIsAtty == 1 && slaveIsAtty == 1);
            sr.result = (masterIsAtty && slaveIsAtty) ? 0 : -1;
            sr.savedErrno = 0;
            strncpy(sr.stepName, stepName(PtyTestStep::TCGETATTR_MASTER), sizeof(sr.stepName) - 1);
            strncpy(sr.errnoMessage, "isatty check", sizeof(sr.errnoMessage) - 1);
            strncpy(sr.details, isattyDetail, sizeof(sr.details) - 1);
            sr.durationUs = timeNowUs() - stepStart;
            result.steps.push_back(sr);
            OH_LOG_INFO(LOG_APP, "step=%{public}s detail=%{public}s", sr.stepName, sr.details);
            FileLogger::instance().logStep(result.testId, sr, result.crashOnFailure ? "crash" : "normal");
        }

        // ── Step: TCGETATTR on slave ──────────────────────────────
        stepStart = timeNowUs();
        struct termios slaveTermios;
        errno = 0;
        ret = tcgetattr(slaveFd, &slaveTermios);
        savedErrno = errno;
        char tcDetail[256];
        snprintf(tcDetail, sizeof(tcDetail), "tcgetattr(slave) ret=%d", ret);
        doStep(result, PtyTestStep::TCGETATTR_SLAVE, ret, savedErrno, tcDetail, stepStart,
            options.performReadWriteTest);

        // ── Step: TIOCGWINSZ ──────────────────────────────────────
        stepStart = timeNowUs();
        struct winsize ws;
        errno = 0;
        ret = ioctl(masterFd, TIOCGWINSZ, &ws);
        savedErrno = errno;
        char wszDetail[256];
        if (ret == 0) {
            snprintf(wszDetail, sizeof(wszDetail), "rows=%d cols=%d xpixels=%d ypixels=%d",
                ws.ws_row, ws.ws_col, ws.ws_xpixel, ws.ws_ypixel);
        } else {
            snprintf(wszDetail, sizeof(wszDetail), "TIOCGWINSZ failed");
        }
        doStep(result, PtyTestStep::STEP_TIOCGWINSZ, ret, savedErrno, wszDetail, stepStart,
            options.performReadWriteTest);

        // ── Step: TIOCSWINSZ ──────────────────────────────────────
        stepStart = timeNowUs();
        struct winsize newWs = { 24, 80, 0, 0 };
        errno = 0;
        ret = ioctl(masterFd, TIOCSWINSZ, &newWs);
        savedErrno = errno;
        doStep(result, PtyTestStep::STEP_TIOCSWINSZ, ret, savedErrno,
            ret == 0 ? "TIOCSWINSZ 24x80 succeeded" : "TIOCSWINSZ failed", stepStart,
            options.performReadWriteTest);

        // ── Read/write tests ──────────────────────────────────────
        if (options.performReadWriteTest) {
            struct termios raw = slaveTermios;
            cfmakeraw(&raw);
            errno = 0;
            tcsetattr(slaveFd, TCSANOW, &raw);

            // ── WRITE_MASTER -> READ_SLAVE ────────────────────────
            stepStart = timeNowUs();
            const char* testMsg = "PTY_DIAG_HELLO";
            size_t msgLen = strlen(testMsg);
            errno = 0;
            ssize_t written = write(masterFd, testMsg, msgLen);
            savedErrno = errno;
            char rwDetail[512];
            if (written > 0) {
                struct pollfd pfd;
                pfd.fd = slaveFd;
                pfd.events = POLLIN;
                int pollRet = poll(&pfd, 1, 500);
                if (pollRet > 0 && (pfd.revents & POLLIN)) {
                    char readBuf[256] = {};
                    errno = 0;
                    ssize_t nread = read(slaveFd, readBuf, sizeof(readBuf) - 1);
                    savedErrno = errno;
                    snprintf(rwDetail, sizeof(rwDetail),
                        "master->slave: wrote=%zd poll=%d read=%zd data='%.*s'",
                        written, pollRet, nread, (int)nread, readBuf);
                    doStep(result, PtyTestStep::WRITE_MASTER, (nread > 0) ? 0 : -1,
                        savedErrno, rwDetail, stepStart, false);
                } else {
                    snprintf(rwDetail, sizeof(rwDetail),
                        "master->slave: wrote=%zd poll=%d (timeout or error)", written, pollRet);
                    doStep(result, PtyTestStep::WRITE_MASTER, -1,
                        pollRet == 0 ? ETIMEDOUT : errno, rwDetail, stepStart, false);
                }
            } else {
                snprintf(rwDetail, sizeof(rwDetail), "write(master) failed: wrote=%zd errno=%d", written, savedErrno);
                doStep(result, PtyTestStep::WRITE_MASTER, -1, savedErrno, rwDetail, stepStart, false);
            }

            // ── WRITE_SLAVE -> READ_MASTER ────────────────────────
            stepStart = timeNowUs();
            const char* testMsg2 = "SLAVE_BACK";
            size_t msgLen2 = strlen(testMsg2);
            errno = 0;
            written = write(slaveFd, testMsg2, msgLen2);
            savedErrno = errno;
            if (written > 0) {
                struct pollfd pfd2;
                pfd2.fd = masterFd;
                pfd2.events = POLLIN;
                int pollRet2 = poll(&pfd2, 1, 500);
                if (pollRet2 > 0 && (pfd2.revents & POLLIN)) {
                    char readBuf2[256] = {};
                    errno = 0;
                    ssize_t nread2 = read(masterFd, readBuf2, sizeof(readBuf2) - 1);
                    savedErrno = errno;
                    snprintf(rwDetail, sizeof(rwDetail),
                        "slave->master: wrote=%zd poll=%d read=%zd data='%.*s'",
                        written, pollRet2, nread2, (int)nread2, readBuf2);
                    doStep(result, PtyTestStep::WRITE_SLAVE, (nread2 > 0) ? 0 : -1,
                        savedErrno, rwDetail, stepStart, false);
                } else {
                    snprintf(rwDetail, sizeof(rwDetail),
                        "slave->master: wrote=%zd poll=%d (timeout or error)", written, pollRet2);
                    doStep(result, PtyTestStep::WRITE_SLAVE, -1,
                        pollRet2 == 0 ? ETIMEDOUT : errno, rwDetail, stepStart, false);
                }
            } else {
                snprintf(rwDetail, sizeof(rwDetail), "write(slave) failed: wrote=%zd errno=%d", written, savedErrno);
                doStep(result, PtyTestStep::WRITE_SLAVE, -1, savedErrno, rwDetail, stepStart, false);
            }
        }
    } while (0);
    // ── End of PTY core steps ─────────────────────────────────────

    // ── CLOSE_SLAVE ───────────────────────────────────────────────
    if (result.slaveFd >= 0) {
        stepStart = timeNowUs();
        errno = 0;
        ret = close(result.slaveFd);
        savedErrno = errno;
        char closeDetail[128];
        snprintf(closeDetail, sizeof(closeDetail), "close(slaveFd=%d) ret=%d", result.slaveFd, ret);
        doStep(result, PtyTestStep::CLOSE_SLAVE, ret, savedErrno, closeDetail, stepStart, false);
        result.slaveFd = -1;
    }

    // ── CLOSE_MASTER ──────────────────────────────────────────────
    if (result.masterFd >= 0) {
        stepStart = timeNowUs();
        errno = 0;
        ret = close(result.masterFd);
        savedErrno = errno;
        char closeDetail[128];
        snprintf(closeDetail, sizeof(closeDetail), "close(masterFd=%d) ret=%d", result.masterFd, ret);
        doStep(result, PtyTestStep::CLOSE_MASTER, ret, savedErrno, closeDetail, stepStart, false);
        result.masterFd = -1;
    }

    // ── FD_LEAK_CHECK ─────────────────────────────────────────────
    stepStart = timeNowUs();
    int fdCountAfter = countOpenFds();
    int fdDelta = fdCountAfter - fdCountBefore;
    char leakDetail[256];
    snprintf(leakDetail, sizeof(leakDetail), "before=%d after=%d delta=%d",
        fdCountBefore, fdCountAfter, fdDelta);
    doStep(result, PtyTestStep::FD_LEAK_CHECK, fdDelta == 0 ? 0 : -1, 0, leakDetail, stepStart, false);

    // ── Collect post-test system state ────────────────────────────
    stepStart = timeNowUs();
    collectSystemState(result.stateAfter, options.collectMountInfo, options.collectSelinuxInfo);
    recordStep(result, PtyTestStep::COLLECT_SYSTEM_STATE, true, 0, 0,
        "Post-test system state collected", stepStart);

    getTimestamp(result.finishedAt, sizeof(result.finishedAt));
    result.durationUs = timeNowUs() - testStartUs;

    // ── Handle crash mode ─────────────────────────────────────────
    if (!result.success && options.crashOnFailure) {
        // Fill crash context first
        fillCrashContext(result);

        // Log crash context
        OH_LOG_FATAL(LOG_APP, "CRASH_CONTEXT magic=0x%{public}016llX testId=%{public}d "
            "failedStep=%{public}s errno=%{public}d msg=%{public}s slavePath=%{public}s",
            (unsigned long long)g_crashContext.magic, g_crashContext.testId,
            g_crashContext.failedStepName, g_crashContext.savedErrno,
            g_crashContext.errnoMessage, g_crashContext.slavePath);

        // Write crash log to file
        FILE* crashFile = fopen(FileLogger::instance().crashLogPath(), "w");
        if (crashFile) {
            fprintf(crashFile, "=== PTY Crash Context ===\n");
            fprintf(crashFile, "magic: 0x%016llX\n", (unsigned long long)g_crashContext.magic);
            fprintf(crashFile, "testId: %d\n", g_crashContext.testId);
            fprintf(crashFile, "failedStep: %d (%s)\n", g_crashContext.failedStep, g_crashContext.failedStepName);
            fprintf(crashFile, "result: %d\n", g_crashContext.result);
            fprintf(crashFile, "savedErrno: %d (%s)\n", g_crashContext.savedErrno, g_crashContext.errnoMessage);
            fprintf(crashFile, "masterFd: %d\n", g_crashContext.masterFd);
            fprintf(crashFile, "slaveFd: %d\n", g_crashContext.slaveFd);
            fprintf(crashFile, "pid: %d\n", g_crashContext.pid);
            fprintf(crashFile, "uid: %d\n", g_crashContext.uid);
            fprintf(crashFile, "gid: %d\n", g_crashContext.gid);
            fprintf(crashFile, "slavePath: %s\n", g_crashContext.slavePath);
            fprintf(crashFile, "mountInfoSummary: %s\n", g_crashContext.mountInfoSummary);
            fprintf(crashFile, "ptmxStatSummary: %s\n", g_crashContext.ptmxStatSummary);
            fflush(crashFile);
            fsync(fileno(crashFile));
            fclose(crashFile);
        }

        // Ensure all logs are flushed
        FileLogger::instance().fsyncLatest();

        // Trigger intentional crash for debugging
        OH_LOG_FATAL(LOG_APP, "PTY_DIAG: Triggering intentional abort() for crash diagnostics. "
            "Magic=0x%{public}016llX failedStep=%{public}s errno=%{public}d",
            (unsigned long long)PTY_CRASH_MAGIC, stepName(result.failedStep), result.errno_);

        abort();
    }

    // Generate report path
    FileLogger::instance().createReport(result, result.reportPath, sizeof(result.reportPath));

    // Rotate logs if needed
    FileLogger::instance().rotate();
}

// ── Shell control test (no PTY) ───────────────────────────────────
void runShellControlTest(PtyTestResult& result) {
    memset(&result, 0, sizeof(result));
    result.testId = static_cast<int>(time(nullptr)) * 1000 + (getpid() % 1000) + 1;
    result.success = true;
    result.crashOnFailure = false;
    result.masterFd = -1;
    result.slaveFd = -1;

    int64_t testStartUs = timeNowUs();
    getTimestamp(result.startedAt, sizeof(result.startedAt));

    int pipeStdout[2] = {-1, -1};
    int pipeStderr[2] = {-1, -1};
    pid_t childPid = -1;
    char shellOutput[4096] = {};
    char shellError[4096] = {};
    int totalOut = 0, totalErr = 0;
    bool childExited = false;
    int exitStatus = -1;
    int exitSignal = -1;

    do {
        // Step: pipe() stdout
        int64_t stepStart = timeNowUs();
        errno = 0;
        int ret = pipe(pipeStdout);
        int savedErrno = errno;
        char detail[512];
        snprintf(detail, sizeof(detail), "pipe(stdout): fds=[%d,%d]", pipeStdout[0], pipeStdout[1]);
        bool pipeOk = doStep(result, PtyTestStep::PRECHECK, ret, savedErrno, detail, stepStart, true);
        if (!pipeOk) break;

        // Step: pipe() stderr
        stepStart = timeNowUs();
        errno = 0;
        ret = pipe(pipeStderr);
        savedErrno = errno;
        snprintf(detail, sizeof(detail), "pipe(stderr): fds=[%d,%d]", pipeStderr[0], pipeStderr[1]);
        pipeOk = doStep(result, PtyTestStep::PRECHECK, ret, savedErrno, detail, stepStart, true);
        if (!pipeOk) break;

        // Step: fork()
        stepStart = timeNowUs();
        errno = 0;
        childPid = fork();
        savedErrno = errno;
        if (childPid < 0) {
            snprintf(detail, sizeof(detail), "fork() failed: errno=%d (%s)", savedErrno, strerror(savedErrno));
            doStep(result, PtyTestStep::PRECHECK, -1, savedErrno, detail, stepStart, true);
            break;
        }

        if (childPid == 0) {
            // ── Child process ─────────────────────────────────────
            close(pipeStdout[0]);
            close(pipeStderr[0]);
            dup2(pipeStdout[1], STDOUT_FILENO);
            dup2(pipeStderr[1], STDERR_FILENO);
            close(pipeStdout[1]);
            close(pipeStderr[1]);

            const char* shellPaths[] = {"/bin/sh", "/system/bin/sh", nullptr};
            for (int i = 0; shellPaths[i]; i++) {
                execl(shellPaths[i], shellPaths[i], "-c", "echo SHELL_OK; id; pwd", nullptr);
            }
            _exit(127);
        }

        // ── Parent process ────────────────────────────────────────
        close(pipeStdout[1]);
        close(pipeStderr[1]);
        pipeStdout[1] = -1;
        pipeStderr[1] = -1;

        // Step: waitpid with timeout via poll
        stepStart = timeNowUs();
        int timeoutMs = 5000;
        auto waitStart = std::chrono::steady_clock::now();

        while (true) {
            auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - waitStart).count();
            if (elapsed >= timeoutMs) break;

            int wstatus;
            pid_t w = waitpid(childPid, &wstatus, WNOHANG);
            if (w == childPid) {
                childExited = true;
                if (WIFEXITED(wstatus)) exitStatus = WEXITSTATUS(wstatus);
                if (WIFSIGNALED(wstatus)) exitSignal = WTERMSIG(wstatus);
                break;
            } else if (w < 0 && errno != ECHILD) {
                break;
            }

            struct pollfd pfd;
            pfd.fd = pipeStdout[0];
            pfd.events = POLLIN;
            int pr = poll(&pfd, 1, 100);
            if (pr > 0 && (pfd.revents & POLLIN) && totalOut < (int)sizeof(shellOutput) - 1) {
                ssize_t n = read(pipeStdout[0], shellOutput + totalOut, sizeof(shellOutput) - 1 - totalOut);
                if (n > 0) totalOut += n;
                else if (n <= 0) break;
            }

            pfd.fd = pipeStderr[0];
            pfd.events = POLLIN;
            pr = poll(&pfd, 1, 100);
            if (pr > 0 && (pfd.revents & POLLIN) && totalErr < (int)sizeof(shellError) - 1) {
                ssize_t n = read(pipeStderr[0], shellError + totalErr, sizeof(shellError) - 1 - totalErr);
                if (n > 0) totalErr += n;
                else if (n <= 0) break;
            }

            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }

        shellOutput[totalOut] = '\0';
        shellError[totalErr] = '\0';

        snprintf(detail, sizeof(detail),
            "childPid=%d exited=%d exitStatus=%d exitSignal=%d stdout='%s' stderr='%s'",
            childPid, childExited, exitStatus, exitSignal, shellOutput, shellError);
        doStep(result, PtyTestStep::COMPLETED,
            (childExited && exitStatus == 0) ? 0 : -1, 0, detail, stepStart, false);

    } while (0);

    // ── Cleanup: close remaining pipe fds ─────────────────────────
    if (pipeStdout[0] >= 0) close(pipeStdout[0]);
    if (pipeStdout[1] >= 0) close(pipeStdout[1]);
    if (pipeStderr[0] >= 0) close(pipeStderr[0]);
    if (pipeStderr[1] >= 0) close(pipeStderr[1]);

    getTimestamp(result.finishedAt, sizeof(result.finishedAt));
    result.durationUs = timeNowUs() - testStartUs;
    FileLogger::instance().createReport(result, result.reportPath, sizeof(result.reportPath));
}

// ── forkpty test ───────────────────────────────────────────────────
// without step-by-step posix_openpt/grantpt/unlockpt.
void runForkptyTest(const PtyTestOptions& options, PtyTestResult& result) {
    memset(&result, 0, sizeof(result));
    result.testId = static_cast<int>(time(nullptr)) * 1000 + (getpid() % 1000) + 2;
    result.success = true;
    result.crashOnFailure = options.crashOnFailure;
    result.masterFd = -1;
    result.slaveFd = -1;

    int64_t testStartUs = timeNowUs();
    getTimestamp(result.startedAt, sizeof(result.startedAt));

    int fdCountBefore = countOpenFds();

    // Pre-test system state
    int64_t stepStart = timeNowUs();
    collectSystemState(result.stateBefore, options.collectMountInfo, options.collectSelinuxInfo);
    recordStep(result, PtyTestStep::COLLECT_SYSTEM_STATE, true, 0, 0,
        "Pre-test system state collected", stepStart);
    logKeySystemState(result.stateBefore);

    // ── forkpty() ──────────────────────────────────────────────
    stepStart = timeNowUs();
    struct winsize ws = { 24, 80, 0, 0 };
    int masterFd = -1;
    errno = 0;
    pid_t childPid = forkpty(&masterFd, nullptr, nullptr, &ws);
    int savedErrno = errno;

    char detail[512];
    if (childPid > 0) {
        // Parent: we have the PTY master
        result.masterFd = masterFd;
        snprintf(detail, sizeof(detail),
            "forkpty() OK: masterFd=%d childPid=%d rows=%d cols=%d",
            masterFd, childPid, ws.ws_row, ws.ws_col);
        doStep(result, PtyTestStep::POSIX_OPENPT, masterFd, savedErrno, detail, stepStart, true);

        // ── Verify master fd ────────────────────────────────────
        stepStart = timeNowUs();
        int isTty = isatty(masterFd);
        errno = 0;
        int tcgRet = tcgetattr(masterFd, nullptr); // just probe
        savedErrno = errno;
        snprintf(detail, sizeof(detail),
            "isatty(master)=%d tcgetattr_probe=%d", isTty, tcgRet);
        doStep(result, PtyTestStep::TCGETATTR_MASTER,
            isTty ? 0 : -1, savedErrno, detail, stepStart, false);

        // ── Write test ──────────────────────────────────────────
        if (options.performReadWriteTest) {
            stepStart = timeNowUs();
            const char* msg = "HELLO_FROM_FORKPTY";
            ssize_t w = write(masterFd, msg, strlen(msg));
            savedErrno = errno;
            snprintf(detail, sizeof(detail), "write(master) ret=%zd", w);
            doStep(result, PtyTestStep::WRITE_MASTER,
                w > 0 ? 0 : -1, savedErrno, detail, stepStart, false);
        }

        // ── Close master fd ─────────────────────────────────────
        stepStart = timeNowUs();
        errno = 0;
        int closeRet = close(masterFd);
        savedErrno = errno;
        snprintf(detail, sizeof(detail), "close(masterFd=%d) ret=%d", masterFd, closeRet);
        doStep(result, PtyTestStep::CLOSE_MASTER, closeRet, savedErrno, detail, stepStart, false);
        result.masterFd = -1;

        // Kill child (SIGTERM)
        kill(childPid, SIGTERM);
        // Non-blocking wait to reap zombie
        int wstatus;
        waitpid(childPid, &wstatus, WNOHANG);

    } else if (childPid == 0) {
        // Child: we shouldn't reach here in a test — forkpty child
        // would normally exec a shell, but we just exit immediately
        // since this is a pure PTY-open test
        _exit(0);
    } else {
        // forkpty failed
        snprintf(detail, sizeof(detail),
            "forkpty() failed: errno=%d (%s)", savedErrno, strerror(savedErrno));
        doStep(result, PtyTestStep::POSIX_OPENPT, -1, savedErrno, detail, stepStart, true);
    }

    // ── FD leak check ───────────────────────────────────────────
    stepStart = timeNowUs();
    int fdCountAfter = countOpenFds();
    int fdDelta = fdCountAfter - fdCountBefore;
    snprintf(detail, sizeof(detail), "before=%d after=%d delta=%d",
        fdCountBefore, fdCountAfter, fdDelta);
    doStep(result, PtyTestStep::FD_LEAK_CHECK, fdDelta == 0 ? 0 : -1, 0, detail, stepStart, false);

    // ── Post-test system state ──────────────────────────────────
    stepStart = timeNowUs();
    collectSystemState(result.stateAfter, options.collectMountInfo, options.collectSelinuxInfo);
    recordStep(result, PtyTestStep::COLLECT_SYSTEM_STATE, true, 0, 0,
        "Post-test system state collected", stepStart);

    getTimestamp(result.finishedAt, sizeof(result.finishedAt));
    result.durationUs = timeNowUs() - testStartUs;

    // Handle crash mode
    if (!result.success && options.crashOnFailure) {
        fillCrashContext(result);
        OH_LOG_FATAL(LOG_APP, "CRASH_CONTEXT magic=0x%{public}016llX testId=%{public}d "
            "failedStep=%{public}s errno=%{public}d msg=%{public}s",
            (unsigned long long)g_crashContext.magic, g_crashContext.testId,
            g_crashContext.failedStepName, g_crashContext.savedErrno,
            g_crashContext.errnoMessage);
        FILE* crashFile = fopen(FileLogger::instance().crashLogPath(), "w");
        if (crashFile) {
            fprintf(crashFile, "=== PTY Crash Context (forkpty) ===\n");
            fprintf(crashFile, "magic: 0x%016llX\n", (unsigned long long)g_crashContext.magic);
            fprintf(crashFile, "testId: %d\n", g_crashContext.testId);
            fprintf(crashFile, "failedStep: %d (%s)\n", g_crashContext.failedStep, g_crashContext.failedStepName);
            fprintf(crashFile, "savedErrno: %d (%s)\n", g_crashContext.savedErrno, g_crashContext.errnoMessage);
            fflush(crashFile);
            fsync(fileno(crashFile));
            fclose(crashFile);
        }
        FileLogger::instance().fsyncLatest();
        OH_LOG_FATAL(LOG_APP, "PTY_DIAG: Triggering intentional abort() for forkpty crash diagnostics. "
            "Magic=0x%{public}016llX failedStep=%{public}s errno=%{public}d",
            (unsigned long long)PTY_CRASH_MAGIC, stepName(result.failedStep), result.errno_);
        abort();
    }

    FileLogger::instance().createReport(result, result.reportPath, sizeof(result.reportPath));
    FileLogger::instance().rotate();
}

// ── Recovery test: after parent PTY failure, can a child process
//    use forkpty()? This identifies whether failure is per-process
//    (SELinux domain degradation) or system-wide. ──────────────────
void runRecoveryTest(PtyTestResult& result) {
    memset(&result, 0, sizeof(result));
    result.testId = static_cast<int>(time(nullptr)) * 1000 + (getpid() % 1000) + 3;
    result.success = true;
    result.crashOnFailure = false;
    result.masterFd = -1;
    result.slaveFd = -1;

    int64_t testStartUs = timeNowUs();
    getTimestamp(result.startedAt, sizeof(result.startedAt));

    // Phase 1: Collect pre-test system state (full)
    int64_t stepStart = timeNowUs();
    collectSystemState(result.stateBefore, true, true);
    recordStep(result, PtyTestStep::COLLECT_SYSTEM_STATE, true, 0, 0,
        "Pre-test system state (full: mount+selinux)", stepStart);

    // Phase 2: Try PTY in parent
    stepStart = timeNowUs();
    errno = 0;
    int parentFd = posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC);
    int savedErrno = errno;
    char detail[512];
    if (parentFd >= 0) {
        snprintf(detail, sizeof(detail),
            "Parent posix_openpt() OK: fd=%d — PTY still working", parentFd);
        doStep(result, PtyTestStep::POSIX_OPENPT, parentFd, savedErrno, detail, stepStart, true);
        close(parentFd);
    } else {
        snprintf(detail, sizeof(detail),
            "Parent posix_openpt() FAIL: errno=%d (%s) — PTY access lost in parent process",
            savedErrno, strerror(savedErrno));
        doStep(result, PtyTestStep::POSIX_OPENPT, -1, savedErrno, detail, stepStart, true);

        // Phase 3: Try forkpty() in child process — does a new process recover?
        stepStart = timeNowUs();
        int pipeFd[2] = {-1, -1};
        pid_t child = -1;
        char childBuf[16] = {};
        int totalWait = 0;
        int childErrno = 0;
        bool childSuccess = false;
        int childMaster = -1;
        pid_t grandchildPid = -1;

        do {
            errno = 0;
            if (pipe(pipeFd) < 0) {
                savedErrno = errno;
                snprintf(detail, sizeof(detail), "pipe() failed: errno=%d", savedErrno);
                doStep(result, PtyTestStep::CHILD_FORKPTY_RECOVERY, -1, savedErrno, detail, stepStart, false);
                break;
            }

            errno = 0;
            child = fork();
            savedErrno = errno;
            if (child < 0) {
                snprintf(detail, sizeof(detail), "fork() failed: errno=%d", savedErrno);
                doStep(result, PtyTestStep::CHILD_FORKPTY_RECOVERY, -1, savedErrno, detail, stepStart, false);
                break;
            }

            if (child == 0) {
                // ── Child: try forkpty() ─────────────────────────
                close(pipeFd[0]);
                int localMaster = -1;
                errno = 0;
                pid_t grandchild = forkpty(&localMaster, nullptr, nullptr, nullptr);
                int localErrno = errno;

                char cbuf[16] = {};
                cbuf[0] = (char)(localErrno & 0xFF);
                if (localMaster >= 0) {
                    cbuf[1] = 1;
                    memcpy(cbuf + 2, &localMaster, sizeof(int));
                }
                memcpy(cbuf + 6, &grandchild, sizeof(pid_t));
                write(pipeFd[1], cbuf, sizeof(cbuf));
                close(pipeFd[1]);

                if (localMaster >= 0) close(localMaster);
                if (grandchild > 0) {
                    kill(grandchild, SIGTERM);
                    int wstatus;
                    waitpid(grandchild, &wstatus, WNOHANG);
                }
                _exit(0);
            }

            // ── Parent: read child result ────────────────────────
            close(pipeFd[1]);
            pipeFd[1] = -1;
            while (totalWait < 3000) {
                struct pollfd pfd;
                pfd.fd = pipeFd[0];
                pfd.events = POLLIN;
                int pr = poll(&pfd, 1, 100);
                if (pr > 0) {
                    ssize_t n = read(pipeFd[0], childBuf, sizeof(childBuf));
                    if (n > 0) break;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
                totalWait += 50;
            }

            childErrno = (unsigned char)childBuf[0];
            childSuccess = (childBuf[1] == 1);
            memcpy(&childMaster, childBuf + 2, sizeof(int));
            memcpy(&grandchildPid, childBuf + 6, sizeof(pid_t));

            if (childSuccess) {
                snprintf(detail, sizeof(detail),
                    "CHILD forkpty() OK: masterFd=%d grandchildPid=%d — "
                    "NEW PROCESS RECOVERS PTY ACCESS! Parent lost it, child works.",
                    childMaster, grandchildPid);
                doStep(result, PtyTestStep::CHILD_FORKPTY_RECOVERY, 0, 0, detail, stepStart, false);
            } else {
                snprintf(detail, sizeof(detail),
                    "CHILD forkpty() FAIL: errno=%d (%s) — "
                    "PTY loss is SYSTEM-WIDE, not per-process.",
                    childErrno, strerror(childErrno));
                doStep(result, PtyTestStep::CHILD_FORKPTY_RECOVERY, -1, childErrno, detail, stepStart, false);
            }
        } while (0);

        // Reap child if still running
        if (child > 0) {
            int wstatus;
            waitpid(child, &wstatus, WNOHANG);
        }
        if (pipeFd[0] >= 0) close(pipeFd[0]);
        if (pipeFd[1] >= 0) close(pipeFd[1]);
    }

    getTimestamp(result.finishedAt, sizeof(result.finishedAt));
    result.durationUs = timeNowUs() - testStartUs;
    FileLogger::instance().createReport(result, result.reportPath, sizeof(result.reportPath));
}

// ── /dev/ptmx attribute check (without opening) ────────────────────
// This replicates the "zsh can execute but ls fails" pattern:
// check if we can stat/access the node without actually opening it.
void checkPtmxAttributes(PtmxAttrResult& attr) {
    memset(&attr, 0, sizeof(attr));

    attr.fdCount = countOpenFds();

    // access checks
    attr.pathExists = (access("/dev/ptmx", F_OK) == 0);
    attr.accessR = access("/dev/ptmx", R_OK);
    attr.accessW = access("/dev/ptmx", W_OK);
    attr.accessX = access("/dev/ptmx", X_OK);

    // stat
    struct stat st;
    errno = 0;
    attr.statRet = stat("/dev/ptmx", &st);
    attr.statErrno = errno;
    if (attr.statRet == 0) {
        snprintf(attr.statDetail, sizeof(attr.statDetail),
            "mode=%o uid=%d gid=%d dev=%lu rdev=%lu ino=%lu size=%ld",
            st.st_mode, st.st_uid, st.st_gid,
            (unsigned long)st.st_dev, (unsigned long)st.st_rdev,
            (unsigned long)st.st_ino, (long)st.st_size);
    } else {
        snprintf(attr.statDetail, sizeof(attr.statDetail),
            "FAIL: errno=%d (%s)", attr.statErrno, strerror(attr.statErrno));
    }

    // lstat
    struct stat lst;
    errno = 0;
    attr.lstatRet = lstat("/dev/ptmx", &lst);
    attr.lstatErrno = errno;
    if (attr.lstatRet == 0) {
        snprintf(attr.lstatDetail, sizeof(attr.lstatDetail),
            "mode=%o uid=%d gid=%d dev=%lu rdev=%lu ino=%lu size=%ld",
            lst.st_mode, lst.st_uid, lst.st_gid,
            (unsigned long)lst.st_dev, (unsigned long)lst.st_rdev,
            (unsigned long)lst.st_ino, (long)lst.st_size);
    } else {
        snprintf(attr.lstatDetail, sizeof(attr.lstatDetail),
            "FAIL: errno=%d (%s)", attr.lstatErrno, strerror(attr.lstatErrno));
    }

    // readlink
    errno = 0;
    ssize_t rl = readlink("/dev/ptmx", attr.readlinkResult, sizeof(attr.readlinkResult) - 1);
    if (rl >= 0) attr.readlinkResult[rl] = '\0';
    else snprintf(attr.readlinkResult, sizeof(attr.readlinkResult),
             "(readlink failed: errno=%d)", errno);

    // test open (immediate close)
    errno = 0;
    attr.openRet = open("/dev/ptmx", O_RDWR | O_NOCTTY | O_CLOEXEC);
    attr.openErrno = errno;
    if (attr.openRet >= 0) close(attr.openRet);

    // mountinfo extract: devpts and /dev lines
    char rawMountInfo[8192];
    int len = readFile("/proc/self/mountinfo", rawMountInfo, sizeof(rawMountInfo));
    if (len > 0) {
        // Extract lines containing "devpts" or " /dev "
        char* saveptr;
        char* line = strtok_r(rawMountInfo, "\n", &saveptr);
        char* devPtr = attr.mountInfoDev;
        char* ptsPtr = attr.mountInfoDevPts;
        size_t devRemain = sizeof(attr.mountInfoDev) - 1;
        size_t ptsRemain = sizeof(attr.mountInfoDevPts) - 1;
        while (line) {
            if (strstr(line, " /dev ") || strstr(line, "devpts")) {
                size_t n = strlen(line);
                if (strstr(line, "devpts")) {
                    if (ptsRemain > n) {
                        int w = snprintf(ptsPtr, ptsRemain, "%s\n", line);
                        ptsPtr += w; ptsRemain -= w;
                    }
                } else {
                    if (devRemain > n) {
                        int w = snprintf(devPtr, devRemain, "%s\n", line);
                        devPtr += w; devRemain -= w;
                    }
                }
            }
            line = strtok_r(nullptr, "\n", &saveptr);
        }
    }

    // SELinux
    readFileToBuf("/proc/self/attr/current", attr.selinuxContext, sizeof(attr.selinuxContext));
}

// ── Batch open/close test ──────────────────────────────────────────
void runBatchOpenTest(int count, int intervalMs, bool closeBetween, bool parallel,
                      PtyTestResult& result, BatchOpenResult& batch) {
    memset(&batch, 0, sizeof(batch));
    batch.totalCount = count;
    batch.firstFailureIndex = -1;

    if (!g_logInitialized) FileLogger::instance().init("/data/storage/el2/base/haps/entry/files");

    OH_LOG_INFO(LOG_APP, "PTY_DIAG BATCH START: count=%{public}d intervalMs=%{public}d close=%{public}d parallel=%{public}d",
        count, intervalMs, closeBetween, parallel);
    FileLogger::instance().log("INFO", "BATCH START: count=%d intervalMs=%d close=%d parallel=%d",
        count, intervalMs, closeBetween, parallel);

    int fdCountBefore = countOpenFds();
    int64_t totalStart = timeNowUs();

    for (int i = 0; i < count && !g_continuousState.running.load(); i++) {
        int64_t stepStart = timeNowUs();

        // If not parallel, open one at a time; if parallel, open all concurrently
        // For parallel mode we just don't close until the end
        errno = 0;
        int fd = posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC);
        int savedErrno = errno;

        if (fd >= 0) {
            batch.successCount++;
            batch.lastSuccessFd = fd;
            if (batch.firstFailureIndex < 0) batch.consecutiveSuccesses++;

            if (closeBetween && !parallel) {
                close(fd);
            }
            // In parallel mode, we leave all fds open; close them at end
        } else {
            batch.failureCount++;
            if (batch.firstFailureIndex < 0) {
                batch.firstFailureIndex = i;
                batch.firstFailureErrno = savedErrno;
                batch.consecutiveFailures = 1;
            } else {
                batch.consecutiveFailures++;
            }
            // On first failure, stop if we're doing sequential (non-parallel) test
            if (!parallel) break;
        }

        int64_t dur = timeNowUs() - stepStart;
        batch.totalDurationUs += dur;
        batch.avgOpenUs = batch.totalDurationUs / (i + 1);

        OH_LOG_INFO(LOG_APP, "PTY_DIAG batch[%{public}d/%{public}d] fd=%{public}d errno=%{public}d dur=%{public}lldus",
            i + 1, count, fd, savedErrno, (long long)dur);
        FileLogger::instance().log(fd >= 0 ? "INFO" : "ERROR",
            "BATCH[%d/%d] fd=%d errno=%d dur=%lldus",
            i + 1, count, fd, savedErrno, (long long)dur);

        // Interval between opens (unless interrupted)
        if (intervalMs > 0 && i < count - 1) {
            auto endTime = std::chrono::steady_clock::now() + std::chrono::milliseconds(intervalMs);
            while (std::chrono::steady_clock::now() < endTime) {
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            }
        }
    }

    // Check fd leak
    int fdCountAfter = countOpenFds();
    batch.fdLeak = fdCountAfter - fdCountBefore;

    FileLogger::instance().log("INFO", "BATCH END: total=%d ok=%d fail=%d firstFailIdx=%d firstFailErrno=%d consecOk=%d consecFail=%d fdLeak=%d",
        count, batch.successCount, batch.failureCount,
        batch.firstFailureIndex, batch.firstFailureErrno,
        batch.consecutiveSuccesses, batch.consecutiveFailures, batch.fdLeak);
    OH_LOG_INFO(LOG_APP, "PTY_DIAG BATCH END: total=%{public}d ok=%{public}d fail=%{public}d",
        count, batch.successCount, batch.failureCount);
    FileLogger::instance().flush();
}

// ── Hold-open test ─────────────────────────────────────────────────
void runHoldOpenTest(int holdSeconds, PtyTestResult& result, HoldOpenResult& hold) {
    memset(&hold, 0, sizeof(hold));
    hold.fd = -1;
    hold.holdSeconds = holdSeconds;

    // Open
    errno = 0;
    hold.fd = posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC);
    hold.openErrno = errno;
    hold.openSuccess = (hold.fd >= 0);

    OH_LOG_INFO(LOG_APP, "PTY_DIAG hold-open start: fd=%{public}d errno=%{public}d holdSec=%{public}d",
        hold.fd, hold.openErrno, holdSeconds);

    if (!hold.openSuccess) {
        hold.stillValidAtEnd = false;
        return;
    }

    // Hold and periodically check (0 = forever, until interrupted)
    int maxSec = (holdSeconds > 0) ? holdSeconds : 2147483647;
    for (int sec = 0; sec < maxSec; sec++) {
        // Check if still valid
        hold.checkCount++;
        struct termios t;
        errno = 0;
        int ret = tcgetattr(hold.fd, &t);

        if (ret < 0) {
            int savedErrno = errno;
            hold.checkFailures++;
            if (hold.firstCheckFailureAtSec == 0) {
                hold.firstCheckFailureAtSec = sec;
                OH_LOG_WARN(LOG_APP, "PTY_DIAG hold-open fd=%{public}d became invalid at sec=%{public}d errno=%{public}d",
                    hold.fd, sec, savedErrno);
            }
        }

        // Check if interrupted
        if (!g_continuousState.running.load()) {
            hold.interrupted = true;
            OH_LOG_INFO(LOG_APP, "PTY_DIAG hold-open interrupted at sec=%{public}d", sec);
            break;
        }

        std::this_thread::sleep_for(std::chrono::seconds(1));
    }

    // Final check
    struct termios t2;
    errno = 0;
    hold.stillValidAtEnd = (tcgetattr(hold.fd, &t2) == 0);

    // Close
    if (hold.fd >= 0) {
        close(hold.fd);
        hold.fd = -1;
    }

    OH_LOG_INFO(LOG_APP, "PTY_DIAG hold-open done: held=%{public}d interrupted=%{public}d "
        "stillValid=%{public}d checks=%{public}d failures=%{public}d firstFailAt=%{public}d",
        holdSeconds, hold.interrupted, hold.stillValidAtEnd,
        hold.checkCount, hold.checkFailures, hold.firstCheckFailureAtSec);
}

// ══════════════════════════════════════════════════════════════════
// SHA-256 minimal implementation (public domain, FIPS 180-4)
// ══════════════════════════════════════════════════════════════════
#include <cinttypes>

static const uint32_t SHA256_K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cd3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

static inline uint32_t rotr32(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }
static inline uint32_t bswap32(uint32_t x) {
    return ((x & 0xFF) << 24) | ((x & 0xFF00) << 8) | ((x & 0xFF0000) >> 8) | ((x & 0xFF000000) >> 24);
}

static void sha256Transform(uint32_t state[8], const unsigned char block[64]) {
    uint32_t w[64];
    for (int i = 0; i < 16; i++) w[i] = bswap32(((uint32_t*)block)[i]);
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = rotr32(w[i-15], 7) ^ rotr32(w[i-15], 18) ^ (w[i-15] >> 3);
        uint32_t s1 = rotr32(w[i-2], 17) ^ rotr32(w[i-2], 19) ^ (w[i-2] >> 10);
        w[i] = w[i-16] + s0 + w[i-7] + s1;
    }
    uint32_t a=state[0], b=state[1], c=state[2], d=state[3], e=state[4], f=state[5], g=state[6], h=state[7];
    for (int i = 0; i < 64; i++) {
        uint32_t S1 = rotr32(e,6) ^ rotr32(e,11) ^ rotr32(e,25);
        uint32_t ch = (e&f) ^ (~e&g);
        uint32_t t1 = h + S1 + ch + SHA256_K[i] + w[i];
        uint32_t S0 = rotr32(a,2) ^ rotr32(a,13) ^ rotr32(a,22);
        uint32_t maj = (a&b) ^ (a&c) ^ (b&c);
        h=g; g=f; f=e; e=d+t1; d=c; c=b; b=a; a=t1+S0;
    }
    state[0]+=a; state[1]+=b; state[2]+=c; state[3]+=d;
    state[4]+=e; state[5]+=f; state[6]+=g; state[7]+=h;
}

static bool sha256File(const char* path, char outHex[65]) {
    int fd = open(path, O_RDONLY);
    if (fd < 0) return false;
    uint32_t state[8] = {0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
    unsigned char buf[64]; ssize_t n; uint64_t bits=0; int pos=0;
    while ((n=read(fd, buf+pos, 64-pos))>0) { bits+=n*8; pos+=n; if(pos==64){sha256Transform(state,buf); pos=0;} }
    close(fd);
    buf[pos++]=0x80; if(pos>56){memset(buf+pos,0,64-pos); sha256Transform(state,buf); pos=0;}
    memset(buf+pos,0,56-pos); ((uint64_t*)(buf+56))[0]=bswap32((uint32_t)(bits>>32));
    ((uint32_t*)(buf+60))[0]=bswap32((uint32_t)bits); sha256Transform(state,buf);
    for(int i=0;i<8;i++) snprintf(outHex+i*8,9,"%08x",state[i]); outHex[64]=0;
    return true;
}

// ── Check if ELF has .codesign section ──────────────────────────────
static bool hasCodesignSection(const char* path) {
    int fd = open(path, O_RDONLY);
    if (fd < 0) return false;
    unsigned char e_ident[64];
    if (read(fd, e_ident, 64) < 64) { close(fd); return false; }
    if (memcmp(e_ident, "\x7f""ELF", 4) != 0) { close(fd); return false; }
    lseek(fd, 0, SEEK_SET);
    char buf[65536];
    ssize_t total = read(fd, buf, sizeof(buf));
    close(fd);
    for (ssize_t i = 0; i < total - 8; i++) {
        if (memcmp(buf + i, ".codesign", 9) == 0) return true;
    }
    return false;
}

// ── Run a single ELF exec test ──────────────────────────────────────
void runElfExecTest(const char* sourceLabel, const char* expectedSign, const char* filePath,
                    ElfExecResult& elfResult) {
    memset(&elfResult, 0, sizeof(elfResult));

    // Ensure logger is initialized (fallback)
    if (!g_logInitialized) {
        FileLogger::instance().init("/data/storage/el2/base/haps/entry/files");
    }
    strncpy(elfResult.source, sourceLabel, sizeof(elfResult.source)-1);
    strncpy(elfResult.expectedSignState, expectedSign, sizeof(elfResult.expectedSignState)-1);
    strncpy(elfResult.filePath, filePath, sizeof(elfResult.filePath)-1);
    sha256File(filePath, elfResult.sha256);
    elfResult.hasCodesignSection = hasCodesignSection(filePath);
    errno = 0;
    elfResult.chmodRet = chmod(filePath, 0755);
    elfResult.chmodErrno = errno;
    OH_LOG_INFO(LOG_APP, "ELF test [%{public}s] path=%{public}s sha256=%{public}s codesign=%{public}d chmod=%{public}d",
        sourceLabel, filePath, elfResult.sha256, elfResult.hasCodesignSection, elfResult.chmodRet);

    int pipeOut[2], pipeErr[2];
    if (pipe(pipeOut) < 0 || pipe(pipeErr) < 0) {
        snprintf(elfResult.execveMsg, sizeof(elfResult.execveMsg), "pipe() failed: %s", strerror(errno));
        return;
    }
    errno = 0;
    pid_t child = fork();
    if (child < 0) {
        elfResult.execveErrno = errno;
        snprintf(elfResult.execveMsg, sizeof(elfResult.execveMsg), "fork() failed: %s", strerror(errno));
        close(pipeOut[0]); close(pipeOut[1]); close(pipeErr[0]); close(pipeErr[1]);
        return;
    }
    if (child == 0) {
        close(pipeOut[0]); close(pipeErr[0]);
        dup2(pipeOut[1], STDOUT_FILENO);
        dup2(pipeErr[1], STDERR_FILENO);
        close(pipeOut[1]); close(pipeErr[1]);
        setenv("ELF_TEST_SOURCE", sourceLabel, 1);
        execl(filePath, filePath, nullptr);
        int err = errno;
        fprintf(stderr, "EXECVE_FAILED: errno=%d (%s)\n", err, strerror(err));
        fflush(stderr);
        _exit(127);
    }
    close(pipeOut[1]); close(pipeErr[1]);
    auto start = std::chrono::steady_clock::now();
    int totalOut=0, totalErr=0, timeoutMs=10000;
    bool exited=false; int wstatus=0;
    while (true) {
        auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-start).count();
        if (elapsed >= timeoutMs) break;
        pid_t w = waitpid(child, &wstatus, WNOHANG);
        if (w == child) { exited = true; break; }
        struct pollfd pfd;
        pfd.fd = pipeOut[0]; pfd.events = POLLIN;
        if (poll(&pfd,1,100)>0 && (pfd.revents&POLLIN)) {
            ssize_t n = read(pipeOut[0], elfResult.stdout_+totalOut, sizeof(elfResult.stdout_)-1-totalOut);
            if (n>0) totalOut+=n;
        }
        pfd.fd = pipeErr[0];
        if (poll(&pfd,1,0)>0 && (pfd.revents&POLLIN)) {
            ssize_t n = read(pipeErr[0], elfResult.stderr_+totalErr, sizeof(elfResult.stderr_)-1-totalErr);
            if (n>0) totalErr+=n;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(30));
    }
    close(pipeOut[0]); close(pipeErr[0]);
    if (exited) {
        if (WIFEXITED(wstatus)) {
            elfResult.exitCode = WEXITSTATUS(wstatus);
            if (elfResult.exitCode == 127 && strstr(elfResult.stderr_, "EXECVE_FAILED")) {
                const char* p = strstr(elfResult.stderr_, "errno=");
                if (p) elfResult.execveErrno = atoi(p+6);
                snprintf(elfResult.execveMsg, sizeof(elfResult.execveMsg), "execve failed: errno=%d (%s)", elfResult.execveErrno, strerror(elfResult.execveErrno));
                elfResult.execveRet = -1;
            } else if (elfResult.exitCode == 0) {
                snprintf(elfResult.execveMsg, sizeof(elfResult.execveMsg), "execve OK, exitCode=0");
                elfResult.execveRet = 0;
            } else {
                snprintf(elfResult.execveMsg, sizeof(elfResult.execveMsg), "exitCode=%d", elfResult.exitCode);
                elfResult.execveRet = elfResult.exitCode;
            }
        } else if (WIFSIGNALED(wstatus)) {
            elfResult.exitSignal = WTERMSIG(wstatus);
            snprintf(elfResult.execveMsg, sizeof(elfResult.execveMsg), "killed by signal %d", elfResult.exitSignal);
            elfResult.execveRet = -elfResult.exitSignal;
        }
    } else {
        kill(child, SIGKILL); waitpid(child, &wstatus, 0);
        snprintf(elfResult.execveMsg, sizeof(elfResult.execveMsg), "timeout (10s)");
        elfResult.execveRet = -1; elfResult.execveErrno = ETIMEDOUT;
    }
    // Conclusion: HELLO_ELF_OK in stdout = success, regardless of exit signal
    if (totalOut > 0 && strstr(elfResult.stdout_, "HELLO_ELF_OK")) {
        snprintf(elfResult.conclusion, sizeof(elfResult.conclusion), "SUCCESS: ELF executed OK. Sign=%s codesign=%d",
            expectedSign, elfResult.hasCodesignSection);
        elfResult.execveRet = 0;

    } else if (elfResult.execveErrno == EACCES || elfResult.execveErrno == EPERM) {
        snprintf(elfResult.conclusion, sizeof(elfResult.conclusion), "BLOCKED: %s. Sign=%s codesign=%d",
            strerror(elfResult.execveErrno), expectedSign, elfResult.hasCodesignSection);
    } else if (elfResult.execveErrno == ENOEXEC) {
        snprintf(elfResult.conclusion, sizeof(elfResult.conclusion), "INVALID: ENOEXEC. codesign=%d", elfResult.hasCodesignSection);
    } else {
        snprintf(elfResult.conclusion, sizeof(elfResult.conclusion), "UNEXPECTED: ret=%d errno=%d exit=%d. Sign=%s codesign=%d",
            elfResult.execveRet, elfResult.execveErrno, elfResult.exitCode, expectedSign, elfResult.hasCodesignSection);
    }
    OH_LOG_INFO(LOG_APP, "ELF test [%{public}s] conclusion: %{public}s", sourceLabel, elfResult.conclusion);

    // Write to file log
    FileLogger::instance().log("INFO", "ELF exec [%s] sha256=%s codesign=%d chmod=%d execRet=%d execErrno=%d exit=%d signal=%d conc=%s",
        elfResult.source, elfResult.sha256, elfResult.hasCodesignSection,
        elfResult.chmodRet, elfResult.execveRet, elfResult.execveErrno,
        elfResult.exitCode, elfResult.exitSignal, elfResult.conclusion);
    if (elfResult.stdout_[0])
        FileLogger::instance().log("INFO", "ELF stdout [%s]: %s", elfResult.source, elfResult.stdout_);
    if (elfResult.stderr_[0])
        FileLogger::instance().log("INFO", "ELF stderr [%s]: %s", elfResult.source, elfResult.stderr_);
    FileLogger::instance().flush();
}

// ── Run all 4 ELF tests ────────────────────────────────────────────
void runAllElfTests(const char* rawfileDir, AllElfResults& all) {
    memset(&all, 0, sizeof(all));
    all.testCount = 4;
    char path[512];
    snprintf(path, sizeof(path), "%s/hello-signed", rawfileDir);
    runElfExecTest("rawfile-signed", "signed", path, all.tests[0]);
    snprintf(path, sizeof(path), "%s/hello-unsigned", rawfileDir);
    runElfExecTest("rawfile-unsigned", "unsigned", path, all.tests[1]);
    snprintf(path, sizeof(path), "%s/imported-signed", rawfileDir);
    runElfExecTest("imported-signed", "signed", path, all.tests[2]);
    snprintf(path, sizeof(path), "%s/imported-unsigned", rawfileDir);
    runElfExecTest("imported-unsigned", "unsigned", path, all.tests[3]);
    int ok=0, blocked=0;
    for (int i=0; i<4; i++) {
        if (strstr(all.tests[i].conclusion, "SUCCESS")) ok++;
        else if (strstr(all.tests[i].conclusion, "BLOCKED")) blocked++;
    }
    snprintf(all.summary, sizeof(all.summary), "ELF tests: %d/4 OK, %d/4 BLOCKED", ok, blocked);
    FileLogger::instance().log("INFO", "=== ELF ALL TESTS: %s ===", all.summary);
    FileLogger::instance().flush();
}

// ══════════════════════════════════════════════════════════════════
// Abstract Unix Socket test — namespace isolation check
// ══════════════════════════════════════════════════════════════════

// ── Abstract Socket SERVER mode (hold open for external client) ────
// Implementation below after PtyTestWorkData definition
static napi_value runAbstractSocketServerNapi(napi_env env, napi_callback_info info);

// Describe the kernel-provided identity of a connected AF_UNIX peer.  This is
// deliberately kept in the demo so the result distinguishes kernel identity
// from the client-provided HELLO fields used by HAPI.
static bool describeUnixPeer(int fd, char* out, size_t outSize) {
    if (out == nullptr || outSize == 0) return false;
    out[0] = '\0';

#ifdef SO_PEERCRED
    struct ucred cred;
    socklen_t credLen = sizeof(cred);
    if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &credLen) != 0) {
        snprintf(out, outSize, "SO_PEERCRED_FAIL errno=%d (%s)", errno, strerror(errno));
        return false;
    }

    char exePath[512] = {};
    char procPath[64] = {};
    snprintf(procPath, sizeof(procPath), "/proc/%ld/exe", static_cast<long>(cred.pid));
    ssize_t exeLen = readlink(procPath, exePath, sizeof(exePath) - 1);
    if (exeLen >= 0) {
        exePath[exeLen] = '\0';
    } else {
        snprintf(exePath, sizeof(exePath), "<readlink failed errno=%d (%s)>", errno, strerror(errno));
    }

    snprintf(out, outSize, "peer_pid=%ld peer_uid=%ld peer_gid=%ld peer_exe=%s",
        static_cast<long>(cred.pid), static_cast<long>(cred.uid),
        static_cast<long>(cred.gid), exePath);
    return true;
#else
    snprintf(out, outSize, "SO_PEERCRED_UNAVAILABLE");
    return false;
#endif
}

static void drainChildOutput(int fd, char* out, size_t outSize) {
    if (out == nullptr || outSize == 0) return;
    out[0] = '\0';
    if (fd < 0) return;
    size_t used = 0;
    while (used + 1 < outSize) {
        ssize_t n = read(fd, out + used, outSize - used - 1);
        if (n > 0) {
            used += static_cast<size_t>(n);
            continue;
        }
        if (n < 0 && errno == EINTR) continue;
        break;
    }
    out[used] = '\0';
}

static napi_value runAbstractSocketTestNapi(napi_env env, napi_callback_info info) {
    // Ensure logger
    if (!g_logInitialized) FileLogger::instance().init("/data/storage/el2/base/haps/entry/files");

    char result[8192] = {};
    int serverFd = -1, clientFd = -1;
    int childPipe[2] = {-1, -1};
    pid_t child = -1;
    bool childReaped = false;
    int childStatus = 0;
    char buf[512];

    do {
        // 1. Create server socket
        serverFd = socket(AF_UNIX, SOCK_STREAM, 0);
        if (serverFd < 0) {
            snprintf(result, sizeof(result), "socket() FAIL: errno=%d (%s)", errno, strerror(errno));
            break;
        }

        // 2. Bind to abstract address @pty_diag_test
        struct sockaddr_un addr;
        memset(&addr, 0, sizeof(addr));
        addr.sun_family = AF_UNIX;
        addr.sun_path[0] = '\0';
        strncpy(addr.sun_path + 1, "pty_diag_test", sizeof(addr.sun_path) - 2);
        socklen_t addrlen = offsetof(struct sockaddr_un, sun_path) + 1 + strlen("pty_diag_test");

        if (bind(serverFd, (struct sockaddr*)&addr, addrlen) < 0) {
            snprintf(result, sizeof(result), "bind() FAIL: errno=%d (%s)", errno, strerror(errno));
            break;
        }

        if (listen(serverFd, 1) < 0) {
            snprintf(result, sizeof(result), "listen() FAIL: errno=%d (%s)", errno, strerror(errno));
            break;
        }

        snprintf(result, sizeof(result), "SERVER: listening on @pty_diag_test (fd=%d)\n", serverFd);
        FileLogger::instance().log("INFO", "ABSTRACT: server listening fd=%d", serverFd);

        // 3. Fork child to run client ELF
        if (pipe(childPipe) != 0) {
            snprintf(buf, sizeof(buf), "PIPE_FAIL: errno=%d (%s)\n", errno, strerror(errno));
            strncat(result, buf, sizeof(result) - strlen(result) - 1);
            FileLogger::instance().log("ERROR", "ABSTRACT: client output pipe failed errno=%d (%s)", errno, strerror(errno));
            break;
        }

        child = fork();
        if (child < 0) {
            snprintf(buf, sizeof(buf), "FORK_FAIL: errno=%d", errno);
            strncat(result, buf, sizeof(result) - strlen(result) - 1);
            break;
        }

        if (child == 0) {
            close(childPipe[0]);
            dup2(childPipe[1], STDOUT_FILENO);
            dup2(childPipe[1], STDERR_FILENO);
            close(childPipe[1]);

            // Child: exec socket_client ELF
            char path[512];
            snprintf(path, sizeof(path), "%s/socket_client-unsigned", g_logDir);
            int chmodUnsigned = chmod(path, 0755);
            // Also try signed version
            char* argv[] = { (char*)"socket_client", nullptr };
            execv(path, argv);
            int unsignedErrno = errno;
            // Fallback: try signed
            snprintf(path, sizeof(path), "%s/socket_client-signed", g_logDir);
            int chmodSigned = chmod(path, 0755);
            execv(path, argv);
            int signedErrno = errno;
            // Both failed
            dprintf(STDERR_FILENO,
                "EXECVE_FAILED unsigned_errno=%d (%s) signed_errno=%d (%s) chmod_unsigned=%d chmod_signed=%d path=%s\n",
                unsignedErrno, strerror(unsignedErrno), signedErrno, strerror(signedErrno),
                chmodUnsigned, chmodSigned, path);
            _exit(127);
        }

        close(childPipe[1]);
        childPipe[1] = -1;
        FileLogger::instance().log("INFO", "ABSTRACT: client child started pid=%ld", static_cast<long>(child));

        // 4. Accept connection (timeout 3s)
        struct pollfd pfd;
        pfd.fd = serverFd;
        pfd.events = POLLIN;
        int pr = poll(&pfd, 1, 3000);
        int pollErrno = errno;
        FileLogger::instance().log("INFO", "ABSTRACT: poll result=%d errno=%d", pr, pr < 0 ? pollErrno : 0);
        if (pr <= 0) {
            snprintf(buf, sizeof(buf), "ACCEPT_TIMEOUT: poll=%d (no client connection within 3s)\n", pr);
            strncat(result, buf, sizeof(result) - strlen(result) - 1);
            kill(child, SIGKILL);
            if (waitpid(child, &childStatus, 0) == child) childReaped = true;
            break;
        }

        clientFd = accept(serverFd, nullptr, nullptr);
        if (clientFd < 0) {
            snprintf(buf, sizeof(buf), "ACCEPT_FAIL: errno=%d (%s)\n", errno, strerror(errno));
            strncat(result, buf, sizeof(result) - strlen(result) - 1);
            kill(child, SIGKILL);
            if (waitpid(child, &childStatus, 0) == child) childReaped = true;
            break;
        }

        // 5. Read kernel peer identity and client data, then reply
        char peerInfo[1024] = {};
        bool peerOk = describeUnixPeer(clientFd, peerInfo, sizeof(peerInfo));
        snprintf(buf, sizeof(buf), "PEER_CREDENTIALS: %s\n", peerInfo);
        strncat(result, buf, sizeof(result) - strlen(result) - 1);
        FileLogger::instance().log("INFO", "ABSTRACT: %s", peerInfo);

        ssize_t n = recv(clientFd, buf, sizeof(buf) - 1, 0);
        if (n > 0) {
            buf[n] = '\0';
            char received[768] = {};
            snprintf(received, sizeof(received), "SERVER_RECV: %s\n", buf);
            strncat(result, received, sizeof(result) - strlen(result) - 1);
            const char* reply = "ABSTRACT_OK_FROM_HAP";
            send(clientFd, reply, strlen(reply), 0);
        }

        // 6. Wait for client and check exit
        if (waitpid(child, &childStatus, 0) == child) childReaped = true;
        if (WIFEXITED(childStatus)) {
            snprintf(buf, sizeof(buf), "CLIENT_EXIT: code=%d\n", WEXITSTATUS(childStatus));
            strncat(result, buf, sizeof(result) - strlen(result) - 1);
        } else if (WIFSIGNALED(childStatus)) {
            snprintf(buf, sizeof(buf), "CLIENT_EXIT: signal=%d\n", WTERMSIG(childStatus));
            strncat(result, buf, sizeof(result) - strlen(result) - 1);
        }

        if (clientFd >= 0 && n > 0 && peerOk) {
            strncat(result, "CONCLUSION: AF_UNIX + SO_PEERCRED WORKS; kernel peer identity was obtained\n",
                sizeof(result) - strlen(result) - 1);
        } else {
            strncat(result, "CONCLUSION: AF_UNIX peer identity test FAILED — inspect PEER_CREDENTIALS and logs\n",
                sizeof(result) - strlen(result) - 1);
        }

    } while (0);

    if (child > 0 && !childReaped) {
        kill(child, SIGKILL);
        if (waitpid(child, &childStatus, 0) == child) childReaped = true;
    }
    if (childPipe[1] >= 0) close(childPipe[1]);
    if (childPipe[0] >= 0) {
        char childOutput[4096] = {};
        drainChildOutput(childPipe[0], childOutput, sizeof(childOutput));
        close(childPipe[0]);
        if (childOutput[0] != '\0') {
            FileLogger::instance().log("INFO", "ABSTRACT: client_output=%s", childOutput);
            strncat(result, "CLIENT_OUTPUT: ", sizeof(result) - strlen(result) - 1);
            strncat(result, childOutput, sizeof(result) - strlen(result) - 1);
            strncat(result, "\n", sizeof(result) - strlen(result) - 1);
        }
    }
    if (child > 0) {
        FileLogger::instance().log("INFO", "ABSTRACT: client child pid=%ld reaped=%d status=%d",
            static_cast<long>(child), childReaped ? 1 : 0, childStatus);
    }

    if (clientFd >= 0) close(clientFd);
    if (serverFd >= 0) close(serverFd);

    FileLogger::instance().log("INFO", "ABSTRACT: %s", result);
    FileLogger::instance().flush();

    napi_value ret;
    napi_create_string_utf8(env, result, NAPI_AUTO_LENGTH, &ret);
    return ret;
}

// ── Async work data ───────────────────────────────────────────────
struct PtyTestWorkData {
    napi_async_work work;
    napi_deferred deferred;
    PtyTestOptions options;
    PtyTestResult result;
    bool shellControlTest = false;
    bool forkptyTest = false;
    bool recoveryTest = false;
    bool attrCheckTest = false;
    bool batchOpenTest = false;
    bool holdOpenTest = false;
    bool elfAllTest = false;
    int elfTestIndex = -1;
    bool socketServerMode = false;
    // batch/hold params
    int batchCount;
    int batchIntervalMs;
    bool batchCloseBetween;
    bool batchParallel;
    int holdSeconds;
};

// ── Abstract Socket Server implementation ──────────────────────────
static napi_value runAbstractSocketServerNapi(napi_env env, napi_callback_info info) {
    auto* wd = new PtyTestWorkData();
    wd->socketServerMode = true;
    napi_value promise;
    napi_create_promise(env, &wd->deferred, &promise);
    napi_value resName;
    napi_create_string_utf8(env, "AbstractSocketServer", NAPI_AUTO_LENGTH, &resName);
    napi_create_async_work(env, nullptr, resName,
        [](napi_env, void* data) {
            auto* w = static_cast<PtyTestWorkData*>(data);
            if (!g_logInitialized) FileLogger::instance().init("/data/storage/el2/base/haps/entry/files");
            int fd = socket(AF_UNIX, SOCK_STREAM, 0);
            if (fd < 0) { snprintf(w->result.slavePath, sizeof(w->result.slavePath), "socket FAIL: errno=%d", errno); return; }
            struct sockaddr_un addr; memset(&addr, 0, sizeof(addr));
            addr.sun_family = AF_UNIX; addr.sun_path[0] = '\0';
            strncpy(addr.sun_path + 1, "pty_diag_test", sizeof(addr.sun_path) - 2);
            socklen_t alen = offsetof(struct sockaddr_un, sun_path) + 1 + strlen("pty_diag_test");
            if (bind(fd, (struct sockaddr*)&addr, alen) < 0 || listen(fd, 1) < 0) {
                snprintf(w->result.slavePath, sizeof(w->result.slavePath), "bind/listen FAIL: errno=%d", errno);
                close(fd); return;
            }
            FileLogger::instance().log("INFO", "ABSTRACT-SERVER: listening @pty_diag_test fd=%d", fd);
            FileLogger::instance().flush();
            struct pollfd pfd = {fd, POLLIN, 0};
            int pr = poll(&pfd, 1, 60000);
            int pe = errno;
            if (pr > 0) {
                int c = accept(fd, nullptr, nullptr);
                if (c >= 0) {
                    char peerInfo[1024] = {};
                    describeUnixPeer(c, peerInfo, sizeof(peerInfo));
                    FileLogger::instance().log("INFO", "ABSTRACT-SERVER: %s", peerInfo);
                    char b[256]={}; ssize_t n=recv(c,b,sizeof(b)-1,0);
                    if(n>0){b[n]=0;FileLogger::instance().log("INFO","ABSTRACT-SERVER: recv: %s",b);send(c,"ABSTRACT_OK_FROM_HAP",19,0);}
                    close(c);
                }
            }
            close(fd);
            snprintf(w->result.slavePath, sizeof(w->result.slavePath), "poll=%d errno=%d ELF=%s/socket_client-signed", pr, pe, g_logDir);
            FileLogger::instance().log("INFO", "ABSTRACT-SERVER: done poll=%d errno=%d", pr, pe);
            FileLogger::instance().flush();
        },
        [](napi_env env, napi_status, void* data) {
            auto* w = static_cast<PtyTestWorkData*>(data);
            napi_value r; napi_create_string_utf8(env, w->result.slavePath, NAPI_AUTO_LENGTH, &r);
            napi_resolve_deferred(env, w->deferred, r);
            napi_delete_async_work(env, w->work);
            delete w;
        }, wd, &wd->work);
    napi_queue_async_work(env, wd->work);
    return promise;
}

// ── File-based Unix Socket Server ──────────────────────────────────
static napi_value runFileSocketServerNapi(napi_env env, napi_callback_info info) {
    auto* wd = new PtyTestWorkData();
    napi_value promise; napi_create_promise(env, &wd->deferred, &promise);
    napi_value rn; napi_create_string_utf8(env, "FileSocket", NAPI_AUTO_LENGTH, &rn);
    napi_create_async_work(env, nullptr, rn,
        [](napi_env, void* d) {
            auto* w = static_cast<PtyTestWorkData*>(d);
            if (!g_logInitialized) FileLogger::instance().init("/data/storage/el2/base/haps/entry/files");
            // The HNP installation directory is read-only at runtime. Use the
            // writable user mount as the runtime socket directory and verify
            // that both HAP and HNP ELF can access it.
            char sp[512]; snprintf(sp, sizeof(sp), "%s", "/storage/Users/currentUser/hapi_peercred.sock");
            unlink(sp);
            int fd = socket(AF_UNIX, SOCK_STREAM, 0);
            if (fd<0) { snprintf(w->result.slavePath,sizeof(w->result.slavePath),"socket FAIL errno=%d",errno); return; }
            struct sockaddr_un a; memset(&a,0,sizeof(a)); a.sun_family=AF_UNIX;
            strncpy(a.sun_path, sp, sizeof(a.sun_path)-1);
            if (bind(fd,(struct sockaddr*)&a,sizeof(a))<0||listen(fd,1)<0) {
                snprintf(w->result.slavePath,sizeof(w->result.slavePath),"bind/listen FAIL errno=%d path=%s",errno,sp);
                close(fd); return;
            }
            FileLogger::instance().log("INFO","FILE-SOCK: listening %s fd=%d",sp,fd);
            FileLogger::instance().flush();
            struct pollfd p={fd,POLLIN,0}; int pr=poll(&p,1,60000), pe=errno;
            if(pr>0){int c=accept(fd,0,0);if(c>=0){char peerInfo[1024]={};describeUnixPeer(c,peerInfo,sizeof(peerInfo));FileLogger::instance().log("INFO","FILE-SOCK: %s",peerInfo);char b[256]={};ssize_t n=recv(c,b,sizeof(b)-1,0);if(n>0){b[n]=0;FileLogger::instance().log("INFO","FILE-SOCK: recv %s",b);send(c,"FILE_OK",7,0);}close(c);}}
            close(fd); unlink(sp);
            snprintf(w->result.slavePath,sizeof(w->result.slavePath),"FILE poll=%d errno=%d %s",pr,pe,sp);
            FileLogger::instance().log("INFO","FILE-SOCK: done poll=%d errno=%d",pr,pe); FileLogger::instance().flush();
        },
        [](napi_env env,napi_status,void* d){
            auto* w=static_cast<PtyTestWorkData*>(d);
            napi_value r;napi_create_string_utf8(env,w->result.slavePath,NAPI_AUTO_LENGTH,&r);
            napi_resolve_deferred(env,w->deferred,r);napi_delete_async_work(env,w->work);delete w;
        },wd,&wd->work);
    napi_queue_async_work(env,wd->work);
    return promise;
}

// Explicit name for the UI/test report. It runs the automated abstract
// socket test above, which now includes SO_PEERCRED and /proc/<pid>/exe.
static napi_value runUnixPeerCredTestNapi(napi_env env, napi_callback_info info) {
    return runAbstractSocketTestNapi(env, info);
}

// ── Convert PtyTestResult to NAPI object ──────────────────────────
static napi_value resultToNapi(napi_env env, const PtyTestResult& result) {
    napi_value obj;
    napi_create_object(env, &obj);

    auto setInt = [&](const char* key, int val) {
        napi_value v;
        napi_create_int32(env, val, &v);
        napi_set_named_property(env, obj, key, v);
    };
    auto setBool = [&](const char* key, bool val) {
        napi_value v;
        napi_get_boolean(env, val, &v);
        napi_set_named_property(env, obj, key, v);
    };
    auto setStr = [&](const char* key, const char* val) {
        napi_value v;
        napi_create_string_utf8(env, val, NAPI_AUTO_LENGTH, &v);
        napi_set_named_property(env, obj, key, v);
    };
    auto setInt64 = [&](const char* key, int64_t val) {
        napi_value v;
        napi_create_int64(env, val, &v);
        napi_set_named_property(env, obj, key, v);
    };

    setInt("testId", result.testId);
    setBool("success", result.success);
    setBool("crashOnFailure", result.crashOnFailure);
    setStr("failedStep", stepName(result.failedStep));
    setInt("errno", result.errno_);
    setStr("errnoMessage", result.errnoMessage);
    setInt("masterFd", result.masterFd);
    setInt("slaveFd", result.slaveFd);
    setStr("slavePath", result.slavePath);
    setStr("startedAt", result.startedAt);
    setStr("finishedAt", result.finishedAt);
    setInt64("durationUs", result.durationUs);
    setStr("reportPath", result.reportPath);

    // steps array
    napi_value stepsArr;
    napi_create_array_with_length(env, result.steps.size(), &stepsArr);
    for (size_t i = 0; i < result.steps.size(); i++) {
        napi_value stepObj;
        napi_create_object(env, &stepObj);
        const auto& s = result.steps[i];
        napi_value v;
        napi_create_string_utf8(env, s.stepName, NAPI_AUTO_LENGTH, &v);
        napi_set_named_property(env, stepObj, "step", v);
        napi_get_boolean(env, s.success, &v);
        napi_set_named_property(env, stepObj, "success", v);
        napi_create_int32(env, s.result, &v);
        napi_set_named_property(env, stepObj, "result", v);
        napi_create_int32(env, s.savedErrno, &v);
        napi_set_named_property(env, stepObj, "errno", v);
        napi_create_string_utf8(env, s.errnoMessage, NAPI_AUTO_LENGTH, &v);
        napi_set_named_property(env, stepObj, "errnoMessage", v);
        napi_create_int64(env, s.durationUs, &v);
        napi_set_named_property(env, stepObj, "durationUs", v);
        napi_create_string_utf8(env, s.details, NAPI_AUTO_LENGTH, &v);
        napi_set_named_property(env, stepObj, "details", v);
        napi_set_element(env, stepsArr, i, stepObj);
    }
    napi_set_named_property(env, obj, "steps", stepsArr);

    // systemStateBefore (simplified - key fields)
    napi_value stateBefore;
    napi_create_object(env, &stateBefore);
    setInt("pid", result.stateBefore.pid);
    setInt("uid", result.stateBefore.uid);
    setInt("gid", result.stateBefore.gid);
    setInt("fdCount", result.stateBefore.fdCount);
    setStr("ptyNr", result.stateBefore.ptyNr);
    setStr("ptyMax", result.stateBefore.ptyMax);
    napi_set_named_property(env, obj, "systemStateBefore", stateBefore);

    napi_value stateAfter;
    napi_create_object(env, &stateAfter);
    setInt("pid", result.stateAfter.pid);
    setInt("fdCount", result.stateAfter.fdCount);
    napi_set_named_property(env, obj, "systemStateAfter", stateAfter);

    return obj;
}

// ── Async execute callback ────────────────────────────────────────
static void ptyTestExecute(napi_env env, void* data) {
    PtyTestWorkData* wd = static_cast<PtyTestWorkData*>(data);
    if (wd->shellControlTest) {
        runShellControlTest(wd->result);
    } else if (wd->forkptyTest) {
        runForkptyTest(wd->options, wd->result);
    } else if (wd->recoveryTest) {
        runRecoveryTest(wd->result);
    } else if (wd->attrCheckTest) {
        // attr check populates result with system state + attr
        collectSystemState(wd->result.stateBefore, true, true);
        PtmxAttrResult attr;
        checkPtmxAttributes(attr);
        wd->result.testId = static_cast<int>(time(nullptr)) * 1000 + (getpid() % 1000) + 4;
        wd->result.success = (attr.openRet >= 0);
        wd->result.errno_ = attr.openErrno;
        // Store attr in the result's state (abusing a bit)
        snprintf(wd->result.slavePath, sizeof(wd->result.slavePath),
            "access:R=%d W=%d X=%d stat:%s lstat:%s open:ret=%d errno=%d rl=%s",
            attr.accessR, attr.accessW, attr.accessX,
            attr.statDetail, attr.lstatDetail,
            attr.openRet, attr.openErrno, attr.readlinkResult);
        getTimestamp(wd->result.startedAt, sizeof(wd->result.startedAt));
        getTimestamp(wd->result.finishedAt, sizeof(wd->result.finishedAt));
    } else if (wd->batchOpenTest) {
        collectSystemState(wd->result.stateBefore, false, false);
        BatchOpenResult batch;
        runBatchOpenTest(wd->batchCount, wd->batchIntervalMs, wd->batchCloseBetween, wd->batchParallel,
                         wd->result, batch);
        wd->result.testId = static_cast<int>(time(nullptr)) * 1000 + (getpid() % 1000) + 5;
        wd->result.success = (batch.failureCount == 0);
        wd->result.masterFd = batch.lastSuccessFd;
        snprintf(wd->result.slavePath, sizeof(wd->result.slavePath),
            "batch:%d/%d ok:%d fail:%d firstFailAt:%d errno:%d consecOk:%d consecFail:%d leak:%d",
            batch.totalCount, batch.successCount + batch.failureCount,
            batch.successCount, batch.failureCount,
            batch.firstFailureIndex, batch.firstFailureErrno,
            batch.consecutiveSuccesses, batch.consecutiveFailures, batch.fdLeak);
        getTimestamp(wd->result.startedAt, sizeof(wd->result.startedAt));
        getTimestamp(wd->result.finishedAt, sizeof(wd->result.finishedAt));
    } else if (wd->holdOpenTest) {
        collectSystemState(wd->result.stateBefore, false, false);
        HoldOpenResult hold;
        runHoldOpenTest(wd->holdSeconds, wd->result, hold);
        wd->result.testId = static_cast<int>(time(nullptr)) * 1000 + (getpid() % 1000) + 6;
        wd->result.success = hold.openSuccess && hold.stillValidAtEnd;
        wd->result.masterFd = hold.fd >= 0 ? hold.fd : -1;
        snprintf(wd->result.slavePath, sizeof(wd->result.slavePath),
            "hold:%ds openOk:%d stillValid:%d interrupted:%d checks:%d failures:%d firstFailAt:%ds",
            hold.holdSeconds, hold.openSuccess, hold.stillValidAtEnd,
            hold.interrupted, hold.checkCount, hold.checkFailures, hold.firstCheckFailureAtSec);
        getTimestamp(wd->result.startedAt, sizeof(wd->result.startedAt));
        getTimestamp(wd->result.finishedAt, sizeof(wd->result.finishedAt));
    } else if (wd->elfAllTest) {
        AllElfResults all;
        runAllElfTests(g_logDir, all);
        wd->result.testId = static_cast<int>(time(nullptr)) * 1000 + (getpid() % 1000) + 7;
        wd->result.success = true;
        snprintf(wd->result.slavePath, sizeof(wd->result.slavePath), "%s", all.summary);
        getTimestamp(wd->result.startedAt, sizeof(wd->result.startedAt));
        getTimestamp(wd->result.finishedAt, sizeof(wd->result.finishedAt));
    } else {
        runFullPtyTest(wd->options, wd->result);
    }
}

// ── Async complete callback ───────────────────────────────────────
static void ptyTestComplete(napi_env env, napi_status status, void* data) {
    PtyTestWorkData* wd = static_cast<PtyTestWorkData*>(data);
    napi_value result = resultToNapi(env, wd->result);

    if (wd->result.success) {
        napi_resolve_deferred(env, wd->deferred, result);
    } else {
        // Even on PTY failure, we resolve with the result (not reject)
        // unless crash mode was set (then we won't reach here)
        napi_resolve_deferred(env, wd->deferred, result);
    }

    napi_delete_async_work(env, wd->work);
    delete wd;
}

// ── NAPI: runPtyTest ──────────────────────────────────────────────
static napi_value runPtyTest(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1] = {nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    auto* wd = new PtyTestWorkData();
    wd->shellControlTest = false;
    wd->forkptyTest = false;
    wd->recoveryTest = false;

    // Parse options
    if (argc > 0 && args[0] != nullptr) {
        napi_valuetype type;
        napi_typeof(env, args[0], &type);
        if (type == napi_object) {
            auto getBoolOpt = [&](const char* key, bool defaultVal) -> bool {
                napi_value v;
                napi_get_named_property(env, args[0], key, &v);
                bool result;
                if (napi_get_value_bool(env, v, &result) == napi_ok) return result;
                return defaultVal;
            };
            wd->options.crashOnFailure = getBoolOpt("crashOnFailure", false);
            wd->options.performReadWriteTest = getBoolOpt("performReadWriteTest", true);
            wd->options.collectMountInfo = getBoolOpt("collectMountInfo", true);
            wd->options.collectSelinuxInfo = getBoolOpt("collectSelinuxInfo", true);
            wd->options.fsyncOnEveryStep = getBoolOpt("fsyncOnEveryStep", false);
        }
    }

    napi_value promise;
    napi_create_promise(env, &wd->deferred, &promise);

    napi_value resourceName;
    napi_create_string_utf8(env, "PtyTest", NAPI_AUTO_LENGTH, &resourceName);
    napi_create_async_work(env, nullptr, resourceName,
        ptyTestExecute, ptyTestComplete, wd, &wd->work);
    napi_queue_async_work(env, wd->work);

    return promise;
}

// ── NAPI: runShellControlTest ─────────────────────────────────────
static napi_value runShellControlTestNapi(napi_env env, napi_callback_info info) {
    auto* wd = new PtyTestWorkData();
    wd->shellControlTest = true;
    wd->forkptyTest = false;
    wd->recoveryTest = false;
    wd->options.crashOnFailure = false;
    wd->options.performReadWriteTest = false;
    wd->options.collectMountInfo = false;
    wd->options.collectSelinuxInfo = false;

    napi_value promise;
    napi_create_promise(env, &wd->deferred, &promise);

    napi_value resourceName;
    napi_create_string_utf8(env, "ShellControlTest", NAPI_AUTO_LENGTH, &resourceName);
    napi_create_async_work(env, nullptr, resourceName,
        ptyTestExecute, ptyTestComplete, wd, &wd->work);
    napi_queue_async_work(env, wd->work);

    return promise;
}

// ── NAPI: runForkptyTest ─────────────────────────────────────────────
static napi_value runForkptyTestNapi(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1] = {nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    auto* wd = new PtyTestWorkData();
    wd->shellControlTest = false;
    wd->forkptyTest = true;
    wd->recoveryTest = false;

    // Parse options
    if (argc > 0 && args[0] != nullptr) {
        napi_valuetype type;
        napi_typeof(env, args[0], &type);
        if (type == napi_object) {
            auto getBoolOpt = [&](const char* key, bool defaultVal) -> bool {
                napi_value v;
                napi_get_named_property(env, args[0], key, &v);
                bool result;
                if (napi_get_value_bool(env, v, &result) == napi_ok) return result;
                return defaultVal;
            };
            wd->options.crashOnFailure = getBoolOpt("crashOnFailure", false);
            wd->options.performReadWriteTest = getBoolOpt("performReadWriteTest", true);
            wd->options.collectMountInfo = getBoolOpt("collectMountInfo", true);
            wd->options.collectSelinuxInfo = getBoolOpt("collectSelinuxInfo", true);
        }
    }

    napi_value promise;
    napi_create_promise(env, &wd->deferred, &promise);

    napi_value resourceName;
    napi_create_string_utf8(env, "ForkptyTest", NAPI_AUTO_LENGTH, &resourceName);
    napi_create_async_work(env, nullptr, resourceName,
        ptyTestExecute, ptyTestComplete, wd, &wd->work);
    napi_queue_async_work(env, wd->work);

    return promise;
}

// ── NAPI: runRecoveryTest (child-process PTY recovery attempt) ─────
static napi_value runRecoveryTestNapi(napi_env env, napi_callback_info info) {
    auto* wd = new PtyTestWorkData();
    wd->shellControlTest = false;
    wd->forkptyTest = false;
    wd->recoveryTest = true;

    napi_value promise;
    napi_create_promise(env, &wd->deferred, &promise);

    napi_value resourceName;
    napi_create_string_utf8(env, "RecoveryTest", NAPI_AUTO_LENGTH, &resourceName);
    napi_create_async_work(env, nullptr, resourceName,
        ptyTestExecute, ptyTestComplete, wd, &wd->work);
    napi_queue_async_work(env, wd->work);

    return promise;
}

// ── NAPI: checkPtmxAttributes ──────────────────────────────────────
static napi_value checkPtmxAttributesNapi(napi_env env, napi_callback_info info) {
    PtmxAttrResult attr;
    checkPtmxAttributes(attr);

    napi_value obj;
    napi_create_object(env, &obj);

    auto setInt = [&](const char* key, int val) {
        napi_value v; napi_create_int32(env, val, &v);
        napi_set_named_property(env, obj, key, v);
    };
    auto setBool = [&](const char* key, bool val) {
        napi_value v; napi_get_boolean(env, val, &v);
        napi_set_named_property(env, obj, key, v);
    };
    auto setStr = [&](const char* key, const char* val) {
        napi_value v; napi_create_string_utf8(env, val, NAPI_AUTO_LENGTH, &v);
        napi_set_named_property(env, obj, key, v);
    };

    setBool("pathExists", attr.pathExists);
    setInt("accessR", attr.accessR);
    setInt("accessW", attr.accessW);
    setInt("accessX", attr.accessX);
    setInt("statRet", attr.statRet);
    setInt("statErrno", attr.statErrno);
    setStr("statDetail", attr.statDetail);
    setInt("lstatRet", attr.lstatRet);
    setInt("lstatErrno", attr.lstatErrno);
    setStr("lstatDetail", attr.lstatDetail);
    setStr("readlinkResult", attr.readlinkResult);
    setInt("openRet", attr.openRet);
    setInt("openErrno", attr.openErrno);
    setStr("mountInfoDevPts", attr.mountInfoDevPts);
    setStr("mountInfoDev", attr.mountInfoDev);
    setStr("selinuxContext", attr.selinuxContext);
    setInt("fdCount", attr.fdCount);

    return obj;
}

// ── NAPI: runBatchOpenTest ─────────────────────────────────────────
static napi_value runBatchOpenTestNapi(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1] = {nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    auto* wd = new PtyTestWorkData();
    wd->shellControlTest = false;
    wd->forkptyTest = false;
    wd->recoveryTest = false;
    wd->attrCheckTest = false;
    wd->batchOpenTest = true;
    wd->holdOpenTest = false;

    // Defaults
    wd->batchCount = 100;
    wd->batchIntervalMs = 10;
    wd->batchCloseBetween = true;
    wd->batchParallel = false;

    if (argc > 0 && args[0] != nullptr) {
        napi_valuetype type;
        napi_typeof(env, args[0], &type);
        if (type == napi_object) {
            auto getInt = [&](const char* key, int defaultVal) -> int {
                napi_value v;
                if (napi_get_named_property(env, args[0], key, &v) == napi_ok) {
                    int result;
                    if (napi_get_value_int32(env, v, &result) == napi_ok) return result;
                }
                return defaultVal;
            };
            auto getBool = [&](const char* key, bool defaultVal) -> bool {
                napi_value v;
                if (napi_get_named_property(env, args[0], key, &v) == napi_ok) {
                    bool result;
                    if (napi_get_value_bool(env, v, &result) == napi_ok) return result;
                }
                return defaultVal;
            };
            wd->batchCount = getInt("count", 100);
            wd->batchIntervalMs = getInt("intervalMs", 10);
            wd->batchCloseBetween = getBool("closeBetween", true);
            wd->batchParallel = getBool("parallel", false);
        }
    }

    napi_value promise;
    napi_create_promise(env, &wd->deferred, &promise);

    napi_value resourceName;
    napi_create_string_utf8(env, "BatchOpenTest", NAPI_AUTO_LENGTH, &resourceName);
    napi_create_async_work(env, nullptr, resourceName,
        ptyTestExecute, ptyTestComplete, wd, &wd->work);
    napi_queue_async_work(env, wd->work);

    return promise;
}

// ── NAPI: runHoldOpenTest ──────────────────────────────────────────
static napi_value runHoldOpenTestNapi(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1] = {nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    auto* wd = new PtyTestWorkData();
    wd->shellControlTest = false;
    wd->forkptyTest = false;
    wd->recoveryTest = false;
    wd->attrCheckTest = false;
    wd->batchOpenTest = false;
    wd->holdOpenTest = true;
    wd->holdSeconds = 30;

    if (argc > 0 && args[0] != nullptr) {
        napi_valuetype type;
        napi_typeof(env, args[0], &type);
        if (type == napi_object) {
            napi_value v;
            if (napi_get_named_property(env, args[0], "holdSeconds", &v) == napi_ok) {
                napi_get_value_int32(env, v, &wd->holdSeconds);
            }
        }
    }

    napi_value promise;
    napi_create_promise(env, &wd->deferred, &promise);

    napi_value resourceName;
    napi_create_string_utf8(env, "HoldOpenTest", NAPI_AUTO_LENGTH, &resourceName);
    napi_create_async_work(env, nullptr, resourceName,
        ptyTestExecute, ptyTestComplete, wd, &wd->work);
    napi_queue_async_work(env, wd->work);

    return promise;
}

// ── USB DDK error string ───────────────────────────────────────────
static const char* usbDdkStrerror(int32_t code) {
    switch (code) {
    case USB_DDK_SUCCESS:           return "USB_DDK_SUCCESS (0)";
    case USB_DDK_NO_PERM:           return "USB_DDK_NO_PERM (201) — permission denied";
    case USB_DDK_INVALID_PARAMETER: return "USB_DDK_INVALID_PARAMETER (401)";
    case USB_DDK_MEMORY_ERROR:      return "USB_DDK_MEMORY_ERROR (27400001)";
    case USB_DDK_INVALID_OPERATION: return "USB_DDK_INVALID_OPERATION (27400002)";
    case USB_DDK_IO_FAILED:         return "USB_DDK_IO_FAILED (27400003)";
    case USB_DDK_TIMEOUT:           return "USB_DDK_TIMEOUT (27400004)";
    default:                        return "(unknown)";
    }
}

// ── NAPI: runUsbDdkTest ───────────────────────────────────────────
// Tests whether the HAP app can use USB DDK (ohos.permission.ACCESS_DDK_USB).
// Returns a diagnostics string.
static napi_value runUsbDdkTestNapi(napi_env env, napi_callback_info info) {
    char result[16384] = {};
    char *p = result;
    char *end = result + sizeof(result) - 1;
    int32_t ret;

    p += snprintf(p, end - p, "=== USB DDK Test (from HAP NAPI) ===\n");

    // 1. Init
    ret = OH_Usb_Init();
    p += snprintf(p, end - p, "[OH_Usb_Init] ret=%d → %s\n", ret, usbDdkStrerror(ret));
    if (ret != USB_DDK_SUCCESS) {
        p += snprintf(p, end - p, "\n*** USB DDK init failed — permission NOT granted to this HAP ***\n");
        goto done;
    }

    // 2. Enumerate devices
    struct Usb_DeviceArray devices;
    memset(&devices, 0, sizeof(devices));
    ret = OH_Usb_GetDevices(&devices);
    p += snprintf(p, end - p, "[OH_Usb_GetDevices] ret=%d → %s, num=%u\n", ret, usbDdkStrerror(ret), devices.num);
    if (ret != USB_DDK_SUCCESS || devices.num == 0) {
        p += snprintf(p, end - p, "(no devices or call failed)\n");
        goto release;
    }

    // 3. For each device: get descriptor
    for (uint32_t di = 0; di < devices.num && di < 8; di++) {
        uint64_t devId = devices.deviceIds[di];
        struct UsbDeviceDescriptor devDesc;
        ret = OH_Usb_GetDeviceDescriptor(devId, &devDesc);
        p += snprintf(p, end - p,
            "--- Device %u (id=0x%llx) ---\n"
            "  [GetDeviceDesc] ret=%d → %s\n"
            "  USB %x.%02x  VID:PID=%04x:%04x  class=0x%02x sub=0x%02x proto=0x%02x  configs=%u\n",
            di, (unsigned long long)devId, ret, usbDdkStrerror(ret),
            devDesc.bcdUSB >> 8, devDesc.bcdUSB & 0xFF,
            devDesc.idVendor, devDesc.idProduct,
            devDesc.bDeviceClass, devDesc.bDeviceSubClass, devDesc.bDeviceProtocol,
            devDesc.bNumConfigurations);

        // 4. Get config descriptor (index 1) and walk interfaces
        struct UsbDdkConfigDescriptor *cfg = nullptr;
        ret = OH_Usb_GetConfigDescriptor(devId, 1, &cfg);
        p += snprintf(p, end - p, "  [GetConfigDesc] ret=%d → %s\n", ret, usbDdkStrerror(ret));
        if (ret == USB_DDK_SUCCESS && cfg) {
            for (int ii = 0; ii < cfg->configDescriptor.bNumInterfaces && ii < 16; ii++) {
                struct UsbDdkInterface *iface = &cfg->interface[ii];
                for (int alt = 0; alt < iface->numAltsetting; alt++) {
                    struct UsbDdkInterfaceDescriptor *id = &iface->altsetting[alt];
                    uint8_t cls  = id->interfaceDescriptor.bInterfaceClass;
                    uint8_t sub  = id->interfaceDescriptor.bInterfaceSubClass;
                    uint8_t prot = id->interfaceDescriptor.bInterfaceProtocol;
                    uint8_t num  = id->interfaceDescriptor.bInterfaceNumber;
                    p += snprintf(p, end - p,
                        "    Iface#%d alt=%d  class=0x%02x sub=0x%02x proto=0x%02x  eps=%u\n",
                        num, alt, cls, sub, prot, id->interfaceDescriptor.bNumEndpoints);

                    // ADB detection
                    if (cls == 0xFF && sub == 0x42 && prot == 0x01) {
                        p += snprintf(p, end - p, "    *** ADB INTERFACE DETECTED ***\n");
                        uint64_t ifHandle = 0;
                        ret = OH_Usb_ClaimInterface(devId, num, &ifHandle);
                        p += snprintf(p, end - p,
                            "    [ClaimInterface] ret=%d → %s  handle=0x%llx\n",
                            ret, usbDdkStrerror(ret), (unsigned long long)ifHandle);
                        if (ret == USB_DDK_SUCCESS) {
                            OH_Usb_ReleaseInterface(ifHandle);
                            p += snprintf(p, end - p, "    [ReleaseInterface] done\n");
                        }
                    }
                }
            }
            OH_Usb_FreeConfigDescriptor(cfg);
        }
    }

release:
    OH_Usb_Release();
    p += snprintf(p, end - p, "[OH_Usb_Release] done\n");

done:
    p += snprintf(p, end - p, "=== USB DDK Test Complete ===\n");

    // Write result to log file
    FileLogger::instance().log("INFO", "%s", result);
    FileLogger::instance().flush();

    napi_value napiResult;
    napi_create_string_utf8(env, result, NAPI_AUTO_LENGTH, &napiResult);
    return napiResult;
}


// ── NAPI: logToFile ──────────────────────────────────────────────
// Allows ArkTS to write directly to the FileLogger
static napi_value logToFileNapi(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1] = {nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    char msg[4096] = {};
    size_t len;
    napi_get_value_string_utf8(env, args[0], msg, sizeof(msg) - 1, &len);
    FileLogger::instance().log("INFO", "%s", msg);
    FileLogger::instance().flush();
    napi_value result;
    napi_get_boolean(env, true, &result);
    return result;
}

// ── USB fd relay server thread ────────────────────────────────────
// ── NAPI: startUsbProxy (inline mmap thread, no fork) ─────────────
// Background thread: mmap shm file, poll for cmds, execute USB ioctls.

// ── NAPI: runRawUsbTest
// ── NAPI: startUsbProxy (TCP server thread) ──────────────────────
// Background thread: TCP server on 127.0.0.1:9999, executes USB ioctls.
static napi_value startUsbProxyNapi(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1] = {nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    int32_t usbFd = -1;
    napi_get_value_int32(env, args[0], &usbFd);

    OH_LOG_INFO(LOG_APP, "USB_PROXY: TCP server fd=%{public}d", usbFd);
    FileLogger::instance().log("INFO", "USB_PROXY: TCP server fd=%d", usbFd);
    FileLogger::instance().flush();

    std::thread t([usbFd]() {
        int sock = socket(AF_INET, SOCK_STREAM, 0);
        if (sock < 0) return;
        int one = 1;
        setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
        struct sockaddr_in addr = {};
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        addr.sin_port = htons(9999);
        if (bind(sock, (struct sockaddr*)&addr, sizeof(addr)) < 0) { close(sock); return; }
        if (listen(sock, 1) < 0) { close(sock); return; }

        FileLogger::instance().log("INFO", "USB_PROXY: TCP listening :9999");
        FileLogger::instance().flush();

        while (true) {
            int client = accept(sock, nullptr, nullptr);
            if (client < 0) continue;

            // Read 1-byte trigger, then command word
            char trigger;
            uint32_t cmd = 0;
            if (read(client, &trigger, 1) > 0)
                read(client, &cmd, sizeof(cmd));

            if (cmd == 1) { // GET_DEVICE_DESC
                struct usb_device_descriptor desc;
                struct usbdevfs_ctrltransfer ctrl = {};
                ctrl.bRequestType = 0x80; ctrl.bRequest = 0x06;
                ctrl.wValue = 0x0100; ctrl.wIndex = 0;
                ctrl.wLength = sizeof(desc); ctrl.timeout = 1000; ctrl.data = &desc;
                int ret = ioctl(usbFd, USBDEVFS_CONTROL, &ctrl);
                if (ret < 0) {
                    int e = errno;
                    char buf[64];
                    int n = snprintf(buf, sizeof(buf), "ERR:%d:%s\n", e, strerror(e));
                    write(client, buf, n);
                } else {
                    char buf[128];
                    int n = snprintf(buf, sizeof(buf),
                        "OK: USB %x.%02x  VID:PID=%04x:%04x\n",
                        desc.bcdUSB >> 8, desc.bcdUSB & 0xFF,
                        desc.idVendor, desc.idProduct);
                    write(client, buf, n);
                }
                FileLogger::instance().log("INFO", "USB_PROXY: cmd=%u done", cmd);
                FileLogger::instance().flush();
            }
            close(client);
        }
    });
    t.detach();

    napi_value result;
    napi_get_boolean(env, true, &result);
    return result;
}static napi_value runRawUsbTestNapi(napi_env env, napi_callback_info info) {
    char path[512];
    snprintf(path, sizeof(path), "%s/raw_usb", g_logDir);
    chmod(path, 0755);
    char* argv[] = { (char*)"raw_usb", NULL };
    char result[16384];
    memset(result, 0, sizeof(result));
    int pipeOut[2] = {-1,-1}, pipeErr[2] = {-1,-1};
    pid_t child = -1;
    int wstatus = 0;
    do {
        if (pipe(pipeOut) < 0 || pipe(pipeErr) < 0) {
            snprintf(result, sizeof(result), "pipe failed: %s", strerror(errno));
            break;
        }
        child = fork();
        if (child < 0) { snprintf(result, sizeof(result), "fork failed: %s", strerror(errno)); break; }
        if (child == 0) {
            close(pipeOut[0]); close(pipeErr[0]);
            dup2(pipeOut[1], STDOUT_FILENO); dup2(pipeErr[1], STDERR_FILENO);
            close(pipeOut[1]); close(pipeErr[1]);
            execv(path, argv);
            fprintf(stderr, "EXECVE_FAILED: errno=%d %s", errno, strerror(errno));
            fflush(stderr); _exit(127);
        }
        close(pipeOut[1]); close(pipeErr[1]);
        int total = 0;
        char buf[4096];
        struct pollfd fds[2] = {{pipeOut[0], POLLIN, 0}, {pipeErr[0], POLLIN, 0}};
        int remain = (int)sizeof(result) - 1;
        while (remain > 0 && (fds[0].fd >= 0 || fds[1].fd >= 0)) {
            int ev = poll(fds, 2, 5000);
            if (ev < 0) break;
            if (ev == 0) break;
            for (int i = 0; i < 2 && remain > 0; i++) {
                if (fds[i].revents & (POLLIN | POLLHUP | POLLERR)) {
                    if (fds[i].revents & POLLIN) {
                        ssize_t n = read(fds[i].fd, buf, remain < (int)sizeof(buf) ? remain : (int)sizeof(buf));
                        if (n <= 0) { close(fds[i].fd); fds[i].fd = -1; continue; }
                        memcpy(result + total, buf, n);
                        total += n; remain -= n;
                        result[total] = 0;
                    } else {
                        close(fds[i].fd);
                        fds[i].fd = -1;
                    }
                }
            }
        }
        close(pipeOut[0]); close(pipeErr[0]);
        waitpid(child, &wstatus, 0);
        char tail[256];
        int ec = WIFEXITED(wstatus) ? WEXITSTATUS(wstatus) : -1;
        int sig = WIFSIGNALED(wstatus) ? WTERMSIG(wstatus) : 0;
        snprintf(tail, sizeof(tail), "\n[exit=%d signal=%d]\n", ec, sig);
        if (total + (int)strlen(tail) < (int)sizeof(result) - 1) strcat(result, tail);
    } while (0);
    if (pipeOut[0] >= 0) { close(pipeOut[0]); close(pipeOut[1]); }
    if (pipeErr[0] >= 0) { close(pipeErr[0]); close(pipeErr[1]); }
    // Write result to log file
    FileLogger::instance().log("INFO", "========== raw_usb test ==========");
    FileLogger::instance().log("INFO", "%s", result);
    FileLogger::instance().flush();

    napi_value napiResult;
    napi_create_string_utf8(env, result, NAPI_AUTO_LENGTH, &napiResult);
    return napiResult;
}

// ── NAPI: runToyboxDirect
static napi_value runToyboxDirectNapi(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1] = {nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    // Default: unsigned; pass "signed" for toybox-signed
    const char* variant = "toybox-unsigned";
    if (argc > 0 && args[0] != nullptr) {
        napi_valuetype type;
        napi_typeof(env, args[0], &type);
        if (type == napi_string) {
            size_t len;
            static char buf[64];
            napi_get_value_string_utf8(env, args[0], buf, sizeof(buf)-1, &len);
            if (strcmp(buf, "signed") == 0) variant = "toybox-signed";
        }
    }

    char path[512];
    snprintf(path, sizeof(path), "%s/%s", g_logDir, variant);
    chmod(path, 0755);

    char* argv[] = { (char*)variant, nullptr };
    char result[8192];

    int pipeOut[2] = {-1,-1}, pipeErr[2] = {-1,-1};
    int totalOut=0, totalErr=0, exitCode=-1, exitSignal=-1, wstatus=0;
    pid_t child = -1;
    char stdout_[4096] = {}, stderr_[2048] = {};

    do {
        if (pipe(pipeOut) < 0 || pipe(pipeErr) < 0) {
            snprintf(result, sizeof(result), "pipe failed: %s", strerror(errno));
            break;
        }

        child = fork();
        if (child < 0) {
            snprintf(result, sizeof(result), "fork failed: %s", strerror(errno));
            break;
        }
        if (child == 0) {
            close(pipeOut[0]);close(pipeErr[0]);
            dup2(pipeOut[1], STDOUT_FILENO);dup2(pipeErr[1], STDERR_FILENO);
            close(pipeOut[1]);close(pipeErr[1]);
            execv(path, argv);
            fprintf(stderr, "EXECVE_FAILED: errno=%d %s\n", errno, strerror(errno));
            fflush(stderr);
            _exit(127);
        }
        close(pipeOut[1]);close(pipeErr[1]);
        auto t0 = std::chrono::steady_clock::now();
        while (std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-t0).count() < 5000) {
            pid_t w = waitpid(child, &wstatus, WNOHANG);
            if (w == child) {
                if (WIFEXITED(wstatus)) exitCode = WEXITSTATUS(wstatus);
                if (WIFSIGNALED(wstatus)) exitSignal = WTERMSIG(wstatus);
                break;
            }
            struct pollfd pfd;
            pfd.fd = pipeOut[0]; pfd.events = POLLIN;
            if (poll(&pfd,1,100)>0 && (pfd.revents&POLLIN) && totalOut < (int)sizeof(stdout_)-1)
                { ssize_t n=read(pipeOut[0],stdout_+totalOut,sizeof(stdout_)-1-totalOut); if(n>0) totalOut+=n; }
            pfd.fd = pipeErr[0];
            if (poll(&pfd,1,0)>0 && (pfd.revents&POLLIN) && totalErr < (int)sizeof(stderr_)-1)
                { ssize_t n=read(pipeErr[0],stderr_+totalErr,sizeof(stderr_)-1-totalErr); if(n>0) totalErr+=n; }
            std::this_thread::sleep_for(std::chrono::milliseconds(30));
        }
        snprintf(result, sizeof(result), "%s: exit=%d signal=%d\nSTDOUT:\n%s\nSTDERR:\n%s",
            variant, exitCode, exitSignal, stdout_, stderr_);
        FileLogger::instance().log("INFO", "toybox-direct [%s] exit=%d signal=%d out=%s err=%s",
            variant, exitCode, exitSignal, stdout_, stderr_);
    } while (0);

    if (pipeOut[0] >= 0) close(pipeOut[0]);
    if (pipeOut[1] >= 0) close(pipeOut[1]);
    if (pipeErr[0] >= 0) close(pipeErr[0]);
    if (pipeErr[1] >= 0) close(pipeErr[1]);
    FileLogger::instance().flush();
    napi_value ret;
    napi_create_string_utf8(env, result, NAPI_AUTO_LENGTH, &ret);
    return ret;
}

// ── NAPI: runThirdPartyCommand ─────────────────────────────────────
// Execute a fixed external command without going through a shell. This keeps
// the test focused on whether the app process can exec the supplied binary.
static napi_value runThirdPartyCommandNapi(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value args[3] = {nullptr, nullptr, nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    std::string commandPath = "/storage/Users/currentUser/.harmonybrew/bin/brew";
    std::vector<std::string> commandArgs = {"--version"};
    if (argc >= 1 && args[0] != nullptr) {
        char pathBuffer[1024] = {};
        size_t pathLength = 0;
        if (napi_get_value_string_utf8(env, args[0], pathBuffer, sizeof(pathBuffer) - 1, &pathLength) == napi_ok
            && pathLength > 0) {
            commandPath = pathBuffer;
        }
    }
    if (argc >= 2 && args[1] != nullptr) {
        char argBuffer[4096] = {};
        size_t argLength = 0;
        if (napi_get_value_string_utf8(env, args[1], argBuffer, sizeof(argBuffer) - 1, &argLength) == napi_ok
            && argLength > 0) {
            commandArgs.clear();
            commandArgs.emplace_back(argBuffer);
            if (argc >= 3 && args[2] != nullptr) {
                char secondArgBuffer[4096] = {};
                size_t secondArgLength = 0;
                if (napi_get_value_string_utf8(env, args[2], secondArgBuffer,
                    sizeof(secondArgBuffer) - 1, &secondArgLength) == napi_ok && secondArgLength > 0) {
                    commandArgs.emplace_back(secondArgBuffer);
                }
            }
        }
    }
    size_t slash = commandPath.find_last_of('/');
    std::string commandName = slash == std::string::npos ? commandPath : commandPath.substr(slash + 1);
    std::string commandLine = commandPath;
    for (const std::string& arg : commandArgs) commandLine += " " + arg;

    const char* workDir = g_logDir[0] != '\0'
        ? g_logDir : "/data/storage/el2/base/haps/entry/files";
    std::string pwdEnv = std::string("PWD=") + workDir;
    std::vector<char*> childEnv;
    extern char** environ;
    for (char** env = environ; env != nullptr && *env != nullptr; ++env) {
        if (strncmp(*env, "PWD=", 4) != 0) childEnv.push_back(*env);
    }
    childEnv.push_back(const_cast<char*>(pwdEnv.c_str()));
    childEnv.push_back(nullptr);

    char result[12288] = {};
    struct stat fileStat = {};
    errno = 0;
    int statRet = stat(commandPath.c_str(), &fileStat);
    int statErrno = statRet == 0 ? 0 : errno;
    errno = 0;
    int accessRet = access(commandPath.c_str(), X_OK);
    int accessErrno = accessRet == 0 ? 0 : errno;

    int pipeFd[2] = {-1, -1};
    pid_t child = -1;
    int wstatus = 0;
    int outputSize = 0;
    bool timedOut = false;
    bool childReaped = false;
    char output[8192] = {};

    int headerSize = snprintf(result, sizeof(result),
        "command=%s\nworkDir=%s\nstat=%d errno=%d access(X_OK)=%d errno=%d\n",
        commandLine.c_str(), workDir, statRet, statErrno, accessRet, accessErrno);
    if (headerSize < 0) headerSize = 0;

    do {
        if (pipe(pipeFd) < 0) {
            snprintf(result + headerSize, sizeof(result) - headerSize,
                "pipe failed: errno=%d (%s)\n", errno, strerror(errno));
            break;
        }

        child = fork();
        if (child < 0) {
            snprintf(result + headerSize, sizeof(result) - headerSize,
                "fork failed: errno=%d (%s)\n", errno, strerror(errno));
            break;
        }

        if (child == 0) {
            close(pipeFd[0]);
            if (dup2(pipeFd[1], STDOUT_FILENO) < 0 || dup2(pipeFd[1], STDERR_FILENO) < 0) {
                _exit(126);
            }
            close(pipeFd[1]);
            if (chdir(workDir) != 0) {
                dprintf(STDERR_FILENO, "chdir failed: %s (errno=%d)\n", strerror(errno), errno);
                _exit(126);
            }
            std::vector<char*> childArgv;
            childArgv.push_back(const_cast<char*>(commandName.c_str()));
            for (std::string& arg : commandArgs) childArgv.push_back(const_cast<char*>(arg.c_str()));
            childArgv.push_back(nullptr);
            execve(commandPath.c_str(), childArgv.data(), childEnv.data());
            int execErrno = errno;
            dprintf(STDERR_FILENO, "execve failed: errno=%d (%s)\n", execErrno, strerror(execErrno));
            _exit(127);
        }

        close(pipeFd[1]);
        pipeFd[1] = -1;
        auto start = std::chrono::steady_clock::now();
        constexpr int kTimeoutMs = 10000;

        while (!childReaped) {
            pid_t waitResult = waitpid(child, &wstatus, WNOHANG);
            if (waitResult == child) {
                childReaped = true;
            } else if (waitResult < 0 && errno != EINTR) {
                snprintf(result + headerSize, sizeof(result) - headerSize,
                    "waitpid failed: errno=%d (%s)\n", errno, strerror(errno));
                break;
            }

            if (pipeFd[0] >= 0) {
                struct pollfd pfd = {pipeFd[0], POLLIN | POLLHUP | POLLERR, 0};
                int pollRet = poll(&pfd, 1, 100);
                if (pollRet > 0 && (pfd.revents & (POLLIN | POLLHUP | POLLERR))) {
                    char buffer[1024];
                    ssize_t bytesRead = read(pipeFd[0], buffer, sizeof(buffer));
                    if (bytesRead > 0) {
                        int copySize = bytesRead < static_cast<ssize_t>(sizeof(output) - 1 - outputSize)
                            ? static_cast<int>(bytesRead) : static_cast<int>(sizeof(output) - 1 - outputSize);
                        if (copySize > 0) {
                            memcpy(output + outputSize, buffer, copySize);
                            outputSize += copySize;
                            output[outputSize] = '\0';
                        }
                    } else if (bytesRead == 0) {
                        close(pipeFd[0]);
                        pipeFd[0] = -1;
                    }
                }
            } else {
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            }

            auto elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - start).count();
            if (elapsedMs >= kTimeoutMs && !childReaped) {
                timedOut = true;
                kill(child, SIGKILL);
                waitpid(child, &wstatus, 0);
                childReaped = true;
                break;
            }

            if (pipeFd[0] < 0 && childReaped) break;
        }
    } while (false);

    if (child >= 0 && !childReaped) {
        kill(child, SIGKILL);
        waitpid(child, &wstatus, 0);
    }
    if (pipeFd[0] >= 0) close(pipeFd[0]);
    if (pipeFd[1] >= 0) close(pipeFd[1]);

    int exitCode = WIFEXITED(wstatus) ? WEXITSTATUS(wstatus) : -1;
    int exitSignal = WIFSIGNALED(wstatus) ? WTERMSIG(wstatus) : 0;
    size_t used = strlen(result);
    snprintf(result + used, sizeof(result) - used,
        "timedOut=%s exitCode=%d signal=%d\noutput:\n%s",
        timedOut ? "true" : "false", exitCode, exitSignal, output);

    FileLogger::instance().log("INFO", "third-party command: %s", result);
    FileLogger::instance().flush();

    napi_value napiResult;
    napi_create_string_utf8(env, result, NAPI_AUTO_LENGTH, &napiResult);
    return napiResult;
}

// ── NAPI: runToyboxPtySh ─────────────────────────────────────────────
static napi_value runToyboxPtyShNapi(napi_env env, napi_callback_info info) {
    char result[4096] = {};
    int master = -1;
    pid_t child = -1;
    char slavePath[256] = {};
    int wstatus = 0;

    do {
        errno = 0;
        master = posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC);
        if (master < 0) {
            int e = errno;
            snprintf(result, sizeof(result), "posix_openpt FAIL: errno=%d (%s)", e, strerror(e));
            break;
        }
        grantpt(master);
        unlockpt(master);
        ptsname_r(master, slavePath, sizeof(slavePath));

        child = fork();
        if (child < 0) {
            snprintf(result, sizeof(result), "fork FAIL: errno=%d", errno);
            break;
        }
        if (child == 0) {
            setsid();
            int slave = open(slavePath, O_RDWR);
            if (slave < 0) _exit(1);
            dup2(slave, STDIN_FILENO);
            dup2(slave, STDOUT_FILENO);
            dup2(slave, STDERR_FILENO);
            if (slave > 2) close(slave);

            char path[512];
            snprintf(path, sizeof(path), "%s/toybox-unsigned", g_logDir);
            chmod(path, 0755);
            char* argv[] = { (char*)"toybox", (char*)"sh", nullptr };
            execv(path, argv);
            fprintf(stderr, "EXECVE_FAILED: errno=%d\n", errno);
            _exit(127);
        }

        // Parent: wait briefly
        std::this_thread::sleep_for(std::chrono::seconds(1));
        pid_t w = waitpid(child, &wstatus, WNOHANG);
        if (w == child) {
            if (WIFEXITED(wstatus))
                snprintf(result, sizeof(result), "toybox sh: child exited code=%d (execve may have failed)", WEXITSTATUS(wstatus));
            else if (WIFSIGNALED(wstatus))
                snprintf(result, sizeof(result), "toybox sh: child killed signal=%d", WTERMSIG(wstatus));
        } else {
            snprintf(result, sizeof(result), "toybox sh: child pid=%d running, PTY slave=%s", child, slavePath);
        }
    } while (0);

    if (master >= 0) close(master);
    FileLogger::instance().log("INFO", "toybox-pty: %s", result);
    FileLogger::instance().flush();
    napi_value ret;
    napi_create_string_utf8(env, result, NAPI_AUTO_LENGTH, &ret);
    return ret;
}
static napi_value runToyboxTestNapi(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1] = {nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    char cmdLine[512] = "ls -la /dev/ptmx";
    if (argc > 0 && args[0] != nullptr) {
        napi_valuetype type;
        napi_typeof(env, args[0], &type);
        if (type == napi_string) {
            size_t len;
            napi_get_value_string_utf8(env, args[0], cmdLine, sizeof(cmdLine)-1, &len);
        }
    }

    char path[512];
    snprintf(path, sizeof(path), "%s/toybox", g_logDir);
    chmod(path, 0755);  // ensure executable

    // Build argv: toybox <cmdLine tokens...>
    char* argv[32];
    int argc2 = 0;
    argv[argc2++] = (char*)"toybox";
    char* saveptr;
    char* tok = strtok_r(cmdLine, " ", &saveptr);
    while (tok && argc2 < 31) {
        argv[argc2++] = tok;
        tok = strtok_r(nullptr, " ", &saveptr);
    }
    argv[argc2] = nullptr;

    int pipeOut[2], pipeErr[2];
    char stdout_[8192] = {}, stderr_[4096] = {};
    int totalOut=0, totalErr=0, exitCode=-1, exitSignal=-1;
    char result[10240] = {};

    do {
        if (pipe(pipeOut) < 0 || pipe(pipeErr) < 0) {
            snprintf(result, sizeof(result), "pipe failed: %s", strerror(errno));
            break;
        }

        errno = 0;
        pid_t child = fork();
        if (child < 0) {
            snprintf(result, sizeof(result), "fork failed: %s", strerror(errno));
            close(pipeOut[0]);close(pipeOut[1]);close(pipeErr[0]);close(pipeErr[1]);
            break;
        }
        if (child == 0) {
            close(pipeOut[0]);close(pipeErr[0]);
            dup2(pipeOut[1], STDOUT_FILENO);dup2(pipeErr[1], STDERR_FILENO);
            close(pipeOut[1]);close(pipeErr[1]);
            execv(path, argv);
            int e = errno;
            fprintf(stderr, "EXECVE_FAILED: %s (errno=%d)\n", strerror(e), e);
            fflush(stderr);
            _exit(127);
        }
        close(pipeOut[1]);close(pipeErr[1]);
        auto start = std::chrono::steady_clock::now();
        int wstatus=0;
        while (std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-start).count() < 5000) {
            pid_t w = waitpid(child, &wstatus, WNOHANG);
            if (w == child) {
                if (WIFEXITED(wstatus)) exitCode = WEXITSTATUS(wstatus);
                if (WIFSIGNALED(wstatus)) exitSignal = WTERMSIG(wstatus);
                break;
            }
            struct pollfd pfd;
            pfd.fd = pipeOut[0]; pfd.events = POLLIN;
            if (poll(&pfd,1,100)>0 && (pfd.revents&POLLIN) && totalOut < (int)sizeof(stdout_)-1)
                { ssize_t n=read(pipeOut[0],stdout_+totalOut,sizeof(stdout_)-1-totalOut); if(n>0) totalOut+=n; }
            pfd.fd = pipeErr[0];
            if (poll(&pfd,1,0)>0 && (pfd.revents&POLLIN) && totalErr < (int)sizeof(stderr_)-1)
                { ssize_t n=read(pipeErr[0],stderr_+totalErr,sizeof(stderr_)-1-totalErr); if(n>0) totalErr+=n; }
            std::this_thread::sleep_for(std::chrono::milliseconds(30));
        }
        close(pipeOut[0]);close(pipeErr[0]);
        snprintf(result, sizeof(result), "exit=%d signal=%d\nSTDOUT:\n%s\nSTDERR:\n%s",
            exitCode, exitSignal, stdout_, stderr_);
    } while (0);

    FileLogger::instance().log("INFO", "toybox [%s] exit=%d signal=%d out=%s err=%s",
        cmdLine, exitCode, exitSignal, stdout_, stderr_);
    FileLogger::instance().flush();

    napi_value ret;
    napi_create_string_utf8(env, result, NAPI_AUTO_LENGTH, &ret);
    return ret;
}

// ── NAPI: runAllElfTests ───────────────────────────────────────────
static napi_value runAllElfTestsNapi(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1] = {nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    auto* wd = new PtyTestWorkData();
    wd->shellControlTest = false;
    wd->forkptyTest = false;
    wd->recoveryTest = false;
    wd->attrCheckTest = false;
    wd->batchOpenTest = false;
    wd->holdOpenTest = false;
    wd->elfAllTest = true;

    napi_value promise;
    napi_create_promise(env, &wd->deferred, &promise);

    napi_value resourceName;
    napi_create_string_utf8(env, "ElfAllTest", NAPI_AUTO_LENGTH, &resourceName);
    napi_create_async_work(env, nullptr, resourceName,
        ptyTestExecute, ptyTestComplete, wd, &wd->work);
    napi_queue_async_work(env, wd->work);

    return promise;
}

// ── NAPI: collectSystemState ──────────────────────────────────────
static napi_value collectSystemStateNapi(napi_env env, napi_callback_info info) {
    SystemStateSnapshot state;
    collectSystemState(state, true, true);

    napi_value obj;
    napi_create_object(env, &obj);

    auto setInt = [&](const char* key, int val) {
        napi_value v;
        napi_create_int32(env, val, &v);
        napi_set_named_property(env, obj, key, v);
    };
    auto setStr = [&](const char* key, const char* val) {
        napi_value v;
        napi_create_string_utf8(env, val, NAPI_AUTO_LENGTH, &v);
        napi_set_named_property(env, obj, key, v);
    };

    setInt("pid", state.pid);
    setInt("ppid", state.ppid);
    setInt("uid", state.uid);
    setInt("euid", state.euid);
    setInt("gid", state.gid);
    setInt("egid", state.egid);
    setInt("tid", state.tid);
    setInt("fdCount", state.fdCount);
    setStr("cwd", state.cwd);
    setStr("ptyNr", state.ptyNr);
    setStr("ptyMax", state.ptyMax);
    setStr("ptyReserve", state.ptyReserve);
    setStr("selinuxCurrent", state.selinuxCurrent);
    setStr("devStat", state.devStat);
    setStr("devLstat", state.devLstat);
    setStr("ptmxStat", state.ptmxStat);
    setStr("ptmxLstat", state.ptmxLstat);
    setStr("ptmxReadlink", state.ptmxReadlink);
    setStr("devPtsStat", state.devPtsStat);
    setStr("devPtsPtmxStat", state.devPtsPtmxStat);

    return obj;
}

// ── NAPI: getLogFilePath ──────────────────────────────────────────
static napi_value getLogFilePath(napi_env env, napi_callback_info info) {
    napi_value result;
    napi_create_string_utf8(env, FileLogger::instance().latestLogPath(),
        NAPI_AUTO_LENGTH, &result);
    return result;
}

// ── NAPI: triggerCrashForTesting ──────────────────────────────────
static napi_value triggerCrashForTesting(napi_env env, napi_callback_info info) {
    // Fill crash context with test values
    memset((void*)&g_crashContext, 0, sizeof(g_crashContext));
    g_crashContext.magic = PTY_CRASH_MAGIC;
    g_crashContext.testId = -999;
    g_crashContext.failedStep = -1;
    g_crashContext.savedErrno = 0;
    g_crashContext.pid = getpid();
    g_crashContext.uid = getuid();
    g_crashContext.gid = getgid();
    strncpy((char*)g_crashContext.failedStepName, "MANUAL_CRASH_TEST", sizeof(g_crashContext.failedStepName) - 1);
    strncpy((char*)g_crashContext.errnoMessage, "Manual crash trigger via NAPI", sizeof(g_crashContext.errnoMessage) - 1);

    OH_LOG_FATAL(LOG_APP, "PTY_DIAG: Manual crash test trigger. Magic=0x%{public}016llX",
        (unsigned long long)PTY_CRASH_MAGIC);

    FileLogger::instance().log("FATAL", "Manual crash test triggered");
    FileLogger::instance().fsyncLatest();

    abort();
    return nullptr; // unreachable
}

// ── Threadsafe function for continuous test callback ──────────────
struct ContinuousCbData {
    napi_threadsafe_function tsfn;
    PtyTestResult result;
    int successCount;
    int failureCount;
    int totalCount;
    PtmxAttrResult attr;  // attr check at time of test
};

static void continuousTestThreadFunc(napi_env env, napi_value js_cb,
                                     void* context, void* data) {
    ContinuousCbData* cbData = static_cast<ContinuousCbData*>(data);
    if (!cbData) return;

    napi_value resultObj = resultToNapi(env, cbData->result);

    // Add attr info
    napi_value attrObj;
    napi_create_object(env, &attrObj);
    auto setInt2 = [&](const char* key, int val) {
        napi_value v; napi_create_int32(env, val, &v);
        napi_set_named_property(env, attrObj, key, v);
    };
    setInt2("accessR", cbData->attr.accessR);
    setInt2("accessW", cbData->attr.accessW);
    setInt2("openRet", cbData->attr.openRet);
    setInt2("openErrno", cbData->attr.openErrno);
    setInt2("statErrno", cbData->attr.statErrno);
    napi_value v;
    napi_create_string_utf8(env, cbData->attr.selinuxContext, NAPI_AUTO_LENGTH, &v);
    napi_set_named_property(env, attrObj, "selinuxContext", v);
    napi_set_named_property(env, resultObj, "attr", attrObj);

    // Also pass aggregated counts
    napi_value counts;
    napi_create_object(env, &counts);
    auto setInt = [&](const char* key, int val) {
        napi_value v;
        napi_create_int32(env, val, &v);
        napi_set_named_property(env, counts, key, v);
    };
    setInt("successCount", cbData->successCount);
    setInt("failureCount", cbData->failureCount);
    setInt("totalCount", cbData->totalCount);
    napi_set_named_property(env, resultObj, "counts", counts);

    napi_value global;
    napi_get_global(env, &global);
    napi_call_function(env, global, js_cb, 1, &resultObj, nullptr);

    delete cbData;
}

static void callContinuousCallback(napi_env env, napi_threadsafe_function tsfn,
                                   const PtyTestResult& result,
                                   int successCount, int failureCount, int totalCount,
                                   const PtmxAttrResult& attr) {
    auto* data = new ContinuousCbData();
    data->tsfn = tsfn;
    data->result = result;
    data->successCount = successCount;
    data->failureCount = failureCount;
    data->totalCount = totalCount;
    data->attr = attr;
    napi_call_threadsafe_function(tsfn, data, napi_tsfn_blocking);
}

// ── Continuous test runner (runs in dedicated thread) ─────────────
static std::thread g_continuousThread;
static napi_threadsafe_function g_continuousTsfn = nullptr;

static void continuousTestLoop() {
    int localSuccess = 0;
    int localFailure = 0;
    int localTotal = 0;

    while (g_continuousState.running.load()) {
        PtyTestOptions opts;
        opts.crashOnFailure = false;
        opts.performReadWriteTest = true;
        opts.collectMountInfo = true;
        opts.collectSelinuxInfo = true;
        opts.fsyncOnEveryStep = false;

        PtyTestResult result;
        PtmxAttrResult attr;
        checkPtmxAttributes(attr);
        runForkptyTest(opts, result);

        localTotal++;
        if (result.success) localSuccess++;
        else localFailure++;

        g_continuousState.successCount.store(localSuccess);
        g_continuousState.failureCount.store(localFailure);
        g_continuousState.totalCount.store(localTotal);

        // Log to buffer
        {
            std::lock_guard<std::mutex> lock(g_continuousState.logMutex);
            char entry[512];
            snprintf(entry, sizeof(entry), "[#%d] %s step=%s errno=%d masterFd=%d slaveFd=%d",
                result.testId,
                result.success ? "OK" : "FAIL",
                stepName(result.failedStep),
                result.errno_,
                result.masterFd,
                result.slaveFd);
            g_continuousState.logBuffer.push_back(entry);
            // Trim if needed
            while ((int)g_continuousState.logBuffer.size() > g_continuousState.maxLogEntries) {
                g_continuousState.logBuffer.erase(g_continuousState.logBuffer.begin());
            }
        }

        // Call back to ArkTS via threadsafe function
        if (g_continuousTsfn) {
            callContinuousCallback(nullptr, g_continuousTsfn, result, localSuccess, localFailure, localTotal, attr);
        }

        // Sleep for the interval
        int intervalMs = g_continuousState.intervalMs.load();
        auto sleepEnd = std::chrono::steady_clock::now() + std::chrono::milliseconds(intervalMs);
        while (g_continuousState.running.load() &&
               std::chrono::steady_clock::now() < sleepEnd) {
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
    }
}

// ── NAPI: startContinuousTest ─────────────────────────────────────
static napi_value startContinuousTest(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2] = {nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    // Check if already running
    if (g_continuousState.running.load()) {
        napi_value err;
        napi_create_string_utf8(env, "Continuous test already running", NAPI_AUTO_LENGTH, &err);
        napi_throw_error(env, nullptr, "Continuous test already running");
        napi_value result;
        napi_create_int32(env, -1, &result);
        return result;
    }

    // Parse interval from options (arg 0)
    int intervalMs = 1000;
    if (argc > 0 && args[0] != nullptr) {
        napi_valuetype type;
        napi_typeof(env, args[0], &type);
        if (type == napi_object) {
            napi_value val;
            if (napi_get_named_property(env, args[0], "intervalMs", &val) == napi_ok) {
                napi_get_value_int32(env, val, &intervalMs);
            }
            if (napi_get_named_property(env, args[0], "maxLogEntries", &val) == napi_ok) {
                napi_get_value_int32(env, val, &g_continuousState.maxLogEntries);
            }
        }
    }

    // Setup threadsafe function for callback (arg 1)
    if (argc > 1 && args[1] != nullptr) {
        napi_value resName;
        napi_create_string_utf8(env, "ContinuousPtyCallback", NAPI_AUTO_LENGTH, &resName);
        napi_create_threadsafe_function(env, args[1], nullptr, resName,
            0, 1, nullptr, nullptr, nullptr,
            continuousTestThreadFunc, &g_continuousTsfn);
    }

    g_continuousState.intervalMs.store(intervalMs);
    g_continuousState.running.store(true);
    g_continuousState.successCount.store(0);
    g_continuousState.failureCount.store(0);
    g_continuousState.totalCount.store(0);
    {
        std::lock_guard<std::mutex> lock(g_continuousState.logMutex);
        g_continuousState.logBuffer.clear();
    }

    int taskId = ++g_continuousState.taskId;
    g_continuousState.taskId.store(taskId);

    // Start worker thread
    g_continuousThread = std::thread(continuousTestLoop);
    g_continuousThread.detach();

    napi_value result;
    napi_create_int32(env, taskId, &result);
    return result;
}

// ── NAPI: stopContinuousTest ──────────────────────────────────────
static napi_value stopContinuousTest(napi_env env, napi_callback_info info) {
    g_continuousState.running.store(false);

    // Release threadsafe function
    if (g_continuousTsfn) {
        napi_release_threadsafe_function(g_continuousTsfn, napi_tsfn_release);
        g_continuousTsfn = nullptr;
    }

    napi_value result;
    napi_get_boolean(env, true, &result);
    return result;
}

// ── NAPI: initLogDir ──────────────────────────────────────────────
static napi_value initLogDir(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1] = {nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    if (argc > 0 && args[0] != nullptr) {
        size_t len;
        napi_get_value_string_utf8(env, args[0], g_logDir, sizeof(g_logDir) - 1, &len);
        FileLogger::instance().init(g_logDir);
        OH_LOG_INFO(LOG_APP, "PTY_DIAG log initialized at: %{public}s", g_logDir);
    }

    napi_value result;
    napi_get_boolean(env, true, &result);
    return result;
}

// ── Module registration ───────────────────────────────────────────
EXTERN_C_START
static napi_value Init(napi_env env, napi_value exports)
{
    napi_property_descriptor desc[] = {
        { "runPtyTest", nullptr, runPtyTest, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "runShellControlTest", nullptr, runShellControlTestNapi, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "runForkptyTest", nullptr, runForkptyTestNapi, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "runRecoveryTest", nullptr, runRecoveryTestNapi, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "checkPtmxAttributes", nullptr, checkPtmxAttributesNapi, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "runBatchOpenTest", nullptr, runBatchOpenTestNapi, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "runHoldOpenTest", nullptr, runHoldOpenTestNapi, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "runAllElfTests", nullptr, runAllElfTestsNapi, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "runUsbDdkTest", nullptr, runUsbDdkTestNapi, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "runRawUsbTest", nullptr, runRawUsbTestNapi, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "startUsbProxy", nullptr, startUsbProxyNapi, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "logToFile", nullptr, logToFileNapi, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "runToyboxTest", nullptr, runToyboxTestNapi, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "runToyboxDirect", nullptr, runToyboxDirectNapi, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "runThirdPartyCommand", nullptr, runThirdPartyCommandNapi, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "runToyboxPtySh", nullptr, runToyboxPtyShNapi, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "runAbstractSocketTest", nullptr, runAbstractSocketTestNapi, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "runUnixPeerCredTest", nullptr, runUnixPeerCredTestNapi, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "runAbstractSocketServer", nullptr, runAbstractSocketServerNapi, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "runFileSocketServer", nullptr, runFileSocketServerNapi, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "startContinuousTest", nullptr, startContinuousTest, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "stopContinuousTest", nullptr, stopContinuousTest, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "collectSystemState", nullptr, collectSystemStateNapi, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "getLogFilePath", nullptr, getLogFilePath, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "triggerCrashForTesting", nullptr, triggerCrashForTesting, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "initLogDir", nullptr, initLogDir, nullptr, nullptr, nullptr, napi_default, nullptr },
    };
    napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
    return exports;
}
EXTERN_C_END

static napi_module demoModule = {
    .nm_version = 1,
    .nm_flags = 0,
    .nm_filename = nullptr,
    .nm_register_func = Init,
    .nm_modname = "entry",
    .nm_priv = ((void*)0),
    .reserved = { 0 },
};

extern "C" __attribute__((constructor)) void RegisterEntryModule(void)
{
    napi_module_register(&demoModule);
}
