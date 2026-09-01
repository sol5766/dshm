# skill: 设备 / hdc 调试

适用：`hdc`/`hdb`、连接、HAP 安装、启动/停止应用、HiLog、bugreport、`aa appdebug`。

## 要点

- `hdc` 与 target 由环境/参数显式传入，不硬编码具体设备；参考 `scripts/ui-test-phone.sh`。
- 安装 `bm install -p <hap>`；启动 `aa start -a EntryAbility -b <bundle>`。
- 冷启动/探活排查看物理机日志：`~/dshm-launcher.log`（ArkTS 流程 + NAPI + readiness）、`~/dshm-dsh-web.log`（dsh stderr）。
- `ARKTS: discovering...` 后无下文 = 探活阶段；`launchDsh NAPI invoked` 后无 `dsh web ready` = 子进程拉起阶段。
