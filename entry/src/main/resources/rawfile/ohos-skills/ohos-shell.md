---
name: ohos-shell
description: HarmonyOS 命令行工具环境（toybox/busybox 语义，zsh/brew 位于特权目录、应用沙箱不可直接调用）。在 HarmonyOS PC 设备上规划 shell 操作时阅读。
whenToUse: 需要运行 shell 命令、安装工具、解释 .zshrc/.bashrc 或 brew 安装命令时。
---

# HarmonyOS shell 工具环境（DSHM 真实布局）

本机命令解释环境与常见 Linux 发行版不同，以下事实务必遵守：

## 两层视图
- **系统终端（开发者模式 / root pty）**：可以访问 `/usr/local`（含 `/usr/local/Homebrew` 与 `/usr/local/bin/zsh` 等），zsh、brew 在此可用且真实存在。
- **应用沙箱（DSHM 运行层，uid 2000）**：没有这些命令，也读不了 `/usr/local`（实测 `ls /usr/local` 返回 Permission denied）。dsh 的 bash 会话只能使用以下基础环境。

## 基础环境（沙箱内可用）
- `/system/bin` 由 toybox 提供 ls/cat/grep/sed/awk/tar/gzip/curl 等 400+ 常用命令。
- 本包额外内置 busybox：`ash` `bash` `hush` `bzip2` `xz` `hexdump` `less` `nc` `unzip` `vi`。
- 交互式 shell 为 bash（toybox/busybox 语义，非 GNU bash 全功能）。

## 规划时的正确姿势
- 沙箱内 `command -v` 探测不到命令时，不代表系统未安装：先区分「沙箱隔离」与「系统缺失」。
- 需确认系统是否真实存在该工具时，通过 root/开发者终端核实（如 `ls /usr/local/bin`）。
- 需要 zsh/brew 的能力时，走系统终端，或把产物复制进沙箱工作区再加工，而不是在沙箱里重新发明。