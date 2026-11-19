#!/usr/bin/env node
/**
 * 门禁：正式包与 Beta 的本地 Host 端口必须隔离。
 *
 * 2026-10-26 真机事故：正式包 `com.dshm.dshclient` 在 127.0.0.1:3120 正常监听时，
 * 侧载的 `com.dshm.dshmbeta` 启动 Host 仍尝试绑定 3120，报 EADDRINUSE，
 * `webserver` 必需插件无法激活，最终不写本次 host-ready.json。
 *
 * 判据：
 *   ① 正式包保持历史端口 3120；
 *   ② Beta 显式固定 3121，不参与哈希或回落到正式端口；
 *   ③ 运行期优先从 UIAbilityContext 取 Beta 包名，bundleManager 只作兜底；
 *   ④ RuntimePort 的正式默认口仍为 3120；
 *   ⑤ 浏览器桥随 Host 端口同步偏移：正式 19390 / Beta 19391。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NODE_RUNTIME = join(ROOT, 'hostruntime/src/main/ets/runtime/NodeRuntime.ets');
const RUNTIME_PORT = join(ROOT, 'hostruntime/src/main/ets/runtime/RuntimePort.ets');

function inspect(nodeRuntime, runtimePort) {
  const fails = [];
  const check = (condition, label) => {
    if (!condition) fails.push(label);
  };

  check(runtimePort.includes('export const HOST_DEFAULT_PORT: number = 3120;'),
    '正式包默认端口必须保持 3120');
  check(runtimePort.includes('export const BROWSER_BRIDGE_DEFAULT_PORT: number = 19390;'),
    '正式包浏览器桥默认端口必须保持 19390');
  check(runtimePort.includes(
    '`DSHM_BROWSER_PORT=${BROWSER_BRIDGE_DEFAULT_PORT + (port - HOST_DEFAULT_PORT)}`'),
  '浏览器桥端口必须随 Host 端口同步隔离');
  check(nodeRuntime.includes("const PROD_BUNDLE_NAME: string = 'com.dshm.dshclient';"),
    '正式包 bundle 常量存在');
  check(nodeRuntime.includes("const BETA_BUNDLE_NAME: string = 'com.dshm.dshmbeta';"),
    'Beta bundle 常量存在');
  check(nodeRuntime.includes('const BETA_HOST_PORT: number = 3121;'),
    'Beta 固定端口必须是 3121');
  const hostDefault = Number(/HOST_DEFAULT_PORT: number = (\d+)/.exec(runtimePort)?.[1] ?? NaN);
  const browserDefault = Number(
    /BROWSER_BRIDGE_DEFAULT_PORT: number = (\d+)/.exec(runtimePort)?.[1] ?? NaN);
  const betaHost = Number(/BETA_HOST_PORT: number = (\d+)/.exec(nodeRuntime)?.[1] ?? NaN);
  check(browserDefault + (betaHost - hostDefault) === 19391,
    `Beta 浏览器桥计算结果必须为 19391（实际 ${browserDefault + (betaHost - hostDefault)}）`);

  const betaBranch = nodeRuntime.match(
    /if \(bundle === BETA_BUNDLE_NAME\) \{\s*return BETA_HOST_PORT;\s*\}/);
  check(betaBranch !== null, 'Beta 必须在通用/默认分支之前显式返回 3121');

  const contextFallback = nodeRuntime.match(
    /const contextBundle: string = abilityContext === undefined[\s\S]{0,180}?abilityContext\.applicationInfo\.name;[\s\S]{0,240}?this\.bundleName = contextBundle\.length > 0 \? contextBundle : readBundleName\(\);/);
  check(contextFallback !== null,
    '包名必须优先取 UIAbilityContext.applicationInfo.name，并回退 bundleManager');

  check(!/if \(bundle\.length === 0 \|\| bundle === PROD_BUNDLE_NAME\) \{\s*return BETA_HOST_PORT;/.test(nodeRuntime),
    '空包名不能走 Beta 端口，避免正式包误分配');
  return fails;
}

const nodeRuntime = readFileSync(NODE_RUNTIME, 'utf8');
const runtimePort = readFileSync(RUNTIME_PORT, 'utf8');
const fails = inspect(nodeRuntime, runtimePort);
console.log('== 正例：当前源码 ==');
console.log(`  ${fails.length === 0 ? 'PASS' : 'FAIL'}（${fails.length} 条失败）`);
for (const fail of fails) console.log(`  ✗ ${fail}`);

const arms = [
  ['正式端口改成 3121', (node, port) => ({
    node,
    port: port.replace('HOST_DEFAULT_PORT: number = 3120', 'HOST_DEFAULT_PORT: number = 3121'),
  })],
  ['Beta 端口改成 3120', (node, port) => ({
    node: node.replace('BETA_HOST_PORT: number = 3121', 'BETA_HOST_PORT: number = 3120'),
    port,
  })],
  ['删掉 Beta 显式分支', (node, port) => ({
    node: node.replace(
      /\s+if \(bundle === BETA_BUNDLE_NAME\) \{\s*return BETA_HOST_PORT;\s*\}\s+/,
      ''),
    port,
  })],
  ['去掉 UIAbilityContext 包名兜底', (node, port) => ({
    node: node.replace(
      /const contextBundle: string = abilityContext === undefined[\s\S]{0,500}?this\.bundleName = contextBundle\.length > 0 \? contextBundle : readBundleName\(\);/,
      'this.bundleName = readBundleName();'),
    port,
  })],
  ['去掉浏览器桥端口隔离', (node, port) => ({
    node,
    port: port.replace(
      '`DSHM_BROWSER_PORT=${BROWSER_BRIDGE_DEFAULT_PORT + (port - HOST_DEFAULT_PORT)}`,',
      '`DSHM_BROWSER_PORT=19390`,'),
  })],
];

let armsOk = true;
console.log('\n== 对照臂：每条变异都必须判红 ==');
for (const [label, mutate] of arms) {
  const changed = mutate(nodeRuntime, runtimePort);
  const changedText = changed.node !== nodeRuntime || changed.port !== runtimePort;
  const armFails = changedText ? inspect(changed.node, changed.port) : [];
  const red = changedText && armFails.length > 0;
  if (!red) armsOk = false;
  console.log(`  ${red ? 'PASS' : 'FAIL'}  ${label}${changedText ? `（fail=${armFails.length}）` : '（变异没生效）'}`);
}

const rc = fails.length === 0 && armsOk ? 0 : 1;
console.log(`\nRESULT: ${rc === 0 ? 'PASS' : 'FAIL'}`);
process.exit(rc);
