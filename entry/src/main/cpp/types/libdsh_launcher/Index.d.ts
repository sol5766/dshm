// Type definitions for libdsh_launcher.so — 外部 DSH 服务启动器
// launchDsh(): 应用主进程内 fork+exec dsh web（继承主进程网络命名空间，
// 使 127.0.0.1:3080 对 ArkWeb 可见）。启动结果异步写入
// <filesDir>/tmp/dsh-service-result.json，由 ArkTS 侧轮询。
export const launchDsh: () => number;
// installBrew(): 应用主进程内安装 Harmonybrew。进度写入
// <filesDir>/log/install-brew-*.log，结果写入 <filesDir>/tmp/install-brew-result.json
export const installBrew: () => number;
// installDsh(): 应用主进程内安装 DeepSeek Harness（缺失 brew 时自动先装 brew）。
// 进度写入 <filesDir>/log/install-dsh-*.log，结果写入 <filesDir>/tmp/install-dsh-result.json
export const installDsh: () => number;
