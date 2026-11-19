/**
 * Store-readiness guard: the few invariants that must never silently regress.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * This project's distribution constraint is a hard one, stated as a product rule:
 * run dsh on device WITHOUT requesting any privileged/ACL permission, so the app
 * can be listed. Concretely that means:
 *
 *   1. No `ohos.permission.kernel.*` permission - above all
 *      `ALLOW_WRITABLE_CODE_MEMORY`, which V8 needs only if JIT is enabled.
 *      Our whole runtime story (self-built libnode + `--jitless`) exists to avoid it.
 *   2. No XML/manifest declaration of it "just in case": the moment it appears in a
 *      `requestPermissions`/`definePermissions` entry, install on a phone fails with
 *      `grant request permissions failed` and listing is off the table.
 *   3. The app must still claim the form factors the objective names: phone,
 *      foldable/tablet, 2in1.
 *   4. `--jitless` must stay in the host argv: it is the *reason* (1) holds.
 *
 * Every one of those can regress in a one-line commit that builds fine and only
 * fails much later, on a device, at install time. So this guard reads the sources
 * and fails loudly instead.
 *
 * Comments are stripped before scanning, because our sources legitimately *talk
 * about* the forbidden permission (explaining why we do not use it). The guard
 * only cares about real declarations.
 *
 * Usage:  node tools/check-store-readiness.mjs
 * Exit 0 = ready, 1 = a blocking invariant is broken.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
// 2026-09-20 起正式包名为 com.dshm.dshclient（vendor: dshm，与签名配置同批变更）；
// E89 时代红线写的是 com.hnmrxz.hdsh，此处随正式包名同步——红线语义（可上架）不变。
const BUNDLE_NAME = 'com.dshm.dshclient';
const FORBIDDEN = 'ALLOW_WRITABLE_CODE_MEMORY';
const REQUIRED_DEVICE_TYPES = ['phone', 'tablet', '2in1'];
const EXPECTED_DELIVERY_DEVICE_TYPES = new Map([
  /* 【2026-11-08】entry 同时声明 tablet + 2in1：双形态平板（Edge/Pro Max）按 PC 应用分发，
     单形态平板运行时仍判 TABLET。原独立 pc 壳已并入 entry。 */
  ['entry', ['tablet', '2in1']],
  ['phone', ['phone']],
  ['hostruntime', ['phone', 'tablet', '2in1']],
]);
const APPROVED_KERNEL_PERMISSIONS = new Set([
  'ohos.permission.kernel.IGNORE_LIBRARY_VALIDATION',
  'ohos.permission.kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY',
]);

const SKIP_DIRS = new Set([
  'node_modules', 'oh_modules', 'build', 'dist', '.git', '.research', '.hvigor', '.idea',
]);

const failures = [];
const notes = [];

function fail(message) { failures.push(message); }
function note(message) { notes.push(message); }

/** Every file named `name` under root, skipping generated/vendored trees. */
function findFiles(dir, name, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      findFiles(join(dir, entry.name), name, out);
    } else if (entry.name === name) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** Remove block and line comments so a scan sees declarations only. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Parse JSON5 well enough for the few keys we read (BOM + comments + trailing commas). */
function looseJson(text) {
  const cleaned = text
    // 实测：仓库里确实有带 UTF-8 BOM 的 module.json5（JSON.parse 会直接抛）
    .replace(/^\uFEFF/, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(cleaned);
}

// ── 1. bundle name ─────────────────────────────────────────────────────────
const appJsonPath = join(ROOT, 'AppScope', 'app.json5');
if (!existsSync(appJsonPath)) {
  fail('AppScope/app.json5 不存在');
} else {
  const app = looseJson(readFileSync(appJsonPath, 'utf8'));
  const actual = app?.app?.bundleName;
  if (actual !== BUNDLE_NAME) {
    fail(`bundleName 必须是 ${BUNDLE_NAME}，实际是 ${String(actual)}`);
  }
}

// ── 2. no privileged / ACL permission may be requested or defined ──────────
for (const path of findFiles(ROOT, 'module.json5').concat(findFiles(ROOT, 'app.json5'))) {
  const raw = readFileSync(path, 'utf8');
  const code = stripComments(raw);
  const rel = relative(ROOT, path).replaceAll('\\', '/');
  if (code.includes(FORBIDDEN)) {
    fail(`${rel}: 在**声明**里出现了 ${FORBIDDEN}（注释里提到是可以的，声明里绝对不行）`);
  }
  for (const match of code.matchAll(/"(ohos\.permission\.kernel\.[A-Z_]+)"/g)) {
    if (!APPROVED_KERNEL_PERMISSIONS.has(match[1])) {
      fail(`${rel}: 申请了未批准的内核权限 ${match[1]}`);
    }
  }
  // `definePermissions` is how a HAR smuggles the restricted permission into its host
  if (/"definePermissions"\s*:\s*\[/.test(code) && /kernel\./.test(code)) {
    fail(`${rel}: definePermissions 里出现了 kernel.* 权限`);
  }
}

// ── 3. delivery modules must cover the intended AGC device surface ─────────
const profilePath = join(ROOT, 'build-profile.json5');
if (!existsSync(profilePath)) {
  fail('build-profile.json5 不存在');
} else {
  const profile = looseJson(readFileSync(profilePath, 'utf8'));
  const modules = profile?.modules ?? [];
  const byName = new Map(modules.map((mod) => [String(mod.name ?? ''), mod]));
  const seenTypes = new Set();
  for (const [name, expected] of EXPECTED_DELIVERY_DEVICE_TYPES) {
    const mod = byName.get(name);
    if (mod === undefined) {
      fail(`build-profile.json5 缺少交付模块 ${name}`);
      continue;
    }
    const srcPath = String(mod.srcPath ?? '').replace(/^\.\//, '');
    const moduleJson = join(ROOT, srcPath, 'src', 'main', 'module.json5');
    if (!existsSync(moduleJson)) {
      fail(`模块 ${name} 的 module.json5 不存在（${relative(ROOT, moduleJson)}）`);
      continue;
    }
    const json = looseJson(readFileSync(moduleJson, 'utf8'));
    const types = json?.module?.deviceTypes ?? [];
    for (const type of types) seenTypes.add(type);
    if (JSON.stringify(types) !== JSON.stringify(expected)) {
      fail(`模块 ${name} 的 deviceTypes=${JSON.stringify(types)}，期望 ${JSON.stringify(expected)}`);
    }
  }
  const missingDevices = REQUIRED_DEVICE_TYPES.filter((type) => !seenTypes.has(type));
  if (missingDevices.length > 0) {
    fail(`交付模块合计缺少设备类型 ${missingDevices.join('/')}`);
  }
  for (const mod of modules) {
    const srcPath = String(mod.srcPath ?? '');
    if (/\b(?:web_engine|electron)\b/i.test(`${String(mod.name ?? '')} ${srcPath}`)) {
      fail(`build-profile.json5 里仍有阶段一遗留模块 ${String(mod.name)}（${srcPath}）：那条通道依赖 JIT，不可上架`);
    }
  }
  if (modules.length === 0) fail('build-profile.json5 没有任何模块');
}

// ── 4. the runtime must stay jitless (the reason section 2 holds) ─────────
const argvPath = join(ROOT, 'hostruntime', 'src', 'main', 'ets', 'runtime', 'RuntimePort.ets');
if (!existsSync(argvPath)) {
  fail('hostruntime/.../RuntimePort.ets 不存在（无法核对 --jitless）');
} else {
  const argv = readFileSync(argvPath, 'utf8');
  if (!argv.includes("'--jitless'") && !argv.includes('"--jitless"')) {
    fail('buildHostArgv 里没有 --jitless：这正是"不申请可写代码内存权限"的前提');
  }
  if (/--experimental-fetch\b/.test(argv) && !/--no-experimental-fetch/.test(argv)) {
    fail('argv 里出现了 --experimental-fetch（本项目必须 --no-experimental-fetch，端侧 fetch 由垫片提供）');
  }
}

// ── report ────────────────────────────────────────────────────────────────
console.log('store-readiness guard');
console.log(`  bundleName   ${BUNDLE_NAME}`);
console.log(`  forbidden    ${FORBIDDEN} / 任何 ohos.permission.kernel.*`);
console.log(`  deviceTypes  必须覆盖 ${REQUIRED_DEVICE_TYPES.join(' / ')}`);
for (const n of notes) console.log(`  note         ${n}`);
console.log('');
if (failures.length === 0) {
  console.log('RESULT: PASS');
  process.exit(0);
}
console.log(`RESULT: FAIL (${failures.length})`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
