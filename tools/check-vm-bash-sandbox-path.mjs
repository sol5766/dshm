#!/usr/bin/env node
/**
 * 门禁：guest bash 的宿主路径镜像必须取实际 HAP 沙箱。
 *
 * 2026-10-24 手机真机：VM / QGA / guest `/bin/bash` 全部正常，但插件把
 * `run-*.sh` 写在 `haps/phone/files`，guest 里却只给 `haps/entry/files`
 * 建了 `/mnt/share` 链接 ⇒ QGA 执行 `/bin/bash <script>` 时脚本不存在，
 * 每条 bash 工具命令都返回 127。
 *
 * 本门禁同时检查：
 *   ① 纯函数对 entry / phone / tablet 三种真实沙箱路径都原样返回；
 *   ② provision 使用 `guestSandboxFilesPath()`，没有恢复写死的 EL2_FILES；
 *   ③ `--self-test` 的三种变异都会判红。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guestSandboxFilesPath } from '../hostcore/plugins/dshm-vm-bash/lib/vm.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'hostcore/plugins/dshm-vm-bash/lib/vm.js');
const SRC = readFileSync(FILE, 'utf8');

function sourceProblems(src) {
  const fails = [];
  const ok = (condition, label) => { if (!condition) fails.push(label); };
  ok(src.includes('export function guestSandboxFilesPath(env = process.env)'),
    '存在 guestSandboxFilesPath(env)');
  ok(src.includes("const sandbox = String(env.DSHM_SANDBOX_HOME || '').trim();"),
    '唯一真源是 DSHM_SANDBOX_HOME');
  ok(src.includes('const guestFiles = guestSandboxFilesPath();'),
    'provision 读取实际 guest 沙箱路径');
  ok(src.includes('`ln -sfn /mnt/share ${guestFiles}`'),
    '/mnt/share 链接到实际 guest 沙箱路径');
  ok(!src.includes('const EL2_FILES ='),
    '不得恢复写死的 EL2_FILES 常量');
  ok(!src.includes('ln -sfn /mnt/share ${EL2_FILES}'),
    '不得把链接目标重新写回 EL2_FILES');
  return fails;
}

function pathChecks() {
  const cases = [
    ['/data/storage/el2/base/haps/entry/files', 'PC / entry'],
    ['/data/storage/el2/base/haps/phone/files', '手机 / phone'],
    ['/data/storage/el2/base/haps/tablet/files', '平板 / tablet'],
  ];
  const fails = [];
  for (const [sandbox, label] of cases) {
    const got = guestSandboxFilesPath({ DSHM_SANDBOX_HOME: sandbox });
    if (got !== sandbox) fails.push(`${label}: expected=${sandbox} got=${got}`);
  }
  const fallback = guestSandboxFilesPath({});
  if (fallback !== '/data/storage/el2/base/haps/entry/files') {
    fails.push(`空 env 兜底变化：${fallback}`);
  }
  return fails;
}

function run(src) {
  return [...pathChecks(), ...sourceProblems(src)];
}

const fails = run(SRC);
console.log('# VM bash 沙箱路径门禁');
for (const fail of fails) console.log('  FAIL  ' + fail);
console.log(fails.length === 0 ? '  PASS  实际沙箱路径 + provision 接线' : `  FAIL  ${fails.length} 条`);

let rc = fails.length === 0 ? 0 : 1;
if (process.argv.includes('--self-test')) {
  const mutations = [
    ['M1 去掉实际路径读取', (s) => s.replace('  const guestFiles = guestSandboxFilesPath();\n', '')],
    ['M2 链接退回 entry 硬编码', (s) => s.replace(
      '`ln -sfn /mnt/share ${guestFiles}`', "`ln -sfn /mnt/share /data/storage/el2/base/haps/entry/files`")],
    ['M3 恢复 EL2_FILES 常量', (s) => s.replace(
      "export function guestSandboxFilesPath(env = process.env) {",
      "const EL2_FILES = '/data/storage/el2/base/haps/entry/files';\nexport function guestSandboxFilesPath(env = process.env) {")],
  ];
  console.log('\n== 对照臂 ==');
  for (const [name, mutate] of mutations) {
    const mutated = mutate(SRC);
    if (mutated === SRC) {
      console.log(`  FAIL  ${name}（锚点漂移）`);
      rc = 1;
      continue;
    }
    const red = sourceProblems(mutated).length > 0;
    console.log(`  ${red ? 'PASS' : 'FAIL'}  ${name} ⇒ ${red ? 'RED（对）' : 'GREEN（错）'}`);
    if (!red) rc = 1;
  }
}
process.exit(rc);
