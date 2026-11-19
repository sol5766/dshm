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
 *     非 Windows 上 `bin/pnpm` 真能跑 ⇒ **不接管、但挂载契约的补丁仍要贴**（PC/2in1 档：包操作
 *     走已验收的假壳链路，皮肤的「需手动安装」判定却必须被收窄）。A7 把这条接线钉在所有平台上
 *     （A3 只在非 Windows 上跑）。
 *   B argv 口径：`--dir <取值>` 的取值不得被当成第二个包名（与 `bin/pnpm` 假壳同一口径）。
 *   C 成功链路：`add` 写出 `.req` + `.dir`（内容逐字），读到 `.done` 后 `{exitCode:0, signal:null}`，
 *     结果文件被消费掉，stdout 里有人能读的完成行。
 *   D 失败链路：`.fail` ⇒ `exitCode:1` 且 stderr 带安装器给的原因。
 *   E 卸载链路：`remove` 写的是 `.rem`（不是 `.req`）。
 *   F 拒绝面：不支持的命令 / 无目标的 `install` ⇒ `127`（**反向判据**：不许返回 0 假装成功）。
 *   G 取消：`cancel()` 后 `done` 要尽快落定（不是干等 20 分钟超时）。
 *   I 托管安装：`installPlugin(request)` 是市场「一键安装」专用的**第二条入口**
 *     （`desktopRunner` 的 `runner.installPlugin`）：request ⇒ 裸 `add name@version`（版本
 *     **不带 `^`**，否则市场 `exactNpmSpecMatches()` 判"来源不符"）、缺目标走同一条拒绝面、
 *     不返回假成功。2026-10-09 真机现场：只实现 `runPlugin` ⇒ 42 条托管皮肤一条都装不上
 *     （`service.installPlugin is not a function`）。
 *   H 仓库接线：pack-core 里的注入函数、标记、插件清单三处必须同时在（否则产物里没有桥，
 *     而门禁却全绿 —— 这正是 `check-core-openharmony-patches.mjs` 那一类"打包期才是唯一兜底"的洞）。
 *   J 市场挂载契约改写：`patchMarketCliBranch()` 把已安装的 `dsh-skin-market` 的**两处**改写成端侧契约
 *     （① 官方 Desktop 判据删掉第三子句；② desktop 分支换 `hostKind: 'dsh'` + 补 `restart`）——
 *     否则 302 条皮肤只有 41 条能一键装、点了「使用」还永远报「请从官方 Desktop 重启」；
 *     两处**相互独立**（J8：只差判据那一处也能单独改对），锚点唯一才写，**升级路径**（上一代补丁）
 *     不叠加 `const`，四条负向臂（锚点不唯一 ×2 / 锚点之间有未知行）一个字节都不写。
 *   K 落位目录：`targetDirFromArgv()` 与 `bin/pnpm` 假壳的 `shimDirResolveLines()` 同优先级
 *     （`--dir`（两种写法）> 宿主 profile 目录），并端到端断言市场的 `prefetch()`（`--dir <临时目录>`）
 *     原样进 `.dir` —— 只认 profileDir 会让隔离预取失效并把包泄漏进 live profile。
 *   L **装完重放**：补丁在 boot 只贴一次，而市场几乎总是**启动之后**才装进来（真机原话：
 *     boot 那次贴的是 `未安装（ENOENT…）`）⇒ 安装队列必须在 `<id>.done` 之前调
 *     `hostcore/app/dshm-market-patch.cjs` 再贴一次（同一份判据函数、市场不在则静默、
 *     桥缺失/形状变了只回一行 reason 不写盘、两份落位清单都带着它）。用户现象：
 *     「皮肤市场的皮肤全部都要手动安装」。
 *     **两个市场共用这一个入口**（L11）：皮肤市场与插件市场都是「启动之后才装进来」的包，
 *     各自那一份就地改写都要重放；只装一个时 reason 与老形态逐字一致（不带前缀）、
 *     两个都在时按「皮肤：…；插件市场预览图：…」拼一行、**互不干扰**（L11f：一个形状坏了
 *     不影响另一个该改的照样改）。
 *   M 插件市场预览图改写（`patchDshmarketThumbs`）：`dshmarket` 的卡片缩略图与灯箱原图
 *     原本直连图床（端侧 WebView 连不上 ⇒ 卡片空白、灯箱打不开）⇒ 就地换成宿主本地代理
 *     `/dshm-shot`。两处**相互独立**、锚点唯一才写、已是目标形态**不写盘**（mtime 读数）、
 *     形状变了只回一行 reason（含 4 条负向臂）；M6 钉宿主侧路由真的存在（别改出个空气地址）。
 *
 * 用法：`node tools/check-market-bridge.mjs`
 * 退出码：0 通过 / 1 有真实问题
 */
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  return {
    provided,
    provide(name, value) { provided.set(name, value); },
    get(name) { return provided.get(name); }
  };
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

/* ── 上游 `dsh-skin-market@0.1.57` 的形状（`lib/index.js` 的蒸馏：只留本桥关心的两处锚点 + 上下文） ──
 * 两处锚点（`officialDesktop` 判据 / desktop 分支的 `desktopHost.effect(…)`）与真机
 * `<profileDir>/node_modules/dsh-skin-market/lib/index.js` **逐字一致**（缩进属于上游源码）。
 * A3 与 J 两节共用这一份，避免"夹具两处漂移"。
 */
const UPSTREAM_OFFICIAL_BLOCK = "        const officialDesktop = configuredProfile?.toLowerCase() === 'desktop'\n"
  + "            || (configuredProfile === undefined && launchedProfile?.toLowerCase() === 'desktop')\n"
  + "            || (desktopProfiles === undefined && pluginManager !== undefined);\n";
const PATCHED_OFFICIAL_BLOCK = "        /* dshm-market-bridge: official-desktop-off */ const officialDesktop = configuredProfile?.toLowerCase() === 'desktop'\n"
  + "            || (configuredProfile === undefined && launchedProfile?.toLowerCase() === 'desktop');\n";
const UPSTREAM_DESKTOP_LINE = "            desktopHost.effect(() => mountRoutes(host, { profile: current.name, profileDir: current.dir, runner: desktopRunner(service, current.dir), hostKind: 'desktop', runtime: detectDshRuntime(), agents }), 'dsh-skin-market: desktop routes');\n";
const UPSTREAM_SHAPE = [
  "import { desktopRunner, runPluginCli } from './commands.js';",
  "import { createCliRestartScheduler } from './restart.js';",
  'export function apply(ctx, config) {',
  "    ctx.inject(['webServer', 'loader'], hostContext => {",
  '        const readService = (name) => ctx.get(name);',
  "        const desktopProfiles = readService('desktopProfiles');",
  "        const pluginManager = readService('pluginManager');",
  ...UPSTREAM_OFFICIAL_BLOCK.split('\n').slice(0, -1).map((line) => line),
  '        if (desktopProfiles === undefined) {',
  "            const appExit = readService('appExit');",
  '            const restart = appExit === undefined ? undefined : createCliRestartScheduler(appExit);',
  "            host.effect(() => mountRoutes(host, { profile, profileDir, runner: runPluginCli, hostKind: 'dsh', runtime: detectDshRuntime(), restart, agents }), 'dsh-skin-market: routes');",
  '            return;',
  '        }',
  "        hostContext.inject(['desktopPnpm'], desktopContext => {",
  '            const current = desktopProfiles.current;',
  '            const service = desktopContext.desktopPnpm;',
  '            const desktopHost = desktopContext;',
  ...UPSTREAM_DESKTOP_LINE.split('\n').slice(0, -1).map((line) => line),
  '        });',
  '    });',
  '}',
  '',
].join('\n');

/** 数一个子串出现几次（断言用；口径与插件里的 `countOccurrences` 一致）。J / L 两节共用。 */
const count = (haystack, needle) => haystack.split(needle).length - 1;

/**
 * 上一代补丁（只补 restart、仍把宿主当官方 Desktop）在现场留下的形态 —— **升级路径的输入**。
 * J4 与 L5 共用这一份，避免"夹具两处漂移"。
 */
const LEGACY_SHAPE = UPSTREAM_SHAPE
  .replace('            const desktopHost = desktopContext;\n',
    '            const desktopHost = desktopContext;\n'
    + '            /* dshm-market-bridge: desktop-restart */ const appExit = readService(\'appExit\');\n'
    + '            const restart = appExit === undefined ? undefined : createCliRestartScheduler(appExit);\n')
  .replace(UPSTREAM_DESKTOP_LINE, UPSTREAM_DESKTOP_LINE.replace(', agents }', ', agents, restart }'));

/* ── 插件市场（dshmarket）预览图的两处夹具：上游那两段的**逐字**形状 ───────────── */
/*
 * 【为什么缩进是 tab】`dshmarket/client/client.js` 是 tsdown 打出来的产物，缩进全是 tab ——
 * 这两段必须逐字节对齐产物才命中（`\\t` 转义写在这里，免得编辑器的 tab/空格转换把它悄悄改坏）。
 *
 * 【校准依据（2026-10-14）】真机取回的那份产物：770192 B /
 * sha256=3b6dd4f8c1094894edb0199091658502f101fbe45dfec37be36284b964898ac8。用同一套常量量过：
 * 上游两段各命中 1 次、目标形态各命中 0 次、`shots[index]` 全文只有 1 处。
 *
 * 【为什么这里再写一份，而不 import 插件里的常量】M 段要验的是"**给定上游形状**会不会改对"；
 * 拿插件自己的常量当夹具就变成"自己等于自己"，上游改形时两边一起漂、门禁照样绿。
 */
const DSHMARKET_THUMB_UP = '\t\tfunction thumbUrl(src, height) {\n'
  + '\t\t\treturn `https://images.weserv.nl/?url=${encodeURIComponent(src.replace(/^https?:\\/\\//, ""))}&h=${String(height)}&fit=inside&we=1`;\n'
  + '\t\t}\n';
const DSHMARKET_THUMB_TARGET = '\t\t/* dshm-market-bridge: shot-proxy */\n'
  + '\t\tfunction shotProxyUrl(src, height) {\n'
  + '\t\t\tconst base = `/dshm-shot?url=${encodeURIComponent(String(src))}`;\n'
  + '\t\t\treturn height === undefined ? base : `${base}&h=${String(height)}`;\n'
  + '\t\t}\n'
  + '\t\tfunction thumbUrl(src, height) {\n'
  + '\t\t\treturn shotProxyUrl(src, height);\n'
  + '\t\t}\n';
const DSHMARKET_BOX_UP = '\t\t\t\t\t\tsrc: shots[index],\n';
const DSHMARKET_BOX_TARGET = '\t\t\t\t\t\tsrc: shotProxyUrl(shots[index]),\n';
/** 夹具文件的首尾（改写只该动那两段，别的一个字节都不许动）。 */
const DSHMARKET_CLIENT_HEAD = 'const gallery = createGallery();\n';
const DSHMARKET_CLIENT_TAIL = 'export { gallery };\n';
const DSHMARKET_CLIENT_UPSTREAM = DSHMARKET_CLIENT_HEAD + DSHMARKET_THUMB_UP + DSHMARKET_BOX_UP + DSHMARKET_CLIENT_TAIL;
/** 上游形状改写后的**唯一**终态（逐字节比较用）。 */
const DSHMARKET_CLIENT_TARGET = DSHMARKET_CLIENT_HEAD + DSHMARKET_THUMB_TARGET + DSHMARKET_BOX_TARGET + DSHMARKET_CLIENT_TAIL;

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
    // A3（对照臂）：假壳真能跑 ⇒ **不接管**，但**挂载契约的补丁仍要贴**。
    //
    // 【为什么这两件事必须分开】接管（provide `desktopProfiles`/`desktopPnpm`）是把市场包操作
    // 从假壳链路改道到进程内队列 —— PC/2in1 档**不能**这么做（会把 `dshmarket` 插件市场一起改道）。
    // 而「把皮肤的官方 Desktop 判据收窄」是另一件事：不收窄，PC 档皮肤市场仍显示「需手动安装」。
    writeFileSync(join(binDir, 'pnpm'), '#!/bin/sh\necho "10.0.0 (dshm install-queue shim)"\nexit 0\n', 'utf8');
    chmodSync(join(binDir, 'pnpm'), 0o755);
    const a3Profile = join(sandbox, 'a3-profile');
    const a3File = join(a3Profile, 'node_modules', 'dsh-skin-market', 'lib', 'index.js');
    mkdirSync(dirname(a3File), { recursive: true });
    writeFileSync(a3File, UPSTREAM_SHAPE, 'utf8');
    const ctx3 = fakeCtx();
    const attached3 = mod.provideMarketBridge(ctx3, { name: 'ondevice', dir: a3Profile });
    const a3After = readFileSync(a3File, 'utf8');
    check('A3 假壳真能跑 ⇒ 不接管（attached=false，且一个服务都不 provide）',
      attached3 === false && ctx3.provided.size === 0,
      `attached=${String(attached3)} provided=${ctx3.provided.size}`);
    check('A3b 但皮肤市场的挂载契约补丁**已贴**（官方 Desktop 判据收窄 + hostKind 换 dsh）',
      a3After.includes('dshm-market-bridge: official-desktop-off')
      && a3After.includes('dshm-market-bridge: cli-branch')
      && (a3After.split("hostKind: 'desktop'").length - 1) === 0
      && (a3After.split("hostKind: 'dsh'").length - 1) === 2,
      `official=${a3After.includes('official-desktop-off')} cli=${a3After.includes('cli-branch')}`);
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

  // A7：**接线**（跨平台也跑）—— 「贴挂载契约补丁」这一步必须在 `shimRunnable()` 早退**之前**发生，
  //     且早退分支本身**一个服务都不 provide**（PC/2in1 档绝不能 provide `desktopProfiles`，
  //     否则会把 `dshmarket` 插件市场从已验收的假壳链路改道到进程内队列）。A3 要真能 spawn 的假壳
  //     （只有非 Windows 能构造），所以在源码层把这条口径钉住。
  {
    const src = readFileSync(join(ROOT, ...PLUGIN_REL.split('/')), 'utf8');
    const shimAt = src.indexOf('if (!forced && shimRunnable()) {');
    const patchAt = src.indexOf('patchMarketCliBranch(profileDir).reason');
    const firstProvideAt = src.indexOf('hostCtx.provide(');
    check('A7 假壳分支里先贴挂载契约补丁再早退（补丁在 provide 之前；早退分支自身不 provide）',
      shimAt !== -1 && patchAt !== -1 && patchAt > shimAt && firstProvideAt > patchAt,
      `shimAt=${shimAt} patchAt=${patchAt} firstProvideAt=${firstProvideAt}`);
  }
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
/* ── I installPlugin：市场「一键安装」的托管入口 ─────────────────────────── */
{
  const ctx = fakeCtx();
  mod.provideMarketBridge(ctx, { name: 'ondevice', dir: profileDir });
  const service = ctx.provided.get('desktopPnpm');
  check('I0 desktopPnpm.installPlugin 是函数（2026-10-09 前只有 runPlugin ⇒ 托管安装全失败）',
    typeof service?.installPlugin === 'function');

  // I1..I4：request ⇒ 裸 `add name@version`，pnpmOptions 跟着走但**不许**污染 spec
  {
    rmSync(queueDir, { recursive: true, force: true });
    // 【形状必须是市场**真实**发的那一种】`commands.js:454` 的 desktopRunner 把包名塞在
    // `recovery` 里；顶层 `packageName/packageVersion` 是官方 Electron runner（official-desktop.js:145）
    // 的形状。2026-10-09 真机第二轮现场：只读顶层 ⇒ argv 退化成裸 `add` ⇒ 市场报
    // `未给出包名或 GitHub 地址`，与"没实现 installPlugin"症状相似、根因不同。
    const handle = service.installPlugin({
      pnpmOptions: ['--prefer-offline', '--reporter=ndjson'],
      invokingDir: '/ignored-cwd',
      recovery: { packageName: 'fengb3.dsh-theme-macintosh', packageVersion: '1.0.3', receiptId: 'rcpt-1' },
    });
    const errText = collect(handle.stderr);
    check('I1 installPlugin 同步返回句柄（stdout/stderr/done/cancel 都在）',
      handle.stdout instanceof EventEmitter && typeof handle.done?.then === 'function'
      && typeof handle.cancel === 'function');
    const reqFile = await waitFor(() => {
      if (!existsSync(queueDir)) return null;
      return readdirSafe(queueDir).find((n) => n.endsWith('.req')) ?? null;
    });
    check('I2 installPlugin 走 .req（add 通道，不是 .rem）', typeof reqFile === 'string', `req=${String(reqFile)}`);
    if (typeof reqFile === 'string') {
      const spec = readFileSync(join(queueDir, reqFile), 'utf8').trim();
      // 市场 profile.js 的 exactNpmSpecMatches() 只认 `version` / `name@version` / `npm:name@version`
      // ⇒ 带 `^` 会被判"来源不符"再抛一次；marketTargets 已把 `-` 开头的选项整段滤掉。
      check('I3 .req 是裸 `name@version`（选项一个都没混进来）',
        spec === 'fengb3.dsh-theme-macintosh@1.0.3', `spec=${spec}`);
      const dirFile = `${reqFile.slice(0, -'.req'.length)}.dir`;
      const dirText = existsSync(join(queueDir, dirFile)) ? readFileSync(join(queueDir, dirFile), 'utf8').trim() : '';
      check('I4 .dir 写的是 profileContext.dir（安装必须落在当前 profile）', dirText === profileDir, `dir=${dirText}`);
      rmSync(join(queueDir, reqFile), { force: true });
      writeFileSync(join(queueDir, `${reqFile.slice(0, -'.req'.length)}.done`),
        JSON.stringify({ ok: true, name: 'fengb3.dsh-theme-macintosh', version: '1.0.3' }), 'utf8');
    } else {
      bad('I3 .req 是裸 `name@version`（选项一个都没混进来）', '没等到 .req');
    }
    const outcome = await handle.done;
    check('I5 托管安装成功 ⇒ {exitCode:0, signal:null}（市场按 signal!==null 判失败）',
      outcome.exitCode === 0 && outcome.signal === null, JSON.stringify(outcome));
    check('I6 成功链路的 stderr 是空的', errText() === '', errText().trim().slice(0, 120));
  }

  // I6b：**顶层** packageName/packageVersion 那一版形状也认（官方 Electron runner 的口径）
  {
    rmSync(queueDir, { recursive: true, force: true });
    const handle = service.installPlugin({ packageName: 'top-level-pkg', packageVersion: '2.0.0' });
    const reqFile = await waitFor(() => {
      if (!existsSync(queueDir)) return null;
      return readdirSafe(queueDir).find((n) => n.endsWith('.req')) ?? null;
    });
    const spec = typeof reqFile === 'string' ? readFileSync(join(queueDir, reqFile), 'utf8').trim() : '';
    check('I6b 顶层形状也认（recovery 缺失时回落 packageName/packageVersion）',
      spec === 'top-level-pkg@2.0.0', `spec=${spec}`);
    if (typeof reqFile === 'string') rmSync(join(queueDir, reqFile), { force: true });
    writeFileSync(join(queueDir, `done-${Date.now()}.done`), JSON.stringify({ ok: true }), 'utf8');
    // 上面那个 .done 不是本句柄的名字 ⇒ 直接取消，别让它挂着等
    handle.cancel();
    await handle.done;
  }

  // I7/I8：缺目标 / request 不是对象 ⇒ 走既有拒绝面（非 0 且说得出话），且**不投递**任何请求
  {
    for (const [label, request] of [['缺 packageName', {}], ['request 不是对象', undefined]]) {
      rmSync(queueDir, { recursive: true, force: true });
      const handle = service.installPlugin(request);
      const errText = collect(handle.stderr);
      const outcome = await handle.done;
      check(`I7 拒绝面 · ${label} ⇒ 非 0 且 stderr 有内容`,
        outcome.exitCode !== 0 && errText().trim().length > 0,
        `exitCode=${outcome.exitCode} stderr=${errText().trim().slice(0, 100)}`);
      const leftovers = existsSync(queueDir)
        ? readdirSafe(queueDir).filter((n) => n.endsWith('.req') || n.endsWith('.rem')) : [];
      check(`I8 拒绝面 · ${label} 没有投递任何请求`, leftovers.length === 0, JSON.stringify(leftovers));
    }
  }

  // I9：signal 直接接到 cancel 上（市场会带超时用的 AbortSignal）
  {
    rmSync(queueDir, { recursive: true, force: true });
    const controller = new AbortController();
    const handle = service.installPlugin({
      packageName: 'never-answered', packageVersion: '1.0.0', signal: controller.signal,
    });
    const started = Date.now();
    await waitFor(() => (existsSync(queueDir) ? readdirSafe(queueDir).some((n) => n.endsWith('.req')) : false));
    controller.abort();
    const outcome = await handle.done;
    const elapsed = Date.now() - started;
    check('I9 installPlugin 的 signal 接到 cancel（abort ⇒ 尽快非零落定）',
      outcome.exitCode !== 0 && elapsed <= 3000, `exitCode=${outcome.exitCode} elapsed=${elapsed}ms`);
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

/* ── J 皮肤市场挂载契约改写（patchMarketCliBranch） ─────────────────────────── */
/*
 * 为什么要有这一节：市场的界面判定只有一处、只看 `hostKind`
 * （`client/client.js` 的 `isManualOnly`：`desktop` ⇒ 只认 `install.desktop.mode==='managed'`；
 * 否则 ⇒ 认 `review.installation`）。端侧发布 `desktopProfiles`/`desktopPnpm` 会走 desktop 分支 ⇒
 * 302 条皮肤里只有 41 条能一键装（目录实测：247 条 `manual-only`、14 条无 `install.desktop`），
 * 其余一律「需手动安装」—— 而端侧的进程内安装器跑的是**完整的 pnpm 装卸契约**
 * （`add <spec>`：npm `name@version` 与 GitHub `github:o/r#sha[&path:/sub]` 都吃）。所以要把那条
 * 分支的 `hostKind` 改成 `'dsh'`（判定随之落到 `review.installation`，251 条可装），并按 CLI 分支
 * 同款补上 `restart`（否则「使用」永远报「请从官方 Desktop 重启应用后生效」）。
 * 这里对**补丁函数本身**做契约断言：只在真装了、锚点唯一命中时才写；否则一个字节不写。
 * 负向臂（J5/J6/J6b）保证「上游改形时不猜着改」，J4 保证「上一代补丁能就地升级而非叠加」。
 */
{
  check('J0 插件导出 patchMarketCliBranch（门禁与运行时同一份实现）',
    typeof mod.patchMarketCliBranch === 'function');
  check('J0b 旧名 patchMarketRestart 不再导出（不留双份实现）', mod.patchMarketRestart === undefined);

  const fixtureRoot = join(sandbox, 'fixture-profile');
  const fixtureFile = join(fixtureRoot, 'node_modules', 'dsh-skin-market', 'lib', 'index.js');
  /** 上游的真实形状（与真机 `profiles/ondevice/node_modules/dsh-skin-market/lib/index.js` 逐字一致）—— 与 A3 共用一份。 */
  const upstreamShape = UPSTREAM_SHAPE;
  const desktopLine = UPSTREAM_DESKTOP_LINE;
  /** 上一代补丁形态（模块级 `LEGACY_SHAPE`）与计数器（模块级 `count`）—— 见各自定义处。 */
  const legacyShape = LEGACY_SHAPE;
  const write = (text) => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    mkdirSync(dirname(fixtureFile), { recursive: true });
    writeFileSync(fixtureFile, text, 'utf8');
  };

  // J1：没装 ⇒ 如实报未安装，且**不创建任何文件**
  {
    rmSync(fixtureRoot, { recursive: true, force: true });
    const r = mod.patchMarketCliBranch(fixtureRoot);
    check('J1 未安装 ⇒ ok:false 且说得出原因，不造文件',
      r.ok === false && r.reason.includes('未安装') && !existsSync(fixtureFile), JSON.stringify(r));
  }

  // J2：上游原形状 ⇒ 改写（hostKind 'desktop' → 'dsh' + restart）
  {
    write(upstreamShape);
    const r = mod.patchMarketCliBranch(fixtureRoot);
    const after = readFileSync(fixtureFile, 'utf8');
    check('J2a 上游原形状 ⇒ 改写（ok:true）', r.ok === true && r.reason.includes('已按 CLI 契约改写'), JSON.stringify(r));
    check('J2b 挂载契约已换成 CLI：hostKind 不再有 desktop、dsh 恰好两处（CLI 分支 + desktop 分支）',
      count(after, "hostKind: 'desktop'") === 0 && count(after, "hostKind: 'dsh'") === 2,
      `desktop=${count(after, "hostKind: 'desktop'")} dsh=${count(after, "hostKind: 'dsh'")}`);
    check('J2c desktop 分支拿到 restart（且只改这一处）', count(after, ', agents, restart })') === 1);
    check('J2d CLI 分支那处 restart 逐字未动', count(after, ', restart, agents })') === 1);
    check('J2e 补的是 readService(\'appExit\') 那条同源写法（两处，CLI 分支原有 + desktop 分支新增）',
      count(after, "const appExit = readService('appExit');") === 2
      && count(after, 'const restart = appExit === undefined ? undefined : createCliRestartScheduler(appExit);') === 2);
    check('J2f 写了幂等标记（下次启动一眼认出）', count(after, 'dshm-market-bridge: cli-branch') === 1);
    check('J2g 官方 Desktop 判据同步收窄（第三子句删掉 + 打上标记）',
      count(after, 'dshm-market-bridge: official-desktop-off') === 1
      && count(after, '|| (desktopProfiles === undefined && pluginManager !== undefined);') === 0
      && count(after, "|| (configuredProfile === undefined && launchedProfile?.toLowerCase() === 'desktop');") === 1,
      `marker=${count(after, 'official-desktop-off')} third=${count(after, '|| (desktopProfiles === undefined && pluginManager !== undefined);')}`);
    // J3：再跑一次 —— 幂等，逐字节不变
    const r2 = mod.patchMarketCliBranch(fixtureRoot);
    check('J3 幂等：第二次是 no-op（文件逐字节不变）',
      r2.ok === true && r2.reason.includes('已是目标形态') && readFileSync(fixtureFile, 'utf8') === after,
      JSON.stringify(r2));
  }

  // J4：**升级路径** —— 设备上已打过上一代补丁（只补 restart）时，就地升级而不是叠加
  //
  // 【为什么必须有这条】旧补丁插的 `const appExit` 与新补丁插的同名同作用域；若只按锚点追加，
  // 一处 `const` 变两处 ⇒ 语法错 ⇒ 整个市场插件挂不起来（比原缺陷更糟）。
  {
    write(legacyShape);
    const r = mod.patchMarketCliBranch(fixtureRoot);
    const after = readFileSync(fixtureFile, 'utf8');
    check('J4a 上一代补丁形态 ⇒ 升级（ok:true 且说得出是升级）',
      r.ok === true && r.reason.includes('升级'), JSON.stringify(r));
    check('J4b 升级后 hostKind 只剩 dsh（两处）', count(after, "hostKind: 'desktop'") === 0 && count(after, "hostKind: 'dsh'") === 2);
    check('J4c **没有**重复声明 const appExit / const restart（各恰好两处）',
      count(after, "const appExit = readService('appExit');") === 2
      && count(after, 'const restart = appExit === undefined ? undefined : createCliRestartScheduler(appExit);') === 2);
    check('J4d 旧标记被摘掉、新标记只一处',
      count(after, 'dshm-market-bridge: desktop-restart') === 0 && count(after, 'dshm-market-bridge: cli-branch') === 1);
    check('J4e 升级结果与"直接改写上游原形"逐字节相同（两条路径同一个终态）',
      after === readFileSync(fixtureFile, 'utf8') && count(after, '            const desktopHost = desktopContext;\n') === 1
      && after === upstreamShape
        .replace(UPSTREAM_OFFICIAL_BLOCK, PATCHED_OFFICIAL_BLOCK)
        .replace(
          '            const desktopHost = desktopContext;\n',
          '            const desktopHost = desktopContext;\n'
          + '            /* dshm-market-bridge: cli-branch */ const appExit = readService(\'appExit\');\n'
          + '            const restart = appExit === undefined ? undefined : createCliRestartScheduler(appExit);\n')
        .replace(desktopLine, desktopLine.replace("hostKind: 'desktop'", "hostKind: 'dsh'").replace(', agents }', ', agents, restart }')));
  }

  // J5：锚点不唯一（上游改过形状）⇒ 一个字节都不写
  {
    const doubled = upstreamShape.replace(
      '            const desktopHost = desktopContext;\n',
      '            const desktopHost = desktopContext;\n            const desktopHost = desktopContext;\n',
    );
    write(doubled);
    const r = mod.patchMarketCliBranch(fixtureRoot);
    check('J5 desktopHost 锚点不唯一 ⇒ ok:false、不猜着改、文件原样',
      r.ok === false && r.reason.includes('形状') && readFileSync(fixtureFile, 'utf8') === doubled,
      JSON.stringify(r));
  }

  // J6：另一处锚点不唯一（desktop mountRoutes 那行出现两次）同理
  {
    const extra = upstreamShape + desktopLine;
    write(extra);
    const r = mod.patchMarketCliBranch(fixtureRoot);
    check('J6 desktop 调用行命中两次 ⇒ 不写',
      r.ok === false && readFileSync(fixtureFile, 'utf8') === extra, JSON.stringify(r));
  }

  // J6b：两个锚点之间出现了**别的东西**（既不是紧贴、也不是上一代补丁整段）⇒ 不写
  {
    const stray = upstreamShape.replace(
      '            const desktopHost = desktopContext;\n',
      '            const desktopHost = desktopContext;\n            const unrelated = 1;\n',
    );
    write(stray);
    const r = mod.patchMarketCliBranch(fixtureRoot);
    check('J6b 锚点之间有未知行 ⇒ ok:false、不写、文件原样',
      r.ok === false && r.reason.includes('不是已知形态') && readFileSync(fixtureFile, 'utf8') === stray,
      JSON.stringify(r));
  }

  // J7：**负向控制** —— 本插件绝不能自己 provide("appExit")
  // J8：**两处改写相互独立** —— 现场只差官方 Desktop 判据那一处（desktop 分支早已是目标形态，
  //     例如 `+dshm.28` 之前那代桥只补了 restart）⇒ 只改判据，desktop 分支一个字节不动。
  {
    const desktopTargetOnly = upstreamShape
      .replace('            const desktopHost = desktopContext;\n',
        '            const desktopHost = desktopContext;\n'
        + '            /* dshm-market-bridge: cli-branch */ const appExit = readService(\'appExit\');\n'
        + '            const restart = appExit === undefined ? undefined : createCliRestartScheduler(appExit);\n')
      .replace(desktopLine, desktopLine.replace("hostKind: 'desktop'", "hostKind: 'dsh'").replace(', agents }', ', agents, restart }'));
    write(desktopTargetOnly);
    const r = mod.patchMarketCliBranch(fixtureRoot);
    const after = readFileSync(fixtureFile, 'utf8');
    check('J8a 只差判据那一处 ⇒ 仍 ok:true，且 reason 点名「官方 Desktop 判据收窄」',
      r.ok === true && r.reason.includes('官方 Desktop 判据收窄') && !r.reason.includes('已按 CLI 契约改写'),
      JSON.stringify(r));
    check('J8b desktop 分支（already 目标形态）一字节未动，只贴了判据那一处',
      count(after, 'dshm-market-bridge: official-desktop-off') === 1
      && count(after, 'dshm-market-bridge: cli-branch') === 1
      && after === desktopTargetOnly.replace(UPSTREAM_OFFICIAL_BLOCK, PATCHED_OFFICIAL_BLOCK));
    // J8c：现状已全为目标形态时再跑 ⇒ no-op（两处都跳过）
    const r2 = mod.patchMarketCliBranch(fixtureRoot);
    check('J8c 两处都已是目标形态 ⇒ no-op（逐字节不变）',
      r2.ok === true && r2.reason.includes('已是目标形态') && readFileSync(fixtureFile, 'utf8') === after,
      JSON.stringify(r2));
  }

  // J9：判据那一处出现两次（上游改形 / 文件里有两份副本）⇒ 一个字节都不写
  {
    const doubledOfficial = upstreamShape.replace(UPSTREAM_OFFICIAL_BLOCK, UPSTREAM_OFFICIAL_BLOCK + UPSTREAM_OFFICIAL_BLOCK);
    write(doubledOfficial);
    const r = mod.patchMarketCliBranch(fixtureRoot);
    check('J9 officialDesktop 判据命中两次 ⇒ ok:false、不写、文件原样',
      r.ok === false && r.reason.includes('形状') && readFileSync(fixtureFile, 'utf8') === doubledOfficial,
      JSON.stringify(r));
  }

  //
  // 【为什么这条是门禁，而不是一句注释】端侧 profile-boot 自己就会
  // `provideCmdline(hostCtx, {…})` ⇒ `ctx.provide("appExit", host.exit)`（上游语义：由启动器
  // 在树挂载前提供）。cordis 的 `provide` 撞名会抛
  // `service "appExit" has been registered at <root>`，而它发生在 boot 回调**期间** ⇒
  // **整个 Host 起不来**（真机 2026-10-09 一次 100% 复现：`dsh: host preparation failed`）。
  // 正确做法是**只补市场那条分支缺的那一跳**，不要另起 provision。这条断言把
  // 「别再手贱补一遍」钉在源码层：有人写回 `provide("appExit")` 门禁当场红。
  {
    const src = readFileSync(join(ROOT, ...PLUGIN_REL.split('/')), 'utf8');
    // 只看**代码行**：头注里把上游那句 `ctx.provide("appExit", host.exit)` 当引用写出来是
    // 必要的（否则读的人不知道为什么不能补），所以这里排除 `*` / `//` / `/*` 开头的行。
    const offending = src.split(/\r?\n/).filter((line) => {
      const t = line.trim();
      if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return false;
      return /provide\(\s*["']appExit["']/.test(line);
    });
    check('J7 插件的**代码**里没有 provide("appExit")（树里已有 ⇒ 撞名把启动打挂）',
      offending.length === 0, offending.join(' | '));
    const ctxFree = fakeCtx();
    const attached = mod.provideMarketBridge(ctxFree, { name: 'ondevice', dir: profileDir });
    check('J7b 接管时也不碰 appExit（两个 provide 仍是 desktopProfiles / desktopPnpm）',
      attached === true && !ctxFree.provided.has('appExit')
      && ctxFree.provided.has('desktopProfiles') && ctxFree.provided.has('desktopPnpm'));
  }
}

/* ── K 落位目录口径（targetDirFromArgv）与 prefetch 的 `--dir` 端到端 ───────── */
/*
 * 【为什么要有这一节】市场的 CLI 链路 `prefetch()` 发的是
 * `add <target> --dir <mkdtemp 出来的临时目录> --ignore-scripts`：先在没被监视的临时项目里
 * 解析/下载，校验通过后才落到真 profile。桥若只认 profileDir，预取会装进 live profile 而
 * 临时目录留空 ⇒ 市场读不到 manifest（`installed package manifest missing`），包/依赖/插件行
 * 还会泄漏进 profile。这条口径必须与 `bin/pnpm` 假壳的 `shimDirResolveLines()` 同优先级。
 */
{
  const P = join(home, 'profiles', 'ondevice');
  const cases = [
    [['add', 'pkg'], P, '缺 --dir ⇒ 宿主 profile 目录'],
    [['add', '--dir', '/tmp/x', 'pkg'], '/tmp/x', '--dir <值> 要取值'],
    [['add', '--dir=/tmp/y', 'pkg'], '/tmp/y', '--dir=<值> 要取值'],
    [['add', '--dir', '/', 'pkg'], P, '--dir / 不采纳（假壳同款）'],
    [['add', '--dir'], P, '--dir 没跟值 ⇒ 宿主 profile'],
    [['add', 'pkg', '--dir', 'sub'], join(P, 'sub'), '相对路径按宿主 profile 归一'],
    [['remove', 'pkg'], P, 'remove 也一样'],
  ];
  for (const [argv, want, label] of cases) {
    const got = mod.targetDirFromArgv(argv, P);
    check(`K 落位目录 · ${label}`, got === want, `got=${got} want=${want}`);
  }

  // K7：端到端 —— `--dir <临时目录>` 必须原样进 `.dir`（隔离预取成立的前提）
  {
    const ctx = fakeCtx();
    mod.provideMarketBridge(ctx, { name: 'ondevice', dir: profileDir });
    const service = ctx.provided.get('desktopPnpm');
    rmSync(queueDir, { recursive: true, force: true });
    const tmp = join(sandbox, 'prefetch-tmp');
    const handle = service.runPlugin(['add', 'pkg@1.0.0', '--dir', tmp, '--ignore-scripts'], profileDir);
    const reqFile = await waitFor(() => (existsSync(queueDir)
      ? readdirSafe(queueDir).find((n) => n.endsWith('.req')) ?? null : null));
    check('K7a 预取请求投出 .req', typeof reqFile === 'string', `req=${String(reqFile)}`);
    if (typeof reqFile === 'string') {
      const base = reqFile.slice(0, -'.req'.length);
      const dirText = existsSync(join(queueDir, `${base}.dir`)) ? readFileSync(join(queueDir, `${base}.dir`), 'utf8').trim() : '';
      check('K7b `--dir <临时目录>` 原样进 .dir（隔离预取没被塞进 live profile）', dirText === tmp, `dir=${dirText}`);
      rmSync(join(queueDir, reqFile), { force: true });
      writeFileSync(join(queueDir, `${base}.done`), JSON.stringify({ ok: true, name: 'pkg', version: '1.0.0' }), 'utf8');
    } else {
      bad('K7b `--dir <临时目录>` 原样进 .dir（隔离预取没被塞进 live profile）', '没等到 .req');
    }
    const outcome = await handle.done;
    check('K7c 预取句柄成功落定（{exitCode:0, signal:null}）', outcome.exitCode === 0 && outcome.signal === null,
      JSON.stringify(outcome));
  }
}
/* ── L 装完重放：市场补丁的**第二次贴**（main.js 安装队列 → dshm-market-patch.cjs） ── */
/*
 * 【为什么必须有这一节（2026-10-14 真机回归）】市场补丁在 boot 回调里**只贴一次**，而皮肤
 * 市场几乎总是**启动之后**才装进来的（它就是「设置 → 插件 → 项目地址」里的一个包）。真机
 * `node-output.log` 留下的原话：boot 12:27:13 贴的是
 *   `皮肤市场挂载契约改写：未安装（ENOENT: …/profiles/ondevice/node_modules/dsh-skin-market/lib/index.js）`
 * 而市场 12:35:09 才经安装队列装完 ⇒ 落盘的市场文件永远是**上游原形** ⇒ 302 条皮肤里只有
 * 41 条能一键装、其余全部「需手动安装」（用户现象："皮肤市场的皮肤全部都要手动安装"）。
 *
 * J 段钉的是**补丁函数本身的契约**，它挡不住这条：函数写得再对，**没人调**等于没修。
 * 所以这里把「装完那一跳真的会调、调的是同一份判据、市场不在时保持沉默、桥缺失/形状变了
 * 绝不硬写、模块真的会进 HAP」逐条钉死。负控制臂：L2（不 import 就返回 null）、
 * L6（形状变了不写）、L7/L8（桥缺失 / 桥自身抛错 ⇒ 只回一行 reason，不抛给安装队列）。
 */
{
  const patchPath = join(ROOT, 'hostcore', 'app', 'dshm-market-patch.cjs');
  const patchMod = (await import(pathToFileURL(patchPath).href)).default;
  const bridgeSrc = join(ROOT, ...PLUGIN_REL.split('/'));

  check('L1 模块导出 replayMarketContractPatch（main.js 靠它重放）',
    typeof patchMod.replayMarketContractPatch === 'function');
  check('L1b 市场落点口径与 patchMarketCliBranch 逐字同源（<profileDir>/node_modules/dsh-skin-market/lib/index.js）',
    patchMod.marketEntryPath('/p') === join('/p', 'node_modules', 'dsh-skin-market', 'lib', 'index.js'),
    patchMod.marketEntryPath('/p'));
  check('L1c 桥落点在核心树的 node_modules/@deepseek-ai/dshm-market-bridge（pack-core 的落点）',
    patchMod.bridgeEntryPath('/core')
      === join('/core', 'node_modules', '@deepseek-ai', 'dshm-market-bridge', 'lib', 'index.js'),
    patchMod.bridgeEntryPath('/core'));

  const replayProfile = join(sandbox, 'replay-profile');
  const replayFile = join(replayProfile, 'node_modules', 'dsh-skin-market', 'lib', 'index.js');
  const noBridge = join(sandbox, 'no-such-bridge.js');
  const putMarket = (text) => {
    rmSync(replayProfile, { recursive: true, force: true });
    mkdirSync(dirname(replayFile), { recursive: true });
    writeFileSync(replayFile, text, 'utf8');
  };

  // L2：市场不在这个 profile ⇒ null（**静默**），而且**没有**去 import 桥 —— 入口故意指一个
  //     不存在的文件：若实现先 import 再判存在，这里会拿到"桥模块不在"而不是 null。
  {
    rmSync(replayProfile, { recursive: true, force: true });
    const r = await patchMod.replayMarketContractPatch(replayProfile, { entry: noBridge });
    check('L2 市场不在这个 profile ⇒ null（静默，且没去 import 任何东西）', r === null, JSON.stringify(r));
  }

  // L3：市场在 + 桥在 ⇒ 真的改写（终态与 J2 同一形态：走的是同一份判据函数）
  let patchedShape = '';
  {
    putMarket(UPSTREAM_SHAPE);
    const r = await patchMod.replayMarketContractPatch(replayProfile, { entry: bridgeSrc });
    patchedShape = readFileSync(replayFile, 'utf8');
    check('L3a 装完重放 ⇒ 走的是同一份判据（reason 逐字来自 patchMarketCliBranch）',
      Boolean(r) && r.ok === true && r.reason.includes('已按 CLI 契约改写'), JSON.stringify(r));
    check('L3b 终态 = CLI 契约（hostKind 只剩 dsh 两处 + 幂等标记各一处）',
      count(patchedShape, "hostKind: 'desktop'") === 0 && count(patchedShape, "hostKind: 'dsh'") === 2
      && count(patchedShape, 'dshm-market-bridge: cli-branch') === 1
      && count(patchedShape, 'dshm-market-bridge: official-desktop-off') === 1,
      `desktop=${count(patchedShape, "hostKind: 'desktop'")} dsh=${count(patchedShape, "hostKind: 'dsh'")}`);
    check('L3c desktop 分支拿到 restart，且没有重复声明 const', count(patchedShape, ', agents, restart })') === 1
      && count(patchedShape, "const appExit = readService('appExit');") === 2);
  }

  // L4：幂等 —— 第二次重放与 boot 那次（同一函数）结果一致，逐字节不写盘
  {
    const r = await patchMod.replayMarketContractPatch(replayProfile, { entry: bridgeSrc });
    check('L4 第二次重放 = no-op（已是目标形态，逐字节不变）',
      Boolean(r) && r.ok === true && r.reason.includes('已是目标形态')
      && readFileSync(replayFile, 'utf8') === patchedShape, JSON.stringify(r));
  }

  // L5：上一代补丁形态（设备上可能正是这一代）⇒ 同一条重放路径也要能就地升级
  {
    putMarket(LEGACY_SHAPE);
    const r = await patchMod.replayMarketContractPatch(replayProfile, { entry: bridgeSrc });
    const after = readFileSync(replayFile, 'utf8');
    check('L5a 上一代形态 ⇒ 升级（reason 点名升级，而不是"改写"）',
      Boolean(r) && r.ok === true && r.reason.includes('升级'), JSON.stringify(r));
    check('L5b 升级后与"直接改写上游原形"逐字节相同（两条路径一个终态）', after === patchedShape);
  }

  // L6：**负向控制** —— 上游形状变了（判据命中两次）⇒ 一个字节都不写，只回一行 reason
  {
    const doubled = UPSTREAM_SHAPE.replace(UPSTREAM_OFFICIAL_BLOCK, UPSTREAM_OFFICIAL_BLOCK + UPSTREAM_OFFICIAL_BLOCK);
    putMarket(doubled);
    const r = await patchMod.replayMarketContractPatch(replayProfile, { entry: bridgeSrc });
    check('L6 上游形状变了 ⇒ ok:false + 一个字节都不写（不猜着改）',
      Boolean(r) && r.ok === false && r.reason.includes('形状') && readFileSync(replayFile, 'utf8') === doubled,
      JSON.stringify(r));
  }

  // L7：市场在、桥模块不在（核心树被裁/版本老）⇒ 说得出路径的一行 reason，不写盘、不抛
  {
    putMarket(UPSTREAM_SHAPE);
    const r = await patchMod.replayMarketContractPatch(replayProfile, { entry: noBridge });
    check('L7 桥模块缺失 ⇒ ok:false + 点名路径，文件一个字节都不动（不阻断安装链路）',
      Boolean(r) && r.ok === false && r.reason.includes('桥模块不在') && r.reason.includes(noBridge)
      && readFileSync(replayFile, 'utf8') === UPSTREAM_SHAPE, JSON.stringify(r));
  }

  // L8：桥自己抛（模块顶层错 / 版本坏了）⇒ 仍只回一行 reason —— 安装队列是 `.done` 的写入方，
  //     绝不能被这里带崩（否则一次补丁异常会把"装成功了"变成 `.fail`）
  {
    const badBridge = join(sandbox, 'bad-bridge.mjs');
    writeFileSync(badBridge, 'throw new Error("boom");\n', 'utf8');
    const r = await patchMod.replayMarketContractPatch(replayProfile, { entry: badBridge });
    check('L8 桥自身抛错 ⇒ 吞成一行 reason（绝不抛给安装队列）',
      Boolean(r) && r.ok === false && r.reason.includes('重放异常'), JSON.stringify(r));
  }

  // L9：**接线** —— main.js 真的在「装完 → .done 之前」调它，且用的是安装器实际落点
  {
    const mainSrc = readFileSync(join(ROOT, 'hostcore', 'app', 'main.js'), 'utf8');
    check('L9a main.js require 了这份模块（装完才有得调）',
      mainSrc.includes("require('./dshm-market-patch.cjs')"));
    const callAt = mainSrc.indexOf('marketPatch.replayMarketContractPatch(');
    const doneAt = mainSrc.indexOf("fs.writeFileSync(path.join(installQueueDir, base + (result.ok ? '.done' : '.fail'))");
    check('L9b 调用点在安装结果写盘（.done/.fail）**之前** —— 写入方拿到结果就可能去挂载',
      callAt > 0 && doneAt > 0 && callAt < doneAt, `call=${callAt} done=${doneAt}`);
    check('L9c 只在**安装成功**时调（`!isRemove && result.ok`，装卸两条链分得清）',
      /if \(!isRemove && result\.ok\) \{[\s\S]{0,600}?marketPatch\.replayMarketContractPatch\(/.test(mainSrc));
    check('L9d 落点取的是安装器实际用的那个目录（instOpts.profileDir 优先，缺省宿主 profile 目录）',
      /const marketProfileDir[\s\S]{0,220}?instOpts\.profileDir[\s\S]{0,220}?path\.join\(HOME_DIR, 'profiles', PROFILE\)/.test(mainSrc));
    check('L9e coreDir 传的是当前已激活的核心树（CORE_DIR，与 loader 同源）',
      /replayMarketContractPatch\(marketProfileDir, \{ coreDir: CORE_DIR \}\)/.test(mainSrc));
  }

  // L10：**落位** —— 两份清单必须同时带上它，否则 HAP 里根本没有这个文件（require 抛
  //      MODULE_NOT_FOUND，被队列的 try/catch 吞成一行日志 ⇒ 与不修一模一样）
  {
    const place = readFileSync(join(ROOT, 'tools', 'place-host-app.mjs'), 'utf8');
    const sync = readFileSync(join(ROOT, 'tools', 'assert-resfile-sync.mjs'), 'utf8');
    check('L10a place-host-app 清单里有 dshm-market-patch.cjs', place.includes("'dshm-market-patch.cjs'"));
    check('L10b assert-resfile-sync 清单同步（两处一起改的纪律）', sync.includes("'dshm-market-patch.cjs'"));
  }

  // L11：**第二个市场**（插件市场 `dshmarket`）走同一个重放入口（2026-10-14 扩充）。
  //      皮肤市场与插件市场都是「设置 → 插件 → 项目地址」里的包、都有"启动之后才装进来"
  //      这条时间线，各自那一份就地改写都得重放：前者是挂载契约，后者是预览图出网。
  //      两处判据**各自独立** ⇒ 只装一个时行为与老形态逐字一致（reason 不带前缀）。
  {
    const dshmarketFile = join(replayProfile, 'node_modules', 'dshmarket', 'client', 'client.js');
    const putDshmarket = (text) => {
      rmSync(replayProfile, { recursive: true, force: true });
      mkdirSync(dirname(dshmarketFile), { recursive: true });
      writeFileSync(dshmarketFile, text, 'utf8');
    };
    check('L11a 插件市场落点口径（<profileDir>/node_modules/dshmarket/client/client.js）',
      patchMod.dshmarketEntryPath('/p') === join('/p', 'node_modules', 'dshmarket', 'client', 'client.js'),
      patchMod.dshmarketEntryPath('/p'));

    // L11b：只装插件市场（皮肤市场不在这个 profile）⇒ 只改预览图，reason **不带前缀**
    //      （老日志形态逐字不变 —— 现场排查时那行日志才好读）。
    putDshmarket(DSHMARKET_CLIENT_UPSTREAM);
    const rD = await patchMod.replayMarketContractPatch(replayProfile, { entry: bridgeSrc });
    const afterD = readFileSync(dshmarketFile, 'utf8');
    check('L11b 只装插件市场 ⇒ 真的改写，且 reason 不带「插件市场预览图：」前缀',
      Boolean(rD) && rD.ok === true && rD.reason.includes('缩略图出网改为宿主代理')
      && !rD.reason.includes('插件市场预览图：'), JSON.stringify(rD));
    check('L11c 同一次重放里灯箱那处也改了（终态逐字节等于目标形态）',
      afterD === DSHMARKET_CLIENT_TARGET, `len=${afterD.length} want=${DSHMARKET_CLIENT_TARGET.length}`);

    // L11d：两个市场都在 ⇒ 一行 reason 里各带前缀，谁的问题一眼看得出
    putDshmarket(DSHMARKET_CLIENT_UPSTREAM);
    mkdirSync(dirname(replayFile), { recursive: true });
    writeFileSync(replayFile, UPSTREAM_SHAPE, 'utf8');
    const rB = await patchMod.replayMarketContractPatch(replayProfile, { entry: bridgeSrc });
    check('L11d 两个市场都在 ⇒ reason 按「皮肤：…；插件市场预览图：…」拼一行、两个文件都改到了',
      Boolean(rB) && rB.ok === true && rB.reason.includes('皮肤：') && rB.reason.includes('插件市场预览图：')
      && count(readFileSync(replayFile, 'utf8'), "hostKind: 'dsh'") === 2
      && readFileSync(dshmarketFile, 'utf8') === DSHMARKET_CLIENT_TARGET, JSON.stringify(rB));

    // L11e：**负控制** —— 两个市场都不在 ⇒ 仍然 null（不 import 桥、不造文件）
    rmSync(replayProfile, { recursive: true, force: true });
    const rN = await patchMod.replayMarketContractPatch(replayProfile, { entry: noBridge });
    check('L11e 两个市场都不在 ⇒ null（静默）', rN === null, JSON.stringify(rN));

    // L11f：**互不干扰** —— 插件市场那份形状坏了（ok:false），皮肤市场该改的**照样改**；
    //      整体 ok:false 只是"有一条没生效"的如实回报，不是"整条重放失败"。
    putDshmarket(DSHMARKET_CLIENT_HEAD + DSHMARKET_THUMB_UP + DSHMARKET_THUMB_UP);
    mkdirSync(dirname(replayFile), { recursive: true });
    writeFileSync(replayFile, UPSTREAM_SHAPE, 'utf8');
    const rX = await patchMod.replayMarketContractPatch(replayProfile, { entry: bridgeSrc });
    check('L11f 插件市场形状坏 ⇒ ok:false，但皮肤市场那边照样改到位（两手互不干扰）',
      Boolean(rX) && rX.ok === false && rX.reason.includes('皮肤：') && rX.reason.includes('插件市场预览图：')
      && count(readFileSync(replayFile, 'utf8'), "hostKind: 'dsh'") === 2
      && readFileSync(dshmarketFile, 'utf8') === DSHMARKET_CLIENT_HEAD + DSHMARKET_THUMB_UP + DSHMARKET_THUMB_UP,
      JSON.stringify(rX));
  }
}

/* ── M 插件市场预览图改写（patchDshmarketThumbs） ────────────────────────────── */
/*
 * 【为什么要有这一节（2026-10-14 用户报「插件市场不显示预览图」）】插件市场（`dshmarket`）
 * 的预览图两条路都是**浏览器直连**：卡片缩略图走 `https://images.weserv.nl/?url=…`
 * （上游拿它当服务端缩放用），灯箱直接 `src: shots[index]`。端侧 WebView 里这两台都连不上
 * （TLS 失败）⇒ 卡片一片空白、点开也没有大图；而**宿主进程**里同一批 URL 1.15–3s 就能拿到
 * ⇒ 就地改写成宿主的本地代理 `/dshm-shot`（同源 http、无 token，见 main.js 的
 * `registerShotProxyEndpoint()`）。开关/白名单都在宿主那侧，这里只换地址。
 *
 * 本段钉**改写函数本身的契约**：上游两段各命中一次才写；已是目标形态 ⇒ 不写盘；
 * 命中 0 或 ≥2（上游改形 / 文件里出现第二份副本）⇒ **一个字节都不写**、只回一行 reason。
 * 两处**相互独立**（M4 两个方向都验）—— 与 J 段同一条纪律：宁可留一处旧行为，也不猜着改。
 * M8 钉的是**接线**：宿主那侧的 `/dshm-shot` 路由真的存在、真的注册、路径与这里逐字同源
 * （否则改出来的地址打在空气上，卡片依旧是白的，而契约断言全绿）。
 */
{
  check('M0 插件导出 patchDshmarketThumbs（门禁与运行时同一份实现）',
    typeof mod.patchDshmarketThumbs === 'function');

  const dmRoot = join(sandbox, 'dshmarket-profile');
  const dmFile = join(dmRoot, 'node_modules', 'dshmarket', 'client', 'client.js');
  const putDm = (text) => {
    rmSync(dmRoot, { recursive: true, force: true });
    mkdirSync(dirname(dmFile), { recursive: true });
    writeFileSync(dmFile, text, 'utf8');
  };

  // M1：没装 ⇒ 如实报未安装，且**不创建任何文件**
  {
    rmSync(dmRoot, { recursive: true, force: true });
    const r = mod.patchDshmarketThumbs(dmRoot);
    check('M1 未安装 ⇒ ok:false 且说得出原因，不造文件',
      r.ok === false && r.reason.includes('未安装') && !existsSync(dmFile), JSON.stringify(r));
  }

  // M2：上游原形状 ⇒ 两处一起改写（终态逐字节等于目标形态）
  {
    putDm(DSHMARKET_CLIENT_UPSTREAM);
    const r = mod.patchDshmarketThumbs(dmRoot);
    const after = readFileSync(dmFile, 'utf8');
    check('M2a 上游原形状 ⇒ 改写（ok:true，两处都点名）',
      r.ok === true && r.reason.includes('缩略图出网改为宿主代理') && r.reason.includes('灯箱原图改为宿主代理'),
      JSON.stringify(r));
    check('M2b 终态逐字节等于目标形态（首尾那两行没被碰）', after === DSHMARKET_CLIENT_TARGET,
      `len=${after.length} want=${DSHMARKET_CLIENT_TARGET.length}`);
    check('M2c 图床直连被换掉：`images.weserv.nl` 与裸 `src: shots[index],` 各剩 0 处',
      count(after, 'images.weserv.nl') === 0 && count(after, 'src: shots[index],') === 0
      && count(after, 'src: shotProxyUrl(shots[index]),') === 1);
    check('M2d 共用的 shotProxyUrl 只定义一次（两处调用点共用，不各写一份 URL 形态）',
      count(after, 'function shotProxyUrl(src, height)') === 1
      && count(after, '/dshm-shot?url=') === 1
      && count(after, 'shotProxyUrl(') === 3);
    check('M2e 幂等标记只贴一处（下次冷启动据此判"已是目标形态"）',
      count(after, '/* dshm-market-bridge: shot-proxy */') === 1);
  }

  // M3：幂等 —— 再跑一遍**不写盘**（mtime 是唯一能证明"没写"的读数：内容相同也可能白写一次）
  {
    const before = readFileSync(dmFile, 'utf8');
    const mtimeBefore = statSync(dmFile).mtimeMs;
    const r = mod.patchDshmarketThumbs(dmRoot);
    check('M3 已是目标形态 ⇒ no-op（ok:true + reason 点名"已是目标形态" + 逐字节不变）',
      r.ok === true && r.reason.includes('已是目标形态') && readFileSync(dmFile, 'utf8') === before,
      JSON.stringify(r));
    check('M3b 且真的**没写盘**（mtimeMs 一个数位都没动）',
      statSync(dmFile).mtimeMs === mtimeBefore, `${mtimeBefore} -> ${statSync(dmFile).mtimeMs}`);
  }

  // M4：**两处相互独立**（两个方向都验）—— 谁在上游形态就改谁，另一个一个字节不动
  {
    // 方向一：缩略图还是上游形态、灯箱早就是目标形态
    const boxFirst = DSHMARKET_CLIENT_HEAD + DSHMARKET_THUMB_UP + DSHMARKET_BOX_TARGET + DSHMARKET_CLIENT_TAIL;
    putDm(boxFirst);
    const r1 = mod.patchDshmarketThumbs(dmRoot);
    check('M4a 只有缩略图是上游形态 ⇒ 仍 ok:true，reason 只点名缩略图',
      r1.ok === true && r1.reason.includes('缩略图') && !r1.reason.includes('灯箱'),
      JSON.stringify(r1));
    check('M4b 终态与"两处一起改"逐字节相同（灯箱那一行没被二次改写）',
      readFileSync(dmFile, 'utf8') === DSHMARKET_CLIENT_TARGET);

    // 方向二：缩略图已是目标形态、灯箱还是上游形态
    const thumbFirst = DSHMARKET_CLIENT_HEAD + DSHMARKET_THUMB_TARGET + DSHMARKET_BOX_UP + DSHMARKET_CLIENT_TAIL;
    putDm(thumbFirst);
    const r2 = mod.patchDshmarketThumbs(dmRoot);
    check('M4c 只有灯箱是上游形态 ⇒ 仍 ok:true，reason 只点名灯箱',
      r2.ok === true && r2.reason.includes('灯箱') && !r2.reason.includes('缩略图'),
      JSON.stringify(r2));
    check('M4d 终态同上（缩略图那段没被再写一遍）',
      readFileSync(dmFile, 'utf8') === DSHMARKET_CLIENT_TARGET);
  }

  // M5：**负向控制** —— 锚点不唯一 / 形状变了 ⇒ 一个字节都不写，只回一行 reason
  {
    const cases = [
      ['缩略图那段出现两份副本', DSHMARKET_CLIENT_HEAD + DSHMARKET_THUMB_UP + DSHMARKET_THUMB_UP + DSHMARKET_BOX_UP + DSHMARKET_CLIENT_TAIL, 'thumbUrl'],
      ['灯箱那一行出现两份副本', DSHMARKET_CLIENT_HEAD + DSHMARKET_THUMB_UP + DSHMARKET_BOX_UP + DSHMARKET_BOX_UP + DSHMARKET_CLIENT_TAIL, '灯箱'],
      ['缩略图改形（weserv 少一个查询参数）',
        (DSHMARKET_CLIENT_HEAD + DSHMARKET_THUMB_UP + DSHMARKET_BOX_UP + DSHMARKET_CLIENT_TAIL)
          .replace('&fit=inside&we=1', '&fit=inside'),
        'thumbUrl'],
      ['灯箱改形（缩进少一层）',
        (DSHMARKET_CLIENT_HEAD + DSHMARKET_THUMB_UP + DSHMARKET_BOX_UP + DSHMARKET_CLIENT_TAIL)
          .replace(DSHMARKET_BOX_UP, '\t\t\t\t\t' + 'src: shots[index],\n'),
        '灯箱'],
    ];
    for (const [label, shape, which] of cases) {
      putDm(shape);
      const r = mod.patchDshmarketThumbs(dmRoot);
      check(`M5 形状变了（${label}）⇒ ok:false、点名字段、一个字节都不写`,
        r.ok === false && r.reason.includes('形状') && r.reason.includes(which)
        && readFileSync(dmFile, 'utf8') === shape, JSON.stringify(r));
    }
  }

  // M6：**接线** —— 宿主那侧的 `/dshm-shot` 路由必须真的在（否则改出来的地址打在空气上）
  //     【为什么夹具不 import 插件常量】M2/M4 是"拿夹具喂给插件的改写函数"：万一夹具与插件
  //     里的锚点常量漂了，M2a 当场红 —— 等价于一条常量同源断言，而且是**行为级**的。
  {
    const mainSrc = readFileSync(join(ROOT, 'hostcore', 'app', 'main.js'), 'utf8');
    check('M6a main.js 注册了 /dshm-shot 路由（预览图代理的宿主侧本体）',
      mainSrc.includes('function registerShotProxyEndpoint(') && mainSrc.includes("path: '/dshm-shot'"));
    check('M6b 启动台阶里真的调了它（不是定义了没人用）',
      /registerShotProxyEndpoint\(ctx\);/.test(mainSrc) && mainSrc.includes("stage('BOOT_64_SHOT_PROXY'"));
    check('M6c 目标形态里的路径与宿主路由逐字同源（`/dshm-shot?url=`）',
      DSHMARKET_THUMB_TARGET.includes('`/dshm-shot?url='));
    check('M6d 代理有主机白名单与字节上限（不是个开放转发口）',
      mainSrc.includes('const SHOT_HOSTS = new Set(') && mainSrc.includes('const SHOT_MAX_BYTES =')
      && mainSrc.includes('!SHOT_HOSTS.has(target.hostname.toLowerCase())'));
  }
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
  + ' 句柄语义（含 signal=null 与取消） / 拒绝面 / 落位目录口径 / 挂载契约改写（含升级路径） /'
  + ' 装完重放（两个市场共用一个入口，含负控制臂） / 插件市场预览图改写（含 mtime 口径的'
  + ' 幂等读数与 4 条负向臂） / 宿主 /dshm-shot 路由接线 / 打包三处接线全部成立');
