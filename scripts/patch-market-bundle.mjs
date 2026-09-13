#!/usr/bin/env node
/**
 * DSHM：把 dshmarket（插件市场）内置进 DSH 环境树。
 *
 * 为什么需要本脚本（而不是只改 prepare-dsh-env.sh）：
 *   本机没有 WSL/bash，跑不了完整的 prepare-dsh-env.sh 重建；而环境树
 *   （entry/src/main/resources/rawfile/dsh）是现成产物，需要能就地打补丁。
 *   本脚本同时被 prepare-dsh-env.sh 引用，保证重建时也能复现同样结果。
 *
 * 做三件事（对齐 dsh-OHDSH 的做法）：
 *   1. 用 `npm pack` + tar 解压把 dshmarket 落进 node_modules/dshmarket。
 *      为什么不用 `npm install`：它的 peer 声明与当前 dsh 0.1.5-rc.1 的 peer 树
 *      不匹配，npm 会拒绝；加 --legacy-peer-deps 又会在同一棵树里剪掉其余 peer，
 *      导致 dsh 启动 ERR_MODULE_NOT_FOUND。`npm pack` 不参与依赖解析，安全。
 *   2. 把 dshmarket 写进 `@deepseek-ai/dsh` 的 dependencies 闭包，这样
 *      dsh-app-boot 复制依赖闭包时会把它带进 profiles/node_modules。
 *   3. 把 dshmarket 加进 `@deepseek-ai/dsh-app-boot` 的 web profile 模板 bundle
 *      列表，新建 profile 自动启用插件市场（已有 profile 由壳侧补写）。
 *
 * 用法: node scripts/patch-market-bundle.mjs <env-root> [version]
 *   例: node scripts/patch-market-bundle.mjs entry/src/main/resources/rawfile/dsh latest
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ENV_ROOT = process.argv[2];
if (ENV_ROOT === undefined || ENV_ROOT.length === 0) {
  console.error('用法: node scripts/patch-market-bundle.mjs <env-root> [version]');
  process.exit(1);
}
const REQUESTED = process.argv[3] ?? process.env.DSH_MARKET_VERSION ?? 'latest';
const NM = join(ENV_ROOT, 'node_modules');
const MARKET_DIR = join(NM, 'dshmarket');
const DSH_MANIFEST = join(NM, '@deepseek-ai', 'dsh', 'package.json');
const APP_BOOT_ENTRY = join(NM, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');

/** 就地解压 tar.gz（Windows 自带 tar.exe；失败则明确报错而不是静默跳过）。 */
function extract(tarball, destination) {
  const tarPath = existsSync('C:\\Windows\\System32\\tar.exe')
    ? 'C:\\Windows\\System32\\tar.exe'
    : 'tar';
  execFileSync(tarPath, ['-xzf', tarball, '-C', destination, '--strip-components=1'], { stdio: 'inherit' });
}

/** 落包：目录缺失或版本不符时重新拉取。 */
function ensureMarketPackage() {
  const manifestPath = join(MARKET_DIR, 'package.json');
  let installed;
  if (existsSync(manifestPath)) {
    try { installed = JSON.parse(readFileSync(manifestPath, 'utf8')).version; } catch { installed = undefined; }
  }
  if (installed !== undefined && REQUESTED !== 'latest') {
    console.log(`dshmarket: 已存在 v${installed}（请求 ${REQUESTED}）`);
    return installed;
  }
  if (installed !== undefined && REQUESTED === 'latest') {
    console.log(`dshmarket: 已存在 v${installed}（latest 已在树中；如需升级请显式传版本号）`);
    return installed;
  }
  console.log(`dshmarket: 拉取 ${REQUESTED} …`);
  mkdirSync(MARKET_DIR, { recursive: true });
  execFileSync('npm', ['pack', `dshmarket@${REQUESTED}`, '--pack-destination', MARKET_DIR], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  const tgz = readdirSync(MARKET_DIR).find((name) => name.startsWith('dshmarket-') && name.endsWith('.tgz'));
  if (tgz === undefined) {
    throw new Error('npm pack 未产出 dshmarket tarball');
  }
  extract(join(MARKET_DIR, tgz), MARKET_DIR);
  rmSync(join(MARKET_DIR, tgz), { force: true });
  const version = JSON.parse(readFileSync(join(MARKET_DIR, 'package.json'), 'utf8')).version;
  console.log(`dshmarket: 已落包 v${version}`);
  return version;
}

/** 校验市场包的关键入口（缺任意一个都会让市场或插件安装失效）。 */
function verifyMarketPackage() {
  const required = ['lib/index.js', 'lib/dsh-cli.js', 'cordis.patch.yml', 'package.json'];
  for (const relative of required) {
    if (!existsSync(join(MARKET_DIR, relative))) {
      throw new Error(`dshmarket 缺少 ${relative}`);
    }
  }
  console.log('dshmarket: 入口校验通过（lib/index.js、lib/dsh-cli.js、cordis.patch.yml）');
}

/** 写进 dsh 依赖闭包（dsh-app-boot 据此把包复制到 profiles/node_modules）。 */
function patchDshDependency(version) {
  const manifest = JSON.parse(readFileSync(DSH_MANIFEST, 'utf8'));
  manifest.dependencies = manifest.dependencies ?? {};
  if (manifest.dependencies.dshmarket === version) {
    console.log(`dsh: dshmarket 已在依赖闭包（${version}）`);
    return;
  }
  manifest.dependencies.dshmarket = version;
  writeFileSync(DSH_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`dsh: 已把 dshmarket@${version} 写入依赖闭包`);
}

/** web profile 模板加入 dshmarket（新 profile 首次初始化即启用插件市场）。 */
function patchProfileTemplate() {
  if (!existsSync(APP_BOOT_ENTRY)) {
    console.log('dsh-app-boot: 未找到入口，跳过模板补丁');
    return;
  }
  let text = readFileSync(APP_BOOT_ENTRY, 'utf8');
  // 只按 web 模板 bundles 列表判重：整个文件里还有别的 dshmarket 字样
  // （例如 profile-managed seed 的注释与判断），用整文件 includes 会误判为已打过。
  const before = '"dshm-terminal", "dshm-ohos-settings" ]';
  const after = '"dshm-terminal", "dshm-ohos-settings", "dshmarket" ]';
  if (text.includes(after)) {
    console.log('dsh-app-boot: web 模板已包含 dshmarket');
    return;
  }
  if (!text.includes(before)) {
    console.log('dsh-app-boot: 未匹配到预期的 web 模板结构，跳过（已有 profile 由壳侧补写）');
    return;
  }
  text = text.replace(before, after);
  writeFileSync(APP_BOOT_ENTRY, text);
  console.log('dsh-app-boot: web 模板已加入 dshmarket');
}

const version = ensureMarketPackage();
verifyMarketPackage();
patchDshDependency(version);
patchProfileTemplate();
console.log(`✅ dshmarket 内置完成（v${version}）`);
