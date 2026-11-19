#!/usr/bin/env node
/**
 * 把鸿蒙 PC 上已有的 brew Codex、CA 包和登录态同步给 DSHM 应用。
 *
 * 背景：
 *   · `/storage/Users/currentUser/.harmonybrew/bin/codex` 对桌面 shell 可见，但应用进程
 *     直接 exec 会被系统拒绝；复制到 `Download/com.dshm.dshclient/codex-brew` 后可执行。
 *   · 应用进程默认没有 Codex Rust TLS 使用的根证书。只修二进制会表现为
 *     `Reconnecting... waiting for network`，实际 HTTPS 可达但证书链校验失败。
 *   · 宿主 `~/.codex` 与 appspawn 的 HOME 属于不同安全域，应用不能直接读取 auth/config。
 *
 * 本脚本做一次幂等同步：
 *   1) codex 本体 → Download/com.dshm.dshclient/codex-brew；
 *   2) brew CA 包 → 同名目录 codex-ca.pem；
 *   3) auth.json / config.toml / models.json / codex-ca.pem → 应用私有 `.codex`。
 *
 * 第 3 步通过 DSHM 自己的 `/dshm-python/run-get` 通道，把一个 0700 临时目录中的文件
 * 复制进应用域，完成后立即清除暂存目录。凭据内容不会进入 URL、源码或终端输出。
 *
 * 用法：
 *   node tools/setup-codex-for-dshm.mjs
 *   node tools/setup-codex-for-dshm.mjs --source <codex> --target <file>
 *   node tools/setup-codex-for-dshm.mjs --no-credentials
 *   node tools/setup-codex-for-dshm.mjs --device 127.0.0.1:45595
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const appBundle = (() => {
  const explicit = arg('--bundle', process.env.DSHM_BUNDLE || '');
  if (explicit.length > 0) return explicit;
  try {
    const text = readFileSync(join(ROOT, 'AppScope', 'app.json5'), 'utf8');
    return /"bundleName"\s*:\s*"([^"]+)"/.exec(text)?.[1] || 'com.dshm.dshclient';
  } catch {
    return 'com.dshm.dshclient';
  }
})();

const source = resolve(arg('--source',
  process.env.DSHM_CODEX_SOURCE
  || join(homedir(), '.harmonybrew', 'bin', 'codex')));
const target = resolve(arg('--target',
  process.env.DSHM_CODEX_BIN
  || join(homedir(), 'Download', appBundle, 'codex-brew')));
const caSource = resolve(arg('--ca-source',
  process.env.DSHM_CODEX_CA_SOURCE
  || join(homedir(), '.harmonybrew', 'etc', 'ca-certificates', 'cert.pem')));
const caTarget = resolve(arg('--ca-target',
  process.env.DSHM_CODEX_CA_FILE
  || join(dirname(target), 'codex-ca.pem')));
const codexHome = resolve(arg('--codex-home',
  process.env.CODEX_HOME || join(homedir(), '.codex')));
const device = arg('--device', process.env.DSHM_HDC_TARGET || '');
const statusUrl = arg('--status-url', 'http://127.0.0.1:3120/dshm-python/status');
const syncCredentials = !args.includes('--no-credentials');

function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function copyWithCp(src, dst, timeout = 300000) {
  const copied = spawnSync('cp', [src, dst], { encoding: 'utf8', timeout });
  if (copied.status !== 0) {
    fail(`复制失败：${src} -> ${dst}\n${copied.stderr || copied.stdout || `exit=${copied.status}`}`, 3);
  }
}

if (!existsSync(source)) fail(`找不到 Codex 源文件：${source}`);
if (!existsSync(caSource)) fail(`找不到 CA 源文件：${caSource}`);
mkdirSync(dirname(target), { recursive: true });

const sourceVersion = spawnSync(source, ['--version'], { encoding: 'utf8', timeout: 20000 });
if (sourceVersion.status !== 0) {
  fail(`源 Codex 不可执行（exit=${sourceVersion.status}）：`
    + String(sourceVersion.stdout || sourceVersion.stderr || '').trim(), 4);
}
const existingVersion = existsSync(target)
  ? spawnSync(target, ['--version'], { encoding: 'utf8', timeout: 20000 })
  : null;
const sameSize = existsSync(target) && statSync(target).size === statSync(source).size;
const sameVersion = existingVersion?.status === 0
  && String(sourceVersion.stdout || sourceVersion.stderr).trim()
    === String(existingVersion.stdout || existingVersion.stderr).trim();
if (!(sameSize && sameVersion)) copyWithCp(source, target);

const targetMode = statSync(target).mode & 0o777;
if ((targetMode & 0o111) === 0) {
  try {
  /*
   * 【hmfs 注记（docs/267 §4，2026-10-28 实测）】本仓位于 hmfs 时 `chmod` **静默无效**
   * （权限由文件系统固定，实测恒 660，见 docs/258 §4.3）；落在 el2 应用沙箱时它正常生效。
   * 所以下面这几处 chmod 是"尽力而为"：失败不要当 bug 排查，判据要看**可读/可执行能力**
   * 而不是权限位。
   */
    chmodSync(target, 0o755);
  } catch (e) {
    fail(`Codex 目标文件没有执行位，且 chmod 失败：${e.message}`, 5);
  }
}
const versionRun = spawnSync(target, ['--version'], { encoding: 'utf8', timeout: 20000 });
const version = String(versionRun.stdout || versionRun.stderr || '').trim();
if (versionRun.status !== 0) fail(`复制后执行失败（exit=${versionRun.status}）：${version}`, 4);

if (!existsSync(caTarget) || sha256(caSource) !== sha256(caTarget)) copyWithCp(caSource, caTarget);
if ((statSync(caTarget).mode & 0o444) === 0) {
  try { chmodSync(caTarget, 0o644); } catch { /* DSHM 的持久文件权限仍可读时继续 */ }
}

function hdcArgs(parts) {
  return device.length > 0 ? ['-t', device, ...parts] : parts;
}

function runningHostToken() {
  if (!/^[A-Za-z0-9._-]+$/.test(appBundle)) return '';
  const log = `/data/app/el2/100/base/${appBundle}/haps/entry/files/node-output.log`;
  const read = spawnSync('hdc', hdcArgs([
    'shell',
    `grep -a "dsh web:" "${log}" | tail -n 1`,
  ]), { encoding: 'utf8', timeout: 15000 });
  if (read.status !== 0) return '';
  return /[?&]token=([^&\s]+)/.exec(String(read.stdout || ''))?.[1] || '';
}

async function hostReady() {
  try {
    const res = await fetch(statusUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.ok === true && body?.ready === true;
  } catch {
    return false;
  }
}

async function syncAppCodexHome() {
  if (!(await hostReady())) {
    console.error('WARN: DSHM 宿主未运行，登录态与 CA 未同步；启动 DSHM 后重跑本脚本。');
    return false;
  }
  const token = runningHostToken();
  if (token.length === 0) {
    console.error('WARN: 读不到当前 DSHM token，登录态与 CA 未同步；确认 hdc 连接后重跑。');
    return false;
  }

  const names = ['auth.json', 'config.toml', 'models.json']
    .filter((name) => existsSync(join(codexHome, name)));
  if (!names.includes('auth.json')) {
    console.error(`WARN: ${join(codexHome, 'auth.json')} 不存在，Codex 登录态未同步。`);
    return false;
  }

  const stage = mkdtempSync(join(dirname(target), '.codex-seed-'));
  try {
    chmodSync(stage, 0o700);
    for (const name of names) {
      copyFileSync(join(codexHome, name), join(stage, name));
      chmodSync(join(stage, name), 0o600);
    }
    copyFileSync(caSource, join(stage, 'codex-ca.pem'));
    chmodSync(join(stage, 'codex-ca.pem'), 0o600);

    const copyNames = names.concat('codex-ca.pem');
    const code = [
      'import json, os, shutil, stat',
      `seed = ${JSON.stringify(stage)}`,
      'app = "/data/storage/el2/base/haps/entry/files/.codex"',
      'os.makedirs(app, mode=0o700, exist_ok=True)',
      'os.chmod(app, 0o700)',
      `names = ${JSON.stringify(copyNames)}`,
      'copied = []',
      'for name in names:',
      '    src = os.path.join(seed, name)',
      '    dst = os.path.join(app, name)',
      '    tmp = dst + ".dshm-sync"',
      '    shutil.copyfile(src, tmp)',
      '    os.chmod(tmp, 0o600)',
      '    os.replace(tmp, dst)',
      '    copied.append(name)',
      'print(json.dumps({"copied": copied, "home_mode": oct(stat.S_IMODE(os.stat(app).st_mode))}))',
    ].join('\n');
    const url = new URL('/dshm-python/run-get', statusUrl);
    url.searchParams.set('token', token);
    url.searchParams.set('timeout', '60');
    url.searchParams.set('code', code);
    const res = await fetch(url, { signal: AbortSignal.timeout(65000) });
    const body = await res.json();
    const nested = body?.stdout ? JSON.parse(body.stdout) : null;
    if (!res.ok || body?.ok !== true || !Array.isArray(nested?.copied)) {
      throw new Error(JSON.stringify(body).slice(0, 800));
    }
    console.log(`credentials: ${nested.copied.join(', ')}`);
    console.log(`app codex home: ${nested.home_mode}`);
    return true;
  } catch (e) {
    console.error(`WARN: 应用私有 .codex 同步失败：${e.message}`);
    return false;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

console.log(`source: ${source}`);
console.log(`target: ${target}`);
console.log(`size: ${statSync(target).size} B`);
console.log(`sha256: ${sha256(target)}`);
console.log(`version: ${version}`);
console.log(`ca source: ${caSource}`);
console.log(`ca target: ${caTarget}`);
console.log(`ca sha256: ${sha256(caTarget)}`);

let credentialsOk = true;
if (syncCredentials) credentialsOk = await syncAppCodexHome();
if (!credentialsOk) process.exitCode = 6;
