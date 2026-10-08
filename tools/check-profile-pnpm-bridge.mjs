#!/usr/bin/env node
/**
 * check-profile-pnpm-bridge.mjs —— 端侧「profile 包管理进程内通道」
 * （`hostcore/plugins/dshm-profile-pnpm/`）的**离线**门禁：不需要核心树、不需要设备、不需要 HarmonyOS SDK。
 *
 * 【为什么要有这条】两份真机诊断报告（2026-10-06）把「设置 → 插件 → 卸载」的失败链一路挖到了
 * `execa("pnpm", …)`：手机/平板档**没有任何可 execve 的 shell**，随包 `bin/pnpm` 假壳的第一行
 * 解释器就被内核拒（`spawn pnpm EACCES`，假报告见 §4.1），假壳里唯一干活的实现
 * （写 `install-queue/<base>.rem`）因此 `*一行都没执行`。修法是给上游 `runProfilePnpm()` 加一条
 * **不走 spawn** 的分叉（`tools/pack-core.mjs` 的 `patchProfilePnpmBridge()`）。
 * 这条分叉的价值全在真机，但实现是纯 JS 的队列投递 + 判据 —— 两件都能在宿主侧逐条断言。
 * 逻辑面在这里钉死，真机只负责验"接线是否生效"（证据是 `dshm-host.log` 的 `[dshm-profile-pnpm]`
 * 行与 `$DSH_HOME/install-queue` 的进出）。
 *
 * 【钉住什么】（每条都带对照臂或反向判据，避免"恒真的摆设"）
 *   A 启用判据：`bin/pnpm` 假壳不可执行 ⇒ 接管；能跑 ⇒ **不接管**（这就是 PC/2in1 档
 *     "行为零变化"的证据）；`DSHM_PROFILE_PNPM_BRIDGE=off` ⇒ 不接管；`=force` ⇒ 强制接管；
 *     `ctx.dir` 缺失 ⇒ 不接管（定位不到 profile 就不该动）。
 *   B argv 口径：`--dir <取值>` 的取值不得被当成第二个包名（与 `bin/pnpm` 假壳同一口径）。
 *   C 卸载链路：`remove` 写的是 `.rem`（不是 `.req`），`.dir` 写的是 profile 目录；
 *     Host 回写 `.done` ⇒ `{exitCode:0}` 且文本里有"完成"。
 *   D 安装链路：`add` 写的是 `.req`。
 *   E 失败链路：`.fail` ⇒ `exitCode:1`，且文本里带安装器给的原因（它经上游
 *     `throw new Error(output)` 原样呈现给用户 ⇒ 必须是可读的中文，不能是裸 errno）。
 *   F 拒绝面：不接管的子命令（`list` 等）⇒ 返回 `undefined`（**照旧 spawn**，不假装成功）；
 *     无目标的 `remove` ⇒ `exitCode:1`；无目标的 `install` ⇒ 与假壳同口径的跳过。
 *   G 取消：`signal.abort()` 后要尽快落定（不是干等 20 分钟超时）。
 *   H 仓库接线：pack-core 的注入函数、调用点、标记、锚点、插件清单必须在（否则产物里没有分叉，
 *     而门禁却全绿 —— 即 `check-core-openharmony-patches.mjs` 那一类"打包期才是唯一兜底"的洞）。
 *
 * 用法：`node tools/check-profile-pnpm-bridge.mjs`               # 门禁
 *       `node tools/check-profile-pnpm-bridge.mjs --self-test`   # 负控制臂（下面那节）
 * 退出码：0 通过 / 1 有真实问题
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PLUGIN_REL = 'hostcore/plugins/dshm-profile-pnpm/lib/index.js';

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

/** `readdirSync` 的容错版（目录可能还没建出来） */
function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** 队列目录里的请求/结果文件（按后缀筛） */
function queueFiles(queueDir, suffix) {
  return readdirSafe(queueDir).filter((n) => n.endsWith(suffix));
}

const sandbox = mkdtempSync(join(tmpdir(), 'dshm-profile-pnpm-'));
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

/* ── A 启用判据 ──────────────────────────────────────────────────────────── */
{
  delete process.env.DSHM_PROFILE_PNPM_BRIDGE;

  // A1：假壳不在 ⇒ 不可执行 ⇒ 接管（手机/平板档形态之一）
  check('A1 假壳缺失 ⇒ shimRunnable() 为假', mod.shimRunnable() === false, `shimRunnable=${String(mod.shimRunnable())}`);

  // A2：假壳在位但不可执行（纯文本，正是端侧形态）⇒ 仍判不可执行
  writeFileSync(join(binDir, 'pnpm'), '#!/system/bin/sh\necho 10.0.0\n', 'utf8');
  check('A2 假壳存在但跑不起来 ⇒ shimRunnable() 仍为假', mod.shimRunnable() === false);

  if (process.platform === 'win32') {
    console.log('skip A3 非 Windows 才可构造"假壳真能跑"的一臂（本机 win32）—— CI 在 ubuntu 上会跑它');
  } else {
    // A3（对照臂）：假壳真能跑 ⇒ 必须**不**接管 ⇒ PC/2in1 档行为零变化
    writeFileSync(join(binDir, 'pnpm'), '#!/bin/sh\necho "10.0.0 (dshm install-queue shim)"\nexit 0\n', 'utf8');
    chmodSync(join(binDir, 'pnpm'), 0o755);
    check('A3 假壳真能跑 ⇒ shimRunnable() 为真', mod.shimRunnable() === true);
    rmSync(queueDir, { recursive: true, force: true });
    const out = await mod.bridgeRunProfilePnpm(['remove', 'dsh-liquid-glass'], { dir: profileDir });
    check('A3（对照臂）假壳真能跑 ⇒ 返回 undefined（照旧 spawn ⇒ PC 档零变化）', out === undefined,
      `return=${JSON.stringify(out) ?? String(out)}`);
    check('A3（对照臂）不接管时队列里一个文件都没写', !existsSync(queueDir) || readdirSafe(queueDir).length === 0,
      JSON.stringify(readdirSafe(queueDir)));
    // 换回"端侧形态"，后续用例都在接管分支上
    writeFileSync(join(binDir, 'pnpm'), '#!/system/bin/sh\necho 10.0.0\n', 'utf8');
    chmodSync(join(binDir, 'pnpm'), 0o644);
  }

  // A4：显式关闭
  process.env.DSHM_PROFILE_PNPM_BRIDGE = 'off';
  const offOut = await mod.bridgeRunProfilePnpm(['remove', 'dsh-liquid-glass'], { dir: profileDir });
  check('A4 DSHM_PROFILE_PNPM_BRIDGE=off ⇒ 不接管', offOut === undefined);
  delete process.env.DSHM_PROFILE_PNPM_BRIDGE;

  // A5：ctx.dir 缺失 ⇒ 不接管（不知道目标 profile 时不猜）
  const noDir = await mod.bridgeRunProfilePnpm(['remove', 'dsh-liquid-glass'], {});
  check('A5 ctx.dir 缺失 ⇒ 不接管（不猜 profile）', noDir === undefined);

  // A6：非包操作子命令 ⇒ 不接管（本桥只认 add/install/i 与 remove/rm/uninstall）
  for (const argv of [['list', '--json'], ['view', 'pkg'], ['config', 'set', 'x', 'y'], ['ls']]) {
    const out = await mod.bridgeRunProfilePnpm(argv, { dir: profileDir });
    check(`A6 不接管的子命令 ${argv[0]} ⇒ undefined`, out === undefined);
  }

  // A7：force 覆盖（把"接管分支"从"假壳判据"里解耦出来，便于真机排障时单独验通道）
  process.env.DSHM_PROFILE_PNPM_BRIDGE = 'force';
  rmSync(queueDir, { recursive: true, force: true });
  const forced = mod.bridgeRunProfilePnpm(['remove', 'never-answered'], { dir: profileDir });
  const forcedRem = await waitFor(() => queueFiles(queueDir, '.rem')[0] ?? null);
  check('A7 =force ⇒ 即使假壳形态不变也接管（投递出 .rem）', typeof forcedRem === 'string',
    `rem=${String(forcedRem)}`);
  if (typeof forcedRem === 'string') {
    // 扮演 Host：取走 .rem、回写 .done
    rmSync(join(queueDir, forcedRem), { force: true });
    writeFileSync(join(queueDir, `${forcedRem.slice(0, -'.rem'.length)}.done`),
      JSON.stringify({ ok: true, name: 'never-answered' }), 'utf8');
  }
  const forcedOut = await forced;
  check('A7 =force 的接管结果可正常收尾（exitCode 0）', forcedOut?.exitCode === 0,
    JSON.stringify(forcedOut?.exitCode ?? null));
  delete process.env.DSHM_PROFILE_PNPM_BRIDGE;
}

/* ── B argv 口径（与 bin/pnpm 假壳逐条对齐） ─────────────────────────────── */
{
  const cases = [
    [['remove', 'pkg'], ['pkg'], '裸包名'],
    [['remove', '--dir', '/x/y', 'dsh-liquid-glass'], ['dsh-liquid-glass'], '--dir 连取值一起跳过（真机实测形态）'],
    [['remove', '--dir=/x/y', 'pkg'], ['pkg'], '--dir= 形式'],
    [['add', '--profile', 'web', 'pkg'], ['pkg'], '--profile 连取值一起跳过'],
    [['add', '--force', '--config.minimum-release-age=0', 'pkg'], ['pkg'], '选项全是 - 开头'],
    [['add', '-w', 'a', 'b'], ['a', 'b'], '多个目标'],
    [['remove'], [], '无目标'],
    [['add', '--dir'], [], '--dir 在末尾（取值不存在时不该把下一个当包名）'],
  ];
  for (const [argv, want, label] of cases) {
    const got = mod.bridgeTargets(argv.slice(1));
    check(`B argv 口径 · ${label}`, JSON.stringify(got) === JSON.stringify(want),
      `argv=${JSON.stringify(argv)} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  }
}

/* ── C/D/E/F/G 投递与结果语义（"Host 那一侧"用文件扮演） ─────────────────── */
{
  const bridge = (argv, ctx = {}) => mod.bridgeRunProfilePnpm(argv, { dir: profileDir, ...ctx });

  // C：卸载链路（remove ⇒ .rem + .dir ⇒ Host 写 .done）
  {
    rmSync(queueDir, { recursive: true, force: true });
    const pending = bridge(['remove', '--dir', profileDir, 'dsh-liquid-glass']);
    const remFile = await waitFor(() => queueFiles(queueDir, '.rem')[0] ?? null);
    check('C1 remove 投递出 .rem（不是 .req）',
      typeof remFile === 'string' && queueFiles(queueDir, '.req').length === 0, `rem=${String(remFile)}`);
    let base = '';
    if (typeof remFile === 'string') {
      base = remFile.slice(0, -'.rem'.length);
      const spec = readFileSync(join(queueDir, remFile), 'utf8').trim();
      check('C2 .rem 内容就是卸载目标（--dir 的取值没被当成包名）', spec === 'dsh-liquid-glass', `spec=${spec}`);
      const dirText = existsSync(join(queueDir, `${base}.dir`))
        ? readFileSync(join(queueDir, `${base}.dir`), 'utf8').trim() : '';
      check('C3 .dir 写的是 profile 目录（Host 原样采纳，不能写错 profile）', dirText === profileDir, `dir=${dirText}`);
      // Host 那一侧：取走请求、写回结果
      rmSync(join(queueDir, remFile), { force: true });
      writeFileSync(join(queueDir, `${base}.done`), JSON.stringify({
        ok: true, name: 'dsh-liquid-glass', note: '重启应用后生效',
      }), 'utf8');
    }
    const res = await pending;
    check('C4 .done ⇒ exitCode 0', res?.exitCode === 0, JSON.stringify({ exitCode: res?.exitCode }));
    check('C5 成功文本里有"完成"与包名（给人看，不是给机器看）',
      typeof res?.text === 'string' && res.text.includes('完成') && res.text.includes('dsh-liquid-glass'),
      JSON.stringify(String(res?.text ?? '').trim().slice(0, 120)));
    check('C6 结果文件由桥自己消费掉（不留 .done 给下一次误读）',
      queueFiles(queueDir, '.done').length === 0, JSON.stringify(readdirSafe(queueDir)));
  }

  // D：安装链路（add ⇒ .req）
  {
    rmSync(queueDir, { recursive: true, force: true });
    const pending = bridge(['add', '--dir', profileDir, 'github:xingyingyuzhui/dsh-liquid-glass#573a81d']);
    const reqFile = await waitFor(() => queueFiles(queueDir, '.req')[0] ?? null);
    check('D1 add 投递出 .req（不是 .rem）',
      typeof reqFile === 'string' && queueFiles(queueDir, '.rem').length === 0, `req=${String(reqFile)}`);
    if (typeof reqFile === 'string') {
      const base = reqFile.slice(0, -'.req'.length);
      const spec = readFileSync(join(queueDir, reqFile), 'utf8').trim();
      check('D2 .req 内容是完整 spec（GitHub 地址没被截断）',
        spec === 'github:xingyingyuzhui/dsh-liquid-glass#573a81d', `spec=${spec}`);
      rmSync(join(queueDir, reqFile), { force: true });
      writeFileSync(join(queueDir, `${base}.done`), JSON.stringify({
        ok: true, name: 'dsh-liquid-glass', version: '1.2.3',
        installed: [{ name: 'dsh-liquid-glass', version: '1.2.3' }],
      }), 'utf8');
    }
    const res = await pending;
    check('D3 add 成功 ⇒ exitCode 0 且文本里有"完成"',
      res?.exitCode === 0 && String(res?.text ?? '').includes('完成'),
      JSON.stringify({ exitCode: res?.exitCode, text: String(res?.text ?? '').trim().slice(0, 90) }));
  }

  // E：失败链路（.fail ⇒ exitCode 1 + 原因进文本）
  {
    rmSync(queueDir, { recursive: true, force: true });
    const pending = bridge(['remove', 'dsh-liquid-glass']);
    const remFile = await waitFor(() => queueFiles(queueDir, '.rem')[0] ?? null);
    let base = '';
    if (typeof remFile === 'string') {
      base = remFile.slice(0, -'.rem'.length);
      rmSync(join(queueDir, remFile), { force: true });
      writeFileSync(join(queueDir, `${base}.fail`), JSON.stringify({
        ok: false, error: 'installer: 该包不属于任何已登记的 profile 依赖',
      }), 'utf8');
    }
    const res = await pending;
    check('E1 .fail ⇒ exitCode 1', res?.exitCode === 1, JSON.stringify({ exitCode: res?.exitCode }));
    check('E2 失败原因进文本（它会被上游 throw 给用户看）',
      String(res?.text ?? '').includes('installer: 该包不属于任何已登记的 profile 依赖'),
      JSON.stringify(String(res?.text ?? '').trim().slice(0, 120)));
    check('E3 失败文本里给了可行动的提示（不能只有裸 errno）',
      String(res?.text ?? '').includes('提示：'), JSON.stringify(String(res?.text ?? '').trim().slice(-90)));
  }

  // F：拒绝面（不假装成功）
  {
    rmSync(queueDir, { recursive: true, force: true });
    const noTarget = await bridge(['remove']);
    check('F1 remove 无目标 ⇒ exitCode 1（不能返回 0 假装卸掉了）', noTarget?.exitCode === 1,
      JSON.stringify({ exitCode: noTarget?.exitCode, text: String(noTarget?.text ?? '').trim() }));
    const installNoTarget = await bridge(['install']);
    check('F2 install 无目标 ⇒ exitCode 0 且明说"按 lockfile 语义跳过"（与假壳同口径）',
      installNoTarget?.exitCode === 0 && String(installNoTarget?.text ?? '').includes('lockfile'),
      JSON.stringify({ exitCode: installNoTarget?.exitCode, text: String(installNoTarget?.text ?? '').trim().slice(0, 90) }));
    check('F3 被拒/跳过的两条都没往队列里投东西',
      !existsSync(queueDir) || readdirSafe(queueDir).length === 0, JSON.stringify(readdirSafe(queueDir)));
  }

  // G：取消要尽快落定（不干等超时）
  {
    rmSync(queueDir, { recursive: true, force: true });
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = bridge(['remove', 'never-answered'], { signal: controller.signal });
    await waitFor(() => queueFiles(queueDir, '.rem').length > 0);
    controller.abort();
    const res = await pending;
    const elapsed = Date.now() - startedAt;
    check('G1 signal.abort() 后立刻落定（≤3s，非零退出）',
      res?.exitCode === 1 && elapsed <= 3000, `exitCode=${res?.exitCode} elapsed=${elapsed}ms`);
  }
}

/* ── H 仓库接线（打包侧必须同时在） ──────────────────────────────────────── */
{
  const packCore = readFileSync(join(ROOT, 'tools', 'pack-core.mjs'), 'utf8');
  check('H1 pack-core 里有 patchProfilePnpmBridge()', packCore.includes('function patchProfilePnpmBridge()'));
  check('H2 pack-core 真的调用它（不是只定义）', /\n\s*patchProfilePnpmBridge\(\);/.test(packCore));
  check('H3 注入标记与门禁一致', packCore.includes("const MARK = 'DSHM_PROFILE_PNPM_BRIDGE';"));
  check('H4 注入串里确实 import 了插件本体',
    packCore.includes('import("@deepseek-ai/dshm-profile-pnpm")')
    && packCore.includes('dshmPnpm.bridgeRunProfilePnpm(args, {'));
  check('H5 锚点是被替换的上游原文（preflight 拒绝分支）',
    packCore.includes("+ \"        return rejected(preflight, 'nothing was installed');"));
  check('H6 插件在 pack-core 的自带插件清单里',
    packCore.includes("{ name: '@deepseek-ai/dshm-profile-pnpm', dir: 'dshm-profile-pnpm' }"));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'hostcore', 'plugins', 'dshm-profile-pnpm', 'package.json'), 'utf8'));
  check('H7 插件 manifest 包名/入口正确',
    pkg.name === '@deepseek-ai/dshm-profile-pnpm' && pkg.main === 'lib/index.js' && pkg.type === 'module',
    JSON.stringify({ name: pkg.name, main: pkg.main, type: pkg.type }));
  const checker = readFileSync(join(ROOT, 'tools', 'check-core-openharmony-patches.mjs'), 'utf8');
  check('H8 核心树补丁门禁里也有这条判据（打包期不是唯一兜底）',
    checker.includes("const PROFILE_PNPM_MARKER = 'DSHM_PROFILE_PNPM_BRIDGE';")
    && checker.includes('profile 包通道补丁 · '));
}

/* ── 负控制臂（--self-test）：把插件的关键判据改坏，证明这些断言真的会红 ──────
 *
 * 为什么必须单独有这一条：上面那批断言**跑的是真插件**，所以"插件坏了门禁会红"
 * 是显然的；但"**判据本身**写成了恒真摆设"（比如把 `--dir` 连值跳过的口径抄错成
 * 恰好也能通过、或 `.rem`/`.req` 分流根本没被断言到）在真插件上**看不出来**。
 * 这里逐个把判据的**源码锚点**改坏（每个变体单独一份临时副本 ⇒ 各自一个 module URL），
 * 断言"上面那批断言在这种情况下必然红" —— 变体不红 = 对应判据是摆设。
 */
if (process.argv.includes('--self-test')) {
  const varTmpRoot = mkdtempSync(join(tmpdir(), 'dshm-profile-pnpm-variants-'));
  const SRC = readFileSync(join(ROOT, 'hostcore', 'plugins', 'dshm-profile-pnpm', 'lib', 'index.js'), 'utf8');

  /** 造一份被改坏的插件副本并 import 它（每个变体一个目录 ⇒ 不共享 ESM 缓存）。 */
  async function loadVariant(label, edits) {
    const dir = join(varTmpRoot, label.replace(/[^a-z0-9]+/gi, '-'));
    mkdirSync(join(dir, 'lib'), { recursive: true });
    let text = SRC;
    for (const [from, to] of edits) {
      if (!text.includes(from)) {
        throw new Error(`变体「${label}」的替换锚点在插件源码里不存在（判据与实现已脱钩）：${JSON.stringify(from)}`);
      }
      text = text.replace(from, to);
    }
    const entry = join(dir, 'lib', 'index.js');
    writeFileSync(entry, text, 'utf8');
    return import(pathToFileURL(entry).href);
  }

  /** 让一次"投递后干等"的调用落地：扮演 Host 写回 `.done`（否则 20 分钟的超时会吊住事件循环）。 */
  async function settle(pending, suffix) {
    const file = await waitFor(() => queueFiles(queueDir, suffix)[0] ?? null, 4000);
    if (typeof file === 'string') {
      const base = file.slice(0, -suffix.length);
      rmSync(join(queueDir, file), { force: true });
      writeFileSync(join(queueDir, `${base}.done`), JSON.stringify({ ok: true, name: 'self-test' }), 'utf8');
    }
    await pending;
    return typeof file === 'string';
  }

  const variants = [
    {
      label: 'VALUE_OPTS 清空（--dir 的取值被当成包名）',
      edits: [['const VALUE_OPTS = ["--dir", "--profile"];', 'const VALUE_OPTS = [];']],
      probe: async (m) => JSON.stringify(m.bridgeTargets(['--dir', '/x/y', 'pkg'])) !== JSON.stringify(['pkg']),
    },
    {
      label: 'REMOVE_COMMANDS 清空（remove 不再被接管）',
      edits: [['const REMOVE_COMMANDS = ["remove", "rm", "uninstall"];', 'const REMOVE_COMMANDS = [];']],
      probe: async (m) => (await m.bridgeRunProfilePnpm(['remove', 'x'], { dir: profileDir })) === undefined,
    },
    {
      label: '.rem 被写成 .req（卸载请求会走成安装）',
      edits: [['${base}${remove ? ".rem" : ".req"}', '${base}.req']],
      probe: async (m) => {
        rmSync(queueDir, { recursive: true, force: true });
        return settle(m.bridgeRunProfilePnpm(['remove', 'self-test'], { dir: profileDir }), '.req');
      },
    },
    {
      label: 'DSHM_PROFILE_PNPM_BRIDGE=off 不再被尊重',
      edits: [['if (mode === "off") {', 'if (false) {']],
      probe: async (m) => {
        process.env.DSHM_PROFILE_PNPM_BRIDGE = 'off';
        rmSync(queueDir, { recursive: true, force: true });
        const tookOver = await settle(m.bridgeRunProfilePnpm(['remove', 'self-test'], { dir: profileDir }), '.rem');
        delete process.env.DSHM_PROFILE_PNPM_BRIDGE;
        return tookOver;
      },
    },
  ];

  for (const v of variants) {
    try {
      const m = await loadVariant(v.label, v.edits);
      const broken = await v.probe(m);
      check(`自检 · 改坏「${v.label}」⇒ 对应判据必红`, broken === true,
        broken ? '' : '变体行为与真品一致 —— 说明那条判据是恒真的摆设');
    } catch (error) {
      bad(`自检 · 改坏「${v.label}」`, error?.message ?? String(error));
    }
  }
  rmSync(varTmpRoot, { recursive: true, force: true });
  console.log('（--self-test 的 4 个变体各自只改一处源码锚点；它们红 ⇒ 上面的对应判据不是摆设）');
}

/* ── 收尾 ───────────────────────────────────────────────────────────────── */
for (const key of ['DSHM_HOME', 'DSHM_SANDBOX_HOME', 'DSHM_PROFILE_PNPM_BRIDGE']) {
  if (savedEnv[key] === undefined) delete process.env[key];
  else process.env[key] = savedEnv[key];
}
rmSync(sandbox, { recursive: true, force: true });

console.log('');
if (failures.length > 0) {
  console.log(`RESULT: ${passed} passed, ${failures.length} failed`);
  for (const line of failures) console.log(`  · ${line}`);
  process.exit(1);
}
console.log(`RESULT: ${passed} passed, 0 failed —— profile 包通道的启用判据 / argv 口径 /`
  + ' 队列协议（.rem 与 .req 分流）/ 结果语义（含取消） / 拒绝面 / 打包接线全部成立');
