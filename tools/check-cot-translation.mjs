#!/usr/bin/env node
/**
 * 官方“思考过程翻译”接线门禁。
 *
 * 为什么需要它：`dsh` 核心随依赖闭包携带了
 * `@deepseek-ai/dsh-experimental-cot-translation-bundle`，但它是可选 bundle。
 * 不把包名写进端侧 `dsh.profile.bundles` 时，Host 的 `translator` 服务和浏览器的
 * “翻译/原文”切换都不会挂载——UI 看起来像功能存在，实际永远不生效。
 *
 * 判据：
 *   A profile 显式启用官方 CoT 翻译 bundle；
 *   B bundle 位于 base / web-app 之后，保持依赖拓扑顺序；
 *   C core inventory 也扫描这条 bundle，插件清单不会漏报 translator/cot-translation；
 *   D 若当前核心 zip 存在，bundle patch 必须同时插入 translator 与 cot-translation，
 *     默认使用无需密钥的 Bing，目标语言跟随 UI。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = join(ROOT, 'hostcore/profile/ondevice/package.json');
const INVENTORY = join(ROOT, 'tools/lib/core-inventory.mjs');
const RECIPE = JSON.parse(readFileSync(join(ROOT, 'hostcore/core-recipe.json'), 'utf8'));
const BUNDLE = '@deepseek-ai/dsh-experimental-cot-translation-bundle';

function inspect(files) {
  const fails = [];
  const ok = (cond, label) => { if (!cond) fails.push(label); };
  const profile = JSON.parse(files.profile);
  const bundles = profile?.dsh?.profile?.bundles;
  ok(Array.isArray(bundles), 'profile 有 dsh.profile.bundles');
  const list = Array.isArray(bundles) ? bundles : [];
  /*
   * ⚠️ 2026-10-31 判据反转（docs/331，用户口径）：
   * 「官方插件里面的思考过程翻译一直是启用的，默认都是关闭，不要给用户预设这些个性化设置」。
   *
   * 旧判据要求"profile 必须启用它"，于是它被塞进 `dsh.profile.bundles` ⇒
   * 每个用户一装就有翻译控件。现在它属于**可选插件**：
   *   · 默认 bundles 里**不得**出现它（不给用户预设）；
   *   · 且必须列进 `removeBundles` —— 设备 profile 是"种子 ∪ 设备已有"的并集，
   *     只在种子里删掉的话，**已经装过它的设备仍会继续启用**。
   * 用户想用时仍可在「设置 → 插件 → 更多」里自己打开（市场里它是 MORE_BUNDLES 之一）。
   */
  const removed = Array.isArray(profile?.dsh?.profile?.removeBundles)
    ? profile.dsh.profile.removeBundles : [];
  ok(!list.includes(BUNDLE), `profile 默认**不**启用 ${BUNDLE}（不预设个性化设置）`);
  ok(removed.includes(BUNDLE), `removeBundles 含 ${BUNDLE}（已装过它的设备也会被关掉）`);
  ok(files.inventory.includes(`'${BUNDLE}'`) && files.inventory.includes('export const BUNDLES'),
    'core inventory 扫描 CoT 翻译 bundle');
  return fails;
}

const files = {
  profile: readFileSync(PROFILE, 'utf8'),
  inventory: readFileSync(INVENTORY, 'utf8'),
};
const fails = inspect(files);

const zip = join(ROOT, 'dist/core',
  `dsh-core-${RECIPE.coreVersion}-openharmony-arm64.zip`);
if (existsSync(zip)) {
  const patchPath = `dsh-core-${RECIPE.coreVersion}/node_modules/${BUNDLE}/cordis.patch.yml`;
  try {
    const patch = execFileSync('unzip', ['-p', zip, patchPath], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    if (!patch.includes('- id: translator')) fails.push('bundle patch 未插入 translator');
    if (!patch.includes('- id: cot-translation')) fails.push('bundle patch 未插入 cot-translation');
    if (!patch.includes('provider: bing')) fails.push('CoT 翻译默认 provider 不是 bing');
    if (!patch.includes('targetLanguage: auto')) fails.push('CoT 翻译未跟随 UI 语言');
  } catch (error) {
    fails.push(`无法读取当前核心中的 CoT bundle patch：${error.message}`);
  }
}

const selfTest = process.argv.includes('--self-test');
if (selfTest) {
  const mutations = [
    /* docs/331 判据反转后，"加回默认 bundles"才是要抓的错（那等于给用户预设） */
    ['把 bundle 塞回默认 profile bundles（应判红）', (f) => {
      const j = JSON.parse(f.profile);
      j.dsh.profile.bundles = [...j.dsh.profile.bundles, BUNDLE];
      f.profile = JSON.stringify(j);
    }],
    ['从 removeBundles 里删掉它（老设备不会被关掉，应判红）', (f) => {
      const j = JSON.parse(f.profile);
      j.dsh.profile.removeBundles = (j.dsh.profile.removeBundles ?? []).filter((b) => b !== BUNDLE);
      f.profile = JSON.stringify(j);
    }],
    ['inventory 不再扫描 bundle', (f) => { f.inventory = f.inventory.replace(`'${BUNDLE}'`, "'missing-bundle'"); }],
  ];
  let armFail = 0;
  for (const [name, mutate] of mutations) {
    const copy = { ...files };
    mutate(copy);
    const got = inspect(copy);
    const red = got.length > 0;
    console.log(`  ${red ? 'PASS' : 'FAIL'}  ${name}（fail=${got.length}）`);
    if (!red) armFail += 1;
  }
  process.exit(fails.length === 0 && armFail === 0 ? 0 : 1);
}

if (fails.length === 0) {
  console.log(`PASS  官方思考过程翻译**默认关闭**、可由插件市场开启（${BUNDLE}，核心 ${RECIPE.coreVersion}）`);
  process.exit(0);
}
console.error('FAIL  官方思考过程翻译接线不完整');
for (const failure of fails) console.error(`  - ${failure}`);
process.exit(1);
