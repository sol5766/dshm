# Bug 档案

> 只在确认复现并定位后追加；新增 bug 先加 `## [日期] 现象` 再从下往上排。

## 已知陷阱（复现摘要）

- **child netns 隔离**：`startNativeChildProcess` 子进程监听 `127.0.0.1`，ArkWeb 连不上 → 主进程 NAPI `fork+exec`。
- **用户目录视图**：`/storage/Users` 按任务隔离，主进程 `access()` 误报未安装 → 子进程上下文检测。
- **brew cwd 拒绝**：应用主进程 cwd 不可读 → 所有子进程先 `cd "$HOME"`。
- **冷启动 http 悬挂**：网络栈未就绪时 `@ohos.net.http` 永久挂 → 先 TCP socket 探测再 http 指纹。
- **W^X / undici WASM**：node 22 `--jitless` 下 `WebAssembly is not defined` → node 24+。
