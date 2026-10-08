---
name: ohos-shell
description: HarmonyOS 命令行工具环境（toybox/busybox 语义，zsh/brew 位于特权目录、应用沙箱不可直接调用）。在 HarmonyOS PC 设备上规划 shell 操作时阅读。
whenToUse: 需要运行 shell 命令、安装工具、解释 .zshrc/.bashrc 或 brew 安装命令时。
---

# HarmonyOS shell 工具环境（DSHM 真实布局）

本机命令解释环境与常见 Linux 发行版不同，以下事实务必遵守：

## 两层视图
- **系统终端（开发者模式 / root pty）**：可以访问 `/usr/local`（含 `/usr/local/Homebrew` 与 `/usr/local/bin/zsh` 等），zsh、brew 在此可用且真实存在。
- **应用沙箱（DSHM 运行层，uid 2000）**：没有这些命令，也读不了 `/usr/local`（`ls /usr/local` 返回 Permission denied）。dsh 的 bash 会话只能使用以下基础环境。

## 基础环境（沙箱内可用）
- `/system/bin` 由 toybox 提供 ls/cat/grep/sed/awk/tar/gzip/curl 等 400+ 常用命令。
- 本包额外内置 busybox，按需落位常用 applet：`ash`、`bzip2`、`xz`、`hexdump`、`less`、`nc`、`unzip`、`vi`。
- 交互式 shell 由随包 `bash` **垫片**提供，转发到 busybox 的 `ash`（toybox/busybox 语义，非 GNU bash 全功能）；**busybox 未编入 `bash`/`hush` applet**。该垫片只在 **PC/2in1 档**能起来（手机 / 平板档见下一条）。
- 沙箱内能否**执行**上述工具，**分三种情形**（判决性真机读数与 MAC 标签表见 `docs/104`）：
  - **PC/2in1 档**：沙箱内 ELF 可以执行（同批 exec 探针 10/10 全通），`bash` 垫片、`rg`、`git`、python 真身都能起。
  - **手机 / 平板档 · 随包 ELF**：一律被系统拒绝（`EACCES`）—— busybox、`bash`/`hush` 垫片、`rg`、`git`、python 真身都**起不来**；连 `/system/bin/sh` 都读不到（MAC 标签 `sh_exec`，`stat` 即 Permission denied）。**不要反复重试，也不要试图改 PATH、换 shebang 或绕过系统限制**：实测"用能执行的程序当启动器"（`toybox env <elf>`）**同判**——execve 只看调用进程当时的域，本机不做域转换（`docs/104` §3）。
  - **手机 / 平板档 · 系统 toybox**：`/system/bin/toybox <applet>` **能真跑**（约 149 个 applet：`ls/cat/grep/sed/find/xargs/sort/uniq/cut/head/tail/wc/cp/mv/rm/mkdir/chmod/tar/gzip/…`），但它**不带 `sh`/`bash`/`ash`** ⇒ 本档**没有真 shell 进程**，有的是**真 userland 命令**；只读检索类工作可以走它。
- **关于 Python 的例外澄清（别把"命令"和"运行时"混为一谈）**：手机 / 平板档下 `python3`/`pip3` 这两个**命令行入口同样起不来**（垫片本身就是脚本，解释器被拒）；但**内嵌 CPython 运行时本身与档位无关** —— 它是宿主进程内的 NAPI addon（不 `execve`），入口是 `/dshm-python/*` 端点。细节与判据见 `docs/106` §4 与 `ohos-python`。

## Python 探测的坑（必读）

沙箱内**没有** python3 二进制：`which python3` / `command -v python3` 会失败，
**但这不代表设备不支持 Python**。本机有内嵌 CPython 3.12，且已提供 `python3`
命令（垫片 `~/bin/python3`，已在 PATH 上），`python3 -c "print(1)"`、
`python3 script.py` 直接可用。判断或运行 Python 前请先读 `ohos-python` 技能。

## 规划时的正确姿势
- 沙箱内 `command -v` 探测不到命令时，不代表系统未安装：先区分「沙箱隔离」与「系统缺失」。
- 需确认系统是否真实存在该工具时，通过 root/开发者终端核实（如 `ls /usr/local/bin`）。
- 需要 zsh/brew 的能力时，走系统终端，或把产物复制进沙箱工作区再加工，而不是在沙箱里重新发明。
