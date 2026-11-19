#!/usr/bin/env node
/**
 * check-memory-guard.mjs
 *
 * 判据：2026-10-19 MatePad Edge 内存风暴后的三层收口必须同时在场（见 `docs/205`）。
 *
 *   A. ArkTS 侧（`EntryAbility.ets`）
 *      A1 `applyWebMemoryProfile()` 在 `onCreate` 首行被调用；
 *      A2 它调 `setRenderProcessMode(RenderProcessMode.SINGLE)`（少一个 :render 常驻）；
 *      A3 覆写 `onMemoryLevel`，并调 `trimMemoryByPressureLevel(...)`；
 *      A4 危急档落持久标记 `diag-mem-critical`（下一轮 Host 读到就关预热）；
 *      A5 每档都落 `diag-mem`（时间 + 档位），供下一次现场判读。
 *
 *   B. Host 侧（`hostcore/app/main.js`）
 *      B1 10 秒采样 `/proc/self/status` 的 VmRSS 与 `/proc/meminfo` 的 MemAvailable；
 *      B2 越过阈值写 `files/diag-mem-critical` 并打 30s 一次的告警行；
 *      B3 危急标记只用于诊断，PC 不再用历史标记切换 VM 预热门；
 *      B4 内存看门狗仍早于核心树 require；
 *      B5 `DSHM_MEM_WATCH=off` 可关、阈值两个 env 可调。
 *
 *   C. VM 侧（`dshm-vm-bash/lib/vm.js`）
 *      C1 12G 档预热默认关；16G+ 性能档默认开；显式 off 始终优先；
 *      C2 开了之后延迟仍夹在 5..600 s；
 *      C3 预热 reason 写明档位与来源（真机日志可判读）。
 *
 *   E. 后台保活（PC/2in1 与平板）
 *      E1 模块声明 `taskKeeping`；
 *      E2 `KeepAlive` 提供 TASK_KEEPING 申请路径；
 *      E3 PC/2in1 启动时优先申请 TASK_KEEPING，失败才降级 DATA_TRANSFER；
 *      E4 平板忙碌后台路径独立于 PC 启动路径，且使用带降级的长时任务申请；
 *      E5 托盘后台 Ability 使用当前包名，不能把 beta 指向正式包。
 *      E6 长时任务申请/降级/取消写 `diag-keepalive`，设备上可直接取证。
 *
 * 变异对照臂（每个都必须判红）：
 *   M1 去掉单渲染进程调用        M2 去掉 trimMemoryByPressureLevel
 *   M3 Host 不采样危急读数          M4 预热默认又变回开
 *   M8 不声明 taskKeeping         M9 PC 仍用 DATA_TRANSFER
 *   M10 托盘 hardcode 正式包名
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const ENTRY = 'entry/src/main/ets/entryability/EntryAbility.ets';
const MAIN = 'hostcore/app/main.js';
const VM = 'hostcore/plugins/dshm-vm-bash/lib/vm.js';
const TERMINAL = 'hostcore/plugins/dshm-vm-bash/lib/terminal.js';
const INDEX = 'hostcore/plugins/dshm-vm-bash/lib/index.js';
const MODULE = 'entry/src/main/module.json5';
const KEEPALIVE = 'platform/src/main/ets/notify/KeepAlive.ets';
const TRAY = 'entry/src/main/ets/system/StatusBarTray.ets';

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function inspect(f) {
  const fails = [];
  const ok = (cond, label) => {
    if (!cond) fails.push(label);
  };

  /* ── A. ArkTS 侧 ─────────────────────────────────────────── */
  ok(f.entry.includes('private applyWebMemoryProfile(): void'), 'A1 applyWebMemoryProfile() 存在');
  ok(f.entry.includes('this.applyWebMemoryProfile();'), 'A1 onCreate 真的调用了它');
  ok(f.entry.includes('setRenderProcessMode(webview.RenderProcessMode.SINGLE)'),
    'A2 切单渲染进程（SINGLE）');
  ok(f.entry.includes('onMemoryLevel(level: AbilityConstant.MemoryLevel): void'),
    'A3 覆写了 onMemoryLevel');
  ok(f.entry.includes('trimMemoryByPressureLevel(pl)'), 'A3 内存压力时释放 ArkWeb 缓存');
  ok(f.entry.includes("filesDir}/diag-mem-critical") && f.entry.includes('markMemCritical('),
    'A4 危急档落持久标记 diag-mem-critical');
  ok(f.entry.includes("filesDir}/diag-mem") && f.entry.includes('writeMemDiag('),
    'A5 每档落 diag-mem');
  ok(f.entry.includes('MEMORY_LEVEL_CRITICAL') && f.entry.includes('MEMORY_LEVEL_LOW'),
    'A5 档位判据覆盖 critical/low/moderate');

  /* ── B. Host 侧 ──────────────────────────────────────────── */
  ok(f.main.includes("readMiB('/proc/self/status'") && f.main.includes('/^VmRSS:'),
    'B1 采样自身 VmRSS');
  ok(f.main.includes("readMiB('/proc/meminfo'") && f.main.includes('MemAvailable'),
    'B1 采样系统 MemAvailable');
  ok(f.main.includes("filesDir, 'diag-mem-critical'"), 'B2 危急标记路径');
  ok(!f.main.includes("process.env.DSHM_VM_PREWARM = 'off'"),
    'B3 危急标记只留诊断，不切换 VM 预热门');
  {
    const iGuard = f.main.indexOf('内存看门狗与诊断');
    const iNative = f.main.indexOf('node-addon-require-builtin');
    ok(iGuard > 0 && iNative > 0 && iGuard < iNative,
      'B4 看门狗安装点早于核心树/内建 shim');
  }
  ok(f.main.includes("DSHM_MEM_WATCH") && f.main.includes('DSHM_MEM_RSS_LIMIT_MIB')
    && f.main.includes('DSHM_MEM_AVAIL_FLOOR_MIB'), 'B5 开关与两个阈值 env');

  /* ── C. VM 侧 ────────────────────────────────────────────── */
  ok(f.vm.includes('memoryTier') && f.vm.includes('VM_PERFORMANCE_MEM_TOTAL_MIB'),
    'C1 物理内存分档判据在');
  ok(f.vm.includes("const on = raw === 'on'"), 'C1 只有显式 on 才算开');
  ok(f.vm.includes('performanceDefault') && f.vm.includes('16G+'),
    'C1 16G+ 性能档默认预热');
  ok(f.vm.includes('默认关（${profile.tier} 档'), 'C3 预热 reason 带档位');
  ok(f.vm.includes('Math.min(600, Math.max(5'), 'C2 延迟仍夹在 5..600 s');

  /* ── D. 终端链路 ─────────────────────────────────────────── *
   * MatePad Edge 上 pty/dlopen/exec 全被系统拒 ⇒ 终端可能"失败→前端重试→再失败"，
   * 每次失败都会 acquire()（必要时冷启动 QEMU）。判据钉住"熔断在碰 VM 之前"与
   * "每次接管都留一行日志"，这是判读"是不是终端重试风暴"的唯一入口。 */
  ok(f.terminal.includes('TERM_FAIL_WINDOW_MS = 60000') && f.terminal.includes('TERM_FAIL_MAX = 3'),
    'D1 终端熔断窗口/阈值常量在');
  ok(f.terminal.includes('terminalBreakerOpen()'), 'D1 有熔断判定');
  ok(f.terminal.includes('终端创建熔断：60s 内已失败'), 'D1 熔断时日志写明原因');
  {
    const iBreaker = f.terminal.indexOf('if (terminalBreakerOpen())');
    const iAcquire = f.terminal.indexOf('await acquire(cwd)');
    ok(iBreaker > 0 && iAcquire > 0 && iBreaker < iAcquire,
      'D2 熔断检查在 acquire 之前（不碰 VM）');
  }
  ok(f.terminal.includes('noteTerminalFailure(') && f.terminal.includes('clearTerminalFailures()'),
    'D3 失败记账、成功清零');
  ok(f.terminal.includes('recentFailures') && f.terminal.includes('breakerOpen'),
    'D3 熔断读数进 terminalDiagnostics');
  ok(f.index.includes('终端接管请求 #') && f.index.includes('终端接管请求 #${takenTerminal} 失败'),
    'D4 每次接管成功/失败都留宿主日志');

  /* ── E. PC/2in1 后台保活 ─────────────────────────────────────────── *
   * 官方约束：DATA_TRANSFER 首次进度超过 10 分钟未更新就会被系统取消。
   * 内测日志里每次约 10 分钟后刚好出现 HandleSubscribeOnContinuousTaskStop，
   * 随后整进程开始 20~25 秒一轮冻结。PC/2in1 的 Agent 计算应使用 TASK_KEEPING。 */
  ok(/"backgroundModes"\s*:\s*\[[^\]]*"taskKeeping"/s.test(f.module),
    'E1 module.json5 声明 taskKeeping');
  ok(f.keepAlive.includes('acquireTaskKeeping()')
    && f.keepAlive.includes('backgroundTaskManager.BackgroundMode.TASK_KEEPING'),
    'E2 KeepAlive 有 TASK_KEEPING 申请路径');
  const desktopStart = f.entry.indexOf('if (!isHandheldForm()) {', f.entry.indexOf('onWindowStageCreate('));
  const desktopEnd = f.entry.indexOf('\n      } else {', desktopStart);
  const desktopBody = desktopStart > 0 && desktopEnd > desktopStart
    ? f.entry.slice(desktopStart, desktopEnd) : '';
  ok(desktopBody.includes('this.keepAlive.acquireTaskKeeping().then('),
    'E3 PC/2in1 启动路径优先走 TASK_KEEPING');
  {
    const iHandheld = f.entry.indexOf('private maybeAcquireHandheldKeepAlive(): void {');
    const iHandheldEnd = f.entry.indexOf('private releaseHandheldKeepAlive(): void {', iHandheld);
    const handheldBody = iHandheld > 0 && iHandheldEnd > iHandheld
      ? f.entry.slice(iHandheld, iHandheldEnd) : '';
    ok(/this\.keepAlive\.(?:acquire|acquireTaskKeeping)\(\)\.then\(/.test(handheldBody)
      && handheldBody.includes('isHandheldForm()')
      && handheldBody.includes('generation !== this.keepAliveGeneration'),
      'E4 平板忙碌后台申请位于独立手持路径，完成后做代次校验');
  }
  ok(f.tray.includes('bundleName: context.abilityInfo.bundleName'),
    'E5 托盘 hold 使用当前 bundle，不写死正式包名');
  ok(!f.tray.includes("const BUNDLE_NAME: string = 'com.dshm.dshclient'"),
    'E5 托盘不再保留写死正式包名');
  ok(f.keepAlive.includes("'diag-keepalive'")
    && f.keepAlive.includes('writeDiag(')
    && f.keepAlive.includes("写入 mode="),
    'E6 长时任务模式与取消原因落 diag-keepalive');

  /* ── E7~E9 后台任务被系统取消后的治理 ───────────────────────────────────
   * DATA_TRANSFER 首次进度超过 10 分钟未更新时可能被系统取消；TASK_KEEPING 被拒时，
   * KeepAlive 会降级到 DATA_TRANSFER。取消后必须退避续期，并沿用上次成功申请的任务类型。 */
  const cancelStart = f.keepAlive.indexOf('private installCancelListener(): void {');
  const cancelEnd = f.keepAlive.indexOf('private clearRenew(): void {', cancelStart);
  const cancelBody = cancelStart > 0 && cancelEnd > cancelStart
    ? f.keepAlive.slice(cancelStart, cancelEnd) : '';
  ok(cancelBody.includes('this.scheduleRenew();')
    && cancelBody.includes('!userInitiated && this.backgroundWanted && this.refs > 0')
    && f.keepAlive.includes('this.renewNow();')
    && f.keepAlive.includes('RENEW_MAX_ATTEMPTS'),
    'E7 系统取消后按条件退避续期');
  ok(f.entry.includes('snap.activeStreams > 0') && f.entry.includes('snap.outbox > 0'),
    'E8 手持档 busy 判据含在途事实（activeStreams/outbox），不只看界面投影');
  ok(f.entry.includes('this.keepAlive.recordNeed(')
    && f.keepAlive.includes('recordNeed('),
    'E8 判据读数落 diag（真机反馈可逐项对账）');
  const renewStart = f.keepAlive.indexOf('private async renewNow(): Promise<void> {');
  const renewEnd = f.keepAlive.indexOf('\n  /**', renewStart);
  const renewBody = renewStart > 0 && renewEnd > renewStart
    ? f.keepAlive.slice(renewStart, renewEnd) : '';
  ok(renewBody.includes('await this.requestMode(this.lastMode, this.lastModeLabel)'),
    'E9 续期沿用上次成功申请的任务类型，不擅自切换');

  return fails;
}

const files = {
  entry: read(ENTRY), main: read(MAIN), vm: read(VM),
  terminal: read(TERMINAL), index: read(INDEX),
  module: read(MODULE), keepAlive: read(KEEPALIVE), tray: read(TRAY),
};

console.log('== 正例：当前源码 ==');
const fails = inspect(files);
if (fails.length === 0) console.log('  PASS（0 条失败）');
else {
  console.log(`  FAIL（${fails.length} 条失败）`);
  for (const f of fails) console.log('  ✗ ' + f);
}

console.log('\n== 纯行为：prewarmPlan 分档 ==');
let behaviorFails = 0;
try {
  const mod = await import(pathToFileURL(join(ROOT, VM)).href);
  const low = mod.prewarmPlan({}, 11700);
  const high = mod.prewarmPlan({}, 15400);
  const on = mod.prewarmPlan({ DSHM_VM_PREWARM: 'on' });
  const cases = [
    [low.enabled === false, '12G 档默认 => 不预热'],
    [high.enabled === true && high.delayMs === 12000, '16G+ 档默认 => 预热 12s'],
    [on.enabled === true && on.delayMs === 12000, 'on => 预热 12s'],
    [mod.prewarmPlan({ DSHM_VM_PREWARM: 'off' }).enabled === false, 'off => 不预热'],
    [mod.prewarmPlan({ DSHM_VM_PREWARM: 'off' }, 15400).enabled === false,
      '16G+ 档显式 off => 不预热'],
    [mod.prewarmPlan({ DSHM_VM_PREWARM: 'on', DSHM_VM_PREWARM_SEC: '3' }).delayMs === 5000, '下限夹 5s'],
    [mod.prewarmPlan({ DSHM_VM_PREWARM: 'on', DSHM_VM_PREWARM_SEC: '9999' }).delayMs === 600000, '上限夹 600s'],
  ];
  for (const [cond, label] of cases) {
    if (cond) console.log('  PASS  ' + label);
    else {
      console.log('  FAIL  ' + label);
      behaviorFails += 1;
    }
  }
} catch (e) {
  console.log('  FAIL  导入 vm.js 失败：' + (e && e.message));
  behaviorFails += 1;
}

console.log('\n== 对照臂：每条变异都必须判红 ==');
const arms = [
  ['M1 去掉单渲染进程调用', (f) => {
    f.entry = f.entry.replace('setRenderProcessMode(webview.RenderProcessMode.SINGLE)', '');
  }],
  ['M2 去掉 ArkWeb 内存回收', (f) => {
    f.entry = f.entry.replace('trimMemoryByPressureLevel(pl)', '');
  }],
  ['M3 Host 不采样危急读数', (f) => {
    f.main = f.main.replace("readMiB('/proc/self/status'", "readMiB('/proc/self/missing'");
  }],
  ['M4 预热默认又变回开', (f) => {
    f.vm = f.vm.replace("const on = raw === 'on' || raw === '1' || raw === 'true' || raw === 'yes';",
      'const on = true;');
  }],
  ['M5 去掉终端熔断（重试风暴不设防）', (f) => {
    f.terminal = f.terminal.replace('if (terminalBreakerOpen()) {', 'if (false) {');
  }],
  ['M6 熔断阈值放到失效', (f) => {
    f.terminal = f.terminal.replace('TERM_FAIL_MAX = 3', 'TERM_FAIL_MAX = 99999');
  }],
  ['M7 终端接管不留日志（现场无法归因）', (f) => {
    f.index = f.index.replaceAll('终端接管请求 #', 'noop #');
  }],
  ['M8 不声明 taskKeeping（PC 计算保活不可达）', (f) => {
    f.module = f.module.replaceAll('"taskKeeping"', '"unsupportedMode"');
  }],
  ['M9 PC 仍申请 DATA_TRANSFER（10 分钟后必被取消）', (f) => {
    f.entry = f.entry.replace('this.keepAlive.acquireTaskKeeping()', 'this.keepAlive.acquire()');
  }],
  ['M11 去掉系统取消后的续期（10 分钟规则一到就断）', (f) => {
    f.keepAlive = f.keepAlive.replace('          this.scheduleRenew();\n', '');
    f.keepAlive = f.keepAlive.replace('    this.scheduleRenew();\n', '');
  }],
  ['M12 手持档判据退回只看界面投影（Host 在跑却判成没事）', (f) => {
    /* 2026-11-12：2026-11-05 给判据加了日程档 schedules，旧锚点失配导致变异空转（自检假绿）；
      锚点必须与 EntryAbility.workloadBusy 的真实表达式逐字一致。 */
    f.entry = f.entry.replace('|| snap.activeStreams > 0 || snap.outbox > 0 || refs > 0 || schedules > 0;', ';');
  }],
  ['M13 续期越权改用 TASK_KEEPING（手持档拿不到的类型）', (f) => {
    f.keepAlive = f.keepAlive.replace(
      'await this.requestMode(this.lastMode, this.lastModeLabel)',
      "await this.requestMode(backgroundTaskManager.BackgroundMode.TASK_KEEPING, 'TASK_KEEPING')");
  }],
  ['M10 托盘 hardcode 正式包名（beta 保活指向错误进程）', (f) => {
    f.tray = f.tray.replace(
      'bundleName: context.abilityInfo.bundleName',
      "bundleName: 'com.dshm.dshclient'");
  }],
];

let armFail = 0;
for (const [name, mutate] of arms) {
  const copy = { ...files };
  mutate(copy);
  const got = inspect(copy);
  if (got.length === 0) {
    console.log(`  FAIL  ${name}（变异没生效）`);
    armFail += 1;
  } else {
    console.log(`  PASS  ${name}（fail=${got.length}）`);
  }
}

if (fails.length > 0 || behaviorFails > 0 || armFail > 0) {
  console.log('\nRESULT: FAIL —— 正例/行为/对照臂有问题');
  process.exitCode = 1;
} else {
  console.log('\nRESULT: PASS —— 正例全绿，行为矩阵与对照臂全部有效');
}
