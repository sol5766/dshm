---
name: ohos-workspace
description: DSHM 工作区授权与同步语义：鸿蒙公共目录如何进入 dsh 可读写视野。涉及工作区、个人磁盘、文档目录时阅读。
whenToUse: 模型需要读写工作区/用户目录，或用户提到"工作区设置、个人磁盘授权"时。
---

# DSHM 工作区（授权 → 同步）

## 链路
1. 用户通过系统目录选择器（DocumentViewPicker）选择目录（文件管理器里的"个人磁盘/文档"等），DSHM 对 URI 做持久授权。
2. 每次启动自动把授权目录内容**复制同步**到沙箱 `<files>/workspace`（node 子进程无法直接以 URI 读写公共目录）。
3. DSH 会话只能读写沙箱路径：工作区文件走 `<files>/workspace/`，授权目录可理解为单向快照。

## 会话内约定
- 需要读写工作区内容时，路径用 `<workspace>/<相对路径>`，不要用 `file://` 或 `/storage/...` URI。
- 变更不会反向写回用户选择目录。若需要把文件"搬到"用户目录，通过 DSHM 的导出/保存流，不直接写 `/storage`。
- 未授权时 `<workspace>` 为空；授权段新增在设置 → 鸿蒙适配里可见。

## 只读探查
- `ls /storage/media /storage/cloud` 等只读探查受权限限制可能报错——此时直接提示"无权限"，不要反复强试。