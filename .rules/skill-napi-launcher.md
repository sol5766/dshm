# skill: NAPI 拉起 / 子进程

适用：`entry/src/main/cpp/**`、`entry/src/main/ets/hdsh/service/**`、`entry/src/main/ets/hdsh/install/**`。

## 不可破坏的约束

- **网络命名空间**：`childProcessManager.startNativeChildProcess` 拉起的 native 子进程在独立 netns，
  其监听 `127.0.0.1` 对 ArkWeb 不可见。必须用 **NAPI 在应用主进程内 `fork+exec`**（见 `dsh_launcher.cpp`），
  子进程继承主进程网络空间，ArkWeb 才可接入。
- **用户目录视图**：`/storage/Users` 是 `hmmac=use_task` 按任务隔离视图。主进程 `access()` 用户目录不可靠，
  安装/检测/拉起应统一在 fork 子进程（自定义沙箱）上下文做，以子进程为准。
- **cwd**：brew / dsh 等工具链子进程先 `cd "$HOME"` 再执行，否则 `brew` 报不可读 cwd 退出。
- **进程清理**：`dsh` 经 `setsid` 脱离进程组，应用退出可能残留占端口，需显式 SIGTERM（`stopDsh`）。
- **探活顺序**：冷启动先用 `@ohos.net.socket` TCP 探测（硬超时、不占主线程），端口开放再做 http 指纹校验；
  `@ohos.net.http` 在网络栈未就绪时可能永久悬挂。

## 检查点

- 新增 NAPI 函数后同步 `types/libdsh_launcher/Index.d.ts` 与 `CMakeLists.txt`。
- 子进程产物落盘到 `<filesDir>/tmp/`，ArkTS 侧轮询读取；不要在主线程阻塞等待。
