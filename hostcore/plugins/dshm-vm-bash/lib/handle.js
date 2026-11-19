/*
 * 把「一次 subprocess spawn」变成「一次 guest 命令」，并合成上游契约要求的 handle。
 *
 * 【契约从哪来】不是猜的，是读出来的：`@deepseek-ai/dsh-subprocess-local` 的
 * `bindManagedProcess()`（`lib/runner-launch-*.js:852-1012`）返回的对象形状就是 seam
 * 的形状 —— `{ stdin, stdout, stderr, control, collected:{stdout?,stderr?}, done,
 * terminate, terminateForHostExit, waitForExit }`，其中：
 *   · `done` → `{exitCode, signal}`（`dsh-bash-local` 的 executeArgv 只认这两个）；
 *   · `collected.stdout/stderr` → 被 `readFrom(0)` 读成 `{text, lossy, spillPath?}`
 *     （`dsh-bash-local:33-40` 的 `finalOutput`）；**必须给**，否则上游直接抛
 *     `subprocess implementation dropped a requested collect stream`（同文件 :133）。
 * 本文件按这个形状实现，所以上游的输出收集 / 结算 / 终止链路一个字都不用改。
 *
 * 【同步返回 + 异步启动】`spawn` 是同步 API（上游拿到 handle 就 `await done`），
 * 而 VM 冷启动实测 11.8 s。⇒ 这里**立刻**返回 handle，把"取会话 + 跑命令"整段放进
 * 后台 promise：第一次命令的额外延迟只体现在这一次 `done` 上，第二次起就是
 * 一次 QGA 往返（81~219 ms）。取消若发生在"会话还没取到"时，命令**根本不执行**。
 *
 * 【与本地实现的**已知语义差异**（刻意、写在这里而不是藏起来）】
 *   ① **没有流式**：QGA 是"跑完把 base64 输出一次给我"，不是管道。所以：
 *      · collect 模式（`bash-local` 用的那种）语义**完全一致**；
 *      · `stdio:'pipe'` 的调用方会在命令**结束后**一次性拿到全部输出，而不是边跑边收。
 *   ② **spill 走宿主侧**：超 `maxBytes` 时把**完整**输出写到 `<vmDir>/spill/<id>.{out,err}`
 *      并报 `spillPath`（路径在宿主上，能直接读）。本地实现的 spill 目录语义
 *      （`prepareManagedProcessBinding()`）是 subprocess-local 内部约定、不是 seam
 *      契约，故不参与。
 *   ③ **没有 `control` 通道**：`stdio.control === 'pipe'` 时本插件不接管（见 index.js
 *      的拒绝面）—— control pipe 是 subprocess-local 私有协议，伪造会静默改变语义。
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { workPath } from './paths.js';

/** 可接管的 guest shell 名字（**只有这些**，见 index.js 的拒绝面）。 */
const GUEST_SHELLS = new Set(['bash', 'sh', 'ash', 'dash', 'zsh']);

/** guest 侧这些 shell 的绝对路径。 */
const GUEST_SHELL_PATHS = {
  bash: '/bin/bash',
  sh: '/bin/sh',
  ash: '/bin/ash',
  dash: '/bin/dash',
  zsh: '/bin/zsh',
};

/** 单引号包裹（POSIX 安全：内部的 `'` 折成 `'\''`）。 */
export function shq(value) {
  return `'${String(value).split("'").join("'\\''")}'`;
}

/**
 * argv[0] 是不是"可以直接改到 guest 里跑"的程序。
 *
 * 只认裸名或 `/bin/<name>`：**刻意收得很窄**。宿主沙箱里那些随包的假壳
 * （`$DSHM_SANDBOX_HOME/bin/{pnpm,python3,git,…}`）不在白名单里 —— 它们的逻辑是
 * "在宿主上做事"（探 execve 白名单、转发 127.0.0.1 的 Python 桥），搬进 guest 只会
 * 得到一串看不懂的失败（guest 的 127.0.0.1 是它自己的回环）。所以那些仍旧原样走本地
 * spawn（也就是保持今天"跑不了"的事实），不假装接管。
 * @returns guest 侧绝对路径，或 null
 */
export function translateProgram(program) {
  const name = String(program || '');
  if (name.length === 0) return null;
  const bare = name.startsWith('/bin/') ? name.slice(5) : name;
  if (!GUEST_SHELLS.has(bare)) return null;
  if (name.startsWith('/bin/')) return name;
  return GUEST_SHELL_PATHS[bare] ?? null;
}

/** 写宿主文件（同时就是 guest 可见路径，因为 el2 被 9p 共享）。 */
function writeHostFile(relative, content) {
  const full = workPath(relative);
  mkdirSync(dirname(full), { recursive: true });
  const stream = createWriteStream(full);
  stream.end(content);
  return full;
}

/**
 * 把 spec 摊平成一份 guest 侧脚本。
 *
 * 【为什么写成脚本文件而不是 `-c` 内联】模型的命令可能是多 KB 的脚本；`-c` 内联要经
 * execve 的 ARG_MAX，且引号层层嵌套。落成 `<vmDir>/tmp/run-<id>.sh` 再
 * `/bin/bash <file>` 两个问题一起消掉，顺带留下可复盘的现场。
 *
 * @param spec 上游的 subprocess spec
 * @param runId 本次运行的 id（文件名用）
 * @returns `{guestPath, guestArgv, guestArgvTail, scriptPath, script}` 或 null（不可接管）
 */
export function buildRun(spec, runId) {
  const argv = spec.argv;
  const guestPath = translateProgram(argv[0]);
  if (guestPath === null) return null;
  const rest = argv.slice(1);

  // `-c` / `-lc` / `-ic` 形态：命令串在 rest[1]，其余是 shell 自己的选项/位置参数。
  const isCommandString = rest.length >= 2 && /^-[-a-z]*c[-a-z]*$/.test(rest[0]);
  const tail = isCommandString ? rest.slice(2) : rest;

  // 【刻意不写 `set -u`】本文件是**替模型执行命令**的：`set -u` 会让用户脚本里任何一次
  // `$UNSET` 展开变成致命错误，而 `bash -c` 本来不会 —— 那是静默改变语义。
  const lines = [];
  // guest 侧 PATH 只给 guest 自己的目录：宿主的随包假壳**刻意不挂**（见 translateProgram）。
  lines.push("export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'");
  lines.push('export HOME=/root');
  const env = spec.env && typeof spec.env === 'object' ? spec.env : {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    lines.push(`export ${key}=${shq(value)}`);
  }
  const cwd = typeof spec.cwd === 'string' && spec.cwd.length > 0 ? spec.cwd : '/';
  // 【失败报文要说人话】guest 只挂了"应用沙箱 + 本次启动绑定的那个工作区"（一进程一
  // VM ⇒ 挂载在启动那一刻定死）⇒ 换到别的工作区时会失败，这里必须把"怎么办"写清楚，
  // 否则调用方只会看到一句"目录不存在"而不知道这条路是通的。
  lines.push(`cd -- ${shq(cwd)} || { echo "dshm: 工作目录不存在（guest 视角）：${cwd}" >&2; echo "dshm: 手持档 guest 只挂载应用沙箱与本次启动绑定的工作区；要在这个工作区用 bash 请重启应用" >&2; exit 127; }`);

  // stdin：`{data}` 由宿主写到共享目录（guest 里同路径可读）⇒ `exec < <file>` 让后续
  // 所有命令共用这份 stdin，比给每条命令追加重定向稳（命令自带管道/重定向也不冲突）。
  const stdin = spec.stdio && spec.stdio.stdin;
  if (stdin !== undefined && stdin !== null && typeof stdin === 'object' && 'data' in stdin) {
    const stdinPath = writeHostFile(join('tmp', `stdin-${runId}.txt`), stdin.data);
    lines.push(`test -r ${shq(stdinPath)} && exec < ${shq(stdinPath)}`);
  } else {
    lines.push('exec < /dev/null');
  }

  if (isCommandString) {
    lines.push(String(rest[1] ?? ''));
  } else {
    // 非 `-c` 形态：还原成一条命令行（位置参数待 guestArgvTail 传，`$1..` 语义保持）。
    lines.push([guestPath, ...tail].map(shq).join(' '));
  }

  const script = `${lines.join('\n')}\n`;
  const scriptPath = writeHostFile(join('tmp', `run-${runId}.sh`), script);
  return {
    guestPath,
    guestArgv: [scriptPath],
    guestArgvTail: isCommandString ? [] : tail,
    scriptPath,
    script,
  };
}

/**
 * 收集器：上游 `dsh-bash-local` 只用到 `readFrom(0)`（取 `text` / `lossy` /
 * `spillPath`），`seal()` 由 subprocess-local 的 `done` 链路调用。实现这两个即可。
 */
class CollectedText {
  constructor(label, mode, onSpill) {
    this.label = label;
    this.maxBytes = mode && typeof mode.maxBytes === 'number' ? mode.maxBytes : 0;
    this.onSpill = onSpill;
    this.chunks = [];
    this.sealed = false;
  }

  push(text) {
    if (this.sealed || typeof text !== 'string' || text.length === 0) return;
    this.chunks.push(Buffer.from(text, 'utf8'));
  }

  seal() {
    this.sealed = true;
  }

  /** 与上游 OutputCollector 同形：`{text, lossy, spillPath?}`。 */
  readFrom() {
    const full = Buffer.concat(this.chunks);
    const limit = this.maxBytes > 0 ? this.maxBytes : full.length;
    const text = full.subarray(0, limit).toString('utf8');
    if (full.length <= limit) return { text, lossy: false };
    let spillPath;
    try {
      spillPath = this.onSpill === undefined ? undefined : this.onSpill(full);
    } catch {
      spillPath = undefined;
    }
    return spillPath === undefined ? { text, lossy: true } : { text, lossy: true, spillPath };
  }
}

/**
 * 跑一次 guest 命令并返回上游形状的 handle。
 *
 * @param spec 上游 subprocess spec（argv/cwd/env/stdio/graceMs/signal）
 * @param acquire `() => Promise<QgaSession>` —— 取（必要时启动）VM 会话
 * @returns handle（同步返回）
 */
export function createVmHandle(spec, acquire) {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const run = buildRun(spec, runId);
  if (run === null) throw new Error('dshm-vm-bash: 该 argv 不可接管（应在 index.js 就拦掉）');

  const outMode = spec.stdio.stdout;
  const errMode = spec.stdio.stderr;
  const wantOut = outMode !== 'ignore' && outMode !== 'inherit';
  const wantErr = errMode !== 'ignore' && errMode !== 'inherit';

  const spillDir = workPath('spill');
  const spill = (label) => (buffer) => {
    try {
      mkdirSync(spillDir, { recursive: true });
      const path = join(spillDir, `${runId}.${label}`);
      createWriteStream(path).end(buffer);
      return path;
    } catch {
      return undefined;
    }
  };
  const collected = {};
  if (wantOut) collected.stdout = new CollectedText('stdout', outMode, spill('out'));
  if (wantErr) collected.stderr = new CollectedText('stderr', errMode, spill('err'));

  const stdout = wantOut && outMode === 'pipe' ? new PassThrough() : undefined;
  const stderr = wantErr && errMode === 'pipe' ? new PassThrough() : undefined;

  // 兜底上限：spec 里没有 timeoutMs（那是 bash-local 自己算的 deadline，经 signal 传进来），
  // 这里只防"卡死的 guest 命令把 handle 永久挂住"。取消正路是 spec.signal。
  const envTimeout = Number(process.env.DSHM_VM_CMD_TIMEOUT_MS || 0);
  const timeoutMs = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 3600000;
  const grace = Number.isFinite(spec.graceMs) && spec.graceMs > 0 ? spec.graceMs : 3000;

  let settled = false;
  let cancelled = false;
  let guestPid = 0;
  let submitted = false;
  let live = null;
  let killTimer = null;
  const signal = spec.signal;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const closeStreams = () => {
    if (stdout !== undefined) stdout.end();
    if (stderr !== undefined) stderr.end();
  };
  const cleanup = () => {
    signal?.removeEventListener('abort', onAbort);
    if (killTimer !== null) {
      clearTimeout(killTimer);
      killTimer = null;
    }
  };
  const finish = (exitCode, signal) => {
    if (settled) return;
    settled = true;
    cleanup();
    closeStreams();
    resolveDone({ exitCode, signal });
  };
  const fail = (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    // 如实失败，绝不伪装成"命令成功但无输出"（那正是本仓踩过的坑）。
    const text = `${(error && error.message) || error}\n`;
    if (collected.stderr !== undefined) collected.stderr.push(text);
    if (stderr !== undefined) stderr.write(text);
    if (stdout !== undefined) stdout.destroy();
    if (stderr !== undefined) stderr.destroy();
    rejectDone(error);
  };

  const killGuest = (signal) => {
    if (!settled && live !== null && guestPid > 0) void live.kill(guestPid, signal);
  };
  const onAbort = () => {
    if (settled) return;
    cancelled = true;
    if (guestPid > 0) {
      if (killTimer !== null) return;
      killGuest('TERM');
      killTimer = setTimeout(() => {
        killTimer = null;
        if (!settled) killGuest('KILL');
      }, grace);
      killTimer.unref?.();
      return;
    }
    // 会话还没取到 / 命令还没起：命令根本不该执行，直接按被取消结算。
    if (!submitted) finish(null, 'SIGTERM');
  };
  if (signal !== undefined && signal !== null) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  if (!cancelled) {
    Promise.resolve()
      .then(acquire)
      .then((qga) => {
        if (cancelled || settled) return undefined;
        live = qga;
        submitted = true;
        // 100 ms 足够及时看到退出，又能避开 15 ms 高频轮询挤占 QGA 串行通道。
        return qga.exec(run.guestPath, [...run.guestArgv, ...run.guestArgvTail], timeoutMs, 100, {
          onPid: (pid) => {
            if (settled) return;
            guestPid = pid;
            if (cancelled) onAbort();
          },
        }).then((result) => {
          if (settled) return;
          if (collected.stdout !== undefined) collected.stdout.push(result.stdout);
          if (collected.stderr !== undefined) collected.stderr.push(result.stderr);
          if (stdout !== undefined) stdout.write(result.stdout);
          if (stderr !== undefined) stderr.write(result.stderr);
          // QGA 只给 `signal`（数字）。非 0 视为被信号结束，报成 SIGKILL 与上游口径一致
          // （上游 POSIX 路径在 grace 到期后发的就是 KILL）。
          finish(result.exitCode, result.signal === null ? null : 'SIGKILL');
        }, (error) => {
          fail(error);
        });
      }, (error) => {
        fail(error);
      });
  }

  const settledPromise = done.then(() => undefined, () => undefined);
  return {
    pid: undefined,
    stdin: undefined,
    stdout,
    stderr,
    control: undefined,
    collected,
    done,
    terminate: () => {
      cancelled = true;
      killGuest('TERM');
    },
    terminateForHostExit: () => {
      /* 宿主退出时不主动 kill：VM 随进程一起消失，guest 侧状态由 rootfs 保留 */
    },
    waitForExit: () => settledPromise,
  };
}

/** 供离线门禁使用（不启动 VM、不写文件之外的副作用）：只把 spec 摊平成脚本。 */
export function previewScript(spec, runId = 'preview') {
  return buildRun(spec, runId);
}
