#!/usr/bin/env node
/**
 * check-market-bridge.mjs —— 端侧「市场宿主桥」（`hostcore/plugins/dshm-market-bridge/`）的
 * **离线**门禁：不需要核心树、不需要设备、不需要 HarmonyOS SDK。
 *
 * 【为什么要有这条】桥的全部价值都在"手持档装得上插件"这一个真机行为上，而它的实现是
 * 纯 JS 的队列投递 + 句柄语义 —— 这两件都能在宿主侧逐条断言。真机只该验证"接线是否生效"
 * （真机那一侧的证据在 `dshm-host.log` 的 `[dshm-market-bridge]` 行与市场的
 * `.dsh-market/log.ndjson`），逻辑面在这里钉死，避免"手机上一次装不上"才发现口径写错。
 *
 * 【钉住什么】（每条都带对照臂或反向判据，避免"恒真摆设"）
 *   A 启用判据：`bin/pnpm` 不可执行 ⇒ 接管；`DSHM_MARKET_BRIDGE=off` ⇒ 不接管；
 *     非 Windows 上 `bin/pnpm` 真能跑 ⇒ 不接管（**这就是 PC/2in1 档"行为零变化"的证据**）。
 *   B argv 口径：`--dir <取值>` 的取值不得被当成第二个包名（与 `bin/pnpm` 假壳同一口径）。
 *   C 成功链路：`add` 写出 `.req` + `.dir`（内容逐字），读到 `.done` 后 `{exitCode:0, signal:null}`，
 *     结果文件被消费掉，stdout 里有人能读的完成行。
 *   D 失败链路：`.fail` ⇒ `exitCode:1` 且 stderr 带安装器给的原因。
 *   E 卸载链路：`remove` 写的是 `.rem`（不是 `.req`）。
 *   F 拒绝面：不支持的命令 / 无目标的 `install` ⇒ `127`（**反向判据**：不许返回 0 假装成功）。
 *   G 取消：`cancel()` 后 `done` 要尽快落定（不是干等 20 分钟超时）。
 *   H 仓库接线：pack-core 里的注入函数、标记、插件清单三处必须同时在（否则产物里没有桥，
 *     而门禁却全绿 —— 这正是 `check-core-openharmony-patches.mjs` 那一类"打包期才是唯一兜底"的洞）。
 *
 * 用法：`node tools/check-market-bridge.mjs`
 * 退出码：0 通过 / 1 有真实问题
 */
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PLUGIN_REL = 'hostcore/plugins/dshm-market-bridge/lib/index.js';

let passed = 0;
const failures = [];
function ok(name, detail = '') {
  passed += 1;
  console.log(`ok   ${name}${detail ? `（${detail}）` : ''}`);
}
function bad(name, detail) {
  failures.push(`${name}：${detail}`);
  console.log(`FAIL ${name}：${detail}`);
}
function check(name, cond, detail = '') {
  if (cond) ok(name, detail);
  else bad(name, detail);
}

/** 轮询等待（队列是文件协议，宿主侧只能看文件） */
async function waitFor(predicate, timeoutMs = 8000, stepMs = 20) {
  const started = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) return null;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** 收集一个 EventEmitter 上的文本（市场就是这么读 stdout/stderr 的） */
function collect(stream) {
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(String(chunk)));
  return () => chunks.join('');
}

/** 造一个"宿主上下文"替身：只记 provide 了什么 */
function fakeCtx() {
  const provided = new Map();
  return { provided, provide(name, value) { provided.set(name, value); } };
}

const sandbox = mkdtempSync(join(tmpdir(), 'dshm-market-bridge-'));
const home = join(sandbox, 'home');
const binDir = join(sandbox, 'bin');
mkdirSync(home, { recursive: true });
mkdirSync(binDir, { recursive: true });
const queueDir = join(home, 'install-queue');
const profileDir = join(home, 'profiles', 'ondevice');
mkdirSync(profileDir, { recursive: true });

const savedEnv = { ...process.env };
process.env.DSHM_HOME = home;
process.env.DSHM_SANDBOX_HOME = sandbox;

const mod = await import(pathToFileURL(join(ROOT, ...PLUGIN_REL.split('/'))).href);

/* ── A 启用判据（三条，其中 C 臂就是 PC 档"不接管"的证据） ───────────────── */
{
  delete process.env.DSHM_MARKET_BRIDGE;
  // A1：bin/pnpm 不在 ⇒ 不可执行 ⇒ 接管（手机档形态之一）
  const ctx1 = fakeCtx();
  const attached1 = mod.provideMarketBridge(ctx1, { name: 'ondevice', dir: profileDir });
  check('A1 随包假壳不可执行 ⇒ 接管', attached1 === true && ctx1.provided.has('desktopProfiles')
    && ctx1.provided.has('desktopPnpm'), `attached=${String(attached1)}`);

  const desktopProfiles = ctx1.provided.get('desktopProfiles');
  check('A1b desktopProfiles.current 就是 profileContext 的 name/dir',
    desktopProfiles?.current?.name === 'ondevice' && desktopProfiles?.current?.dir === profileDir,
    JSON.stringify(desktopProfiles?.current ?? null));

  // A2：bin/pnpm 在位但不可执行（普通文本文件）⇒ 仍要接管（手机档形态之二）
  writeFileSync(join(binDir, 'pnpm'), '#!/system/bin/sh\necho 10.0.0\n', 'utf8');
  const ctx2 = fakeCtx();
  const attached2 = mod.provideMarketBridge(ctx2, { name: 'ondevice', dir: profileDir });
  check('A2 假壳存在但跑不起来 ⇒ 仍接管', attached2 === true, `attached=${String(attached2)}`);

  if (process.platform === 'win32') {
    console.log('skip A3 非 Windows 才可构造"假壳真能跑"的一臂（本机 win32）—— CI 在 ubuntu 上会跑它');
  } else {
    // A3（对照臂）：假壳真能跑 ⇒ 必须**不**接管 ⇒ PC/2in1 档行为零变化
    writeFileSync(join(binDir, 'pnpm'), '#!/bin/sh\necho "10.0.0 (dshm install-queue shim)"\nexit 0\n', 'utf8');
    chmodSync(join(binDir, 'pnpm'), 0o755);
    const ctx3 = fakeCtx();
    const attached3 = mod.provideMarketBridge(ctx3, { name: 'ondevice', dir: profileDir });
    check('A3 假壳真能跑 ⇒ 不接管（PC 档零变化）', attached3 === false && ctx3.provided.size === 0,
      `attached=${String(attached3)} provided=${ctx3.provided.size}`);
    // 这一臂之后让后续用例回到"接管"形态（把可执行文件换回不可执行的文本）
    writeFileSync(join(binDir, 'pnpm'), '#!/system/bin/sh\necho 10.0.0\n', 'utf8');
    chmodSync(join(binDir, 'pnpm'), 0o644);
  }

  // A4：显式关闭
  process.env.DSHM_MARKET_BRIDGE = 'off';
  const ctxOff = fakeCtx();
  const attachedOff = mod.provideMarketBridge(ctxOff, { name: 'ondevice', dir: profileDir });
  check('A4 DSHM_MARKET_BRIDGE=off ⇒ 不接管', attachedOff === false && ctxOff.provided.size === 0,
    `attached=${String(attachedOff)}`);
  delete process.env.DSHM_MARKET_BRIDGE;

  // A5：profileContext 不成形 ⇒ 不接管（且不抛）
  const ctx5 = fakeCtx();
  const attached5 = mod.provideMarketBridge(ctx5, { name: '', dir: '' });
  check('A5 profileContext 缺 name/dir ⇒ 不接管且不抛', attached5 === false, `attached=${String(attached5)}`);
  const ctx6 = fakeCtx();
  const attached6 = mod.provideMarketBridge({}, { name: 'x', dir: profileDir });
  check('A6 宿主 ctx 没有 provide() ⇒ 吞掉异常返回 false', attached6 === false, `attached=${String(attached6)}`);
}

/* ── B argv 口径（与 bin/pnpm 假壳逐条对齐） ─────────────────────────────── */
{
  const cases = [
    [['add', 'pkg'], ['pkg'], '裸包名'],
    [['add', '-w', '@scope/pkg@1.2.3'], ['@scope/pkg@1.2.3'], '-w 单跳过'],
    [['add', '--dir', '/tmp/x', 'pkg'], ['pkg'], '--dir 连取值一起跳过'],
    [['add', '--dir=/tmp/x', 'pkg'], ['pkg'], '--dir= 形式'],
    [['add', '--profile', 'web', 'pkg'], ['pkg'], '--profile 连取值一起跳过'],
    [['add', '--force', '--config.minimum-release-age=0', 'pkg'], ['pkg'], '市场选项全是 - 开头'],
    [['add', '-w', 'a', 'b'], ['a', 'b'], '多个目标'],
    [['add'], [], '无目标'],
  ];
  for (const [argv, want, label] of cases) {
    const got = mod.marketTargets(argv.slice(1));
    check(`B argv 口径 · ${label}`, JSON.stringify(got) === JSON.stringify(want),
      `argv=${JSON.stringify(argv)} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  }
}

/* ── C/D/E/F/G 句柄语义（把"Host 那一侧"用文件扮演） ───────────────────── */
{
  const ctx = fakeCtx();
  mod.provideMarketBridge(ctx, { name: 'ondevice', dir: profileDir });
  const service = ctx.provided.get('desktopPnpm');
  check('C0 desktopPnpm.runPlugin 是函数', typeof service?.runPlugin === 'function');

  // C：成功链路（add，带市场选项；Host 侧写 .done）
  {
    rmSync(queueDir, { recursive: true, force: true });
    const handle = service.runPlugin(
      ['add', '-w', '@scope/pkg@1.2.3', '--force', '--reporter=ndjson'],
      '/ignored-cwd',
    );
    const outText = collect(handle.stdout);
    const errText = collect(handle.stderr);
    check('C1 runPlugin 同步返回句柄（stdout/stderr/done/cancel 都在）',
      handle.stdout instanceof EventEmitter && handle.stderr instanceof EventEmitter
      && typeof handle.done?.then === 'function' && typeof handle.cancel === 'function');

    const reqFile = await waitFor(() => {
      if (!existsSync(queueDir)) return null;
      return readdirSafe(queueDir).find((n) => n.endsWith('.req')) ?? null;
    });
    check('C2 投递出 .req（等待 Host 取件）', typeof reqFile === 'string', `req=${String(reqFile)}`);
    if (typeof reqFile === 'string') {
      const spec = readFileSync(join(queueDir, reqFile), 'utf8').trim();
      check('C3 .req 内容就是这个目标（选项一个都没被当成包名）', spec === '@scope/pkg@1.2.3', `spec=${spec}`);
      const dirFile = `${reqFile.slice(0, -'.req'.length)}.dir`;
      const dirText = existsSync(join(queueDir, dirFile)) ? readFileSync(join(queueDir, dirFile), 'utf8').trim() : '';
      check('C4 .dir 写的是 profileContext.dir（Host 原样采纳，不能写错 profile）', dirText === profileDir, `dir=${dirText}`);
      // Host 那一侧：取走 req、写回 done
      rmSync(join(queueDir, reqFile), { force: true });
      writeFileSync(join(queueDir, `${reqFile.slice(0, -'.req'.length)}.done`), JSON.stringify({
        ok: true, name: '@scope/pkg', version: '1.2.3',
        installed: [{ name: '@scope/pkg', version: '1.2.3', files: 7 }],
        note: '重启应用后生效',
      }), 'utf8');
    }
    const outcome = await handle.done;
    // signal 必须**恰好**是 null：市场用 `outcome.signal !== null` 判失败
    check('C5 done 解析为 {exitCode:0, signal:null}', outcome.exitCode === 0 && outcome.signal === null,
      JSON.stringify(outcome));
    check('C6 stdout 里有给人看的完成行', outText().includes('@scope/pkg') && outText().includes('1.2.3'), outText().trim().slice(0, 120));
    check('C7 失败时不该有 stderr', errText() === '', errText().trim().slice(0, 120));
    const leftovers = existsSync(queueDir) ? readdirSafe(queueDir).filter((n) => n.endsWith('.done') || n.endsWith('.fail')) : [];
    check('C8 结果文件被桥自己消费掉（不留陈旧文件）', leftovers.length === 0, JSON.stringify(leftovers));
  }

  // D：失败链路
  {
    rmSync(queueDir, { recursive: true, force: true });
    const handle = service.runPlugin(['add', 'bad-pkg'], profileDir);
    const errText = collect(handle.stderr);
    const reqFile = await waitFor(() => {
      if (!existsSync(queueDir)) return null;
      return readdirSafe(queueDir).find((n) => n.endsWith('.req')) ?? null;
    });
    if (typeof reqFile === 'string') {
      writeFileSync(join(queueDir, `${reqFile.slice(0, -'.req'.length)}.fail`),
        JSON.stringify({ ok: false, error: 'registry 里没有这个包' }), 'utf8');
    } else {
      bad('D1 失败链路：没等到 .req', '队列里没有请求文件');
    }
    const outcome = await handle.done;
    check('D2 .fail ⇒ exitCode 1', outcome.exitCode === 1 && outcome.signal === null, JSON.stringify(outcome));
    check('D3 stderr 带上安装器给的原因（不是一句空话）', errText().includes('registry 里没有这个包'),
      errText().trim().slice(0, 120));
  }

  // E：卸载链路写 .rem
  {
    rmSync(queueDir, { recursive: true, force: true });
    const handle = service.runPlugin(['remove', 'dshmarket'], profileDir);
    const reqFile = await waitFor(() => {
      if (!existsSync(queueDir)) return null;
      return readdirSafe(queueDir).find((n) => n.endsWith('.rem')) ?? null;
    });
    check('E1 remove ⇒ .rem（不是 .req）', typeof reqFile === 'string', `rem=${String(reqFile)}`);
    if (typeof reqFile === 'string') {
      writeFileSync(join(queueDir, `${reqFile.slice(0, -'.rem'.length)}.done`),
        JSON.stringify({ ok: true, name: 'dshmarket', note: '已移除' }), 'utf8');
    }
    const outcome = await handle.done;
    check('E2 卸载成功 ⇒ exitCode 0', outcome.exitCode === 0, JSON.stringify(outcome));
  }

  // F：拒绝面（反向判据：不许返回 0 假装成功）
  {
    rmSync(queueDir, { recursive: true, force: true });
    const cases = [
      [['install'], 127, '无目标的 install（恢复备份流程）'],
      [['list', '--json'], 127, '不支持的命令 list'],
      [['add'], 1, 'add 但没给目标'],
      [['remove'], 1, 'remove 但没给目标'],
    ];
    for (const [argv, want, label] of cases) {
      const handle = service.runPlugin(argv, profileDir);
      const errText = collect(handle.stderr);
      const outcome = await handle.done;
      check(`F 拒绝面 · ${label} ⇒ ${want}`, outcome.exitCode === want,
        `got=${outcome.exitCode} stderr=${errText().trim().slice(0, 100)}`);
      // 反向：拒绝时必须**说得出话**（句柄的 emit 不能被"听众还没挂上"吃掉）
      check(`F 拒绝面 · ${label} 的 stderr 有内容`, errText().trim().length > 0,
        `stderr=${JSON.stringify(errText().trim().slice(0, 120))}`);
    }
    // 拒绝之后队列目录里不许留下请求（否则 Host 会去装一个不存在的东西）
    const leftovers = existsSync(queueDir)
      ? readdirSafe(queueDir).filter((n) => n.endsWith('.req') || n.endsWith('.rem'))
      : [];
    check('F5 被拒的命令没有投递任何请求', leftovers.length === 0, JSON.stringify(leftovers));
  }

  // G：取消要尽快落定（不干等 20 分钟超时）
  {
    rmSync(queueDir, { recursive: true, force: true });
    const handle = service.runPlugin(['add', 'never-answered'], profileDir);
    const startedAt = Date.now();
    await waitFor(() => (existsSync(queueDir) ? readdirSafe(queueDir).some((n) => n.endsWith('.req')) : false));
    handle.cancel();
    const outcome = await handle.done;
    const elapsed = Date.now() - startedAt;
    check('G1 cancel() 后 done 立刻落定（≤3s，非零退出）', outcome.exitCode !== 0 && elapsed <= 3000,
      `exitCode=${outcome.exitCode} elapsed=${elapsed}ms`);
  }
}

/* ── H 仓库接线（打包侧三处必须同时在） ─────────────────────────────────── */
{
  const packCore = readFileSync(join(ROOT, 'tools', 'pack-core.mjs'), 'utf8');
  check('H1 pack-core 里有 patchMarketDesktopRuntime()', packCore.includes('function patchMarketDesktopRuntime()'));
  check('H2 pack-core 真的调用它（不是只定义）', /\n\s*patchMarketDesktopRuntime\(\);/.test(packCore));
  check('H3 注入标记与门禁一致', packCore.includes("const MARK = 'DSHM_MARKET_BRIDGE_BOOT';"));
  check('H4 注入串里确实调用了插件本体（两个 provide 由插件做，注入串只负责调用）',
    packCore.includes('mkt.provideMarketBridge(hostCtx, profileContext);'));
  check('H5 插件在 pack-core 的自带插件清单里',
    packCore.includes("{ name: '@deepseek-ai/dshm-market-bridge', dir: 'dshm-market-bridge' }"));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'hostcore', 'plugins', 'dshm-market-bridge', 'package.json'), 'utf8'));
  check('H6 插件 manifest 包名/入口正确',
    pkg.name === '@deepseek-ai/dshm-market-bridge' && pkg.main === 'lib/index.js' && pkg.type === 'module',
    JSON.stringify({ name: pkg.name, main: pkg.main, type: pkg.type }));
  const checker = readFileSync(join(ROOT, 'tools', 'check-core-openharmony-patches.mjs'), 'utf8');
  check('H7 核心树补丁门禁里也有这条判据（打包期不是唯一兜底）',
    checker.includes("const DSH_MARKET_MARKER = 'DSHM_MARKET_BRIDGE_BOOT';")
    && checker.includes('市场宿主桥补丁 · '));
}

/* ── 收尾 ───────────────────────────────────────────────────────────────── */
for (const key of ['DSHM_HOME', 'DSHM_SANDBOX_HOME', 'DSHM_MARKET_BRIDGE']) {
  if (savedEnv[key] === undefined) delete process.env[key];
  else process.env[key] = savedEnv[key];
}
rmSync(sandbox, { recursive: true, force: true });

/** `readdirSync` 的容错版（目录可能还没建出来） */
function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

console.log('');
if (failures.length > 0) {
  console.log(`RESULT: ${passed} passed, ${failures.length} failed`);
  for (const line of failures) console.log(`  · ${line}`);
  process.exit(1);
}
console.log(`RESULT: ${passed} passed, 0 failed —— 市场宿主桥的启用判据 / argv 口径 / 队列协议 /`
  + ' 句柄语义（含 signal=null 与取消） / 拒绝面 / 打包三处接线全部成立');
