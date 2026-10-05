#!/usr/bin/env node
/**
 * 门禁：**PTC 运行时的"换实现"接线必须真的接上**（profile ↔ 打包清单 ↔ 源码树 三处一致）
 *
 * ---------------------------------------------------------------------------
 * 为什么要有它（这不是形式主义，是真机排障给出的两条假设）
 * ---------------------------------------------------------------------------
 * 2026-10-05 端侧报告把"盘上改了实现、重启后错误逐字不变"的排障空间列成 H1–H5，其中
 *   · H1 配置未真正生效：官方 `ptc-runtime` 行仍为主导，或两条并存；
 *   · H2 路径未解析：`insert` 的包名在树里不存在。
 * 而 dsh 的补丁机制对这两种情况**都只 warn 不报错**：
 *   · `applyEntryPatches`（`dsh-app-boot/lib/index.js:61-108`）查不到 id 时
 *     `warn("patch: entry %C not found")` 然后**静默跳过**；
 *   · 我们自己那条 `insert` 若包名解析不到，Loader 只会记一条 activation failure，
 *     `ctx.ptcRuntime` 缺失 ⇒ 表现为"PTC 模式照旧不可用"，**与没改一样**。
 * 本门禁把这三处的一致性钉死，让"改了没生效"在**仓库层**就红：
 *   ① profile 里官方行确实被停用、且 `insert` 的正是我们的实现；
 *   ② 我们的包名确实在 `tools/pack-core.mjs` 的 `DSHM_PLUGIN_PACKAGES` 清单里，
 *      且源码目录/入口/manifest 包名三处自洽（pack-core 会按它拷进核心树）；
 *   ③ profile 里那条**被停用的 id** 在核心树里真的存在（上游若改名，这里必须红，
 *      而不是让补丁变成一句无声的 warn）。
 *
 * 用法：node tools/check-ptc-wiring.mjs [--verbose]
 * 退出码：0 通过 / 1 失败 / 3 环境不具备（核心树或 profile 未就位）
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');

const PLUGIN_NAME = '@deepseek-ai/dshm-ptc-runtime-inproc';
const PLUGIN_DIR = 'dshm-ptc-runtime-inproc';
const OFFICIAL_ROW_ID = 'ptc-runtime';
const PROFILE = join(ROOT, 'hostcore', 'profile', 'ondevice', 'cordis.patch.yml');
const PACK_CORE = join(ROOT, 'tools', 'pack-core.mjs');
const RECIPE = join(ROOT, 'hostcore', 'core-recipe.json');

const failures = [];
const notes = [];
const ok = (msg) => notes.push(`ok    ${msg}`);
const bad = (msg) => failures.push(msg);
const vlog = (msg) => { if (VERBOSE) console.log(`      ${msg}`); };

/* ── 环境前置 ── */
for (const p of [PROFILE, PACK_CORE, RECIPE]) {
  if (!existsSync(p)) {
    console.error(`环境不具备：缺 ${p}`);
    process.exit(3);
  }
}
const recipe = JSON.parse(readFileSync(RECIPE, 'utf8'));
const CORE_DIR = join(ROOT, 'dist', 'core', 'work', `dsh-core-${recipe.coreVersion}`);
const YAML_PATH = join(CORE_DIR, 'node_modules', 'yaml');
if (!existsSync(YAML_PATH) || !existsSync(CORE_DIR)) {
  console.error(`环境不具备：核心树未就位（${CORE_DIR}）`);
  process.exit(3);
}
const YAML = require(YAML_PATH);

/* ── ① profile：官方行停用 + insert 我们的实现 ── */
const profileText = readFileSync(PROFILE, 'utf8');
let profile;
try {
  profile = YAML.parse(profileText);
} catch (e) {
  bad(`profile 不是合法 YAML：${e.message}`);
  profile = [];
}
if (!Array.isArray(profile)) {
  bad('profile 顶层不是数组（期望 patch 列表）');
} else {
  const disabledOfficial = profile.some((e) => e && e.id === OFFICIAL_ROW_ID && e.disabled === true);
  const insertedNames = profile
    .filter((e) => e && Array.isArray(e.insert))
    .flatMap((e) => e.insert)
    .map((e) => e && e.name)
    .filter(Boolean);
  const switchPatch = profile.filter((e) => e && e.name === PLUGIN_NAME);
  if (disabledOfficial) ok(`profile 停用了官方行 \`${OFFICIAL_ROW_ID}\``);
  else bad(`profile 没有停用官方行 \`${OFFICIAL_ROW_ID}\` —— 官方实现仍在，换实现不会生效（H1）`);
  if (insertedNames.includes(PLUGIN_NAME)) ok(`profile insert 了 ${PLUGIN_NAME}`);
  else bad(`profile 的 insert 里没有 ${PLUGIN_NAME}（H1：新实现根本没被加载）`);
  if (switchPatch.length > 0) {
    // applyEntryPatches 的普通 patch 行只按键覆盖，name 仅作校验 ⇒ 用 name 换实现是无效写法
    bad(
      `profile 里出现了以 \`name: ${PLUGIN_NAME}\` 的**普通 patch 行** —— `
      + 'applyEntryPatches 不支持用 name 换实现（它只校验），必须改成 disable 官方行 + insert',
    );
  }
}

/* ── ② 打包清单 ↔ 源码目录 ↔ manifest 三处自洽 ── */
const packText = readFileSync(PACK_CORE, 'utf8');
const listBlock = packText.match(/const DSHM_PLUGIN_PACKAGES = \[([\s\S]*?)\n\];/);
if (!listBlock) {
  bad('pack-core.mjs 里找不到 DSHM_PLUGIN_PACKAGES 清单块');
} else {
  const listed = [...listBlock[1].matchAll(/\{\s*name:\s*'([^']+)'\s*,\s*dir:\s*'([^']+)'\s*\}/g)]
    .map((m) => ({ name: m[1], dir: m[2] }));
  const entry = listed.find((p) => p.name === PLUGIN_NAME);
  if (!entry) {
    bad(`DSHM_PLUGIN_PACKAGES 里没有 ${PLUGIN_NAME} ⇒ 打包时不会拷进核心树（H2）`);
  } else {
    ok(`DSHM_PLUGIN_PACKAGES 含 ${PLUGIN_NAME} → hostcore/plugins/${entry.dir}/`);
    if (entry.dir !== PLUGIN_DIR) vlog(`注意：目录名是 ${entry.dir}（门禁里写死的期望是 ${PLUGIN_DIR}）`);
    const srcDir = join(ROOT, 'hostcore', 'plugins', entry.dir);
    const manifestPath = join(srcDir, 'package.json');
    const entryPath = join(srcDir, 'lib', 'index.js');
    if (existsSync(manifestPath)) {
      let manifest = null;
      try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch (e) { bad(`manifest 不是合法 JSON：${e.message}`); }
      if (manifest) {
        if (manifest.name === entry.name) ok(`manifest 包名与清单一致（${manifest.name}）`);
        else bad(`manifest 包名 ${manifest.name} 与清单 ${entry.name} 不一致（pack-core 会 die）`);
      }
    } else bad(`缺 manifest：${manifestPath}`);
    if (existsSync(entryPath)) ok(`入口存在：lib/index.js`);
    else bad(`缺入口：${entryPath}（pack-core 会 die）`);
    // 打包副本（若已打包）必须与源码**逐字节一致**。
    // 【为什么这条必须有（2026-10-05 真机事故）】当时的打包恰好发生在插件源码的"变异中间态"
    //   （`Config.timeoutMs` 的 `.default(12e4)` 被临时拿掉），于是设备上
    //   `new DshmPtcRuntime` 抛 `timeoutMs must be positive and finite` ⇒ `ctx.ptcRuntime`
    //   注册失败 ⇒ **PTC 照旧不可用**；而仓库里所有门禁全绿——它们读的都是**源码**。
    //   这条断言把"树里那份 = 源码那份"钉死，让这类问题在 306MB 构建/装机之前就红。
    const packedEntry = join(CORE_DIR, 'node_modules', '@deepseek-ai', entry.dir, 'lib', 'index.js');
    if (existsSync(packedEntry) && existsSync(entryPath)) {
      const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
      if (sha(packedEntry) === sha(entryPath)) {
        ok('核心树里的打包副本与源码逐字节一致（lib/index.js）');
      } else {
        bad(
          `核心树里的 ${entry.dir}/lib/index.js 与源码**不一致** —— 打包很可能发生在编辑中间态；`
          + '重跑 `node tools/pack-core.mjs --skip-install --place-in-app`（真机事故 2026-10-05 的成因）',
        );
      }
    } else {
      vlog('核心树里还没有该插件的打包副本（尚未 pack-core），本次跳过一致性断言');
    }
    // 擦除器与 vendor：本插件的"纯 JS"承诺靠它们，缺失即整条链失效
    const strip = join(srcDir, 'lib', 'ts-strip.cjs');
    const vendor = join(srcDir, 'lib', 'vendor', 'babel-standalone', 'babel.min.cjs');
    if (existsSync(strip)) ok('擦除器存在：lib/ts-strip.cjs');
    else bad(`缺擦除器：${strip}`);
    if (existsSync(vendor)) ok('vendor 存在：lib/vendor/babel-standalone/babel.min.cjs');
    else bad(`缺 vendor 擦除器 bundle：${vendor}`);
  }
}

/* ── ③ 被停用的 id 在核心树里真的存在（上游改名 → 这里红，而不是无声 warn） ── */
const basePatch = join(CORE_DIR, 'node_modules', '@deepseek-ai', 'dsh-base', 'cordis.patch.yml');
if (!existsSync(basePatch)) {
  bad(`核心树里找不到 dsh-base/cordis.patch.yml（${basePatch}）`);
} else {
  const baseText = readFileSync(basePatch, 'utf8');
  const rowRe = new RegExp(`^\\s*-\\s*id:\\s*${OFFICIAL_ROW_ID}\\s*$`, 'm');
  if (rowRe.test(baseText)) {
    ok(`核心树 dsh-base 里确实有 id: ${OFFICIAL_ROW_ID} 这一行（补丁目标存在）`);
  } else {
    bad(
      `核心树 dsh-base 里没有 id: ${OFFICIAL_ROW_ID} —— 上游可能改名/移走了；`
      + '此时 profile 那条 disabled 会被 applyEntryPatches 静默跳过（H1）',
    );
  }
  const officialName = /@deepseek-ai\/dsh-ptc-runtime-node/.test(baseText);
  if (officialName) ok('官方实现仍是 @deepseek-ai/dsh-ptc-runtime-node（替换对象没变）');
  else bad('核心树里找不到 @deepseek-ai/dsh-ptc-runtime-node —— 上游实现可能已换名，请复核本门禁的前提');
}

/* ── 结论 ── */
console.log('════════ PTC 接线门禁（profile ↔ pack-core ↔ 核心树） ════════');
for (const n of notes) console.log(n);
if (failures.length > 0) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\n结论：FAIL（${failures.length} 项）`);
  process.exit(1);
}
console.log(`\n结论：PASS（${notes.length} 项一致）—— PTC 的"换实现"三处接线自洽。`);
