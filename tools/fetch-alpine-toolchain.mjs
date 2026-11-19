#!/usr/bin/env node
/**
 * 从 Alpine 官方 CDN 采集「可直接在端侧跑」的工具链包（tmux / gh 及其依赖闭包）。
 *
 * ── 为什么用 Alpine 包（而不是自己交叉编译）───────────────────────────────
 * 端侧已有的 git 就是从 Alpine 包解出来的（`toolchain/gitroot/usr/bin/git`，
 * `file` 判为 `ELF 64-bit LSB arm64, dynamic (/lib/ld-musl-aarch64.so.1)`），
 * 而它在真机上**实测能跑** ⇒ 设备自带 musl 加载器，Alpine aarch64 包与设备 ABI 相容。
 * 于是 tmux / gh 用同一套来源与同一套解包-包装-自签名机制即可，不需要新的构建链。
 *
 * ── TLS 为什么要显式给 CA ────────────────────────────────────────────────
 * 设备侧没有 `/etc/ssl/certs/ca-certificates.crt`（实测四个常见路径全无），
 * Python/Node 的默认信任库因此拿不到根证书（实测 `CERTIFICATE_VERIFY_FAILED`）。
 * 而随包 git 自带一份 CA（`toolchain/gitroot/etc/ssl/certs/ca-certificates.crt`，
 * 181 KB）—— 正是 git 能走 HTTPS 的原因。本脚本优先用它，找不到再退回 `NODE_EXTRA_CA_CERTS`。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node tools/fetch-alpine-toolchain.mjs --out <目录> [--packages tmux,github-cli]
 *                                        [--branch v3.22] [--dry-run]
 *
 * 产出：`<out>/<pkgname>/...`（每个包解到自己的目录，避免不同包的 usr/ 互相覆盖），
 * 以及 `<out>/manifest.json`（包名→版本→大小→依赖），供后续打包与门禁核对。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import zlib from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIRROR = 'https://dl-cdn.alpinelinux.org/alpine';
/** 端侧 gitroot 里那份 CA：git 走 HTTPS 靠它，这里复用同一份口径。 */
const DEVICE_CA = '/data/storage/el2/base/haps/entry/files/toolchain/gitroot/etc/ssl/certs/ca-certificates.crt';

/** 设备侧已经提供的组件：不重复打包（musl 加载器由系统给；git 已随包且更完整）。 */
const EXCLUDE = new Set(['musl', 'git', 'busybox', 'scanelf', 'ca-certificates-bundle']);

function parseArgs(argv) {
  const out = { out: join(ROOT, 'dist/alpine-stage'), packages: ['tmux', 'github-cli'], branch: 'v3.22', dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--packages') out.packages = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--branch') out.branch = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

/** 读 CA：优先端侧 gitroot 那份（与 git 同源），其次 NODE_EXTRA_CA_CERTS，最后不传（用系统库）。 */
function loadCa() {
  for (const p of [process.env.DSHM_ALPINE_CA, DEVICE_CA, process.env.NODE_EXTRA_CA_CERTS]) {
    if (!p) continue;
    try {
      if (existsSync(p)) return readFileSync(p);
    } catch (e) { /* 读不到就试下一个 */ }
  }
  return undefined;
}

const CA = loadCa();

function httpGet(url, redirects = 0) {
  return new Promise((res, rej) => {
    https.get(url, { ca: CA, headers: { 'User-Agent': 'dshm-fetch/1.0' } }, (r) => {
      const code = r.statusCode ?? 0;
      if (code >= 300 && code < 400 && r.headers.location && redirects < 5) {
        r.resume();
        res(httpGet(new URL(r.headers.location, url).href, redirects + 1));
        return;
      }
      if (code !== 200) {
        r.resume();
        rej(new Error(`HTTP ${code} ${url}`));
        return;
      }
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => res(Buffer.concat(chunks)));
      r.on('error', rej);
    }).on('error', rej);
  });
}

/** 解 APKINDEX.tar.gz → Map<pkgname, entry>（entry 取 P/V/I/D 等字段）。 */
async function fetchIndex(branch, repo) {
  const url = `${MIRROR}/${branch}/${repo}/aarch64/APKINDEX.tar.gz`;
  const raw = await httpGet(url);
  const tar = zlib.gunzipSync(raw);
  /* 极简 tar 解析：只需找到名为 APKINDEX 的条目。 */
  let off = 0;
  let text = '';
  while (off + 512 <= tar.length) {
    const name = tar.toString('utf8', off, off + 100).replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(tar.toString('ascii', off + 124, off + 136).trim() || '0', 8);
    const dataStart = off + 512;
    if (name === 'APKINDEX') {
      text = tar.toString('utf8', dataStart, dataStart + size);
      break;
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  const pkgs = new Map();
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    const e = {};
    for (const line of block.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) e[line.slice(0, i)] = line.slice(i + 1);
    }
    if (e.P) pkgs.set(e.P, e);
  }
  return { pkgs, url };
}

/** 依赖串里的 `so:` 条目不是包名，跳过；其余递归。 */
/**
 * 依赖项的原始 token（保留 `so:` 前缀）。
 *
 * 【为什么不能把 `so:` 直接丢掉】tmux 的依赖是
 * `so:libevent_core-2.1.so.7` / `so:libncursesw.so.6` —— 这些不是包名，
 * 但**必须**解析到提供它们的包（libevent / ncurses-libs），否则闭包缺库、
 * 端侧一跑就 `Error loading shared library`。第一版就是这么漏掉的（dry-run 只出 4 个包）。
 */
function depTokens(entry) {
  return (entry.D ?? '').split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * 建 soname/命令 提供表：`p:` 字段形如 `so:libncursesw.so.6=6.5_p20250503-r0`。
 * 同时把包名本身也算提供者（Alpine 里 `p:` 通常包含自身名字）。
 */
function buildProvides(indexes) {
  const map = new Map();
  for (const ix of indexes) {
    for (const [name, e] of ix.pkgs) {
      const add = (key) => { if (key && !map.has(key)) map.set(key, name); };
      add(name);
      for (const prov of (e.p ?? '').split(/\s+/).filter(Boolean)) {
        add(prov.split('=')[0]);
      }
    }
  }
  return map;
}

/**
 * 解包一个 .apk（tar.gz）到 destDirs，并把**软链物化成副本**。
 *
 * 【为什么必须物化，而不是保留软链】三段事实叠在一起：
 *   ① Alpine 包把 `.so` 的真实名字放在 `libX.so.7.0.2`，`libX.so.7` 是**软链**；
 *   ② 端侧 hmfs **不支持创建软链**（git 归档当年就撞过，见 main.js 的
 *      `GIT_SYMLINK_REPLICA_FALLBACK`）；
 *   ③ 我第一版解包只写普通文件，软链条目被**整条丢掉**。
 * 结果：设备上 `tmux` 一跑就
 *   `Error loading shared library libevent_core-2.1.so.7 (needed by tmux)`
 * ——而 `gh` 只依赖 libc.musl，所以它没事（这就是"gh 能跑、tmux 不能"的全部原因）。
 * 解法：构建期把软链**读成副本**写进去（名字与目标都照软链），设备侧只解普通文件即可。
 */
function extractApk(buf, destDirs) {
  const tar = zlib.gunzipSync(buf);
  let off = 0;
  const made = [];
  const pendingLinks = [];
  while (off + 512 <= tar.length) {
    const name = tar.toString('utf8', off, off + 100).replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(tar.toString('ascii', off + 124, off + 136).trim() || '0', 8);
    const mode = parseInt(tar.toString('ascii', off + 100, off + 108).trim() || '0', 8);
    const type = tar[off + 156];
    const dataStart = off + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    if (type === 0x30 || type === 0) { // 普通文件
      const p = join(destDirs, name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, data, { mode: mode & 0o777 });
      made.push(name);
    } else if (type === 0x32 || type === 0x31) { // 软链 '2' / 硬链 '1'
      const linkname = tar.toString('utf8', off + 157, off + 257).replace(/\0.*$/, '');
      pendingLinks.push({ name, linkname });
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  /* 物化软链：目标按"同包内相对路径"解析（软链目标多为 `libX.so.7.0.2` 这种同目录名） */
  for (const { name, linkname } of pendingLinks) {
    const target = join(destDirs, dirname(name), linkname);
    const out = join(destDirs, name);
    try {
      if (existsSync(target)) {
        mkdirSync(dirname(out), { recursive: true });
        copyFileSync(target, out);
        made.push(name);
      }
    } catch (e) { /* 物化失败只影响该别名，不阻断整包 */ }
  }
  return made;
}

async function main() {
  const opt = parseArgs(process.argv);
  console.log(`[fetch] branch=${opt.branch} packages=${opt.packages.join(',')} out=${opt.out}`);
  console.log(`[fetch] CA: ${CA ? '已加载（端侧 gitroot 同源）' : '未加载（将用系统信任库）'}`);

  const indexes = [];
  for (const repo of ['main', 'community']) indexes.push(await fetchIndex(opt.branch, repo));
  for (const ix of indexes) console.log(`[fetch] index ${ix.url}  ${ix.pkgs.size} 包`);
  const provides = buildProvides(indexes);

  /* 依赖闭包（BFS），并记录每个包来自哪个 repo（下载 URL 要用）。 */
  const want = new Map();
  const queue = [...opt.packages];
  while (queue.length > 0) {
    const n = queue.shift();
    if (!n || want.has(n) || EXCLUDE.has(n)) continue;
    let entry = null; let repo = null;
    for (const [i, ix] of indexes.entries()) {
      const e = ix.pkgs.get(n);
      if (e) { entry = e; repo = i === 0 ? 'main' : 'community'; break; }
    }
    if (!entry) { console.warn(`[fetch] ⚠ 未找到包 ${n}（依赖缺失，可能是 so: 提供者）`); continue; }
    want.set(n, { entry, repo });
    for (const tok of depTokens(entry)) {
      const base = tok.split(/[<>=~]/)[0];
      if (EXCLUDE.has(base)) continue;            // 设备已提供（musl / git），不重复打包
      queue.push(base.startsWith('so:') || base.startsWith('cmd:') || base.startsWith('pc:')
        ? (provides.get(base) ?? base)              // so: → 提供它的包
        : base);
    }
  }
  console.log(`[fetch] 依赖闭包 ${want.size} 个包：${[...want.keys()].join(', ')}`);

  let total = 0;
  const manifest = {};
  for (const [n, { entry, repo }] of want) {
    const file = `${n}-${entry.V}.apk`;
    const url = `${MIRROR}/${opt.branch}/${repo}/aarch64/${file}`;
    const dest = join(opt.out, n);
    console.log(`[fetch] ${n} ${entry.V} (${Math.round((+entry.I || 0) / 1024)} KB) ← ${repo}`);
    if (opt.dryRun) { manifest[n] = { version: entry.V, repo, url, downloaded: false }; continue; }
    const buf = await httpGet(url);
    total += buf.length;
    mkdirSync(dest, { recursive: true });
    /*
     * 【为什么不把 .apk 留在盘上】`check-no-apk-surface` 会拒绝**包里**出现 apk 扩展名，
     * 而它会扫 `dist/`；一旦把下载物原样留在这里，门禁就红（本轮实测命中 4 个）。
     * 这些 .apk 只用于解包，解完即弃 —— 需要重下时重跑本脚本即可（幂等）。
     */
    const apkPath = join(opt.out, `${n}-${entry.V}.apk`);
    writeFileSync(apkPath, buf);
    const files = extractApk(buf, dest);
    try { unlinkSync(apkPath); } catch (e) { /* 删不掉也不影响解包结果 */ }
    manifest[n] = {
      version: entry.V, repo, url, bytes: buf.length, files: files.length,
      sha256: createHash('sha256').update(buf).digest('hex'),
    };
  }
  if (!opt.dryRun) {
    writeFileSync(join(opt.out, 'manifest.json'), JSON.stringify({ branch: opt.branch, packages: manifest }, null, 2) + '\n');
    console.log(`[fetch] 完成：${want.size} 个包，${(total / 1048576).toFixed(1)} MB → ${opt.out}`);
  }
}

main().catch((e) => {
  console.error('[fetch] 失败：' + (e && e.message ? e.message : e));
  process.exit(1);
});
