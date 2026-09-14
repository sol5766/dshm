#!/usr/bin/env node
/**
 * DSHM 鸿蒙适配：把 @deepseek-ai/node-addon-system 的 flock 换成健壮的纯 JS 实现。
 *
 * 背景（为什么必须有这个补丁）：
 *   上游只为 linux/darwin 提供预编译 system.node，鸿蒙没有该包，
 *   `tryLockExclusive` 会抛 `flock is not supported on openharmony-arm64`；
 *   该调用来自 `dsh-session-persistence-jsonl` 的会话写所有权 lease，因此
 *   不补丁会导致对话直接报错。
 *
 * 为什么不能用「O_EXCL 锁文件 + 进程内轮询」的朴素实现（2026-09-13 修复）：
 *   上游 lease 的契约是「描述符关闭即释放，**包括进程死亡时**」（见
 *   dsh-session-persistence-jsonl/lib/index.js:2772 注释）。真实 flock 由内核
 *   保证这一点，但 O_EXCL 锁文件不会：进程被 force-stop / 崩溃 / 重启后，
 *   负责 unlink 的 setInterval 永远不会执行，锁文件永久残留。
 *   下次启动 openSync(lockPath, 'wx') 命中 EEXIST → 抛 EAGAIN → 会话写入所有权
 *   拿不到 → **旧会话无法继续对话**（实测症状：装完 HAP 后旧会话打不开/发不出去，
 *   宿主与内嵌模式同时复现，因为与运行模式无关）。
 *
 * 本实现的三层保障：
 *   1. 正常释放：轮询调用方 fd 是否已关闭（fstatSync 抛 EBADF），关闭即删锁（原逻辑保留）。
 *   2. 残留自愈：命中 EEXIST 时读锁文件里的 pid，进程已死则删除锁并重试一次；
 *      pid 不可解析时用 mtime 兜底（超过 STALE_MS 视为残留）。
 *   3. 退出清理：process exit / SIGINT / SIGTERM / SIGHUP 时删除本进程持有的锁，
 *      并在清理后恢复默认信号处置（重发信号），不改变原终止语义。
 *
 * 用法: node scripts/patch-flock-ohos.mjs <env-root>
 *   例: node scripts/patch-flock-ohos.mjs entry/src/main/resources/rawfile/dsh
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ENV_ROOT = process.argv[2];
if (ENV_ROOT === undefined || ENV_ROOT.length === 0) {
  console.error('用法: node scripts/patch-flock-ohos.mjs <env-root>');
  process.exit(1);
}

const target = join(ENV_ROOT, 'node_modules', '@deepseek-ai', 'node-addon-system', 'lib', 'flock.js');
if (!existsSync(target)) {
  console.error(`错误: 未找到 ${target}（环境未就绪或包名变化）`);
  process.exit(1);
}

const MARK = 'DSHM 鸿蒙适配：健壮 flock';

const source = `/** Lazy POSIX flock entry; importing it does not load a native addon. */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getSystemErrorName } from 'node:util';
import {
  closeSync, fstatSync, openSync, readFileSync, statSync, unlinkSync, writeSync, readlinkSync,
} from 'node:fs';

/**
 * ${MARK}（O_EXCL 锁文件 + pid 活性自愈 + 退出清理）。
 *
 * 语义对齐目标：flock 的释放是「关闭该 open file description 即释放」，
 * **包括进程死亡**。纯 JS 无法拿到内核锁，因此用「锁文件 + 三层清理」逼近：
 *   1. 轮询调用方 fd 关闭 → 删锁（正常路径）；
 *   2. 撞锁时读 pid，进程已死 → 视为残留，删锁重试（进程被强杀后的自愈）；
 *   3. exit / SIGINT / SIGTERM / SIGHUP → 删本进程持有的锁。
 */
const LOCK_SUFFIX = '.dshm-flock';
/** pid 不可解析时的兜底残留阈值：超过该时长的锁视为残留。 */
const STALE_MS = 60_000;
/** fd 关闭检测间隔（保持与旧实现一致）。 */
const POLL_MS = 200;

/** 本进程当前持有的锁文件路径，供退出清理使用。 */
const ownedLocks = new Set();
let exitCleanupInstalled = false;

function lockPathForFd(fd) {
  try {
    const link = readlinkSync(\`/proc/self/fd/\${fd}\`);
    if (typeof link === 'string' && link.length > 0 && link.charCodeAt(0) === 47) {
      return link + LOCK_SUFFIX;
    }
  } catch { /* 回退到按 fd 编号 */ }
  return \`/tmp/dshm-flock-\${fd}\`;
}

/** 读锁文件里记录的持有者 pid；不可解析时返回 undefined。 */
function readLockOwner(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** 进程是否存活：EPERM 视为存活（存在但无权限），仅 ESRCH 判定已死。 */
function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** 锁是否可判定为残留：持有者已死，或 pid 不可解析且锁文件已过期。 */
function isStaleLock(lockPath) {
  const owner = readLockOwner(lockPath);
  if (owner !== undefined) return !isProcessAlive(owner);
  try {
    return Date.now() - statSync(lockPath).mtimeMs > STALE_MS;
  } catch {
    return true; // 文件已消失：按残留处理，让重试重新竞争
  }
}

function removeLock(lockPath) {
  ownedLocks.delete(lockPath);
  try { unlinkSync(lockPath); } catch { /* 已释放或无权删除 */ }
}

/** 删除本进程持有的全部锁；幂等。 */
function releaseOwnedLocks() {
  for (const lockPath of [...ownedLocks]) removeLock(lockPath);
}

function installExitCleanup() {
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  process.on('exit', releaseOwnedLocks);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try {
      process.on(signal, () => {
        releaseOwnedLocks();
        // 清理后恢复默认处置并重发信号，保持原有终止语义与退出码约定。
        process.removeAllListeners(signal);
        try { process.kill(process.pid, signal); } catch { process.exit(1); }
      });
    } catch { /* 运行时不支持该信号 */ }
  }
}

function contentionError() {
  return Object.assign(new Error('EAGAIN: flock failed'), {
    code: 'EAGAIN', errno: 11, syscall: 'flock',
  });
}

async function tryLockExclusiveJs(fd) {
  const lockPath = lockPathForFd(fd);
  // 残留锁自愈：最多重试一次（删掉已死持有者的锁后重新竞争）。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = openSync(lockPath, 'wx');
    } catch (error) {
      const contended = error && (error.code === 'EEXIST' || error.code === 'EACCES');
      if (!contended) throw error;
      if (attempt === 0 && isStaleLock(lockPath)) {
        removeLock(lockPath);
        continue;
      }
      throw contentionError();
    }
    // 写入 pid 供后续进程做活性判定（诊断与自愈都依赖它）。
    try { writeSync(handle, String(process.pid)); } catch { /* 内容仅供诊断 */ }
    closeSync(handle);
    ownedLocks.add(lockPath);
    installExitCleanup();
    const timer = setInterval(() => {
      try {
        fstatSync(fd);
      } catch {
        clearInterval(timer);
        removeLock(lockPath);
      }
    }, POLL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    return;
  }
  throw contentionError();
}

let binding;
function loadBinding() {
  if (binding)
    return binding;
  const { platform, arch } = process;
  if (platform !== 'linux' && platform !== 'darwin') {
    throw Object.assign(new Error(\`flock is not supported on \${platform}-\${arch}\`), {
      code: 'ERR_FLOCK_UNSUPPORTED_PLATFORM',
      syscall: 'flock',
    });
  }
  let filename = 'system.node';
  if (platform === 'linux') {
    // Node's report types omit the libc field supplied by Linux reports.
    const report = process.report.getReport();
    filename = join(report.header.glibcVersionRuntime ? 'glibc' : 'musl', filename);
  }
  const require = createRequire(import.meta.url);
  const manifest = require.resolve(\`@deepseek-ai/node-addon-system-\${platform}-\${arch}/package.json\`);
  binding = require(join(dirname(manifest), 'bin', filename));
  return binding;
}
/**
 * Attempt an exclusive, nonblocking POSIX flock on the caller's descriptor.
 * The syscall runs in asynchronous work, so acquisition can occur after this
 * call returns. Keep fd open until the promise settles; the binding never
 * opens, duplicates, or closes it. Closing the locked descriptor releases the
 * lock once all descriptors for its open file description are closed.
 * @param fd - Open file descriptor to lock; ownership remains with the caller.
 * @returns A promise resolving to void on acquisition. Contention rejects with
 *   EAGAIN/EWOULDBLOCK; other syscall failures also reject. Syscall errors carry
 *   code, positive errno, and syscall='flock'. Native setup errors, unsupported
 *   platforms, and addon loading failures reject; importing alone does not load it.
 */
export async function tryLockExclusive(fd) {
  if (process.platform === 'openharmony') {
    return tryLockExclusiveJs(fd);
  }
  const errno = await new Promise((resolve) => {
    loadBinding().tryLock(fd, resolve);
  });
  if (errno === 0)
    return;
  const code = getSystemErrorName(-errno);
  throw Object.assign(new Error(\`\${code}: flock failed\`), {
    code,
    errno,
    syscall: 'flock',
  });
}
`;

const previous = readFileSync(target, 'utf8');
if (previous === source) {
  console.log('flock: 已是最新（健壮版）');
  process.exit(0);
}
writeFileSync(target, source);
console.log(`flock: 已写入健壮版（pid 活性自愈 + 退出清理）-> ${target}`);
