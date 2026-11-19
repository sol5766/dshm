/*
 * DSHM 端侧「guest 虚拟机终端」：把 `ctx.subprocess.spawnTerminal` 在手持档改派到随包
 * QEMU guest 里的**真 tty**。
 *
 * ── 要解决什么 ────────────────────────────────────────────────────────────
 * 侧边栏终端走的是链 2：`ui-sidebar-terminal` → `dsh-api-terminal-controller`
 * （`lib/index.js:999` 直接 `subprocess.spawnTerminal(...)`）→ 本机 PTY。手持档的沙箱里
 * 既没有可 execve 的 shell，也没有能被 dlopen 的 pty 后端可用外壳 ⇒ 终端"打不开"。
 * 但 `spawnTerminal` 与 `spawn` 一样，**最后一跳是可换实现的**（docs/120–122 已把
 * `spawn` 换成 guest 里的 bash），这里把同一台 VM 的第二条缝也接上。
 *
 * ── 通道长什么样 ──────────────────────────────────────────────────────────
 *   host                                            guest
 *   net.connect(<vm>/tmp/term<i>)  ←——— QEMU ———→  /dev/hvc<i-1>  (virtio-console, 真 tty)
 *        socket chardev（server=on,wait=off）          shell 的 stdin/stdout/stderr
 *
 * 【通道换过两版，两版都上过真机（2026-10-08 / 2026-10-09）——为什么最后是 virtconsole】
 *   · `-device virtserialport`（**普通 port**）在 guest 里是 `/dev/vport5p1`（`251, 1`，
 *     **动态 cdev**，非 tty）⇒ 没有 termios / 行规程 / 作业控制，挂上去只能得到哑终端。
 *   · `-serial` 出的是 `/dev/ttyAMA<i>`（`204, 64` = PL011，真 tty，镜像里 ttyAMA0 上本来
 *     就跑着 autologin 的 root shell）—— 质量最好，但 guest 里**只有 2 个 PL011**
 *     （0 号留给控制台日志 serial.log）⇒ 最多 1 个并发终端。
 *   · `-device virtconsole`（virtio-console 的 **console 型**端口）⇒ `/dev/hvc<i-1>`
 *     （`229, <i-1>`，真 tty，`/proc/tty/drivers` 在册）—— 作业控制 / resize / 双向字节
 *     全部实测可用（读数见 `paths.js` 的 TERM_PORTS 头注）⇒ **现版走这条，端口 4 个**。
 *     hvc 号只发给 console 型端口、按枚举顺序 ⇒ QGA 那条 `virtserialport` 不占号。
 *
 * ── guest 侧怎么把 shell 挂上去 ───────────────────────────────────────────
 * 镜像里没有 telnetd / socat，也不该为此再塞一个守护进程。用 Linux 的一条既有语义：
 * **会话首领第一次 open 一个没有控制终端的 tty ⇒ 该 tty 成为它的控制终端**。所以：
 *
 *   setsid /bin/busybox sh -c 'exec <shell> <args> < <tty> > <tty> 2>&1' &
 *
 * 内层 sh 刚 setsid 完是"会话首领且无控制终端"，`exec` 的重定向由**它**执行 open ⇒
 * 认领成功 ⇒ exec 之后 shell 拿到控制终端（作业控制、SIGWINCH 都在）。真机实测
 * （docs/123 `1）：该进程 `pgrp=session=pid`，`tty_nr` 非 0 —— PL011 上是 `1026`，
 * hvc 上是 `58625`（= `229,1`）。
 * 注意 `/bin/setsid` 在镜像里**没有链接**，必须走 `busybox setsid`。
 *
 * ── 与本地实现的差异（刻意，写在这里而不是藏起来）──────────────────────────
 *   ① **窗口尺寸靠 ioctl 带外设置**：QEMU 的 chardev 不带 winsize 通道，`resize(cols,rows)`
 *      落成 guest 侧 `stty -F <tty> rows R cols C`（真机实测可用）。`TIOCSWINSZ` 会由
 *      guest 内核自己给前台进程组发 SIGWINCH，所以交互式程序的重绘是通的。
 *   ② **前台进程组靠 /proc 探测**：guest 里没有 tcgetpgrp 的 shell 入口，改为扫
 *      `/proc/<pid>/stat` 找"stdin 指向本 tty"的会话首领，取它的 `tpgid`（真机实测
 *      `ps -o` 支持 pid/pgid/sid/tty/stat 但**没有 tpgid**）。结果按 1 s 缓存 —— 上游
 *      的 `inspectForeground()` 会被逐块输出调用，不能每块都问一次 guest。
 *   ③ **pid 是 guest 侧的 pid**：宿主上没有对应进程（QEMU 在进程内跑，没有 per-shell
 *      的宿主 pid）。上游只用它做展示与 `inspectActivity`，语义不受影响。
 *   ④ **`done` 的 exitCode 恒为 null**：shell 死在 guest 里，宿主拿不到它的退出码
 *      （tty 通道断开只能说明"这条 tty 没了"）。`signal` 如实写 SIGHUP / SIGTERM。
 *   ⑤ **并发终端上限 = TERM_PORTS（= 4）**：每个 `-device virtconsole` 在 guest 里给一个
 *      `/dev/hvc<i-1>`（真 tty；读数与认领语义见 `paths.js` 的 TERM_PORTS 头注）。
 *      第 N+1 个终端会拿到"请先关闭一个终端"的可行动报错，而不是一个没有 shell 的空壳。
 *      任何一步对不上（设备不存在 / 认领失败）都**当场抛错**，不交半成品 —— 见下面
 *      `DSHM_TERM_NO_TTY` 与 CLAIM_TIMEOUT_MS 的注释。
 *
 * ── 刻意不做的 ────────────────────────────────────────────────────────────
 *   · **不为非白名单程序开工**：argv[0] 必须能过 `translateProgram`（bash/sh/ash/dash/zsh）。
 *     于是 `terminal-bash` 在端侧配置的 `/usr/bin/zsh`（本档不存在）仍旧**不接管**，
 *     与 `spawn` 那条链的拒绝面逐条一致 —— 不假装能跑。
 *   · **不新增 guest 侧程序、不改镜像**：只用 busybox 自带的 `setsid` / `stty` / `kill`。
 *   · **不碰用户数据**：运行目录只有 `<vm>/tmp/term<i>`（socket，QEMU 自己建）。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 *   · **桌面模式 档零变化**：本模块只在 index.js 的 `enabled()` 为真时接线（判据与
 *     dshm-market-bridge / dshm-profile-pnpm / 本插件的 spawn 那条**同源**）。
 *   · **失败一律 reject**：`spawnTerminal` 是 async 的，VM 起不来 / 端口用满 / 通道连不上
 *     都在 await 点报中文可行动的错误，绝不返回半成品 handle（半个终端比没有更糟）。
 *   · **端口用满就明说**：本档最多 TERM_PORTS 个并发终端，第 N+1 个得到的是"先关一个"，
 *     而不是一个假装能用的会话。
 */
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { connect } from './qga.js';
import { shq, translateProgram } from './handle.js';
import { TERM_PORTS, termSocket, termTty } from './paths.js';
import { session } from './vm.js';

/** 连 tty 通道的超时：VM 刚起来时 socket 文件可能已存在但还没 accept。 */
const CONNECT_TIMEOUT_MS = 8000;
/** guest 侧认领 tty 的最长等待（真机实测 spawn 到认领 < 300 ms）。 */
const CLAIM_TIMEOUT_MS = 8000;
/** /proc 探测的缓存窗口（见头注 ②）。 */
const FOREGROUND_TTL_MS = 1000;
/** 调用方没给 terminalType 时的默认 TERM。 */
const DEFAULT_TERM = 'xterm-256color';
/** guest 侧 PATH：与 handle.js 的 guest 脚本逐字一致（本档刻意不给宿主假壳目录）。 */
const GUEST_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
/**
 * guest 侧那份"自己的 rc"落在 `/tmp`（tmpfs，开机自建，**不碰镜像**）：
 * ash 家族的**交互式** shell 读 `$ENV`、bash 读 `--rcfile`，两条都指向它（见 spawnScript 头注）。
 */
const RC_PATH = '/tmp/.dshm-rc';
/** 信号名 → `kill -<X>` 的写法（guest 侧只认这几个短名）。 */
const SIGNALS = {
  SIGINT: 'INT', SIGQUIT: 'QUIT', SIGTERM: 'TERM', SIGKILL: 'KILL', SIGHUP: 'HUP',
  SIGTSTP: 'TSTP', SIGCONT: 'CONT', SIGWINCH: 'WINCH', SIGUSR1: 'USR1', SIGUSR2: 'USR2',
};
/**
 * /proc/<pid>/stat 的解析器（awk 程序，单引号由 shq() 负责）。
 * 字段：1=pid，comm 在括号里（可能含空格）⇒ 先把 "…(comm) " 整体剥掉再切分：
 * 剩下的 [1]=state [2]=ppid [3]=pgrp [4]=session [5]=tty_nr [6]=tpgid。
 */
const AWK = '{ pid = $1; sub(/^.*\) /, ""); split($0, f, " "); print pid, f[3], f[4], f[6] }';
const AWK_TAGGED = '{ pid = $1; sub(/^.*\) /, "", $0); split($0, f, " "); '
  + 'if (f[5] > 0) print "DSHM_TERM_ROW", pid, f[3], f[4], f[6] }';

/** 端口占用表与读数（诊断用；一进程一 VM ⇒ 模块级状态即会话级状态）。 */
const state = {
  used: new Set(), opened: 0, closed: 0, failed: 0, cwdMiss: 0,
  /* 最近 60 s 的失败时刻（只保留时间戳，不保留错误对象，避免把栈留在内存里） */
  recentFailures: [], lastFailure: '',
  /* 最近一次成功建终端的耗时分段（ms）；只用于诊断，不参与业务判断。 */
  lastTotalMs: 0, lastAcquireMs: 0, lastChannelMs: 0, lastLaunchMs: 0, lastClaimSource: '',
};

/*
 * 终端创建的**熔断器**（2026-10-19 MatePad Edge 现场后加）。
 *
 * 【要解决什么】这台设备上 `pty-spawn` 报 E15、`sandbox-dlopen` 报 E39、`exec` 报 EPERM，
 * 终端链路在"创建失败 → 前端自动重试 → 再失败"之间可能形成短周期循环；每次失败都会
 * 走一遍 `acquire()`（必要时冷启动 QEMU）与端口/套接字分配。其他设备上这条链一次就成，
 * 所以从没暴露；在这台设备上它会变成资源放大器。
 *
 * 【熔断口径】60 s 窗口内失败 ≥ 3 次 ⇒ 之后 60 s 内**直接快速失败**，不再尝试
 * `acquire()` / 连 guest；错误文案写明"已暂停"，让前端/用户看到明确结论而不是无限重试。
 * 成功一次即清零。阈值与窗口都提成常量，便于真机对照。
 */
const TERM_FAIL_WINDOW_MS = 60000;
const TERM_FAIL_MAX = 3;

function pruneFailures(now) {
  state.recentFailures = state.recentFailures.filter((at) => now - at < TERM_FAIL_WINDOW_MS);
}

/** 熔断是否已打开（顺带裁剪过期记录）。 */
function terminalBreakerOpen() {
  const now = Date.now();
  pruneFailures(now);
  return state.recentFailures.length >= TERM_FAIL_MAX;
}

function noteTerminalFailure(message) {
  const now = Date.now();
  state.recentFailures.push(now);
  state.lastFailure = String(message || '').slice(0, 200);
  pruneFailures(now);
}

function clearTerminalFailures() {
  state.recentFailures = [];
  state.lastFailure = '';
}

/** 与 index.js / vm.js 同一枚 TAG。 */
function log(message) {
  try {
    console.log('[dshm-vm-bash] ' + message);
  } catch {
    /* 日志通道异常不许影响功能 */
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 取一个空闲端口号（`1..TERM_PORTS`）；没有就返回 null（调用方报"先关一个"）。 */
function takePort() {
  for (let index = 1; index <= TERM_PORTS; index += 1) {
    if (!state.used.has(index)) {
      state.used.add(index);
      return index;
    }
  }
  return null;
}

function releasePort(index) {
  state.used.delete(index);
}

/** 机器可读诊断（进宿主自检）。 */
export function terminalDiagnostics() {
  return {
    ports: TERM_PORTS,
    inUse: [...state.used].sort((a, b) => a - b),
    opened: state.opened,
    closed: state.closed,
    failed: state.failed,
    cwdMiss: state.cwdMiss,
    /* 熔断读数：窗口内失败次数与最近一次原文（重试风暴判读用） */
    recentFailures: state.recentFailures.length,
    lastFailure: state.lastFailure,
    breakerOpen: terminalBreakerOpen(),
    timing: {
      totalMs: state.lastTotalMs,
      acquireMs: state.lastAcquireMs,
      channelMs: state.lastChannelMs,
      launchMs: state.lastLaunchMs,
      claimSource: state.lastClaimSource,
    },
  };
}

/** 经 QGA 在 guest 里跑一段 sh，取 stdout（失败抛错，调用方决定怎么报）。 */
async function execInGuest(script, timeoutMs) {
  const live = session();
  if (live === null) throw new Error('端侧 VM 会话不在（请重启应用）');
  const result = await live.exec('/bin/busybox', ['sh', '-c', script], timeoutMs, 15);
  return result.stdout;
}

/** 起 shell 的 guest 脚本（见头注"guest 侧怎么把 shell 挂上去"）。 */
function spawnScript(index, spec, cols, rows, owner = '') {
  const tty = termTty(index);
  const program = String(spec.argv[0]);
  const bareProgram = program.slice(program.lastIndexOf('/') + 1);
  const argvParts = spec.argv.map((part) => shq(String(part)));
  // bash 的交互式非登录 shell **既不读 /etc/profile 也不读 $ENV**（它只读 ~/.bashrc 或 --rcfile）
  // ⇒ 对 bash 必须用 `--rcfile` 才落得到我们的 prompt；ash/dash 那边用 $ENV（见下）。
  if (bareProgram === 'bash') argvParts.splice(1, 0, '--rcfile ' + shq(RC_PATH));
  const argv = argvParts.join(' ');
  const lines = ['set -u'];
  if (Number.isInteger(cols) && Number.isInteger(rows) && cols >= 2 && rows >= 1) {
    // 先把 tty winsize 定好再拉起 shell；失败不阻断，后续 resize 仍可补。
    lines.push(sizeScript(index, cols, rows));
  }
  const cwd = typeof spec.cwd === 'string' && spec.cwd.length > 0 ? spec.cwd : '';
  // cwd 失败**不当致命**：工作区可以落在本次启动没绑定的目录（一进程一 VM ⇒ 挂载在启动
  // 那一刻定死），那种情况退回 /root 起一个能用的终端，比整个会话起不来强。
  // 【但不许静默】原来 `2>/dev/null || true` 把失败咽成"悄悄落到 /root"——用户只看到
  // 终端不在工作区却毫无线索（2026-10-12 真机）。失败时打一个回执标记，宿主在
  // createVmTerminal 里读到就记一行（见 DSHM_TERM_CWD_MISS），行为本身不变。
  if (cwd.length > 0) lines.push('cd ' + shq(cwd) + ' 2>/dev/null || echo DSHM_TERM_CWD_MISS');
  lines.push('export PATH=' + shq(GUEST_PATH));
  lines.push('export HOME=/root');
  const env = spec.env && typeof spec.env === 'object' ? spec.env : {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    // PATH/HOME/TERM/ENV/PS1 由本脚本自己定：调用方给的值会盖掉我们刚设好的 prompt 与通道口径。
    if (key === 'PATH' || key === 'HOME' || key === 'TERM' || key === 'ENV' || key === 'PS1') continue;
    lines.push('export ' + key + '=' + shq(String(value)));
  }
  const term = typeof spec.terminalType === 'string' && spec.terminalType.length > 0 ? spec.terminalType : DEFAULT_TERM;
  lines.push('export TERM=' + shq(term));
  /*
   * 【prompt：写一份自己的 rc，再让 shell 去读它】—— 这一段是"两行当前路径"的根治。
   *
   * 现象（2026-10-09 真机，侧栏宽 42 列）：终端一开就打印两行当前路径。根因不是宿主拼帧，
   * 是 **prompt 比列数宽**：镜像 /etc/profile 给非 bash/ash-zsh 的分支是
   * `PS1='${HOSTNAME%%.*}:$PWD'`（+ root 的 `# `），本档 cwd
   * `/storage/Users/currentUser/Download/harness` ⇒ prompt 46 列 > 42 ⇒ 折成两行；
   * 之后的 SIGWINCH 重绘（`\r` + prompt + ESC[K）落在第二行上，于是"路径又打了一遍"。
   * 窄屏不可能放下整条工作区路径 ⇒ 把 prompt 定成 **`\W# `**（busybox ash / bash 都支持
   * `\W` = cwd 的 basename，真机实测：`cd /usr/share` ⇒ `share# `）——一眼看得到目录、
   * 又永远只有十几列。要看全路径就 `pwd`。
   *
   * 【为什么是"另写 rc"而不是直接 export PS1】/etc/profile 里那行是**无条件赋值**，
   * 直接在 exec 前 export 会被它覆盖回长 prompt（真机实测）。ash 家族读 `$ENV`（交互式），
   * bash 读 `--rcfile`；两条都指向这份 rc，rc 里**先**source /etc/profile（保留镜像的
   * umask/PAGER 等），**后**覆盖 PS1 ⇒ 无论哪条路，最后生效的都是它。
   * 真机实证（2026-10-09）：`exec env ENV=<rc> /bin/sh -i` ⇒ prompt 变成 rc 里的值
   * （`RR-ENV# `）；`exec /bin/bash --rcfile <rc> -i` ⇒ `RR-BASH# ` 且 `BASH_VERSION=5.2.37`。
   */
  // rc 落在 guest 的 /tmp（tmpfs，不碰镜像）：**先** source /etc/profile 保住镜像的
  // umask / PAGER 等，**后**覆盖 PS1 —— 这样 /etc/profile 里那条无条件赋值也盖不掉我们。
  const rcText = ['[ -r /etc/profile ] && . /etc/profile', "PS1='\\W# '", 'umask 022'].join('\n') + '\n';
  lines.push('printf %s ' + shq(rcText) + ' > ' + RC_PATH);
  lines.push('export ENV=' + RC_PATH);
  // 提示符里若用了 \h，别让 hostname 缺失时把它留空（镜像里有 `hostname`，这句只是兜底）。
  lines.push('export HOSTNAME=${HOSTNAME:-dshm}');
  // 【先验设备再起 shell】端口表与 guest 的 UART 数量一旦不一致（2026-10-08 真机就是这么
  // 死的：端口 2 对应的 tty 在 guest 里根本不存在），`exec < <tty>` 失败、
  // shell 当场退出，而宿主只看到"脚本跑过了"的假象 ⇒ 这里先判一次字符设备，问题当场暴露。
  lines.push('[ -c ' + shq(tty) + ' ] || { echo DSHM_TERM_NO_TTY; exit 3; }');
  if (owner) lines.push('export DSHM_TERM_OWNER=' + shq(owner));
  lines.push('setsid /bin/busybox sh -c ' + shq('exec ' + argv + ' < ' + tty + ' > ' + tty + ' 2>&1') + ' </dev/null >/dev/null 2>&1 &');
  lines.push('child=$!');
  lines.push('echo DSHM_TERM_SPAWNED');
  // 【同一趟 QGA 里完成首轮认领】原来的顺序是 size → spawn → 再单独扫描全 /proc。
  // 三条 QGA 命令在 TCI 档上会累加成秒级停顿；这里先直读 `$!` 的 stat（99% 是 setsid
  // 已 exec 后的 shell 本身），找不到再交回现有全表探测作为兜底。
  lines.push('i=0');
  lines.push('while [ "$i" -lt 20 ]; do');
  lines.push('  if [ -r "/proc/$child/stat" ]; then');
  lines.push('    row=$(awk ' + shq(AWK_TAGGED) + ' "/proc/$child/stat")');
  lines.push('    if [ -n "$row" ]; then echo "$row"; exit 0; fi');
  lines.push('  fi');
  lines.push('  i=$((i+1)); sleep 0.02');
  lines.push('done');
  return lines.join('\n');
}

/** 供门禁直接验证生成结果；运行时与 createVmTerminal 使用同一份实现。 */
export function terminalLaunchScript(index, spec, cols, rows) {
  return spawnScript(index, spec, cols, rows);
}

/** 解析同一趟 spawn 回执里的 shell 行；没有命中返回 null（调用方走全表兜底）。 */
function parseLaunchRow(text) {
  const match = /^DSHM_TERM_ROW\s+(.+)$/m.exec(String(text));
  if (match === null) return null;
  return pickShell(parseRows(match[1]));
}

export function parseTerminalLaunchReceipt(text) {
  return parseLaunchRow(text);
}

/** 已知 shell pid 时只读一个 /proc/<pid>/stat，不再扫全进程表。 */
function directProbeScript(pid) {
  return 'awk ' + shq(AWK) + ' ' + shq('/proc/' + String(pid) + '/stat') + ' 2>/dev/null';
}

/** 认领/前台进程组探测脚本：按"stdin 指向本 tty"找进程，逐行回 `pid pgrp session tpgid`。 */
function probeScript(index) {
  const tty = termTty(index);
  return [
    'TTY=' + tty,
    'for p in /proc/[0-9]*; do',
    '  [ -r "$p/fd/0" ] || continue',
    '  [ "$(readlink "$p/fd/0" 2>/dev/null)" = "$TTY" ] || continue',
    '  awk ' + shq(AWK) + ' "$p/stat" 2>/dev/null',
    'done',
  ].join('\n');
}

/** 解析探测输出。 */
function parseRows(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number(parts[0]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    rows.push({ pid, pgrp: Number(parts[1]), sid: Number(parts[2]), tpgid: Number(parts[3]) });
  }
  return rows;
}

/** 会话首领（pgrp=session=pid）就是这台终端的 shell。 */
function pickShell(rows) {
  for (const row of rows) {
    if (row.pid === row.pgrp && row.pid === row.sid) return row;
  }
  return rows.length > 0 ? rows[0] : null;
}

/** 把探测行翻成上游的 `{processGroupId, inputWaiting}`。 */
function foregroundOf(row) {
  if (row === null) return null;
  if (!Number.isFinite(row.tpgid) || row.tpgid <= 0) return { processGroupId: row.pid, inputWaiting: true };
  return { processGroupId: row.tpgid, inputWaiting: row.tpgid === row.pid };
}

/**
 * 带外设置窗口尺寸（见头注 ①）。**一条 stty 同时给 rows 与 cols** —— 分成两条会各触发一次
 * SIGWINCH 重绘（2026-10-09 真机实测：合并前 3 行、合并后 2 行，多出来的那行就是重绘残留）。
 */
function sizeScript(index, cols, rows) {
  const tty = termTty(index);
  return 'stty -F ' + tty + ' rows ' + rows + ' cols ' + cols + ' 2>&1 || true';
}

/**
 * 建一台 guest 终端。**async** —— 与 `spawn`（同步返回 handle）不同，`spawnTerminal` 本身
 * 就是 async 的，所以冷启动（首次会拉起 VM，实测 ~13 s）就地在 await 点上等，失败直接
 * reject，绝不返回半成品。
 *
 * @param spec 上游的 terminal spec（argv/cwd/env/rows/cols/terminalType/signal）
 * @param acquire `async (cwd) => {ok, error?}` —— 取（必要时启动）VM 会话
 * @returns 上游 `BrowserTerminal` / `LocalPtySession` 认的 handle（见头注）
 */
export async function createVmTerminal(spec, acquire) {
  const createdAt = Date.now();
  if (spec === null || typeof spec !== 'object' || !Array.isArray(spec.argv) || spec.argv.length === 0) {
    throw new Error('端侧终端：argv 为空');
  }
  if (translateProgram(spec.argv[0]) === null) {
    throw new Error('端侧终端：argv[0]=' + String(spec.argv[0]) + ' 不在 guest shell 白名单（bash/sh/ash/dash/zsh）');
  }
  const checkCancelled = () => {
    if (spec.signal?.aborted) throw new Error('端侧终端创建已取消');
  };
  checkCancelled();
  /*
   * 熔断检查放在**最前**（argv 校验之后、acquire 之前）：失败重试风暴里最贵的是
   * acquire()（可能冷启动 QEMU），所以要在碰 VM 之前就挡住。
   */
  if (terminalBreakerOpen()) {
    state.failed += 1;
    log('终端创建熔断：60s 内已失败 ' + state.recentFailures.length + ' 次（最近：'
      + state.lastFailure + '），本次直接拒绝，不再尝试 acquire');
    throw new Error('端侧终端连续失败，已暂停 60 秒内的新建（最近一次：' + state.lastFailure
      + '）。请稍后重试；若持续失败，说明本机终端通道不可用（pty/dlopen 被系统拒绝），不影响其他功能');
  }
  log('终端创建请求：argv=' + spec.argv.join(' ')
    + '（60s 内最近失败 ' + state.recentFailures.length + ' 次）');
  const cwd = typeof spec.cwd === 'string' ? spec.cwd : '';
  let outcome;
  const acquireAt = Date.now();
  try {
    outcome = await acquire(cwd);
  } catch (error) {
    const msg = '端侧 VM 启动异常：' + (error && error.message ? error.message : String(error));
    noteTerminalFailure(msg);
    log('终端创建失败（acquire 抛错）：' + msg);
    throw new Error(msg);
  }
  state.lastAcquireMs = Date.now() - acquireAt;
  checkCancelled();
  if (outcome !== undefined && outcome !== null && outcome.ok === false) {
    const msg = '端侧 VM 不可用：' + String(outcome.error);
    noteTerminalFailure(msg);
    log('终端创建失败（VM 不可用）：' + msg);
    throw new Error(msg);
  }
  const index = takePort();
  if (index === null) {
    state.failed += 1;
    throw new Error('端侧终端端口已用满（本档最多 ' + TERM_PORTS + ' 个并发终端），请先关闭一个终端再开新的');
  }
  const tty = termTty(index);
  let socket = null;
  const channelAt = Date.now();
  try {
    socket = await connect(termSocket(index), CONNECT_TIMEOUT_MS);
  } catch (error) {
    releasePort(index);
    state.failed += 1;
    const msg = '端侧终端：连不上 guest tty 通道 ' + termSocket(index)
      + '（' + (error && error.message ? error.message : String(error)) + '）';
    noteTerminalFailure(msg);
    throw new Error(msg);
  }
  state.lastChannelMs = Date.now() - channelAt;
  // 端口已定 ⇒ 从这里开始无论哪一步失败都必须把端口还回去（否则失败 N 次后再也开不了终端）。
  const output = new PassThrough();
  const settled = Promise.withResolvers();
  let ended = false;
  let closing = false;
  let creating = true;
  let delivered = false;
  let stopping = null;
  let monitor = null;
  const owner = randomUUID();
  let shellRow = null;
  let cachedAt = 0;
  let cachedRow = null;
  let activity = { state: 'unknown', revision: 0 };

  /** 会话结束（幂等）。`signalName` 如实进 `done`。 */
  const end = (signalName) => {
    if (ended) return;
    ended = true;
    clearTimeout(monitor);
    spec.signal?.removeEventListener('abort', abort);
    socket.removeListener('data', onData);
    socket.removeListener('error', onError);
    socket.removeListener('close', onClose);
    output.removeListener('drain', onDrain);
    socket.pause();
    const tail = delivered && socket.readableLength > 0 ? socket.read(socket.readableLength) : null;
    releasePort(index);
    state.closed += 1;
    try {
      socket.destroy();
    } catch {
      /* 已经关了 */
    }
    try {
      if (delivered) output.end(tail);
      else output.destroy();
    } catch {
      /* 同上 */
    }
    settled.resolve({ exitCode: null, signal: signalName });
  };

  const stop = (signalName) => {
    closing = true;
    if (creating) return Promise.resolve();
    if (stopping !== null) return stopping;
    if (ended) return Promise.resolve();
    stopping = (async () => {
      const script = [
        'for sig in TERM KILL; do',
        '  groups=" "',
        '  for p in /proc/[0-9]*; do',
        '    [ -r "$p/environ" ] || continue',
        '    tr "\\000" "\\n" < "$p/environ" 2>/dev/null | grep -Fxq ' + shq('DSHM_TERM_OWNER=' + owner) + ' || continue',
        '    pid=${p##*/}',
        '    row=$(awk ' + shq(AWK) + ' "$p/stat" 2>/dev/null)',
        '    set -- $row',
        '    [ "$#" -eq 4 ] && [ "$1" = "$pid" ] || continue',
        '    pg=$2',
        '    case "$pg" in ""|*[!0-9]*) continue;; esac',
        '    [ "$pg" -gt 1 ] || continue',
        '    case "$groups" in *" $pg "*) continue;; esac',
        '    groups="$groups$pg "',
        '    kill -"$sig" -"$pg" 2>/dev/null || true',
        '  done',
        '  [ "$sig" != TERM ] || sleep 0.4',
        'done',
      ].join('\n');
      await execInGuest(script, 15000).catch((error) => {
        log('终端收尾失败（#' + index + ' ' + tty + '）：' + String(error?.message || error));
      });
      end(signalName);
    })();
    return stopping;
  };
  const abort = () => { void stop('SIGTERM'); };
  spec.signal?.addEventListener('abort', abort, { once: true });

  const onDrain = () => {
    if (!ended) socket.resume();
  };
  const onData = (chunk) => {
    if (ended) return;
    try {
      if (!output.write(chunk)) socket.pause();
    } catch {
      /* 下游关了就别再写 */
    }
  };
  const onError = (error) => {
    log('终端通道出错（#' + index + ' ' + tty + '）：' + (error && error.message ? error.message : String(error)));
    void stop('SIGHUP');
  };
  const onClose = () => {
    if (closing || ended) return;
    log('终端通道被关闭（#' + index + ' ' + tty + '）');
    void stop('SIGHUP');
  };
  output.on('drain', onDrain);
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);

  /** 当前探测（带缓存）。探测失败不算致命：返回上一次的行或 null，调用方按 unknown 处理。 */
  const currentRow = async () => {
    if (ended || closing) return null;
    const now = Date.now();
    if (cachedRow !== null && now - cachedAt < FOREGROUND_TTL_MS) return cachedRow;
    try {
      const text = shellRow === null
        ? await execInGuest(probeScript(index), 8000)
        : await execInGuest('[ -d /proc/' + shellRow.pid + ' ] || { echo DSHM_TERM_EXITED; exit 0; }\n' + directProbeScript(shellRow.pid), 8000);
      if (ended || closing) return null;
      if (shellRow !== null && text.trim() === 'DSHM_TERM_EXITED') {
        void stop('SIGHUP');
        return null;
      }
      cachedRow = pickShell(parseRows(text));
      cachedAt = Date.now();
      if (cachedRow !== null && (shellRow === null || cachedRow.pid === shellRow.pid)) shellRow = cachedRow;
      return cachedRow;
    } catch {
      cachedAt = now;
      return cachedRow;
    }
  };

  try {
    checkCancelled();
    const cols = Number(spec.cols);
    const rows = Number(spec.rows);
    let row = null;
    const launchAt = Date.now();
    const spawned = await execInGuest(spawnScript(index, spec, cols, rows, owner), 20000);
    creating = false;
    checkCancelled();
    if (closing) throw new Error('端侧终端通道已关闭');
    state.lastClaimSource = 'direct';
    row = parseLaunchRow(spawned);
    if (row !== null) {
      shellRow = row;
      cachedRow = row;
      cachedAt = Date.now();
    }
    state.lastLaunchMs = Date.now() - launchAt;
    if (row === null) state.lastClaimSource = 'probe';
    if (spawned.includes('DSHM_TERM_NO_TTY')) {
      throw new Error('端侧终端：guest 里没有 ' + tty + ' 这个 tty 设备（端口表与 guest 的 UART 数量不一致）');
    }
    if (!spawned.includes('DSHM_TERM_SPAWNED')) {
      throw new Error('guest 侧没能起 shell：' + spawned.trim().slice(0, 200));
    }
    // 起了 shell 但 `cd <cwd>` 落空（见 spawnScript 的 DSHM_TERM_CWD_MISS）：会话可用，
    // 但不在调用方要的目录里。不致命，但必须留一行证据，别让它又变成"悄悄落到 /root"。
    if (spawned.includes('DSHM_TERM_CWD_MISS')) {
      state.cwdMiss += 1;
      log('终端 #' + index + '：本会话的 cwd（' + (cwd || '(空)') + '）在 guest 里不可达'
        + '（VM 启动时未挂该工作区）⇒ 已落到 guest 默认目录；如需该工作区请重启应用');
    }
    // 等 shell 认领 tty（拿 pid 与前台进程组）。**等不到就是错**：认领失败意味着
    // 这条 tty 上没有能用的 shell（设备不存在 / exec 当场死掉 / 别的东西攥住了它），
    // 交出去的会是一个"看起来 running、屏幕永远空白"的哑终端 —— 那正是 2026-10-08
    // 真机上 UI 第二次开终端的样子。这里 fail-loud：让调用方拿到可行动的报错去重试，
    // 绝不返回半成品（清理走下面的 catch：端口归还 + destroy）。
    const deadline = Date.now() + CLAIM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      cachedAt = 0;
      row = await currentRow();
      checkCancelled();
      if (closing || ended) throw new Error('端侧终端会话已结束');
      if (row !== null) break;
      await sleep(200);
    }
    if (row === null) {
      throw new Error('端侧终端：' + tty + ' 上没有 shell 认领终端（' + CLAIM_TIMEOUT_MS
        + ' ms 内没找到 stdin 指向它的进程）—— 请关闭后重开终端；若反复出现，说明端口表与 guest 的 tty 对不上');
    }
    state.opened += 1;
    state.lastTotalMs = Date.now() - createdAt;
    /* 成功一次就清零熔断计数：偶发抖动不该让后续真实终端被拒。 */
    clearTerminalFailures();
    log('终端会话已建立（#' + index + ' ' + tty + '，argv=' + spec.argv.join(' ')
      + '，shell pid=' + row.pid + '，前台进程组=' + row.tpgid + '，'
      + 'acquire=' + state.lastAcquireMs + 'ms channel=' + state.lastChannelMs + 'ms '
      + 'launch=' + state.lastLaunchMs + 'ms claim=' + state.lastClaimSource
      + ' total=' + state.lastTotalMs + 'ms）');
  } catch (error) {
    creating = false;
    await stop(spec.signal?.aborted ? 'SIGTERM' : 'SIGHUP');
    state.failed += 1;
    noteTerminalFailure(error && error.message ? error.message : String(error));
    throw error instanceof Error ? error : new Error(String(error));
  }

  const watch = async () => {
    if (ended || closing) return;
    cachedAt = 0;
    await currentRow();
    if (!ended && !closing) monitor = setTimeout(watch, FOREGROUND_TTL_MS);
  };
  monitor = setTimeout(watch, FOREGROUND_TTL_MS);

  delivered = true;
  return {
    pid: shellRow === null ? undefined : shellRow.pid,
    output,
    done: settled.promise,
    async write(data) {
      if (ended) throw new Error('端侧终端会话已结束');
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
      if (buffer.length === 0) return;
      socket.write(buffer);
    },
    async resize(cols, rows) {
      if (ended) throw new Error('端侧终端会话已结束');
      const colCount = Number(cols);
      const rowCount = Number(rows);
      if (!Number.isInteger(colCount) || !Number.isInteger(rowCount) || colCount < 2 || rowCount < 1) return;
      await execInGuest(sizeScript(index, colCount, rowCount), 8000).catch((error) => {
        log('终端 resize 失败（#' + index + ' ' + tty + '）：' + (error && error.message ? error.message : String(error)));
      });
    },
    async inspectForeground() {
      if (ended) return undefined;
      const foreground = foregroundOf(await currentRow());
      return foreground === null ? undefined : foreground;
    },
    async signalForeground(signal) {
      if (ended || closing) throw new Error('端侧终端会话已结束');
      const foreground = foregroundOf(await currentRow());
      if (foreground === null) {
        throw new Error('端侧终端：解析不到 ' + tty + ' 的前台进程组');
      }
      const pgid = foreground.processGroupId;
      if (signal === 'SIGKILL' && shellRow !== null && pgid === shellRow.pid) {
        throw new Error('refusing to SIGKILL the terminal shell; terminate the terminal session instead');
      }
      const short = SIGNALS[signal];
      if (short === undefined) throw new Error('端侧终端：不支持的信号 ' + String(signal));
      await execInGuest('kill -' + short + ' -' + pgid + ' 2>&1 || true', 8000).catch((error) => {
        log('终端信号失败（#' + index + ' ' + tty + ' ' + signal + '）：' + (error && error.message ? error.message : String(error)));
      });
      return pgid;
    },
    async inspectActivity() {
      if (ended) return { state: 'unknown', revision: activity.revision + 1 };
      const row = await currentRow();
      if (row === null) {
        activity = { state: 'unknown', revision: activity.revision + 1 };
        return { state: activity.state, revision: activity.revision };
      }
      // 前台进程组就是 shell 本身 ⇒ 它在等输入（与本地实现 idle 的语义对齐）。
      const next = row.tpgid <= 0 || row.tpgid === row.pid ? 'idle' : 'busy';
      if (next !== activity.state) activity = { state: next, revision: activity.revision + 1 };
      return { state: activity.state, revision: activity.revision };
    },
    async terminate() {
      await stop('SIGTERM');
    },
  };
}
