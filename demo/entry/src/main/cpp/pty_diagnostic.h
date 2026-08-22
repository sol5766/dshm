#ifndef PTY_DIAGNOSTIC_H
#define PTY_DIAGNOSTIC_H

#include <cstdint>
#include <ctime>
#include <string>
#include <vector>
#include <atomic>
#include <mutex>
#include <sys/types.h>

// ── Crash context magic ───────────────────────────────────────────
// Search for this in crash dumps: 0x505459444941474E
// ASCII: "PTYDIAGN" (little-endian interpretation)
constexpr uint64_t PTY_CRASH_MAGIC = 0x505459444941474EULL;

// ── Test step enumeration ─────────────────────────────────────────
enum class PtyTestStep {
    NONE = 0,
    PRECHECK,
    STAT_DEV,
    STAT_PTMX,
    STAT_DEV_PTS,
    STAT_DEV_PTS_PTMX,
    POSIX_OPENPT,
    GRANTPT,
    UNLOCKPT,
    PTSNAME_R,
    OPEN_SLAVE,
    TCGETATTR_MASTER,
    TCGETATTR_SLAVE,
    STEP_TIOCGWINSZ,
    STEP_TIOCSWINSZ,
    WRITE_MASTER,
    READ_SLAVE,
    WRITE_SLAVE,
    READ_MASTER,
    CLOSE_SLAVE,
    CLOSE_MASTER,
    FD_LEAK_CHECK,
    COLLECT_SYSTEM_STATE,
    CHILD_FORKPTY_RECOVERY,
    PTMX_ATTR_CHECK,
    BATCH_OPEN,
    HOLD_OPEN,
    COMPLETED
};

// ── Step result ───────────────────────────────────────────────────
struct PtyStepResult {
    PtyTestStep step;
    bool success;
    int result;          // syscall return value
    int savedErrno;      // errno saved immediately after call
    char stepName[64];
    char errnoMessage[128];
    char details[1024];
    int64_t durationUs;  // microseconds
};

// ── System state snapshot ─────────────────────────────────────────
struct SystemStateSnapshot {
    int pid;
    int ppid;
    uid_t uid;
    uid_t euid;
    gid_t gid;
    gid_t egid;
    int tid;
    int fdCount;
    char cwd[512];
    char procStatus[4096];
    char procCmdline[1024];
    char procLimits[2048];
    char mountInfo[8192];
    char mounts[4096];
    char ptyNr[64];
    char ptyMax[64];
    char ptyReserve[64];
    char selinuxCurrent[256];
    // Per-path stat info
    char devStat[512];
    char devLstat[512];
    char ptmxStat[512];
    char ptmxLstat[512];
    char devPtsStat[512];
    char devPtsLstat[512];
    char devPtsPtmxStat[512];
    char devPtsPtmxLstat[512];
    char ptmxReadlink[256];
    int devAccessR;
    int devAccessW;
    int devAccessX;
    int ptmxAccessR;
    int ptmxAccessW;
    int ptmxAccessX;
    int devPtsAccessR;
    int devPtsAccessW;
    int devPtsAccessX;
};

// ── Full test result ──────────────────────────────────────────────
struct PtyTestResult {
    int testId;
    bool success;
    bool crashOnFailure;
    PtyTestStep failedStep;
    int errno_;
    char errnoMessage[128];
    int masterFd;
    int slaveFd;
    char slavePath[256];
    char startedAt[64];
    char finishedAt[64];
    int64_t durationUs;
    std::vector<PtyStepResult> steps;
    SystemStateSnapshot stateBefore;
    SystemStateSnapshot stateAfter;
    char reportPath[512];
};

// ── Crash context (global, volatile) ──────────────────────────────
struct PtyCrashContext {
    uint64_t magic;
    int testId;
    int failedStep;
    int result;
    int savedErrno;
    int masterFd;
    int slaveFd;
    pid_t pid;
    uid_t uid;
    gid_t gid;
    char failedStepName[64];
    char errnoMessage[128];
    char slavePath[256];
    char mountInfoSummary[2048];
    char ptmxStatSummary[1024];
};

// Global crash context - marked volatile to prevent optimization
extern volatile PtyCrashContext g_crashContext;

// ── /dev/ptmx attribute check result ──────────────────────────
struct PtmxAttrResult {
    bool pathExists;       // access(F_OK)
    int accessR;           // access(R_OK)
    int accessW;           // access(W_OK)
    int accessX;           // access(X_OK)
    int statRet;           // stat() return
    int statErrno;
    int lstatRet;          // lstat() return
    int lstatErrno;
    int openRet;           // open() return (test open+close immediately)
    int openErrno;
    char statDetail[512];
    char lstatDetail[512];
    char readlinkResult[256];
    char mountInfoDevPts[4096]; // grep devpts from mountinfo
    char mountInfoDev[4096];    // grep /dev from mountinfo
    char selinuxContext[256];
    int fdCount;
};

// ── Batch open test result ────────────────────────────────────
struct BatchOpenResult {
    int totalCount;
    int successCount;
    int failureCount;
    int firstFailureIndex;  // -1 if all success
    int firstFailureErrno;
    int lastSuccessFd;
    int consecutiveSuccesses; // count before first failure
    int consecutiveFailures;  // count after first failure
    int64_t totalDurationUs;
    int64_t avgOpenUs;
    int fdLeak;
};

// ── Hold-open test result ─────────────────────────────────────
struct HoldOpenResult {
    int fd;
    bool openSuccess;
    int openErrno;
    int holdSeconds;
    bool interrupted;
    bool stillValidAtEnd;   // fd still usable?
    int checkCount;         // how many times we re-checked
    int checkFailures;      // how many checks failed
    int firstCheckFailureAtSec; // when did it start failing
};
// HoldOpenResult ─────────────────────────────────────────────────────

// ── ELF execution test result ──────────────────────────────────────
struct ElfExecResult {
    char source[64];
    char expectedSignState[16];
    char filePath[512];
    char sha256[65];
    bool hasCodesignSection;
    int chmodRet;
    int chmodErrno;
    int execveRet;
    int execveErrno;
    char execveMsg[256];
    char stdout_[4096];
    char stderr_[4096];
    int exitCode;
    int exitSignal;
    char conclusion[256];
};

struct AllElfResults {
    ElfExecResult tests[4];
    int testCount;
    char summary[1024];
};

struct PtyTestOptions {
    bool crashOnFailure;
    bool performReadWriteTest;
    bool collectMountInfo;
    bool collectSelinuxInfo;
    bool fsyncOnEveryStep;
};

// ── Continuous test state ─────────────────────────────────────────
struct ContinuousTestState {
    std::atomic<bool> running{false};
    std::atomic<int> taskId{0};
    std::atomic<int> intervalMs{1000};
    std::atomic<int> successCount{0};
    std::atomic<int> failureCount{0};
    std::atomic<int> totalCount{0};
    int maxLogEntries = 10000;
    std::mutex logMutex;
    std::vector<std::string> logBuffer;
};

// ── Utility functions ─────────────────────────────────────────────
const char* stepName(PtyTestStep step);
const char* stepDescription(PtyTestStep step);
void saveErrnoImmediately(int& savedErrno);
int64_t timeNowUs();
void getTimestamp(char* buf, size_t size);
int countOpenFds();

// ── Core test functions ───────────────────────────────────────────
void collectSystemState(SystemStateSnapshot& state, bool collectMount, bool collectSelinux);
void runFullPtyTest(const PtyTestOptions& options, PtyTestResult& result);
void runShellControlTest(PtyTestResult& result);
void runForkptyTest(const PtyTestOptions& options, PtyTestResult& result);
void runRecoveryTest(PtyTestResult& result);
void checkPtmxAttributes(PtmxAttrResult& attr);
void runBatchOpenTest(int count, int intervalMs, bool closeBetween, bool parallel,
                      PtyTestResult& result, BatchOpenResult& batch);
void runHoldOpenTest(int holdSeconds, PtyTestResult& result, HoldOpenResult& hold);
void runElfExecTest(const char* sourceLabel, const char* expectedSign, const char* filePath,
                    ElfExecResult& elfResult);
void runAllElfTests(const char* rawfileDir, AllElfResults& all);

// ── File logging ──────────────────────────────────────────────────
class FileLogger {
public:
    static FileLogger& instance();
    void init(const char* logDir);
    void log(const char* level, const char* format, ...) __attribute__((format(printf, 3, 4)));
    void logStep(int testId, const PtyStepResult& step, const char* mode);
    void flush();
    void fsyncLatest();
    void rotate();
    const char* latestLogPath() const { return latestPath_; }
    const char* historyLogPath() const { return historyPath_; }
    const char* crashLogPath() const { return crashPath_; }
    void createReport(const PtyTestResult& result, char* outPath, size_t size);

private:
    FileLogger() = default;
    char logDir_[512] = {};
    char latestPath_[512] = {};
    char historyPath_[512] = {};
    char crashPath_[512] = {};
    FILE* latestFile_ = nullptr;
    FILE* historyFile_ = nullptr;
    std::mutex mutex_;
    int64_t historyBytesWritten_ = 0;
    static constexpr int64_t kMaxHistorySize = 10 * 1024 * 1024; // 10 MB
};

#endif // PTY_DIAGNOSTIC_H
