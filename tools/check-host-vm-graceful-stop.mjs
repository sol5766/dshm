#!/usr/bin/env node
/*
 * check-host-vm-graceful-stop.mjs —— P0-1（docs/388）：宿主停止必须等 VM QMP 优雅关机
 *
 * 【为什么需要】QEMU 是**同进程 worker 线程**。旧 `requestStop()` 在 1.5 s 后直接
 * `process.exit(0)`，从不等 guest 刷盘 ⇒ 半写 rootfs.qcow2；而 `stage()` 只在镜像
 * 不存在时才重拷 ⇒ 坏镜像跨启动持久化，VM 以后每次都起不来，只能清应用数据自救。
 *
 * 【修法】插件把导出的 `shutdown()` 注册到进程级 Set，宿主取出并**等它 settle** 再关
 * Host；`stop()` 返回 Promise，等 worker 线程退出才 resolve，另带超时兜底。
 * 本门禁把「接线存在 + 顺序正确 + 有超时兜底 + stop() 可等待」逐条钉死。
 *
 * 【用法】node tools/check-host-vm-graceful-stop.mjs [--self-test]
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');

const MAIN = 'hostcore/app/main.js';
const INDEX = 'hostcore/plugins/dshm-vm-bash/lib/index.js';
const VM = 'hostcore/plugins/dshm-vm-bash/lib/vm.js';

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/** 纯静态判据：输入三份源码文本，返回失败原因数组（空数组 = 通过）。 */
function evaluate({ mainSrc, indexSrc, vmSrc }) {
  const fails = [];
  const need = (cond, label) => { if (!cond) fails.push(label); };

  // A. 宿主：读钩子 → 收集 → 等 settle → 才关 Host；且必须有超时兜底
  need(mainSrc.includes('globalThis.__DSHM_HOST_SHUTDOWN_HOOKS__'), 'A1 宿主未读取关机钩子注册表');
  need(mainSrc.includes('hookList = Array.from(hooks)'), 'A2 宿主未把钩子收集成待等待列表');
  need(mainSrc.includes('const HOST_STOP_HOOK_TIMEOUT_MS = 10000;'), 'A3 宿主缺关机钩子总超时常量');
  need(mainSrc.includes('setTimeout(done, HOST_STOP_HOOK_TIMEOUT_MS)'), 'A4 宿主缺超时兜底定时器');
  need(mainSrc.includes('Promise.allSettled(jobs).then(done, done)'), 'A5 宿主没有等待全部钩子 settle');
  need(mainSrc.includes('clearTimeout(guard)') && mainSrc.includes('finishHostStop();'), 'A6 钩子收尾没有关 Host');
  const iHook = mainSrc.indexOf('globalThis.__DSHM_HOST_SHUTDOWN_HOOKS__');
  const iShutdown = mainSrc.indexOf('shutdown.shutdown(0)');
  need(iHook >= 0 && iShutdown > iHook, 'A7 关机钩子必须在 shutdown.shutdown(0) 之前');

  // B. 插件：注册、卸载移除、shutdown() 返回可等待的 Promise
  need(indexSrc.includes('hooks.add(shutdown)'), 'B1 插件未注册 shutdown 钩子');
  need(indexSrc.includes('hooks.delete(shutdown)'), 'B2 插件卸载未移除钩子');
  need(indexSrc.includes('globalThis.__DSHM_HOST_SHUTDOWN_HOOKS__'), 'B3 插件未使用同一注册表');
  need(/export function shutdown\(\)\s*\{\s*return stop\(\);\s*\}/.test(indexSrc), 'B4 shutdown() 未返回 stop() 的 Promise');

  // C. VM：stop() 可等待、发 quit、等 worker 退出、无 VM 立即返回、有超时
  need(vmSrc.includes('export const VM_STOP_GRACE_MS = 8000;'), 'C1 缺 VM 关机等待上限常量');
  need(vmSrc.includes('if (worker === null && socket === null) return Promise.resolve();'), 'C2 无 VM 时 stop() 未立即 resolve');
  need(vmSrc.includes('stopping = new Promise(') && vmSrc.includes('return stopping;'), 'C3 stop() 未返回共享Promise');
  need(vmSrc.includes("worker.once('exit', finish)"), 'C4 stop() 未等 QEMU worker 线程退出');
  need(vmSrc.includes("execute: 'qmp_capabilities'") && vmSrc.includes("execute: 'quit'"), 'C5 stop() 未发 QMP quit');
  need(!vmSrc.includes("qmp.on('close', finish)") && !vmSrc.includes("qmp.on('end', finish)") && vmSrc.includes("qmp.on('error'"), 'C6 QMP不能冒充worker退出');
  need(vmSrc.includes('}, VM_STOP_GRACE_MS)') && vmSrc.includes('worker exit unconfirmed'), 'C7 stop() 缺未确认退出的超时兜底');

  return fails;
}

function sources() {
  return { mainSrc: read(MAIN), indexSrc: read(INDEX), vmSrc: read(VM) };
}

if (SELF_TEST) {
  const base = sources();
  const clean = evaluate(base);
  if (clean.length > 0) {
    console.error('FAIL：未变异的源码就没过判据：' + clean.join('；'));
    process.exit(1);
  }
  const without = (text, token) => text.split(token).join('');
  const mutations = [
    ['M1 删宿主注册表', (s) => ({ ...s, mainSrc: without(s.mainSrc, 'globalThis.__DSHM_HOST_SHUTDOWN_HOOKS__') })],
    ['M2 删钩子收集', (s) => ({ ...s, mainSrc: without(s.mainSrc, 'hookList = Array.from(hooks);') })],
    ['M3 删总超时常量', (s) => ({ ...s, mainSrc: without(s.mainSrc, 'const HOST_STOP_HOOK_TIMEOUT_MS = 10000;') })],
    ['M4 删等待钩子', (s) => ({ ...s, mainSrc: without(s.mainSrc, 'Promise.allSettled(jobs).then(done, done);') })],
    ['M5 钩子挪到关 Host 之后', (s) => ({ ...s, mainSrc: without(s.mainSrc, 'globalThis.__DSHM_HOST_SHUTDOWN_HOOKS__') + '\nconst __late = globalThis.__DSHM_HOST_SHUTDOWN_HOOKS__;\n' })],
    ['M6 插件不注册', (s) => ({ ...s, indexSrc: without(s.indexSrc, 'hooks.add(shutdown);') })],
    ['M7 shutdown 不返回 Promise', (s) => ({ ...s, indexSrc: s.indexSrc.replace('return stop();', 'stop();') })],
    ['M8 stop 不返回 Promise', (s) => ({ ...s, vmSrc: without(s.vmSrc, 'return stopping;') })],
    ['M9 不等 worker 退出', (s) => ({ ...s, vmSrc: without(s.vmSrc, "worker.once('exit', finish);") })],
    ['M10 不发 quit', (s) => ({ ...s, vmSrc: s.vmSrc.replace("execute: 'quit'", "execute: 'query-status'") })],
    ['M11 删 VM 超时', (s) => ({ ...s, vmSrc: without(s.vmSrc, '}, VM_STOP_GRACE_MS)') })],
    ['M13 QMP greeting关闭提前结束', (s) => ({ ...s, vmSrc: s.vmSrc + "\nqmp.on('close', finish)" })],
    ['M12 删无 VM 早退', (s) => ({ ...s, vmSrc: without(s.vmSrc, 'if (worker === null && socket === null) return Promise.resolve();') })],
  ];
  let passed = 0;
  for (const [label, mutate] of mutations) {
    const fails = evaluate(mutate(base));
    if (fails.length === 0) {
      console.error(`FAIL：${label} 没有判红`);
      process.exit(1);
    }
    passed += 1;
  }
  console.log(`OK：check-host-vm-graceful-stop --self-test ${passed}/${mutations.length} 个变异体全部判红`);
  process.exit(0);
}

const fails = evaluate(sources());

// 真跑：没有 VM 时 stop() 必须返回 thenable 且立即 resolve（否则宿主会被拖到超时）。
const url = new URL(`file:///${join(ROOT, VM).split('\\').join('/')}`).href;
const vm = await import(url);
const job = vm.stop();
if (!job || typeof job.then !== 'function') {
  fails.push('D1 真跑：stop() 没有返回 Promise');
} else {
  let timer = null;
  const outcome = await Promise.race([
    Promise.resolve(job).then(() => 'resolved', () => 'rejected'),
    new Promise((r) => { timer = setTimeout(() => r('timeout'), 2000); }),
  ]);
  clearTimeout(timer);
  if (outcome !== 'resolved') {
    fails.push(`D2 真跑：无 VM 时 stop() 未在 2 s 内 resolve（${outcome}）`);
  }
}

if (fails.length > 0) {
  console.error('FAIL：' + fails.join('；'));
  process.exit(1);
}
console.log('OK：宿主关机钩子接线 / 顺序 / 超时兜底 / stop() 可等待（含真跑）');
