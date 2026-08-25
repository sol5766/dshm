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
// checkInstall(): 检测 Harmonybrew / DeepSeek Harness 安装状态。
// 在 fork 子进程（自定义沙箱上下文，与 install/launch 同一 /storage/Users 视图）
// 里执行检测，主进程直接 access 会误报未安装。
// 同步返回 JSON 字符串：{"brewInstalled":boolean,"dshInstalled":boolean,"dshPath":string}
export const checkInstall: () => string;
// stopDsh(pid): 停止自启动的 dsh 进程（SIGTERM）。dsh 经 setsid 脱离进程组，
// 应用退出后可能残留占用 3080，必须显式停止。返回 kill(2) 的返回值。
export const stopDsh: (pid: number) => number;
// physTrace(msg): 把 ArkTS 侧消息镜像到物理机 ~/dshm-launcher.log（best-effort）。
// 用于冷启动流程端到端定位，终端可直接读取。
export const physTrace: (msg: string) => void;
