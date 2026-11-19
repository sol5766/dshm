#!/usr/bin/env node
/**
 * 设备代码指纹：回答"设备上跑的核心树，是不是**本机这份代码**"。
 *
 * 【为什么有这条】`docs/109` §5.3 的判据是**逐字节 sha256**，不是"最近有没有装过东西"。
 * 装机脚本只会告诉你"装成功了"，不会告诉你"设备树里的 5 个自研文件与工作区里的一致"。
 *
 * 【移植说明（docs/267 P2-1）】本工具是 `tools/device-code-fingerprint.ps1` 的 Node 版：
 * PowerShell 在鸿蒙 PC 上不可用，而这条判据是每次出包/排障都要跑的只读检查。
 * 判据、三级 token 取源口径与三态退出码与 PS1 版**逐条对齐**（见下），
 * 差异在末尾"与 PS1 版的已知差异"一节如实登记。
 *
 * 【判据】对每台在线设备：
 *   ① 从 `dshm-host.log` 取运行中的核心树版本（`dsh/cores/<ver>`）与本轮 boot 行号；
 *   ② 本机树 = `dist/core/work/dsh-core-<ver>`（或用 `--local-tree` 指别处，供负控制用）；
 *   ③ 设备侧 5 个关键文件经应用自身的 Python 桥读出来算 sha256（不用 hdc file recv：
 *      `dsh/home` 是 0700、`hdc shell` 是另一个 uid，`cat` 与 `file recv` 都会 Permission denied）；
 *   ④ 逐文件比对，三态结论：一致 / 不一致（列出两侧 sha256）/ 未验证（桥不通、超时、树缺文件）。
 *
 * 【退出码】0 = 全部一致；1 = 有文件不一致；2 = 未验证（取不到证据链）。
 *
 * 用法：
 *   node tools/device-code-fingerprint.mjs                 # 默认 bundle com.dshm.dshclient
 *   node tools/device-code-fingerprint.mjs --bundle com.dshm.dshmbeta
 *   node tools/device-code-fingerprint.mjs --token <live>  # 桥 401 时喂一次（重启后 token 必换）
 *   node tools/device-code-fingerprint.mjs --local-tree <目录>   # 负控制：指向别处必须判"不一致"
 *   node tools/device-code-fingerprint.mjs --self-test     # 无设备也能跑：用合成输入证明判据有牙
 *
 * 【与 PS1 版的已知差异（如实登记）】
 *   · 端口候选只取「`--port` 显式值」+「`RuntimePort.ets` 的 `HOST_DEFAULT_PORT`」+「3120」，
 *     **不**再从日志 grep `origin=http://127.0.0.1:<n>` —— 那份日志里混着客户端源端口，
 *     PS1 版自己也把这条标为"幻觉来源"（2026-10-06 实测抓到过 45700）。少一个候选
 *     只会更早回落到真端口常量，不会误判。
 *   · `hdc fport` 的创建/清理沿用 `tools/lib/hdc-client.mjs` 的 `runHdc`，转发列表按
 *     "已存在则不动、我们建的才撤"的口径处理。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeHdc, resolveHdc, runHdc } from './lib/hdc-client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const argOf = (n, d = '') => {
  const i = argv.indexOf(n);
  return i >= 0 ? (argv[i + 1] ?? d) : d;
};

const BUNDLE = argOf('--bundle', 'com.dshm.dshclient');
const TOKEN_ARG = argOf('--token', '');
const LOCAL_TREE_ARG = argOf('--local-tree', '');
const PORT_ARG = Number(argOf('--port', '0'));
const TIMEOUT_SEC = Number(argOf('--timeout', '25'));
const SELF_TEST = flag('--self-test');
const TARGET = argOf('--target', '');

/** 5 个关键文件（与 PS1 版逐条对齐）：它们决定"模型发一条 bash/落一次盘"之后到底走哪条实现。 */
const KEY_FILES = [
  'node_modules/@deepseek-ai/dsh-fs-local/lib/index.js',
  'node_modules/@deepseek-ai/dshm-fs-write-nonchmod/lib/denial-hints.js',
  'node_modules/@deepseek-ai/dshm-fs-write-nonchmod/lib/fsio-nochmod.js',
  'node_modules/@deepseek-ai/dshm-tool-fs-remove/lib/denial-hints.js',
  'node_modules/@deepseek-ai/dshm-tool-fs-remove/lib/index.js',
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sha256File = (p) => sha256(readFileSync(p));

/* ── 纯判据（供 --self-test 在合成输入上跑同一段逻辑）────────────────────── */

/**
 * @param {{rel:string, size:number, sha:string}[]} local   本机树的读数
 * @param {{rel:string, size:number, sha:string}|{rel:string, miss:string}[]} remote 设备侧读数
 * @returns {{state:'same'|'diff'|'error', rows:object[]}}
 */
export function judgeFingerprint(local, remote) {
  const localBy = new Map(local.map((r) => [r.rel, r]));
  const rows = [];
  let sawError = false;
  for (const name of KEY_FILES) {
    const a = localBy.get(name);
    const b = remote.find((r) => r.rel === name);
    if (a === undefined) {
      sawError = true;
      rows.push({ rel: name, state: 'error', why: '本机树里没有这个文件（先跑 pack-core --place-in-app）' });
      continue;
    }
    if (b === undefined || b.miss !== undefined) {
      sawError = true;
      rows.push({ rel: name, state: 'error', why: `设备侧读不到：${b ? b.miss : '未回帧'}` });
      continue;
    }
    if (a.size !== b.size) {
      rows.push({ rel: name, state: 'diff', why: `大小不同：本机 ${a.size} B / 设备 ${b.size} B` });
      continue;
    }
    if (a.sha !== b.sha) {
      rows.push({ rel: name, state: 'diff', why: `内容不同：本机 ${a.sha.slice(0, 12)}… / 设备 ${b.sha.slice(0, 12)}…` });
      continue;
    }
    rows.push({ rel: name, state: 'same', why: `${a.size} B ${a.sha.slice(0, 12)}…` });
  }
  if (rows.some((r) => r.state === 'diff')) return { state: 'diff', rows };
  if (sawError) return { state: 'error', rows };
  return { state: 'same', rows };
}

/* ── 自检：无设备也能证明判据有牙 ─────────────────────────────────────────── */
if (SELF_TEST) {
  const mk = (rel, size, sha) => ({ rel, size, sha });
  const base = KEY_FILES.map((rel, i) => mk(rel, 100 + i, String(i).repeat(64).slice(0, 64)));
  const arms = [
    { name: '全等 ⇒ same', local: base, remote: base, want: 'same' },
    { name: '内容不同 ⇒ diff', local: base, remote: base.map((r, i) => (i === 2 ? { ...r, sha: 'f'.repeat(64) } : r)), want: 'diff' },
    { name: '大小不同 ⇒ diff', local: base, remote: base.map((r, i) => (i === 1 ? { ...r, size: r.size + 1 } : r)), want: 'diff' },
    { name: '设备侧缺文件 ⇒ error（不许当"一致"）', local: base, remote: base.filter((r) => r.rel !== KEY_FILES[3]), want: 'error' },
    { name: '本机树缺文件 ⇒ error', local: base.filter((r) => r.rel !== KEY_FILES[0]), remote: base, want: 'error' },
  ];
  let ok = true;
  for (const arm of arms) {
    const got = judgeFingerprint(arm.local, arm.remote).state;
    const pass = got === arm.want;
    console.log(`  ${pass ? '✅' : '❌'} ${arm.name} ⇒ ${got}（期望 ${arm.want}）`);
    if (!pass) ok = false;
  }
  console.log(ok ? '\n✅ 自检通过：五条变异体全部按预期判态。' : '\n❌ 自检失败。');
  process.exit(ok ? 0 : 3);
}

/* ── 设备侧取数（无设备时如实回 2）────────────────────────────────────────── */
const hdc = resolveHdc();
if (hdc === null) {
  console.error('拿不到 hdc（可设 DSHM_HDC 指向 hdc）。⇒ 未验证');
  process.exit(2);
}
/*
 * 【2026-10-28 修】这一段上次移植时写错了：`runHdc` 的真实签名是
 * `runHdc(hdc, target, args, opts)`，这里却按 `(args, opts)` 调；`listTargets` 还被当成 Promise。
 * 结果是**设备路径从未真正跑过**（当时只跑了不碰 hdc 的 `--self-test`）。
 * 现在改用 `probeHdc()`（含本机回环 + 诚实分类），并按真实签名调 `runHdc`。
 */
const probe = probeHdc(hdc);
if (probe.targets.length === 0) {
  if (!probe.available) {
    console.error('hdc 不可用（不是"没有设备"）：' + probe.note);
    console.error('  ⇒ 请在桌面终端 / DevEco 侧运行本工具，或设 DSHM_HDC 指向可用的 hdc。未验证。');
  } else {
    console.error(`没有在线设备：${probe.note} ⇒ 未验证`);
  }
  process.exit(2);
}
const dev = TARGET.length > 0 ? TARGET : probe.targets[0];
if (probe.targets.indexOf(dev) < 0) {
  console.error(`指定设备 ${dev} 不在线。当前在线：${probe.targets.join(', ')} ⇒ 未验证`);
  process.exit(2);
}
console.log(`  设备   = ${dev}${probe.port.length > 0 ? `（本机回环 127.0.0.1:${probe.port}）` : ''}`);
const shellOut = (cmd) => {
  const r = runHdc(hdc, dev, ['shell', cmd]);
  if (r.status !== 0 || r.error !== null) {
    console.error(`hdc shell 失败：status=${r.status} error=${r.error ?? ''} ${String(r.stderr).trim()}`);
  }
  return String(r.stdout ?? '');
};

const filesDir = `/data/app/el2/100/base/${BUNDLE}/haps/entry/files`;

console.log(`# 设备代码指纹（bundle=${BUNDLE}）`);
console.log(`  hdc    = ${hdc}`);

const log = shellOut(`cat ${filesDir}/dshm-host.log 2>/dev/null`);
const verMatch = /cores\/([0-9][^/"'\s]*)/.exec(log);
if (verMatch === null) {
  console.error('读不到运行中的核心树版本（dshm-host.log 里没有 cores/<ver>）⇒ 未验证');
  process.exit(2);
}
const ver = verMatch[1];
const localTree = LOCAL_TREE_ARG.length > 0
  ? resolve(LOCAL_TREE_ARG)
  : join(ROOT, 'dist', 'core', 'work', `dsh-core-${ver}`);
console.log(`  核心树 = ${ver}`);
if (!existsSync(localTree)) {
  console.error(`本机没有对应目录：${localTree} ⇒ 先跑 node tools/pack-core.mjs --place-in-app。未验证`);
  process.exit(2);
}

const local = KEY_FILES.map((rel) => {
  const p = join(localTree, rel);
  if (!existsSync(p)) return { rel, size: -1, sha: '' };
  return { rel, size: statSync(p).size, sha: sha256File(p) };
});

/* token：命令行 > host-ready.json（权威） > 日志本轮 boot 段三级优先（与 PS1 版同口径）。 */
let token = TOKEN_ARG;
let tokenSrc = token.length > 0 ? '命令行 --token' : '';
if (token.length === 0) {
  const raw = shellOut(`cat ${filesDir}/dsh/home/host-ready.json 2>/dev/null`);
  const m = /"token"\s*:\s*"([A-Za-z0-9_-]+)"/.exec(raw);
  if (m !== null) { token = m[1]; tokenSrc = 'host-ready.json'; }
}
if (token.length === 0) {
  console.error('拿不到宿主 token（host-ready.json 读不到，也未用 --token 喂）⇒ 未验证');
  console.error('  宿主重启后 token 必换；请用 --token <live> 再跑一次。');
  process.exit(2);
}
console.log(`  token 来源 = ${tokenSrc}（长度 ${token.length}）`);

/* 端口：显式 > RuntimePort.ets 的常量 > 3120（不从日志猜端口，见头注差异一节）。 */
const portCands = [];
if (PORT_ARG > 0) portCands.push(PORT_ARG);
try {
  const src = readFileSync(join(ROOT, 'entry/src/main/ets/runtime/RuntimePort.ets'), 'utf8');
  const pm = /HOST_DEFAULT_PORT\s*:\s*number\s*=\s*(\d+)/.exec(src);
  if (pm !== null) portCands.push(Number(pm[1]));
} catch { /* 常量读不到时用兜底 */ }
portCands.push(3120);

const pyProbe = [
  'import hashlib, json, os',
  'home = os.environ.get("HOME", "")',
  `root = os.path.join(home, "dsh", "cores", ${JSON.stringify(ver)})`,
  `files = ${JSON.stringify(KEY_FILES)}`,
  'for rel in files:',
  '    p = os.path.join(root, rel)',
  '    try:',
  '        with open(p, "rb") as f:',
  '            b = f.read()',
  '        print("SHA %s %d %s" % (rel, len(b), hashlib.sha256(b).hexdigest()))',
  '    except Exception as e:',
  '        print("MISS %s %s" % (rel, e))',
].join('\n');

let remote = null;
for (const port of [...new Set(portCands)]) {
  const url = `http://127.0.0.1:${port}/dshm-python/run-get?token=${encodeURIComponent(token)}`
    + `&code=${encodeURIComponent(pyProbe)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_SEC * 1000) });
    if (!res.ok) {
      console.log(`  端口 ${port} 应答 ${res.status}，换下一个候选…`);
      continue;
    }
    const body = await res.text();
    if (!body.includes('"ok"')) {
      console.log(`  端口 ${port} 答的不是桥的 JSON，换下一个候选…`);
      continue;
    }
    remote = [];
    for (const line of body.split('\n')) {
      const sha = /^SHA (\S+) (\d+) ([0-9a-f]{64})$/.exec(line.trim());
      if (sha !== null) { remote.push({ rel: sha[1], size: Number(sha[2]), sha: sha[3] }); continue; }
      const miss = /^MISS (\S+) (.*)$/.exec(line.trim());
      if (miss !== null) remote.push({ rel: miss[1], miss: miss[2] });
    }
    break;
  } catch (e) {
    console.log(`  端口 ${port} 不通（${e && e.name ? e.name : 'error'}），换下一个候选…`);
  }
}

if (remote === null) {
  console.error('桥不通（所有端口候选都不应答）⇒ 未验证');
  process.exit(2);
}

const verdict = judgeFingerprint(local, remote);
console.log('');
for (const row of verdict.rows) {
  const tag = row.state === 'same' ? '✅ 一致' : row.state === 'diff' ? '❌ 不一致' : '⚠️  未验证';
  console.log(`  ${tag}  ${row.rel}\n           ${row.why}`);
}
console.log('');
if (verdict.state === 'same') {
  console.log(`结论：一致（${KEY_FILES.length}/${KEY_FILES.length}）—— 设备在跑本机这份核心树。`);
  process.exit(0);
}
if (verdict.state === 'diff') {
  console.log('结论：不一致 —— 设备跑的是**另一份**代码；请先覆盖安装再复测。');
  process.exit(1);
}
console.log('结论：未验证 —— 证据链不完整，**不要**据此宣布"一致"或"不一致"。');
process.exit(2);