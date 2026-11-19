#!/usr/bin/env node
/**
 * 门禁：pnpm/npm 假壳的**执行语义**（docs/293 §5.1 / §5.2 两条真缺陷的守卫）。
 *
 * 【为什么必须"真跑"而不是静态 grep】假壳是生成出来的 shell 脚本，缺陷全在执行语义上：
 *   · `list` 的失败分支 `echo "[]"` 写在 `exit` 之前 ⇒ 退出码被 `echo` 覆盖成 0；
 *   · `dir=$(pwd)` 被无条件当成 profile 目录 ⇒ 在 `/tmp` 下 404，文案却说"端点不可达"；
 *   · 裸 `config` 什么都不打印却 rc=0。
 * 正则判不出这些 —— 只能拿**真实生成的脚本**在假 HOME 下跑一遍。
 *
 * 【本文件踩过并已修正的三个坑（写下来，避免下一个人重蹈）】
 *   ① **不能 `spawnSync`**：它会阻塞本进程事件循环，而同进程里的模拟 Host 就永远
 *      响应不了 ⇒ 门禁整体挂死（第一版卡在这里，表现为"跑到 A 就没动静"）。
 *      必须用 `spawn` + `await`，让 server 能并发处理假壳的请求。
 *   ② **不能依赖本机 `/bin/wget`**：本机是 luckybox 变体，连 200 都不回正文。
 *      这里注入一个与 busybox wget 三态语义一致的假 wget（200→rc0 带正文 /
 *      404→rc1 空 / 连不上→rc1 + connect 文案），被测面仍是被假壳真实调用。
 *   ③ 假 wget 直接 `exec` 到 node 代理，不经中转文件 —— 中转文件会引入
 *      "$$ 可用性 / 重定向顺序"两个与本判据无关的失败面。
 *
 * 对照臂（--self-test）：删 list 的 `exit 1` / 把 config 退回空输出 / 去掉 profile 回落
 * ⇒ 必须判红。
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MAIN = 'hostcore/app/main.js';

/* ── 从 main.js 抽出生成规则（唯一事实源） ─────────────────────────────── */

function extractArraySource(src) {
  const at = src.indexOf('const CLI_SHIM_LINES = [');
  if (at < 0) return '';
  const open = src.indexOf('[', at);
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote !== null) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return '';
}

function extractFn(src, name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) return '';
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return '';
}

/** 用 main.js 里的真实片段重建渲染器：`(env) => 脚本文本`。 */
export function buildRenderer(src) {
  const arraySrc = extractArraySource(src);
  if (arraySrc.length === 0) return null;
  const dirFn = extractFn(src, 'shimDirResolveLines');
  const skipFn = extractFn(src, 'shimSkipOptValuesLines');
  try {
    // eslint-disable-next-line no-new-func
    return new Function(`
      const HOME_DIR = '\\u0000H\\u0000';
      const PORT = '\\u0000P\\u0000';
      const PROFILE = 'ondevice';
      const DSH_BASE = '';
      const SANDBOX_HOME = '';
      ${dirFn}
      ${skipFn}
      const CLI = ${arraySrc};
      return (env) => CLI.map((l) => String(l)
        .replaceAll('\\u0000H\\u0000', env.HOME_DIR)
        .replaceAll('\\u0000P\\u0000', String(env.PORT))).join('\\n') + '\\n';
    `)();
  } catch (e) {
    console.error(`renderer 构造失败：${e.message}`);
    return null;
  }
}

/* ── 假 wget（与 busybox wget 三态同语义） ──────────────────────────────── */

const WGET_PROXY_SRC = [
  "import { request } from 'node:http';",
  'const url = new URL(process.argv[2]);',
  'const req = request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method: "GET" }, (res) => {',
  '  const chunks = [];',
  "  res.on('data', (c) => chunks.push(c));",
  "  res.on('end', () => {",
  '    const body = Buffer.concat(chunks).toString("utf8");',
  '    if (res.statusCode === 200) { process.stdout.write(body); process.exit(0); }',
  '    process.stderr.write("wget: response " + res.statusCode + String.fromCharCode(10));',
  '    process.exit(1);',
  '  });',
  '});',
  'req.on("error", () => {',
  '  process.stderr.write("Connecting to " + url.hostname + String.fromCharCode(10));',
  '  process.stderr.write("wget: can\'t connect to remote host (" + url.hostname + "): Connection refused" + String.fromCharCode(10));',
  '  process.exit(1);',
  '});',
  'req.end();',
  '',
].join('\n');

function makeFakeWget(dir) {
  const script = [
    '#!/bin/sh',
    '# 假 wget：语义对齐 busybox（200→rc0 带正文；404→rc1 空；连不上→rc1 + connect 文案）',
    'url=""',
    'for a in "$@"; do',
    '  case "$a" in',
    '    http://*) url="$a" ;;',
    '  esac',
    'done',
    '[ -z "$url" ] && { echo "wget: missing URL" >&2; exit 1; }',
    `exec "${process.execPath}" "${join(dir, 'wget-proxy.mjs')}" "$url"`,
    '',
  ].join('\n');
  writeFileSync(join(dir, 'wget'), script, 'utf8');
  chmodSync(join(dir, 'wget'), 0o755);
}

/* ── 模拟 Host（异步：必须让事件循环转起来） ────────────────────────────── */

function startHost(mode) {
  if (mode === 'down') return Promise.resolve({ port: 1, close: () => {} });
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname !== '/dshm-packages/list') {
        res.writeHead(404); res.end('{}'); return;
      }
      if (mode === '404') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'profile package.json 不可读' }));
        return;
      }
      const dir = url.searchParams.get('dir') || '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ name: dir.split('/').pop(), path: dir, private: true, dependencies: { dshmarket: '1.0.0' } }]));
    });
    server.listen(0, '127.0.0.1', () => {
      resolvePromise({ port: server.address().port, close: () => { try { server.close(); } catch { /* 已关 */ } } });
    });
  });
}

/* ── 跑一次假壳（异步 spawn，绝不 spawnSync） ───────────────────────────── */

function runShim(script, { home, toolDir, argv, cwd, token }) {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-shim-run-'));
  const bin = join(dir, 'pnpm');
  writeFileSync(bin, script, 'utf8');
  chmodSync(bin, 0o755);
  return new Promise((resolvePromise) => {
    const child = spawn('/bin/sh', [bin, ...argv], {
      cwd,
      env: { PATH: `${toolDir}:/usr/bin:/bin`, HOME: home, DSHM_PYTHON_TOKEN: token || '' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('close', (code) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      resolvePromise({ rc: code, out, err });
    });
  });
}

/* ── 判据套件 ──────────────────────────────────────────────────────────── */

export async function runSuite(render, { quiet = false } = {}) {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    if (!quiet) console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `（${detail}）`}`);
  };

  const sandbox = mkdtempSync(join(tmpdir(), 'dshm-shim-home-'));
  const toolDir = join(sandbox, 'tools');
  mkdirSync(toolDir, { recursive: true });
  writeFileSync(join(toolDir, 'wget-proxy.mjs'), WGET_PROXY_SRC, 'utf8');
  makeFakeWget(toolDir);

  const home = join(sandbox, 'home');
  const profileDir = join(home, 'profiles', 'ondevice');
  const pkgDir = join(sandbox, 'pkg');
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'ondevice', dependencies: {} }));
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'pkg', dependencies: {} }));
  writeFileSync(join(home, 'host-ready.json'), JSON.stringify({ token: 'tok-test' }));

  const okHost = await startHost('ok');
  const notFound = await startHost('404');
  const base = { home, toolDir, token: 'tok-test' };

  {
    const r = await runShim(render({ HOME_DIR: home, PORT: okHost.port }), { ...base, argv: ['list'], cwd: pkgDir });
    check('A list：pwd 是包目录 ⇒ rc=0 且返回依赖树', r.rc === 0 && r.out.includes('dshmarket'), `rc=${r.rc} out=${r.out.slice(0, 100)}`);
    check('A list：成功时不打"回落"提示', !r.err.includes('改查'), r.err.slice(0, 100));
    check('A list：返回的 path 就是 pwd', r.out.includes(pkgDir), r.out.slice(0, 160));
  }
  {
    const r = await runShim(render({ HOME_DIR: home, PORT: okHost.port }), { ...base, argv: ['list'], cwd: tmpdir() });
    check('B list：pwd 无 package.json ⇒ 回落到当前 profile 目录', r.rc === 0 && r.out.includes(profileDir), `rc=${r.rc} out=${r.out.slice(0, 160)}`);
    check('B list：回落结果在 stderr 点明（不静默换目录）', r.err.includes('改查'), r.err.slice(0, 160));
  }
  {
    const r = await runShim(render({ HOME_DIR: home, PORT: notFound.port }), { ...base, argv: ['list'], cwd: pkgDir });
    check('C list：端点 404 ⇒ rc=1（不再被 echo 覆盖成 0）', r.rc === 1, `rc=${r.rc}`);
    check('C list：端点 404 ⇒ stderr 指向"不是包目录"', r.err.includes('不是可枚举的包目录'), r.err.slice(0, 160));
    check('C list：端点 404 ⇒ stdout 仍是合法 JSON []', r.out.trim() === '[]', r.out.slice(0, 80));
  }
  {
    const r = await runShim(render({ HOME_DIR: home, PORT: 1 }), { ...base, argv: ['list'], cwd: pkgDir });
    check('D list：Host 连不上 ⇒ rc=1', r.rc === 1, `rc=${r.rc}`);
    check('D list：Host 连不上 ⇒ stderr 说"连不上 Host"', r.err.includes('连不上 Host'), r.err.slice(0, 160));
  }
  {
    const r = await runShim(render({ HOME_DIR: home, PORT: okHost.port }), { ...base, argv: ['list'], cwd: pkgDir });
    check('E list：成功 ⇒ rc=0 且 stdout 是端点原文', r.rc === 0 && r.out.includes('"dependencies"'), `rc=${r.rc} out=${r.out.slice(0, 100)}`);
  }
  {
    const script = render({ HOME_DIR: home, PORT: okHost.port });
    for (const argv of [['config'], ['config', 'list'], ['config', '--json']]) {
      const r = await runShim(script, { ...base, argv, cwd: pkgDir });
      check(`F config ${argv.slice(1).join(' ') || '(裸)'} ⇒ 打印 registry、rc=0、stderr 有边界说明`,
        r.rc === 0 && r.out.includes('registry=') && r.err.length > 0,
        `rc=${r.rc} out=${r.out.slice(0, 60)} err=${r.err.slice(0, 60)}`);
    }
  }
  {
    const script = render({ HOME_DIR: home, PORT: okHost.port });
    const g1 = await runShim(script, { ...base, argv: ['config', 'get', 'registry'], cwd: pkgDir });
    check('G config get registry ⇒ 真值 rc=0', g1.rc === 0 && g1.out.includes('npmmirror'), `rc=${g1.rc}`);
    const g2 = await runShim(script, { ...base, argv: ['config', 'get', 'store-dir'], cwd: pkgDir });
    check('G config get <其它键> ⇒ 空串 rc=0（上游据此判 registry，口径不能变）', g2.rc === 0 && g2.out.trim() === '', `rc=${g2.rc} out=${JSON.stringify(g2.out)}`);
  }
  {
    const script = render({ HOME_DIR: home, PORT: okHost.port });
    for (const argv of [['config', 'set', 'registry', 'x'], ['config', 'delete', 'registry']]) {
      const r = await runShim(script, { ...base, argv, cwd: pkgDir });
      check(`H ${argv.join(' ')} ⇒ 拒绝且 rc=1`, r.rc === 1 && r.err.length > 0, `rc=${r.rc}`);
    }
  }
  {
    const r = await runShim(render({ HOME_DIR: home, PORT: okHost.port }), { ...base, argv: ['outdated'], cwd: pkgDir });
    check('I 未知子命令 ⇒ 明确提示 rc=1', r.rc === 1 && r.err.includes('端侧只收'), `rc=${r.rc} err=${r.err.slice(0, 80)}`);
  }

  okHost.close();
  notFound.close();
  rmSync(sandbox, { recursive: true, force: true });
  return results;
}

/* ── 入口 ──────────────────────────────────────────────────────────────── */

const selfTest = process.argv.includes('--self-test');
const src = readFileSync(join(ROOT, MAIN), 'utf8');

if (!selfTest) {
  const render = buildRenderer(src);
  if (render === null) {
    console.error(`❌ 无法从 ${MAIN} 取出 CLI_SHIM_LINES 重建假壳（生成规则被改动？）`);
    process.exit(1);
  }
  const results = await runSuite(render);
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n❌ 假壳语义不合格（${failed.length} 条）`);
    process.exit(1);
  }
  console.log(`\n✅ 通过：${results.length} 条 —— list 目录回落/rc/stdout 分流、config 列表与写拒绝、未知子命令均符合 docs/293 修法。`);
  process.exit(0);
}

console.log('--self-test：变异体必须判红 --');
let ok = true;
const arms = [
  /*
   * 【为什么这样变异】原缺陷是"失败分支先 echo 再 exit，退出码被 echo 的成功覆盖成 0"。
   * 直接删 `exit 1` 不够：脚本末尾还有一条 `exit 1` 兜底，rc 仍是 1（第一版变异就栽在这，
   * 表现为"变异生效但判据不红"）。真正要钉的是"失败分支必须显式 exit 1"，
   * 所以把这一条的退出码改成 0 —— 等价于"忘了 exit、让 echo 的成功漏出去"。
   */
  ['list 失败分支把 exit 1 改成 exit 0（rc 被吞）', (s) => s.replace(
    "  '  esac',\n  '  echo \"[]\"',\n  '  exit 1',\n  'fi',\n  'echo \"pnpm(shim): 端侧只收",
    "  '  esac',\n  '  echo \"[]\"',\n  '  exit 0',\n  'fi',\n  'echo \"pnpm(shim): 端侧只收")],
  ['config 列表分支退回静默空输出', (s) => s.replace(
    "  '    echo \"registry=https://registry.npmmirror.com/\"',\n  '    echo \"pnpm(shim): 端侧只有 registry 一项配置",
    "  '    echo \"\"',\n  '    echo \"pnpm(shim): 端侧只有 registry 一项配置")],
  ['list 去掉 profile 回落（退回无条件 pwd）', (s) => s.replace(
    "  '    LISTDIR=\"$PROFILE_DIR\"',",
    "  '    LISTDIR=\"$(pwd)\"',")],
];
for (const [label, mutate] of arms) {
  const mutated = mutate(src);
  if (mutated === src) { ok = false; console.log(`  ❌ ${label} ⇒ 变异未生效`); continue; }
  const render = buildRenderer(mutated);
  if (render === null) { ok = false; console.log(`  ❌ ${label} ⇒ renderer 构造失败`); continue; }
  const results = await runSuite(render, { quiet: true });
  const failCount = results.filter((r) => !r.ok).length;
  if (failCount === 0) ok = false;
  console.log(`  ${failCount > 0 ? '✅' : '❌'} ${label} ⇒ ${failCount > 0 ? `判红（${failCount} 条）` : '未判红（门禁没牙）'}`);
}
console.log(ok ? '\n✅ 自检通过。' : '\n❌ 自检失败（门禁没牙）。');
process.exit(ok ? 0 : 3);
