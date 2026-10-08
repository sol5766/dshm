# 104 · 手机 / 平板档的终端与 bash：能力判据与结论

> 2026-10-06（真机 HUAWEI Mate 80 / `VYG-AL00` / OH 7.0.0.105 / API 26，`deviceType=phone`）。
> 用户提问原话：「继续测试手机端的毛病，手机和平板本身都不带终端，bash是不是就无解」。
> 本篇给出**判决性读数**、机制解释、三条可选修法与取舍；顺带记录本轮修掉的**装机脚本假绿**。

---

## 1. 结论

| 问题 | 结论 | 依据 |
|---|---|---|
| 手机 / 平板能不能有**真 shell 进程**（bash / sh / ash / zsh） | **无解** | §2 六条读数、§3 标签表：三条件全否（随包 ELF 一律 `EACCES`；系统 `sh` 连 `stat` 都被拒；唯一能 execve 的 `toybox` 与宿主**同域**、且不带 sh applet） |
| 能不能有**真 userland 命令** | **有解** | `/system/bin/toybox` 能真跑（`rc=0`），带 149 个 applet（§5），无 sh / bash / ash |
| 侧边栏终端今天为什么是坏的 | 解析器前置判据拒绝 + 无可用解释器 | §4、`dsh-subprocess-local` 的 `stat().isFile()` + `access(X_OK)` 预检 |
| 2in1 / PC 是否受影响 | **不受影响** | 同一份探针在 PC 档给出 `ash=ok`（docs/102 §端侧 exec 边界）；本轮未改 PC 路径 |

一句话：**"终端"在手机 / 平板上只能做成"内置命令翻译层"，不是真 shell**；
真 shell 需要平台侧放行（系统 sh 的 MAC 标签、或沙箱 ELF 的 exec 许可），不是我们能在应用层解决的。

---

## 2. 六条判决性读数（每次启动留证）

新增判据 `probeShellCapability()`（`hostcore/app/main.js`，紧跟 `exec 探测` 之后跑）。
两条独立 boot（`07:18:12Z` / `07:36:29Z`）**读数逐字相同** ⇒ 确定性结论，不是偶发：

```
终端能力 toybox域：rc0 out=[o:r:debug_hap:s0:x226,x335,x512,x868,x1024] err=[]
终端能力 toybox-stat-sh：rc1 out=[] err=[ls: /system/bin/sh: Permission denied]
终端能力 toybox-exec-sh：rc126 out=[] err=[env: exec /system/bin/sh: Permission denied]
终端能力 toybox-exec-ash：rc126 out=[] err=[env: exec /data/storage/el2/base/haps/entry/files/bin/ash: Permission denied]
终端能力 libs-exec：err(EACCES) out=[] err=[]
终端能力汇总：宿主域=o:r:debug_hap:s0:x226,x335,x512,x868,x1024，toybox域=rc0，
             toybox-stat-sh=rc1，toybox-exec-sh=rc126，toybox-exec-ash=rc126，libs-exec=err(EACCES)
```

（末行原样 210 字节，单行；`\n` 结尾。`rc126` = shell 的"命令找到了但执行不了"，`err(EACCES)` = `uv_spawn` 在 execve 处被拒。）

配套的 `exec 探测` 行（同一台机、同一份清单）：

```
exec 探测：python3.12=缺，git=缺，git-core/git=缺，git-remote-http=缺，rg=denied，
           ash=denied，bash=denied，system-sh=缺，toybox=ok，git-ls-remote=缺
```

两条读数的**区别**正是判据的关键：
* `rg=denied` / `ash=denied` / `bash=denied` —— **stat 拿得到、execve 被拒**（`EACCES`）；
* `system-sh=缺` —— **连 `stat` 都被拒**（"缺"来自 `statSize(t.p) <= 0`，即 `statSync` 抛错）。
  同一份 `ls -lZ`（`hdc shell` 域）下它是 `-rwxr-xr-x root:shell 349184`；
* `toybox=ok` —— 真跑起来了（判据是"真 spawn"，不是元数据）。

---

## 3. 机制：MAC 标签 + execve 只看**调用进程的域**

`hdc shell`（shell 域）与 `hdc shell "cat /proc/self/attr/current"` 对照拿到标签表：

| 文件 | MAC 标签 | app 域能 stat | app 域能 execve |
|---|---|---|---|
| `/system/bin/sh` | `u:object_r:sh_exec:s0` | **否**（Permission denied） | 否 |
| `/system/bin/toybox` | `u:object_r:toybox_exec:s0` | 能 | **能**（`rc=0`） |
| 随包 ELF（`files/bin/ash`、`busybox`、`rg` 真身） | `o:object_r:debug_hap_data_file:s0` | 能 | **否**（`EACCES`） |
| HAP `libs/arm64/*.so` | （bundle 内，与上图同源） | 能 | **否**（`EACCES`） |
| 宿主进程自己 | 域 = `o:r:debug_hap:s0` | — | — |

**"用能执行的程序当启动器"这条路为什么也死**：第 1 条读数显示 `toybox` 跑起来后
**域仍然是 `o:r:debug_hap`（app 域）** —— execve 不做域转换（对比 SELinux 里常见的
`domain_auto_trans(...)` 到 `sh` 域的写法，本机**没有**这条规则）。而 execve 的许可
判决只看**调用进程当时的域**，于是 `toybox env /system/bin/sh` 与宿主自己 exec
**同判**（第 3 条读数 `Permission denied`）。同理，`libs/` 里的 ELF 直执也是
`EACCES`（第 5 条）⇒ **把 shell 装成 `libX.so` 随包发也不行**。
（`dlopen` 与 `execve` 是两套许可：`libs/` 的 `dlopen` 可用已由 E18 证明，见
`hostcore/app/jitless-env.cjs`；不要把它推广成"可执行"。）

---

## 4. 一个读数陷阱：`toybox-sh=ok` 曾经**看起来**是"有 sh"

上一轮的装机读数里有 `toybox-sh=ok` / `toybox-applets=ok`。它们**不是**"有 sh"：

* `probeExec()` 的判据是"进程有没有被 execve 起来"，**任何正常退出都记 `ok`**
  （只有 `EACCES` → `denied`、loader 失败 → `so-fail` 才改判）；
* `toybox sh` 的真相在 **stderr**：`toybox: Unknown command sh (see "toybox --help")`，
  退出码非 0 —— 但 `probeExec` 不看退出码。

⇒ 本轮把"终端能力"**单开** `probeShellCapability()`（`spawnSync` + rc / 信号 / stdout /
stderr 全留证），并**删掉**那三条一次性探针（`bin-sh` / `toybox-sh` / `toybox-applets`），
避免"用数字看不出真假"的读数继续留在装机日志里。

---

## 5. toybox 能提供什么（149 applet，清单落档）

`hdc shell "toybox"` 原文（本机）落档于 `dist/dbg/toybox-applets.txt`（一次性取证件，非交付物）。

* **有**（覆盖日常只读/写操作）：`ls cat grep egrep fgrep sed find xargs env timeout setsid
  nohup stat sha256sum base64 xxd od patch sort uniq cut head tail wc cp mv rm mkdir chmod
  chown ln readlink realpath touch truncate tar gzip gunzip zcat cpio split strings diff3 …`
* **没有**：**`sh` / `bash` / `ash`**（也没有 `mksh` / `dash` / `ksh` / `zsh`），
  以及 `awk` / `tr` / `diff` / `curl` / `wget` / `expr` / `hexdump`。
* 注意 `toybox` 是**单个二进制按 argv[1] 派发**：它与 `/bin/<applet>` 那些符号链接等价，
  但**只能通过 `toybox <applet>` 调**（那些链接本身在 app 域不可 exec）。

---

## 6. 三条修法（取舍，需用户拍板）

| 修法 | 是什么 | 代价 / 边界 |
|---|---|---|
| **一（推荐先做）纯 JS 命令翻译层** | 不需要 exec：把"命令字符串"翻译成 FS 操作（先只读子集：`pwd/cd/ls/cat/head/tail/grep/find/wc/stat` + 管道），写操作走已有的 `dsh-fs-local` | 覆盖**我们实现过**的命令；**诚实文案**必须写清"内置命令翻译层，不是真 shell"——跑不了 `make` / `git` / 任意二进制。侧边栏终端同时可用（PTY 换 REPL） |
| **二（真命令、无真 shell）只读工具改走 toybox** | `rg` / `find` / `ls` 一类落到 `/system/bin/toybox <applet>`（已证可 execve） | 149 applet 的**真实**行为与输出；但 `git` / `python` / `rg` 真身仍是随包 ELF，救不了；管道/重定向/glob 仍要 JS 层实现 |
| **三（收口）手机档不暴露终端与 bash 工具** | 如实说明"本档无 shell" | 工作量最小，但用户看到的是"功能消失" |

修法一与二**不冲突**（可叠加：JS 层负责解析与管道，叶子命令优先走 toybox applet）。

---

## 7. 顺带修掉：装机脚本第 8 步的"假绿"

**现象**：本轮一次 `hdc install -r` 之后应用**根本没起来**（日志停在上一轮的
`LOOP-ALIVE 第 420 拍`，端口无响应），`tools/update-device.ps1` 却报：

```
OK   Host HTTP 已就绪（有 websocket 接入）
FAIL exec 探测未全通（共 13 项）：…（← 这是**上一轮**的读数）
```

**根因**（两条都是"跨 boot 追加"的日志 + 无新鲜度判据）：

* `dshm-host.log` 首行至今仍是 `2026-09-27` 的 boot 标记 ⇒ 它是**只追加、不截断**的；
* 第 8 步取 `grep 'exec 探测：' | tail -1` —— **最后一行永远是上一轮的**；
* `grep -c 'IN-UPGRADE GET /api/remote.mux' -gt 0` —— 对只追加的日志**恒真**。

**修法**（同一次改动，`tools/update-device.ps1`）：

1. 新增 `§2b`：装前记下 `LogCount`（`--- boot pid=` / `exec 探测：` / `IN-UPGRADE …`）三个只增不减的计数器；
2. 第 6 步从"盲等 90 秒"改为**轮询到 exec 计数增加**（最多 `$BootWaitSec`），
   仍未起就**再拉一次前台**并再等 25 秒，仍不起就明确 `Bad`；
3. 第 8 步只认**本轮增量**：`$afterExecCount -le $beforeExecCount` ⇒ 直接判"读数不可用"；
   mux 那一项降级为 `Info`（非判据）。

**实测（`dist/dbg/update-device-phone9.log`，`-SkipRebuild`）**：

```
日志台账基线：boot=19 exec=11 mux=18
OK   端侧已起来（第 5 秒出现本轮 exec 探测）
…
本轮未见新的 websocket 接入（18 → 18；非判据）
```

**附带坑**：`grep -c '--- boot pid='` 因模式串以 `-` 开头被当成选项，
**返回 0 而不报错**（实测第一版基线 `boot=0`）⇒ 必须写成 `grep -c -e '<pattern>'`。

---

## 8. 未做 / 待决

* 三条修法**尚未实施**：等用户拍板（特别是"终端"要不要做成翻译层、以及是否接受"非真 shell"的表述）。
* 平板档（`deviceType=tablet`）与手机同归手持，机制一致，但无单独真机读数。
* 2in1 / PC 档本轮未复测（本轮改动只新增探针与装机脚本判据，未触碰 PC 路径）。
* `~/.ohos`、用户数据、`dsh/home` 全程未动：装机 3 次，`links 8→8`、核心树 `0.2.1-alpha.1+dshm.6` 均在。