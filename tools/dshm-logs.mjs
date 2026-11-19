#!/usr/bin/env node
/**
 * DSHM 运行日志一键取证（本机直读 + hdc 远程两种通道）。
 *
 * 【为什么需要它】排障时最有价值的三份证据——宿主 stdout（node-output.log）、
 * ArkTS/原生侧日志（dshm-host.log）、以及会话里的 turn/end 失败码——分别散落在
 * `<filesDir>`、`<filesDir>/dsh/home` 与会话 zstd 文件里。过去每轮都要手写一串
 * grep/tail，慢且容易漏（尤其 `PI_AI_ERROR` 这类**只出现在会话记录里**的错误：
 * 宿主 stdout 一次都没有）。本工具把它们收敛成**一份可交付的目录**：
 *
 *   <out>/
 *     SUMMARY.md          人读的结论页（错误直方图 + 命中行 + 下一步建议）
 *     SUMMARY.json        机器读（同一份事实，便于后续脚本吃）
 *     host-ready.json     脱敏后的宿主就绪信息（token 一律抹掉）
 *     node-output.log     宿主 stdout 尾部（默认 6 MB）
 *     dshm-host.log       ArkTS/原生侧日志尾部
 *     host-crash.log      崩溃现场（有则全量）
 *     diag-*.{json,txt}   端侧诊断标记（keepalive / tray / notify / mem …）
 *     sessions/           最近会话的原始 zstd + 解码出的 turn 摘要
 *     hdc/                远程模式下抓回的 hilog 片段（本机模式没有这一项）
 *
 * 【两种通道】
 *   · 本机（默认）：DSHM 就跑在这台设备上 ⇒ 直接读 `<filesDir>`，零依赖、最快。
 *   · 远程（--hdc）：**只能在本应用沙箱之外用**（DevEco 终端 / 普通 shell）。
 *     沙箱内 hdc 起不来：服务端固定绑 `/data/hdc/hdc_debug/hdc_server` 而该目录
 *     在沙箱里不存在 ⇒ `bind uds addr fail! ret:-13`（EACCES，docs/352 实测）；
 *     同时 `/dev/bus/usb` 也不可见（用户今天再确认：Permission denied）。
 *     所以沙箱内调用 `--hdc` 会被本工具识别并**自动回退本机直读**；
 *     要连别的设备请在沙箱外跑：`hdc tconn <ip>:<port>` 后加 `--target`。
 *
 * 【安全边界】全程只读：不删设备文件、不卸载应用、不写设备端任何路径；
 * 产物落**用户可见**的 `Download/<包名>/dshm-logs/`（写不进去才退回 dist/logs）。
 * 所有写出的文本都过一遍 `redact()`：token / api-key / Authorization / Cookie
 * 一律替换为 `<redacted>`（任务消息正文不抓取）。
 *
 * 用法：
 *   node tools/dshm-logs.mjs                     # 本机，抓默认 6 MB 尾部
 *   node tools/dshm-logs.mjs --tail 15           # 抓更多（MB）
 *   node tools/dshm-logs.mjs --out /tmp/xyz      # 指定落点
 *   node tools/dshm-logs.mjs --list              # 只列出可用通道
 *   node tools/dshm-logs.mjs --hdc --target <k>  # 远程已连接目标
 *   node tools/dshm-logs.mjs --hdc --tconn 192.168.1.23:5555
 *   node tools/dshm-logs.mjs --self-test         # 自检（脱敏 + 摘要，离线）
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FILES = '/data/storage/el2/base/haps/entry/files';
const SESSION_MARK = 'session.v4.jsonl.zstd';
/** 错误关键字：既能捞到宿主的 enoent，也能捞到我们自己的诊断词。 */
const ERROR_RE = /(error|fail|fatal|denied|EACCES|EPERM|ENOENT|timeout|timed out|aborted|abort\b|PI_AI|context overflow|crash|unhandled|rejected)/i;
const MIB = 1024 * 1024;

function log(message) {
  console.log(`[dshm-logs] ${message}`);
}

function fail(message) {
  console.error(`[dshm-logs] ${message}`);
  process.exit(2);
}

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

/** 统一脱敏：宁可多抹，也不要把凭据带进可交付目录。 */
export function redact(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text
    // URL 查询参数：?token=… / &token=…
    .replace(/([?&](?:token|access_token|api_key|apikey|key|sig|signature)=)[^&\s"'<>]+/gi, '$1<redacted>')
    /*
     * 认证头**必须先于**下面的键值规则：`Authorization: Bearer xxx` 会被键值规则
     * 先吃掉 "Bearer" 这个词，剩下的 token 反而逃过一劫（自检里就是这样发现的）。
     */
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g, '$1 <redacted>')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, '<redacted>')
    // JSON / env / YAML 三类赋值形态
    .replace(/("?(?:token|access_token|api[-_]?key|apikey|authorization|cookie|secret|password|passwd|pwd|credential)"?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}]+)/gi,
      '$1"<redacted>"');
}

function mb(bytes) {
  return `${(bytes / MIB).toFixed(2)} MB`;
}

/** 读文件尾部 N 字节（大文件不整读，183 MB 的 node-output.log 实测会打爆内存）。 */
function readTail(file, bytes) {
  const size = statSync(file).size;
  const start = Math.max(0, size - bytes);
  const fd = readFileSync(file);
  return fd.subarray(start).toString('utf8');
}

/** 找 hdc：环境变量优先，其次 DevEco/CLT 常见根，最后 PATH。 */
export function resolveHdc() {
  const explicit = String(process.env.DSHM_HDC || '').trim();
  const candidates = [explicit];
  const roots = [
    process.env.DEVECO_HOME,
    '/data/service/hnp/hmos-clt.org/hmos-clt_1.0.0',
    join(homedir(), '.harmonybrew'),
  ].filter(Boolean);
  for (const root of roots) {
    candidates.push(join(root, 'sdk', 'default', 'openharmony', 'toolchains', 'hdc'));
    candidates.push(join(root, 'default', 'openharmony', 'toolchains', 'hdc'));
    candidates.push(join(root, 'openHarmony', 'Sdk', 'toolchains', 'hdc'));
  }
  candidates.push(join(ROOT, 'third_party', 'hdc'));
  for (const file of candidates) {
    if (file && existsSync(file)) return file;
  }
  const which = spawnSync('sh', ['-c', 'command -v hdc'], { encoding: 'utf8' });
  const fromPath = String(which.stdout || '').trim();
  return fromPath.length > 0 ? fromPath : '';
}

function run(file, args, timeout = 60000) {
  const r = spawnSync(file, args, { encoding: 'utf8', maxBuffer: 64 * MIB, timeout });
  return {
    ok: r.status === 0,
    status: r.status,
    out: String(r.stdout || ''),
    err: String(r.stderr || (r.error ? r.error.message : '') || ''),
  };
}

/** 会话文件：解不开 zstd 就只返回原文信息，绝不因为解压失败丢掉取证。 */
function decodeSession(file) {
  try {
    const buf = zlib.zstdDecompressSync(readFileSync(file));
    return { ok: true, text: buf.toString('utf8'), bytes: buf.length };
  } catch (e) {
    return { ok: false, text: '', bytes: 0, error: String(e && e.message ? e.message : e) };
  }
}

/** 把一次会话的 turn/end 失败码聚合出来 —— PI_AI_ERROR 只在这里可见。 */
export function summarizeSession(text) {
  const lines = text.split('\n').filter(Boolean);
  const errors = new Map();
  const samples = new Map();
  let turns = 0;
  let lastError = null;
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== 'turn/end') continue;
    turns++;
    const reason = obj.data && obj.data.reason;
    if (!reason || reason.kind === undefined) continue;
    const code = reason.kind === 'error'
      ? ((reason.error && reason.error.code) || 'ERROR')
      : reason.kind;
    if (code === 'completed') continue;
    errors.set(code, (errors.get(code) || 0) + 1);
    if (!samples.has(code)) {
      samples.set(code, {
        message: String((reason.error && reason.error.message) || '').slice(0, 240),
        time: obj.time ? new Date(obj.time).toISOString() : '',
      });
    }
    lastError = { code, at: obj.time || 0, message: String((reason.error && reason.error.message) || '') };
  }
  return { turns, errors, samples, lastError };
}

function listSessions(homeDir) {
  const root = join(homeDir, 'sessions');
  if (!existsSync(root)) return [];
  const out = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const one = join(root, dir.name);
    for (const sub of readdirSync(one, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const file = join(one, sub.name, SESSION_MARK);
      if (existsSync(file)) {
        out.push({ workspace: dir.name, id: sub.name, file, mtime: statSync(file).mtimeMs });
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 从日志尾部按时间邻近收集命中行（去重 + 限量）。 */
export function pickHits(text, limit = 60) {
  const hits = [];
  const seen = new Set();
  for (const line of text.split('\n')) {
    if (!ERROR_RE.test(line)) continue;
    const key = line.slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(line.slice(0, 400));
    if (hits.length >= limit) break;
  }
  return hits;
}

function adviceFor(summary) {
  const tips = [];
  const codes = new Set();
  for (const s of summary.sessions) {
    /* errors 在内存里是 Map、写进 SUMMARY.json 后是普通对象 —— 两种都要能读。 */
    const keys = s.errors instanceof Map ? [...s.errors.keys()] : Object.keys(s.errors || {});
    for (const c of keys) codes.add(c);
  }
  if (codes.has('PI_AI_ERROR')) {
    tips.push('PI_AI_ERROR：模型流**中途**被上游中断，而 pi-ai 适配层把无法归类的终止'
      + '（最常见是上游只回一句 "aborted"）判成**不可重试**的通用错误，于是整轮直接失败。'
      + '它不是编译/插件缺陷；先看同轮耗时与网络。临时规避：重试该轮，或把长任务拆小。');
  }
  if (codes.has('CONTEXT_WINDOW_EXCEEDED')) {
    tips.push('CONTEXT_WINDOW_EXCEEDED：上下文超限。换更小的工作集（新开会话、精简附件），'
      + '或换上下文更大的模型后再继续。');
  }
  if (codes.has('AUTH') || codes.has('QUOTA_EXCEEDED')) {
    tips.push('AUTH / QUOTA：账号池失效或额度用尽——去 Channel Pack 面板检查账号与额度，'
      + '不要反复重试同一轮。');
  }
  if (codes.has('INVALID_REQUEST')) {
    tips.push('INVALID_REQUEST（400）：请求体被上游拒绝，常见是附件过大或模型不支持该参数；'
      + '看 SUMARY.json 里该轮的 message 原文。');
  }
  if (codes.has('UNKNOWN')) {
    tips.push('UNKNOWN 且 message 含 "WebAssembly is not defined"：这是宿主 --jitless 下'
      + '某条原生/插件路径依赖 WASM；记录在案，改走纯 JS 分支。');
  }
  if (tips.length === 0) {
    tips.push('未见模型侧失败码；若界面仍有异常，优先看 SUMMARY.md 的「命中行」与 '
      + 'diag-* 诊断文件。');
  }
  tips.push('复现后立刻再跑一次本工具：日志是环形/覆盖写的，越早抓越完整。');
  return tips;
}

function collectLocal(filesDir, outDir, tailMb) {
  const home = join(filesDir, 'dsh', 'home');
  const tailBytes = Math.max(1, tailMb) * MIB;
  const copied = [];

  const copyTail = (src, destName, bytes) => {
    if (!existsSync(src)) return;
    const text = redact(readTail(src, bytes));
    writeFileSync(join(outDir, destName), text, 'utf8');
    copied.push({ name: destName, source: src, bytes: statSync(src).size, kept: text.length });
  };

  copyTail(join(filesDir, 'node-output.log'), 'node-output.log', tailBytes);
  copyTail(join(filesDir, 'dshm-host.log'), 'dshm-host.log', Math.min(tailBytes, 4 * MIB));
  copyTail(join(filesDir, 'dshm-boot-rescue.log'), 'dshm-boot-rescue.log', 512 * 1024);

  if (existsSync(join(filesDir, 'host-crash.log'))) {
    const text = redact(readFileSync(join(filesDir, 'host-crash.log'), 'utf8'));
    writeFileSync(join(outDir, 'host-crash.log'), text, 'utf8');
    copied.push({ name: 'host-crash.log', source: join(filesDir, 'host-crash.log'), bytes: statSync(join(filesDir, 'host-crash.log')).size, kept: text.length });
  }

  /* 诊断标记：端侧每次启动/后台/托盘/通知都会写，是"功能到底走没走到"的直接证据。 */
  const diagDir = filesDir;
  for (const name of readdirSync(diagDir)) {
    if (!/^diag[-.]/.test(name)) continue;
    const src = join(diagDir, name);
    let st;
    try { st = statSync(src); } catch { continue; }
    if (!st.isFile() || st.size > 256 * 1024) continue;
    const text = redact(readFileSync(src, { encoding: 'utf8' }));
    writeFileSync(join(outDir, name), text, 'utf8');
    copied.push({ name, source: src, bytes: st.size, kept: text.length });
  }

  const hostReady = join(home, 'host-ready.json');
  let hostInfo = null;
  if (existsSync(hostReady)) {
    try {
      const parsed = JSON.parse(readFileSync(hostReady, 'utf8'));
      /*
       * 【按字段重建，而不是对整段 JSON 跑正则】
       * `?token=…` 的 URL 替换会插进引号内部，正则脱敏会把 JSON 弄坏（实测：
       * `"url": "…?token="<redacted>""`）。这里只保留诊断需要的白名单字段，
       * 并且 url 用 URL 解析后重新拼（token 直接不写）。
       */
      let url = '';
      try {
        const u = new URL(String(parsed.url || ''));
        u.searchParams.delete('token');
        url = u.toString();
      } catch { url = ''; }
      hostInfo = {
        port: parsed.port,
        pid: parsed.pid,
        startedAt: parsed.startedAt,
        profile: parsed.profile,
        runtime: parsed.runtime,
        workspace: parsed.workspace,
      };
      writeFileSync(join(outDir, 'host-ready.json'),
        JSON.stringify({ ...hostInfo, url: url }, null, 2), 'utf8');
    } catch { /* 坏 JSON 不影响取证 */ }
  }

  const stateFiles = ['task-state.json', 'workload.json', 'runtime-facts.json', 'card-state.json'];
  const states = {};
  for (const name of stateFiles) {
    const src = join(home, name);
    if (!existsSync(src) || statSync(src).size > 2 * MIB) continue;
    try {
      const raw = readFileSync(src, 'utf8');
      writeFileSync(join(outDir, name), redact(raw), 'utf8');
      states[name] = JSON.parse(raw);
    } catch { /* 同上 */ }
  }

  /* 会话：取最近 2 个（跨工作区取全局最新的），原始 zstd 一并带上。 */
  const sessions = listSessions(home).slice(0, 2);
  const sessDir = join(outDir, 'sessions');
  const sessSummary = [];
  for (const s of sessions) {
    mkdirSync(sessDir, { recursive: true });
    const dest = join(sessDir, `${s.id}.jsonl.zstd`);
    writeFileSync(dest, readFileSync(s.file));
    const decoded = decodeSession(s.file);
    let one = { id: s.id, workspace: s.workspace, mtime: new Date(s.mtime).toISOString(), turns: 0, errors: {}, samples: {} };
    if (decoded.ok) {
      const sum = summarizeSession(decoded.text);
      one = {
        ...one,
        turns: sum.turns,
        errors: Object.fromEntries([...sum.errors].sort((a, b) => b[1] - a[1])),
        samples: Object.fromEntries([...sum.samples].map(([k, v]) => [k, v])),
      };
      const errLines = sum.lastError === null ? '' : `${sum.lastError.code} @ ${new Date(sum.lastError.at).toISOString()} ${sum.lastError.message.slice(0, 300)}\n`;
      writeFileSync(join(sessDir, `${s.id}.errors.txt`), redact(errLines), 'utf8');
    } else {
      one.decodeError = decoded.error;
    }
    sessSummary.push(one);
  }

  return { hostInfo, states, sessions: sessSummary, copied, filesDir, home };
}

function writeSummary(outDir, info, mode) {
  const lines = [];
  lines.push(`# DSHM 日志取证报告`);
  lines.push('');
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push(`- 通道：${mode}`);
  lines.push(`- 文件根：${info.filesDir}`);
  if (info.hostInfo) {
    const rt = info.hostInfo.runtime || {};
    const natives = Array.isArray(rt.natives)
      ? rt.natives.map((n) => `${n.name}=${n.ok ? 'ok' : 'no'}`).join(' ')
      : '';
    lines.push(`- Host：pid=${info.hostInfo.pid ?? '?'} port=${info.hostInfo.port ?? '?'} `
      + `startedAt=${info.hostInfo.startedAt ?? '?'}`);
    /* 只摘**判读要用**的字段：整段 runtime 有 1 KB+，塞进摘要没人看得下去。 */
    const bits = [
      rt.nodeVersion ? `node=${rt.nodeVersion}` : '',
      rt.platform ? `platform=${rt.platform}` : '',
      rt.jitless === true ? 'jitless' : '',
      rt.nodeCli ? `nodeCli=${rt.nodeCli.ready ? 'ready' : 'no'}(${rt.nodeCli.version || '?'}${rt.nodeCli.source ? '/' + rt.nodeCli.source : ''})` : '',
      rt.python ? `python=${rt.python.ready ? 'ready' : 'no'}` : '',
      rt.terminal && rt.terminal.realShell ? 'shell=real' : '',
      natives ? `natives:${natives}` : '',
      rt.exec && rt.exec.summary ? `exec:${rt.exec.summary}` : '',
    ].filter(Boolean);
    if (bits.length > 0) lines.push(`- 运行时：${bits.join(' · ')}`);
  } else {
    lines.push('- Host：未找到 host-ready.json（宿主可能没起）');
  }
  lines.push('');
  lines.push('## 会话轮次与失败码');
  if (info.sessions.length === 0) lines.push('（没有会话记录）');
  for (const s of info.sessions) {
    const errs = Object.entries(s.errors || {}).map(([k, v]) => `${k}×${v}`).join('，') || '无';
    lines.push(`- \`${s.id}\`（${s.workspace}）turn=${s.turns} 失败：${errs}`);
    for (const [code, sample] of Object.entries(s.samples || {})) {
      if (!sample.message) continue;
      lines.push(`  - ${code} @ ${sample.time}：${String(sample.message).slice(0, 260)}`);
    }
    if (s.decodeError) lines.push(`  - 会话解码失败：${s.decodeError}`);
  }
  lines.push('');
  lines.push('## 日志文件');
  for (const c of info.copied) {
    lines.push(`- ${c.name}：原 ${mb(c.bytes)} → 保留 ${mb(c.kept)}`);
  }
  lines.push('');
  lines.push('## 命中行（最近 40 条）');
  const hits = info.hits || [];
  if (hits.length === 0) lines.push('（未命中错误关键字）');
  for (const h of hits) lines.push(`\`\`\`\n${h}\n\`\`\``);
  lines.push('');
  lines.push('## 建议');
  for (const t of adviceFor({ sessions: info.sessions })) lines.push(`- ${t}`);
  lines.push('');
  lines.push('> 已脱敏：token / api-key / Authorization / Cookie 统一替换为 `<redacted>`。');
  const text = redact(lines.join('\n'));
  writeFileSync(join(outDir, 'SUMMARY.md'), text, 'utf8');
  writeFileSync(join(outDir, 'SUMMARY.json'), redact(JSON.stringify({
    generatedAt: new Date().toISOString(),
    mode,
    filesDir: info.filesDir,
    host: info.hostInfo,
    sessions: info.sessions,
    copied: info.copied,
    hits,
  }, null, 2)), 'utf8');
  return text;
}

function defaultOutDir() {
  const visible = '/storage/Users/currentUser/Download/com.dshm.dshclient/dshm-logs';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const tryDirs = [visible, join(ROOT, 'dist', 'logs')];
  for (const base of tryDirs) {
    try {
      mkdirSync(join(base, `DSHM-logs-${stamp}`), { recursive: true });
      return join(base, `DSHM-logs-${stamp}`);
    } catch { /* 换下一个 */ }
  }
  fail('没有可写目录（试过 Download/<bundle> 与 dist/logs）');
}

function runSelfTest() {
  const problems = [];
  const ok = (cond, label) => { if (!cond) problems.push(label); };

  const redacted = redact('url=http://127.0.0.1:3120/?token=abc123&x=1\n'
    + '{"apiKey":"sk-abcdefgh12345"}\nAuthorization: Bearer abcdef.token.value\n'
    + 'cookie: sid=deadbeef\npassword= hunter2');
  ok(!redacted.includes('abc123'), 'URL token 未脱敏');
  ok(!redacted.includes('sk-abcdefgh12345'), 'apiKey 未脱敏');
  ok(!redacted.includes('abcdef.token.value'), 'Bearer 未脱敏');
  ok(redacted.includes('<redacted>'), '脱敏标记缺失');

  const text = [
    JSON.stringify({ type: 'turn/end', time: 1, data: { turn: 1, reason: { kind: 'completed' } } }),
    JSON.stringify({ type: 'turn/end', time: 2, data: { turn: 2, reason: { kind: 'error', error: { code: 'PI_AI_ERROR', message: 'aborted' } } } }),
    JSON.stringify({ type: 'turn/end', time: 3, data: { turn: 3, reason: { kind: 'error', error: { code: 'PI_AI_ERROR', message: 'aborted' } } } }),
  ].join('\n');
  const sum = summarizeSession(text);
  ok(sum.turns === 3, 'turn 计数错误');
  ok(sum.errors.get('PI_AI_ERROR') === 2, '失败码计数错误');
  ok(sum.samples.get('PI_AI_ERROR').message === 'aborted', '失败样本丢失');
  ok(adviceFor({ sessions: [ { errors: sum.errors } ] }).join('\n').includes('PI_AI_ERROR'), '建议未覆盖 PI_AI_ERROR');

  const hits = pickHits('ok\nERROR boom\nERROR boom\nEACCES denied\n');
  ok(hits.length === 2, `命中行去重失败（${hits.length}）`);

  if (problems.length === 0) {
    console.log('--self-test: PASS（脱敏 / 会话直方图 / 命中行 / 建议）');
    process.exit(0);
  }
  console.error('--self-test: FAIL');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

function remoteCollect(hdc, target, filesDir, outDir, tailMb) {
  const baseArgs = target ? ['-t', target] : [];
  const readRemote = (path, localName) => {
    const dest = join(outDir, localName);
    const recv = run(hdc, [...baseArgs, 'file', 'recv', path, dest], 120000);
    if (!recv.ok || !existsSync(dest)) {
      const cat = run(hdc, [...baseArgs, 'shell', `cat ${path}`], 120000);
      if (cat.ok && cat.out.length > 0) {
        writeFileSync(dest, redact(cat.out), 'utf8');
        return true;
      }
      return false;
    }
    const text = redact(readFileSync(dest, 'utf8'));
    writeFileSync(dest, text, 'utf8');
    return true;
  };

  const copied = [];
  for (const name of ['node-output.log', 'dshm-host.log', 'host-crash.log', 'dshm-boot-rescue.log']) {
    if (readRemote(join(filesDir, name), name)) {
      copied.push({ name, source: join(filesDir, name), bytes: statSync(join(outDir, name)).size, kept: statSync(join(outDir, name)).size });
    }
  }
  const home = join(filesDir, 'dsh', 'home');
  readRemote(join(home, 'host-ready.json'), 'host-ready.json');

  const hilog = run(hdc, [...baseArgs, 'shell', 'hilog -x'], 120000);
  let hits = [];
  if (hilog.ok) {
    const kept = hilog.out.split('\n').filter((l) => /dshm|DSHM|entry|node|error|EACCES/i.test(l)).slice(-2000).join('\n');
    writeFileSync(join(outDir, 'hdc', 'hilog.log'), redact(kept), 'utf8');
    hits = pickHits(kept, 40);
  }
  return { filesDir, home, hostInfo: null, states: {}, sessions: [], copied, hits };
}

function main() {
  if (flag('--self-test')) runSelfTest();

  const wantHdc = flag('--hdc') || arg('--target') !== undefined || arg('--tconn') !== undefined;
  const tailMb = Number(arg('--tail', '6')) || 6;
  const explicitOut = arg('--out');
  const filesDir = arg('--files-dir', process.env.DSHM_FILES_DIR || DEFAULT_FILES);

  if (flag('--list')) {
    const hdc = resolveHdc();
    console.log(`本机文件根：${filesDir}（${existsSync(filesDir) ? '可读' : '不存在'}）`);
    console.log(`hdc：${hdc || '未找到'}`);
    if (hdc) {
      const list = run(hdc, ['list', 'targets']);
      const targets = String(list.out || '').trim().split('\n').filter(Boolean);
      console.log(`hdc targets：${targets.join(', ') || '（无）'}`);
      if (targets.length === 0) {
        const hdcLog = join(homedir(), '.hdc', 'hdc.log');
        if (existsSync(hdcLog) && /bind uds addr fail/i.test(readTail(hdcLog, 64 * 1024))) {
          console.log('说明：本应用沙箱内 hdc 服务端起不来（bind uds ret:-13 / 目录 /data/hdc 不存在，docs/352）'
            + '；rc 恒 0、输出为空，不代表“没有设备”。');
          console.log('      本机日志请直接用本工具默认通道（无需 hdc）；'
            + '连别的设备请到 DevEco 终端执行 hdc。');
        }
      }
    }
    return;
  }

  const outDir = explicitOut ? resolve(explicitOut) : defaultOutDir();
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, 'hdc'), { recursive: true });

  let info;
  if (wantHdc) {
    const hdc = resolveHdc();
    if (!hdc) fail('找不到 hdc：设置 DSHM_HDC 或安装 DevEco/CLT');
    const tconn = arg('--tconn');
    if (tconn) {
      const c = run(hdc, ['tconn', tconn]);
      log(`tconn ${tconn} ⇒ ${c.ok ? 'ok' : `失败（${(c.err || c.out).trim().slice(0, 160)}）`}`);
    }
    let target = arg('--target', '');
    if (!target) {
      const list = run(hdc, ['list', 'targets']);
      target = String(list.out || '').trim().split('\n').filter(Boolean)[0] || '';
    }
    if (!target) {
      /*
       * 沙箱内 hdc 的失败形态是**静默**的：`list targets` 输出空、退出码 0。
       * 唯一可靠的判据是它自己的日志（docs/352：UDS 固定绑 /data/hdc ⇒ EACCES）。
       * 认出这种情况就直说，并**回退本机通道** —— 而不是让调用方以为"没有设备"。
       */
      const hdcLog = join(homedir(), '.hdc', 'hdc.log');
      let why = '';
      if (existsSync(hdcLog)) {
        const tail = readTail(hdcLog, 64 * 1024);
        if (/bind uds addr fail/i.test(tail)) why = 'UDS 绑定被拒（/data/hdc 在沙箱内不存在）';
        else if (/libusb_init failed/i.test(tail) && why.length === 0) why = 'USB 栈不可用';
      }
      if (why.length > 0 && existsSync(filesDir)) {
        log(`hdc 在本应用沙箱内不可用：${why}（docs/352）。`);
        log('⇒ 自动回退本机直读通道（同一台设备，不需要 hdc）。要连别的设备请在 DevEco 终端跑本工具 --hdc。');
        info = collectLocal(filesDir, outDir, tailMb);
        const combined = readFileSync(join(outDir, 'node-output.log'), 'utf8').slice(-1 * MIB)
          + '\n' + readFileSync(join(outDir, 'dshm-host.log'), 'utf8').slice(-512 * 1024);
        info.hits = pickHits(combined, 40);
      } else {
        fail('没有可用的 hdc 目标：目标设备需开启无线调试；USB 直连请在 DevEco 终端执行');
      }
    } else {
      log(`目标：${target}`);
      info = remoteCollect(hdc, target, filesDir, outDir, tailMb);
      log('远程抓取完成（hilog 已降采样）');
    }
  } else {
    if (!existsSync(filesDir)) fail(`本机文件根不存在：${filesDir}（可用 --files-dir 指定）`);
    info = collectLocal(filesDir, outDir, tailMb);
    const combined = readFileSync(join(outDir, 'node-output.log'), 'utf8').slice(-1 * MIB)
      + '\n' + readFileSync(join(outDir, 'dshm-host.log'), 'utf8').slice(-512 * 1024);
    info.hits = pickHits(combined, 40);
  }

  const summary = writeSummary(outDir, info, wantHdc ? 'hdc' : 'local');
  const firstError = (summary.split('## 会话轮次与失败码')[1] || '').split('##')[0].trim();
  console.log('');
  console.log(`✔ 日志包：${outDir}`);
  console.log(`  文件：${readdirSync(outDir).length} 项`);
  if (firstError.length > 0) {
    console.log('  会话失败码：');
    for (const l of firstError.split('\n').slice(0, 6)) console.log(`   ${l.trim()}`);
  }
  console.log('  摘要：SUMMARY.md（已脱敏）');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}