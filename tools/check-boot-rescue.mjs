#!/usr/bin/env node
/**
 * 门禁：随包内置的「启动救援」插件（dshm-boot-rescue）必须真的会被加载。
 *
 * 【为什么需要】它救的正是「插件把 Web UI 打成 Failed to load plugins」这种故障：
 * 一旦它没被装进核心树、或 profile 种子少了 insert 行，用户仍会掉回
 * 「只能卸载重装」的老路，而正常启动完全看不出差异 —— 属于典型的"平时全绿、
 * 出事才失效"的保险丝，必须用门禁钉住。
 *
 * 判定：
 *   ① 源码包名必须是 @deepseek-ai/dshm-boot-rescue（pack-core 只落 scope 内的 dshm-*）；
 *   ② 入口 lib/index.js 与注入脚本 lib/rescue-client.js 都在，且 Node 语法可解析；
 *   ③ 插件不声明 static inject（缺服务会 pending，那正是它要救的故障模式）；
 *   ④ pack-core 的 DSHM_PLUGIN_PACKAGES 含本项（否则不会进核心树）；
 *   ⑤ profile 种子 `hostcore/profile/ondevice/cordis.patch.yml` 有默认启用的 insert 行；
 *   ⑥ 注入走 webServer.tapIndex（失败页仍能执行），且自身不依赖 client 半身。
 *
 * 只读仓库内文件，不需要核心树、不需要设备。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PLUGIN = join(ROOT, 'hostcore', 'plugins', 'dshm-boot-rescue');
const PROFILE = join(ROOT, 'hostcore', 'profile', 'ondevice', 'cordis.patch.yml');
const PACK_CORE = join(ROOT, 'tools', 'pack-core.mjs');

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass += 1; console.log('  PASS  ' + msg); }
  else { fail += 1; console.log('  FAIL  ' + msg); }
};

console.log('# 启动救援插件（内置核心树 + profile 默认启用 + 失败页注入）');

const manifestPath = join(PLUGIN, 'package.json');
ok(existsSync(manifestPath), '插件 manifest 存在');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
ok(manifest.name === '@deepseek-ai/dshm-boot-rescue',
  '包名是 @deepseek-ai/dshm-boot-rescue（pack-core 只落 scope 内 dshm-*）');
ok(manifest.type === 'module' && manifest.main === 'lib/index.js', 'ESM 入口指向 lib/index.js');
ok(manifest.exports?.['.']?.default === './lib/index.js', 'exports 默认入口与 main 一致');

const entryPath = join(PLUGIN, 'lib', 'index.js');
const clientPath = join(PLUGIN, 'lib', 'rescue-client.js');
ok(existsSync(entryPath), '宿主入口 lib/index.js 存在');
ok(existsSync(clientPath), '失败页注入脚本 lib/rescue-client.js 存在');

const entry = existsSync(entryPath) ? readFileSync(entryPath, 'utf8') : '';
ok(/export function apply\s*\(/.test(entry), '导出 cordis apply()');
ok(!/export const inject|export\s*{[^}]*\binject\b/.test(entry),
  '不声明 static inject（缺服务时不会 pending，才能救失败页）');
ok(entry.includes('tapIndex') && entry.includes('rescue-client'),
  '通过 webServer.tapIndex 注入救援脚本');
ok(entry.includes('node:fs') && !entry.includes('node:child_process'),
  '只用 Node 内置模块且不创建子进程（端侧 --jitless / 禁 execve）');

const packCore = readFileSync(PACK_CORE, 'utf8');
ok(packCore.includes("{ name: '@deepseek-ai/dshm-boot-rescue', dir: 'dshm-boot-rescue' }"),
  'pack-core 的 DSHM_PLUGIN_PACKAGES 含本插件（会落进核心树）');

const profile = readFileSync(PROFILE, 'utf8');
const hasBuiltin = (text) => /- insert:\s*\n\s*- id: dshm-boot-rescue-builtin\s*\n\s*name: '@deepseek-ai\/dshm-boot-rescue'/.test(text);
ok(hasBuiltin(profile), 'profile 种子默认启用（独立 builtin id，外部同名插件不冲突）');
if (process.argv.includes('--self-test')) {
  ok(!hasBuiltin(profile.replace('id: dshm-boot-rescue-builtin', 'id: dshm-boot-rescue')), '负控制：复活外部同名 id 必须拒绝');
  ok(!hasBuiltin(profile.replace("name: '@deepseek-ai/dshm-boot-rescue'", "name: '@deepseek-ai/wrong'")), '负控制：错包必须拒绝');
}

const bundlePatch = join(PLUGIN, 'cordis.patch.yml');
ok(existsSync(bundlePatch)
  && readFileSync(bundlePatch, 'utf8').includes("name: '@deepseek-ai/dshm-boot-rescue'"),
  'bundle patch 的行名与包名一致（市场重装同一份包）');

console.log(fail === 0 ? `PASS ${pass} / 0` : `FAIL ${fail}（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
