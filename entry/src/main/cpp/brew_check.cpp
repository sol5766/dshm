/**
 * libbrew_check.so — 检测 Harmonybrew 与 deepseek-harness 安装状态。
 *
 * 由 ArkTS 层通过 childProcessManager.startNativeChildProcess 启动。
 * 检测结果写入 <filesDir>/tmp/brew-check-result.json，ArkTS 侧轮询读取。
 *
 * 检测逻辑：
 *   1. $HOME/.harmonybrew/bin/brew 是否存在 → brewInstalled
 *   2. $HOME/.harmonybrew/bin/dsh 是否存在 → dshInstalled
 *   3. 读取 dsh 路径 → dshPath
 */
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include "common/child_process_utils.h"

extern "C" __attribute__((visibility("default"))) void Main() {
    // entryParams contains filesDir for result writing
    std::string home = GetHomeDir();
    std::string brewBin = home + "/.harmonybrew/bin/brew";
    std::string dshBin = home + "/.harmonybrew/bin/dsh";

    bool brewInstalled = FileExists(brewBin);
    bool dshInstalled = FileExists(dshBin);

    // Try to detect dsh via PATH as fallback
    std::string dshPath = "";
    if (dshInstalled) {
        dshPath = dshBin;
    }

    // Write JSON result
    std::string json = "{";
    json += "\"brewInstalled\":" + std::string(brewInstalled ? "true" : "false") + ",";
    json += "\"dshInstalled\":" + std::string(dshInstalled ? "true" : "false") + ",";
    json += "\"dshPath\":\"" + dshPath + "\"";
    json += "}";

    WriteResultFile("brew-check-result.json", json);
}
