# skill: 运行时错误 / 崩溃排查

适用：冷启动探活挂死、ArkWeb 白屏、NAPI 拉起异常、安装进程报错、faultlog/hilog。

## 排查路径

1. 看日志：`~/dshm-launcher.log`、`~/dshm-dsh-web.log`、`~/dshm-install-*.log`。
2. 判断阶段：`discovering` / `launchDsh NAPI invoked` / `dsh web ready`。
3. 结合 `AGENTS.md` 的架构约束判断是否属「netns / 用户目录视图 / cwd / 探活挂死」。

## 常见根因

- 探活阶段：冷启动 `@ohos.net.http` 悬挂 → 改 TCP socket 探测 + 指纹。
- 拉起阶段：child netns 隔离 → 用主进程 NAPI `fork+exec`。
- 安装检测：主进程 `access()` 不可靠 → 在 fork 子进程上下文检测。
- brew cwd 报错 → 子进程先 `cd "$HOME"`。
- W^X / `--jitless`：node 22 内置 undici 的 llhttp（WASM）崩 → node 24+ 修复。

## 提醒

- 修改前先备份（`.bak`）；修复后自查 ArkTS / 本文件 / AGENTS.md 约束。
