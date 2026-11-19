#!/usr/bin/env node
/**
 * 门禁：WebSocket 升级失败后**必须自己持续重试**（左下角「连接异常」根治）。
 *
 * 【为什么需要这条门禁】
 * 2026-10-31 真机三端（PC / 手机 / 平板）齐刷刷左下角「连接异常，刷新重试」，
 * 换云调试的新设备同样复现。日志逐毫秒对照：
 *
 *   09:11:24.550  ACCEPT #10 127.0.0.1:40010
 *   09:11:24.551  IN-UPGRADE GET /api/remote.mux ... origin=http://127.0.0.1:3120
 *                 URLRequestCanceled error:ERR_WS_UPGRADE(-173)
 *
 * 此后**整份日志再无任何 ACCEPT / UPGRADE** —— 不是"连上又断"，是"一次失败后永久不试"。
 *
 * 上游缺陷（`@deepseek-ai/dsh-api-gateway` 的 `RemoteStreamMuxClient`）：
 *   · `maintain()` 失败后只置 `failure`，不排下一次；
 *   · 唯一重启入口 `onReconnectRequested` 只在 `ConnectionController.loop()` 的
 *     retry 分支触发，而 `loop()` 可能永远卡在 offline 分支（`await waitForAbort`）。
 *
 * 修法（`tools/pack-core.mjs` 的 `patchRemoteStreamSelfHeal()`）：让 `maintain()` 失败后
 * 自己排一次退避重连（500ms 起、×2、封顶 10s），连上即复位。
 *
 * 【判据怎么保证有牙】
 * 不用"源码里有没有这行字符串"这种装饰性判据，而是**真把两个版本跑起来**：
 *   A 段：从核心树取出**已打补丁**的 client.browser.js，抽出自愈逻辑，注入一个
 *        恒失败的 WebSocket 载体，断言 **3 秒内至少发起 3 次连接尝试**（正常退避下远超 3 次）；
 *   B 段（对照臂）：在同一份文件上**把自愈调用删掉**（模拟上游原样），断言
 *        **3 秒内只有 1 次尝试** —— 必须与 A 段形成明确反差，否则本门禁失去意义。
 *
 * 依赖：核心树（`dist/core/work/dsh-core-<ver>/`）。没有核心树时以 exit 2 结束（如实跳过）。
 */

import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RECIPE = JSON.parse(readFileSync(join(ROOT, 'hostcore', 'core-recipe.json'), 'utf8'));
const STAGE = join(ROOT, 'dist', 'core', 'work', `dsh-core-${RECIPE.coreVersion}`);
const TARGET = join(STAGE, 'node_modules', '@deepseek-ai', 'dsh-api-gateway', 'lib', 'client.browser.js');

let failed = 0;
function ok(cond, label) {
  if (cond) console.log(`  ✅ ${label}`);
  else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

console.log('[check-ws-self-heal] WebSocket 失败后必须持续重试');

if (!existsSync(TARGET)) {
  console.log(`  ⏭  未找到核心树文件 ${TARGET}`);
  console.log('     （干净克隆里 resfile 不入库 ⇒ 需要核心树；先跑 node tools/pack-core.mjs）');
  process.exit(2);
}

const src = readFileSync(TARGET, 'utf8');

// ── 1. 静态：补丁确实落在树里 ───────────────────────────────────────────
ok(src.includes('DSHM_WS_SELF_HEAL'), 'A1 核心树里的 client.browser.js 已打自愈补丁');
ok(src.includes('scheduleSelfHeal() {'), 'A2 自愈方法 scheduleSelfHeal() 存在');
ok(src.includes('this.scheduleSelfHeal();'), 'A3 maintain() 失败后确实调用自愈');

// 静态判据只能证明"写了"，真正有牙的在下面：**跑起来比行为**。

// ── 2. 动态：把 mux 客户端跑起来，数真实连接尝试次数 ─────────────────────
/**
 * 从源码里截出 `RemoteStreamMuxClient` 类体，在一个最小外壳里执行。
 * 该类的依赖只有：RemoteStreamCarrierError / UPLINK_DONE / Deque / remoteStreamUrl /
 * WebSocket 全局。我们用桩替代，只关心"发起了几次 openSocket"。
 */
function extractClass(text, className) {
  const start = text.search(new RegExp(`var ${className}\\s*=\\s*class\\s*\\{`));
  if (start < 0) return void 0;
  // 从 "= class {" 起配对花括号
  const braceStart = text.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return void 0;
}

function buildHarness(classText, { stripSelfHeal }) {
  let body = classText;
  if (stripSelfHeal) {
    // 对照臂：把自愈调用摘掉，还原成上游"失败后不重试"的形态
    body = body.replace(/\n[\t ]*this\.scheduleSelfHeal\(\);/g, '');
  }
  // 同时抽出 StreamInbox（open() 会用到）
  const inbox = extractClass(src, 'StreamInbox') ?? '';
  return `
const REMOTE_STREAM_MUX_PATH = "/api/remote.mux";
class RemoteStreamCarrierError extends Error {}
const UPLINK_DONE = { value: void 0, done: true };
class Deque {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  pushBack(v) { this.items.push(v); }
  popFront() { return this.items.shift(); }
  clear() { this.items = []; }
}
function remoteStreamUrl() { return "ws://127.0.0.1:3120/api/remote.mux"; }
var WebSocket = class { constructor() { this.readyState = 0; } close() {} };
${inbox}
${body}
export { RemoteStreamMuxClient };
`;
}

async function countAttempts({ stripSelfHeal, windowMs = 3000 }) {
  const classText = extractClass(src, 'RemoteStreamMuxClient');
  if (classText === void 0) throw new Error('找不到 RemoteStreamMuxClient 类');
  const code = buildHarness(classText, { stripSelfHeal });

  const dir = mkdtempSync(join(tmpdir(), 'dshm-ws-'));
  const file = join(dir, 'harness.mjs');
  writeFileSync(file, code, 'utf8');

  let attempts = 0;
  // 恒失败的 WebSocket 载体：模拟 ArkWeb 取消升级（error + close，永不 open）
  const fakeSocket = () => {
    attempts++;
    const listeners = new Map();
    const sock = {
      readyState: 0,
      addEventListener(type, fn) {
        const arr = listeners.get(type) ?? [];
        arr.push(fn);
        listeners.set(type, arr);
      },
      removeEventListener(type, fn) {
        const arr = listeners.get(type) ?? [];
        listeners.set(type, arr.filter((x) => x !== fn));
      },
      send() {},
      close() {
        sock.readyState = 3;
        for (const fn of listeners.get('close') ?? []) fn({ code: 1006, wasClean: false, reason: '' });
      },
    };
    // 异步失败：模拟 ERR_WS_UPGRADE
    setTimeout(() => {
      sock.readyState = 3;
      for (const fn of listeners.get('error') ?? []) fn({ code: 1006, reason: '' });
      for (const fn of listeners.get('close') ?? []) fn({ code: 1006, reason: '', wasClean: false });
    }, 5);
    return sock;
  };

  globalThis.__fakeSocket = fakeSocket;
  try {
    const mod = await import(pathToFileURL(file).href + `?strip=${stripSelfHeal}&t=${Date.now()}`);
    const client = new mod.RemoteStreamMuxClient(() => globalThis.__fakeSocket(), true);
    client.start();
    await new Promise((r) => setTimeout(r, windowMs));
    client.close?.();
    // 清掉可能残留的定时器
    if (client.selfHealTimer !== void 0) clearTimeout(client.selfHealTimer);
    client.running = false;
    client.disposed = true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return attempts;
}

/*
 * ── C1 连上成功后必须复位退避（docs/335 落实核实）────────────────────
 *
 * 这是补丁**最可能伤到正常功能**的地方：如果 `opened` 分支没有清 `selfHealTimer` /
 * 没有把 `selfHealAttempt` 归零，那么"这一次连上了"之后仍会有一次迟到的 `maintain()`
 * 把连接**重新打断**——表现就是"用着用着突然断一下、又自己连回来"。
 *
 * 判据：先让它失败两次，再让它成功；成功后**再过 3 秒**，不允许出现新的连接尝试，
 * 且 `selfHealAttempt` 必须是 0。
 */
async function verifyResetOnOpen() {
  const classText = extractClass(src, 'RemoteStreamMuxClient');
  if (classText === void 0) throw new Error('找不到 RemoteStreamMuxClient 类');
  const code = buildHarness(classText, { stripSelfHeal: false });
  const dir = mkdtempSync(join(tmpdir(), 'dshm-ws-reset-'));
  const file = join(dir, 'harness.mjs');
  writeFileSync(file, code, 'utf8');

  let attempts = 0;
  /* 前 2 次失败（模拟 ERR_WS_UPGRADE），第 3 次起成功 */
  const fakeSocket = () => {
    attempts++;
    const listeners = new Map();
    const okNow = attempts >= 3;
    const sock = {
      readyState: 0,
      addEventListener(type, fn) {
        const arr = listeners.get(type) ?? [];
        arr.push(fn);
        listeners.set(type, arr);
      },
      removeEventListener(type, fn) {
        const arr = listeners.get(type) ?? [];
        listeners.set(type, arr.filter((x) => x !== fn));
      },
      send() {},
      close() { sock.readyState = 3; },
    };
    setTimeout(() => {
      if (okNow) {
        sock.readyState = 1;
        for (const fn of listeners.get('open') ?? []) fn({});
      } else {
        sock.readyState = 3;
        for (const fn of listeners.get('error') ?? []) fn({ code: 1006, reason: '' });
        for (const fn of listeners.get('close') ?? []) fn({ code: 1006, reason: '', wasClean: false });
      }
    }, 5);
    return sock;
  };

  globalThis.__fakeSocket = fakeSocket;
  let attemptAfterOpen = -1;
  const timerAtOpen = { cleared: true };
  try {
    const mod = await import(pathToFileURL(file).href + `?reset&t=${Date.now()}`);
    const client = new mod.RemoteStreamMuxClient(() => globalThis.__fakeSocket(), true);
    client.start();
    /* 等它经历 2 次失败 + 1 次成功 */
    await new Promise((r) => setTimeout(r, 2500));
    attemptAfterOpen = client.selfHealAttempt;
    timerAtOpen.cleared = client.selfHealTimer === void 0;
    const attemptsAtOpen = attempts;
    /* 成功之后再观察 3 秒：不应再有新尝试（否则就是"连上又被自己的定时器打断"） */
    await new Promise((r) => setTimeout(r, 3000));
    const extra = attempts - attemptsAtOpen;
    client.running = false; client.disposed = true;
    return { extra, attemptAfterOpen, timerCleared: timerAtOpen.cleared };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  const reset = await verifyResetOnOpen();
  console.log(`     连上后：selfHealAttempt=${reset.attemptAfterOpen}，定时器已清=${reset.timerCleared}，之后 3 秒新增尝试=${reset.extra}`);
  ok(reset.attemptAfterOpen === 0, `C1 连上后退避计数复位（实测 ${reset.attemptAfterOpen}）`);
  ok(reset.timerCleared, 'C2 连上后残留的重连定时器被清掉（不会自己打断连接）');
  ok(reset.extra === 0, `C3 连上后不再有新尝试（实测 ${reset.extra} 次）—— 正常功能不受影响`);
} catch (error) {
  console.log(`  ❌ 复位场景验证抛错：${error instanceof Error ? error.message : String(error)}`);
  failed++;
}

try {
  const withFix = await countAttempts({ stripSelfHeal: false });
  const withoutFix = await countAttempts({ stripSelfHeal: true });
  console.log(`     打了补丁：3 秒内尝试 ${withFix} 次`);
  console.log(`     对照臂（删掉自愈）：3 秒内尝试 ${withoutFix} 次`);

  ok(withFix >= 3, `B1 修复后失败会持续重试（实测 ${withFix} 次 ≥ 3）`);
  ok(withoutFix === 1, `B2 对照臂：删掉自愈就只试一次（实测 ${withoutFix} 次 = 1）—— 判据有牙`);
  ok(withFix > withoutFix, 'B3 修复与对照形成明确反差');
} catch (error) {
  console.log(`  ❌ 动态验证抛错：${error instanceof Error ? error.message : String(error)}`);
  failed++;
}

console.log(failed === 0 ? '\n[check-ws-self-heal] 通过' : `\n[check-ws-self-heal] 失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
