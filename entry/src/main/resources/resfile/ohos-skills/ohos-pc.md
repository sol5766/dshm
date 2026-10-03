---
name: ohos-pc
description: HarmonyOS PC 设备实况（设备形态、个人磁盘入口、存储与权限边界）。在本会话目标为 HarmonyOS PC 设备时阅读。
whenToUse: 用户提及"鸿蒙设备/个人磁盘/大小屏/沙箱"时；建模设备存储前先读本技能。
---

# HarmonyOS PC 设备实况（DSHM）

DSHM 当前运行在 HarmonyOS PC（OpenHarmony 内核 Linux aarch64）上。
模型在执行任何"本机操作"前，先对照本文件核对事实，避免使用不存在的能力。

## 设备与存储

- 个人磁盘入口：`/storage/media`（多媒体/下载）、`/storage/cloud`（云盘）。普通授权下可读，写入需用户授权；不要假定可以自由写入公共目录（本应用自己认领的 `Download/<包名>/` 是例外，见下条）。
- 应用沙箱：DSHM 只能自由读写自己的沙箱目录（HOME）。公共目录按**包名归属**：属于本应用的 `Download/<包名>/` 可直接按路径读写，其它包名的目录会被系统拒绝。
- 工作区就是本应用认领到的 `Download/<包名>/`，**按路径**直接读写（相对会话 cwd，或普通绝对路径 `/storage/.../Download/<包名>/...`）——没有"同步到沙箱副本"这回事。写不进时的三步顺序（工作区 → 沙箱 → `publish` 发布）见 ohos-workspace.md。

## 权限与安全
- 涉及系统状态（重启、删除、配置修改）的命令先确认影响范围，读取选明确"看"优先。
- 沙箱内禁止 symlink/hardlink；需要多命令时优先用 `cp` 复制语义或 `busybox` 工具。

## 常用适配
- 系统工具的完整视图（含 zsh/brew，位于 /usr/local 等特权目录）只在系统终端/开发者会话中可见；沙箱内视图与受限事实见 ohos-shell.md。