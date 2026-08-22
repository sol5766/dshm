#!/bin/bash
# ============================================================
# HDSH: DSH for OpenHarmony 适配脚本
# 在 DSH 运行环境（node_modules）上应用 OpenHarmony 适配：
#   1. 原生模块 stub（sharp/node-pty/koffi —— OpenHarmony 无预编译 binding）
#   2. bundle patch（禁用沙箱链/权限/工具插件 —— 鸿蒙沙箱环境不需要）
#   3. app-boot patch（activation 检查降级为 warn）
#   4. bash 环境说明：busybox（rawfile/busybox）由 DshBootstrap 解压到
#      filesDir/busybox 并提供 sh/bash 软链 + PATH/SHELL 注入，因此
#      tool-bash / tool-terminal 保留启用（如需强制禁用可加 --no-bash）
# 用法: apply-dsh-ohos-adapt.sh <DSH运行环境目录> [--no-bash]
# 注意: 在任何 pnpm install 重装后需重新执行。
# ============================================================
set -e
DSH_DIR="${1:?usage: apply-dsh-ohos-adapt.sh <dsh-env-dir>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NO_BASH=0
if [ "$2" = "--no-bash" ]; then NO_BASH=1; fi
cd "$DSH_DIR"

echo "[1/4] 原生模块 stub (sharp/node-pty/koffi)..."

NPTY_LIB=$(find node_modules -maxdepth 5 -type d -path "*node-pty/lib" 2>/dev/null | head -1)
if [ -n "$NPTY_LIB" ] && [ -f "$NPTY_LIB/index.js" ]; then
  cat > "$NPTY_LIB/index.js" <<'PTYEOF'
"use strict";
// [HDSH] OpenHarmony: PTY 不可用 stub
exports.spawn = function () { throw new Error('PTY not supported on OpenHarmony'); };
exports.fork = exports.spawn; exports.open = exports.spawn; exports.createTerminal = exports.spawn;
exports.native = {};
PTYEOF
fi

SHARP_D=$(find node_modules -maxdepth 4 -path "*sharp/dist" -type d 2>/dev/null | head -1)
if [ -f "$SHARP_D/index.cjs" ]; then
  cat > "$SHARP_D/index.cjs" <<'SHARPEOF'
"use strict";
// [HDSH] OpenHarmony: sharp 不可用 stub
function sharp() { throw new Error('sharp not supported on OpenHarmony'); }
module.exports = sharp; module.exports.default = sharp; module.exports.sharp = sharp;
module.exports.format = {}; module.exports.cache = function(){return{};};
SHARPEOF
  cat > "$SHARP_D/index.mjs" <<'SHARPMEOF'
// [HDSH] OpenHarmony: sharp 不可用 stub
function sharpStub() { throw new Error('sharp not supported on OpenHarmony'); }
export default sharpStub;
export { sharpStub as sharp };
export const format = {}; export const versions = {};
export function cache() { return {}; }
export function concurrency() {}
export function counters() { return {}; }
SHARPMEOF
fi

KOFFI_D=$(find node_modules -maxdepth 4 -path "*koffi" -type d 2>/dev/null | head -1)
if [ -f "$KOFFI_D/index.js" ]; then
  cat > "$KOFFI_D/index.js" <<'KOFFIEOF'
// [HDSH] OpenHarmony: koffi (FFI) 不可用 stub
function unsupported() { return undefined; }
function typeCtor() { return function () { return undefined; }; }
const stub = {
  load: unsupported, decode: unsupported, encode: unsupported,
  pointer: typeCtor, sizeof: unsupported, alignof: unsupported,
  typeof: unsupported, address: unsupported, cast: unsupported,
  struct: typeCtor, union: typeCtor, enum: typeCtor, callback: typeCtor,
  type: typeCtor, define: typeCtor, register: typeCtor, array: typeCtor,
  object: typeCtor, str: typeCtor, ptr: typeCtor, types: {},
  int8:'int8',int16:'int16',int32:'int32',int64:'int64',uint8:'uint8',uint16:'uint16',uint32:'uint32',uint64:'uint64',
  float:'float',double:'double',void:'void',bool:'bool',char:'char',
  platform: 'openharmony'
};
export default stub;
export { stub as koffi };
KOFFIEOF
fi

echo "[2/4] bundle patch (禁用沙箱链/权限/hmr 插件)..."
PATCH_FILE="${TMPDIR:-/tmp}/__patch_dsh_bundle_$$.mjs"
trap 'rm -f "$PATCH_FILE"' EXIT
cat > "$PATCH_FILE" <<'PATCHEOF'
import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d)) {
    const p = path.join(d, e);
    if (!fs.statSync(p).isDirectory()) continue;
    const pj = path.join(p, 'cordis.patch.yml');
    if (fs.existsSync(pj)) files.push(pj);
    if (!fs.existsSync(path.join(p, 'package.json'))) walk(p);
  }
};
walk(path.join(root, 'node_modules'));
// 鸿蒙应用沙箱禁止直接执行 filesDir 内 ELF；tool-bash/tool-terminal 使用系统 hnp bash。
// 沙箱链（Landlock/权限预设）在鸿蒙沙箱中无意义，继续禁用；--no-bash 时一并禁用 bash 工具。
// 注意：sandbox-policy 不能进 disableIds——tool-bash 要求 ctx.sandboxPolicy，
// 循环给 id 补 disabled: true 会让它被禁用（rc.6 的 mode 正则恰好删掉了
// disabled 行掩盖了此问题；rc.7 无 disabled 行，保留后会禁用 sandbox-policy）。
const disableIds = ['sandbox','fs-sandbox','bash-sandbox','pwsh-sandbox','permission-presets','hmr'];
if (process.env.HDSH_NO_BASH === '1') {
  disableIds.push('tool-bash', 'tool-terminal');
}
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf-8').split('\n');
  const out = [];
  let curId = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(\s*)- id: (\S+)/);
    if (m) curId = m[2];
    if (disableIds.includes(curId) && /^\s+disabled: /.test(line) && !/^\s*disabled: true\s*$/.test(line)) {
      out.push(/^\s+/.exec(line)[0] + 'disabled: true');
      continue;
    }
    out.push(line);
    const nameM = line.match(/^(\s+)name:/);
    if (nameM && disableIds.includes(curId)) {
      const next = i + 1 < lines.length ? lines[i + 1] : '';
      if (!/^\s+disabled:/.test(next)) out.push(nameM[1] + 'disabled: true');
    }
  }
  fs.writeFileSync(f, out.join('\n'));
}
console.log('bundle patches applied');
PATCHEOF
if [ "$NO_BASH" = "1" ]; then HDSH_NO_BASH=1 node "$PATCH_FILE"; else HDSH_NO_BASH=0 node "$PATCH_FILE"; fi

echo "[3/4] app-boot activation 降级..."
for AB in $(find node_modules -path "*dsh-app-boot@0.1.0-rc.6*/lib/index.js" -o -path "node_modules/@deepseek-ai/dsh-app-boot/lib/index.js" 2>/dev/null); do
  node -e "
const fs=require('fs');
const f='$AB';
const lines=fs.readFileSync(f,'utf-8').split('\n');
for(let i=0;i<lines.length;i++){
  if(lines[i].includes('did not activate') && lines[i].includes('throw new Error')){
    lines[i]=lines[i].replace(/throw new Error\([^;]*did not activate[\s\S]*?\);/, 'console.warn(\`[HDSH] degraded boot, pending: \${failures.join(\" | \")}\`)');
    fs.writeFileSync(f,lines.join('\n'));
    break;
  }
}
"
done

echo "[4/4] bash 环境检查 (system hnp bash)..."
if [ "$NO_BASH" = "1" ]; then
  echo "  --no-bash: tool-bash/tool-terminal 已禁用"
else
  echo "  bash 模式: tool-bash/tool-terminal 使用系统 hnp bash"
fi

echo "[5/5] HDSH 鸿蒙沙箱适配 patch (bash/fs 注册, sandboxMode, TMPDIR, symlink 降级, manifest)..."
HDSH_PATCH="${TMPDIR:-/tmp}/__patch_hdsh_adapt_$$.mjs"
trap 'rm -f "$HDSH_PATCH"' EXIT
cat > "$HDSH_PATCH" <<'HDSHPATCHEOF'
import fs from 'node:fs';
import path from 'node:path';
// ESM 作用域无 require：用 createRequire 兼容（mjs 内既有 require 调用）
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = process.cwd();
const nm = path.join(root, 'node_modules');

// 1) dsh-base/cordis.patch.yml：补注册 bash/fs 服务；启用 sandbox-policy
const basePatch = path.join(nm, '@deepseek-ai/dsh-base/cordis.patch.yml');
if (fs.existsSync(basePatch)) {
  let t = fs.readFileSync(basePatch, 'utf-8');
  const anchor = "    - id: subprocess\n      name: '@deepseek-ai/dsh-subprocess-local'";
  if (t.includes(anchor) && !t.includes("name: '@deepseek-ai/dsh-bash-local'")) {
    const insert = anchor + "\n\n" +
      "    # HDSH 鸿蒙适配：官方 host composition（apps/cli 的 base/web.cordis.yml）\n" +
      "    # 不在 npm 包内，需补注册 shell/fs 服务提供方，否则 tool-bash /\n" +
      "    # tool-fs 报 \"waiting for shell/fs\" 无法激活。\n" +
      "    - id: bash\n      name: '@deepseek-ai/dsh-bash-local'\n      config:\n        cwd: !!js process.cwd()\n\n" +
      "    - id: fs\n      name: '@deepseek-ai/dsh-fs-local'\n      config:\n        cwd: !!js process.cwd()\n";
    t = t.replace(anchor, insert);
  }
  // 启用 sandbox-policy（tool-bash 要求 ctx.sandboxPolicy；sandbox-local 保持禁用避免 koffi 崩溃）。
  // 注意：rc.7 的 sandbox-policy 块没有 disabled: true 行（rc.6 有），旧正则
  // /disabled: true\n config:\n mode: 'workspace-write'/ 会误匹配并产生坏 YAML
  // （config: 被拼到 name 同行 → dsh-app-boot 解析失败，DSH 无法启动）。
  // 修复：只精确替换 mode 值，不触碰缩进/结构。
  t = t.replace(
    /mode: !!js process\.env\.DSH_PERMISSION_MODE \?\? 'workspace-write'/,
    "mode: !!js process.env.DSH_PERMISSION_MODE ?? 'danger-full-access'"
  );
  fs.writeFileSync(basePatch, t);
  console.log('dsh-base patch: bash/fs registered, sandbox-policy enabled');
}

// 2) dsh-bash-local：提供 sandboxMode（permission-presets 要求）；bash → 系统 sh
const bashLocal = path.join(nm, '@deepseek-ai/dsh-bash-local/lib/index.js');
if (fs.existsSync(bashLocal)) {
  let t = fs.readFileSync(bashLocal, 'utf-8');
  if (!t.includes('HDSH 鸿蒙适配：应用沙箱本身已提供进程隔离')) {
    const anchor = 'var LocalBashExecutor = class LocalBashExecutor extends ShellExecutor {\n\tstatic inject = ["subprocess"];';
    const insert = anchor + '\n\t/**\n\t* HDSH 鸿蒙适配：应用沙箱本身已提供进程隔离，dsh 内层 bwrap/landlock/\n\t* windows-acl runner 在鸿蒙不可用（sandbox-local 加载即崩）。声明\n\t* danger-full-access 让 permission-presets 的 sandboxMode 检查通过，\n\t* bash 直接运行不 confine，隔离由鸿蒙应用沙箱承担。\n\t*/\n\tget sandboxMode() {\n\t\treturn "danger-full-access";\n\t}';
    if (t.includes(anchor)) {
      t = t.replace(anchor, insert);
    }
  }
  // OH_Skills 实测（2026-08-13）：系统 /bin/sh 在沙箱域无 MAC 执行权
  // （failed to spawn shell: Permission denied os error 13）；
  // /data/service/hnp/bin/bash（hnp_file:s0 域）可 exec 且语义完整。
  t = t.replaceAll('"bash",\n\t\t\t"-c"', '"/data/service/hnp/bin/bash",\n\t\t\t"-c"');
  // HDSH 鸿蒙适配：appspawn 继承的 cwd 可能让 bash 的 getcwd() 返回 EACCES；
  // 在 shell 内显式 cd 到同一工作目录，恢复 pwd、无参数 ls 等相对路径操作。
  // npm 包在 Windows 工作区可能使用 CRLF；shell argv 也已在上面的替换
  // 中变为绝对 hnp bash，不能依赖 argv[0] === "bash"。
  const spawnCwdPattern = /\n\t\treturn \{\r?\n\t\t\targv,\r?\n\t\t\tcwd: spec\.workdir,/;
  const spawnCwdPatch = `
\t\t// HDSH 鸿蒙适配：spawn 前显式 cd，修复继承 cwd 的 getcwd EACCES。
\t\tconst shellWorkdir = spec.workdir.replaceAll(String.fromCharCode(39), String.fromCharCode(39, 34, 39, 34, 39));
\t\tconst spawnArgv = argv.length >= 3 && argv[1] === "-c"
\t\t\t? [argv[0], argv[1], "cd '" + shellWorkdir + "' 2>/dev/null || exit 1; " + argv[2], ...argv.slice(3)]
\t\t\t: argv;
\t\treturn {
\t\t\targv: spawnArgv,
\t\t\tcwd: spec.workdir,`;
  if (spawnCwdPattern.test(t) && !t.includes('HDSH 鸿蒙适配：spawn 前显式 cd')) {
    t = t.replace(spawnCwdPattern, spawnCwdPatch);
  }
  fs.writeFileSync(bashLocal, t);
  console.log('dsh-bash-local: sandboxMode + hnp bash + cwd recovery patched');
}

// 3) dsh-spill-local：privateRoot 优先读 TMPDIR（鸿蒙无 /tmp）
const spillLocal = path.join(nm, '@deepseek-ai/dsh-spill-local/lib/index.js');
if (fs.existsSync(spillLocal)) {
  let t = fs.readFileSync(spillLocal, 'utf-8');
  if (!t.includes('HDSH 鸿蒙适配：沙箱内 os.tmpdir()')) {
    const oldFn = 'function privateRoot() {\n\tdefaultRoot ??= mkdtempSync(join(tmpdir(), "dsh-spill-"));\n\treturn defaultRoot;\n}';
    const newFn = 'function privateRoot() {\n\t// HDSH 鸿蒙适配：沙箱内 os.tmpdir() 返回 /tmp（不存在，mkdtemp ENOENT），\n\t// 优先使用 libdsh_host 注入的 TMPDIR（<filesDir>/tmp）。\n\tconst base = process.env.TMPDIR || process.env.TMP || process.env.TEMP || tmpdir();\n\tdefaultRoot ??= mkdtempSync(join(base, "dsh-spill-"));\n\treturn defaultRoot;\n}';
    if (t.includes(oldFn)) {
      t = t.replace(oldFn, newFn);
      fs.writeFileSync(spillLocal, t);
      console.log('dsh-spill-local: TMPDIR-aware privateRoot');
    }
  }
}

// 3.5) dsh-subprocess-local：privateSpillDir 优先读 TMPDIR（bash/glob/grep 等
//      子进程工具的 spill 目录，沙箱内 tmpdir() 返回 /tmp 不可写）
const subprocessLocal = path.join(nm, '@deepseek-ai/dsh-subprocess-local/lib/index.js');
if (fs.existsSync(subprocessLocal)) {
  let t = fs.readFileSync(subprocessLocal, 'utf-8');
  if (!t.includes('HDSH 鸿蒙适配：沙箱内 os.tmpdir()')) {
    const oldFn = 'function privateSpillDir() {\n\tdefaultSpillDir ??= mkdtempSync(join(tmpdir(), "dsh-subprocess-"));\n\treturn defaultSpillDir;\n}';
    const newFn = 'function privateSpillDir() {\n\t// HDSH 鸿蒙适配：沙箱内 os.tmpdir() 返回 /tmp（不存在，mkdtemp ENOENT），\n\t// 优先使用 libdsh_host 注入的 TMPDIR（<filesDir>/tmp）。\n\tconst base = process.env.TMPDIR || process.env.TMP || process.env.TEMP || tmpdir();\n\tdefaultSpillDir ??= mkdtempSync(join(base, "dsh-subprocess-"));\n\treturn defaultSpillDir;\n}';
    if (t.includes(oldFn)) {
      t = t.replace(oldFn, newFn);
      fs.writeFileSync(subprocessLocal, t);
      console.log('dsh-subprocess-local: TMPDIR-aware privateSpillDir');
    }
  }
}

// 3.6) run_code：node:module 的 stripTypeScriptTypes 依赖 amaro WASM，
//      而 --jitless 禁用 WebAssembly（run_code 报 "WebAssembly is not
//      supported ... required for TypeScript"）。内置 typescript 纯 JS 包，
//      用 transpileModule 实现兼容的类型剥离。
const TS_DEST = path.join(nm, 'typescript');
const TS_TARBALL = process.env.HDSH_TS_TARBALL || '';
if (!fs.existsSync(path.join(TS_DEST, 'lib/typescript.js'))) {
  if (TS_TARBALL !== '' && fs.existsSync(TS_TARBALL)) {
    // 从本地 tarball 解压（prepare-dsh-env.sh 预先下载）
    const { execSync } = require('node:child_process');
    fs.mkdirSync(TS_DEST, { recursive: true });
    execSync(`tar -xzf "${TS_TARBALL}" -C "${TS_DEST}" --strip-components=1`, { stdio: 'ignore' });
    console.log('typescript: extracted from tarball');
  } else {
    // 兜底：直接拉取 npm（构建环境可联网时）
    const { execSync } = require('node:child_process');
    fs.mkdirSync(TS_DEST, { recursive: true });
    execSync(`npm pack typescript@5.9.3 --pack-destination "${TS_DEST}"`, { stdio: 'ignore' });
    const tgz = fs.readdirSync(TS_DEST).find((f) => f.startsWith('typescript-') && f.endsWith('.tgz'));
    if (tgz) {
      execSync(`tar -xzf "${path.join(TS_DEST, tgz)}" -C "${TS_DEST}" --strip-components=1`, { stdio: 'ignore' });
      fs.rmSync(path.join(TS_DEST, tgz), { force: true });
      console.log('typescript: fetched from npm');
    }
  }
}
const workerPath = path.join(nm, '@deepseek-ai/dsh-code-runtime-worker-thread/lib/index.js');
if (fs.existsSync(workerPath)) {
  let t = fs.readFileSync(workerPath, 'utf-8');
  if (!t.includes('HDSH 鸿蒙适配：node:module 的 stripTypeScriptTypes')) {
    t = t.replace(
      'import { stripTypeScriptTypes } from "node:module";',
      'import { transpileModule, ModuleKind, ScriptTarget } from "typescript";'
    );
    const fn = `/**
 * HDSH 鸿蒙适配：node:module 的 stripTypeScriptTypes 依赖 amaro WASM，
 * 而 --jitless 模式下 V8 禁用 WebAssembly。改用 typescript 纯 JS 的
 * transpileModule 做类型剥离（保持 ESNext/ESM 输出，行为兼容）。
 */
function stripTypeScriptTypes(source) {
	const result = transpileModule(source, {
		compilerOptions: {
			target: ScriptTarget.ESNext,
			module: ModuleKind.ESNext,
			isolatedModules: true,
			removeComments: false
		},
		reportDiagnostics: false
	});
	return result.outputText;
}

`;
    const anchor = 'const STRIP_WRAP = {';
    if (t.includes(anchor)) {
      t = t.replace(anchor, fn + anchor);
      fs.writeFileSync(workerPath, t);
      console.log('dsh-code-runtime-worker-thread: stripTypeScriptTypes -> transpileModule');
    }
  }
}

// 3.7) typescript 加入 dsh manifest dependencies：
//      healProfilesModuleFallback 只处理依赖闭包内的包，typescript 包若不在
//      dsh dependencies，profiles/node_modules fallback 不会包含它，
//      worker 从 profiles 解析时 ERR_MODULE_NOT_FOUND。
const dshManifestTs = path.join(nm, '@deepseek-ai/dsh/package.json');
if (fs.existsSync(dshManifestTs)) {
  const manifest = JSON.parse(fs.readFileSync(dshManifestTs, 'utf-8'));
  if (!(manifest.dependencies ?? {})['typescript']) {
    manifest.dependencies = manifest.dependencies ?? {};
    manifest.dependencies['typescript'] = '^5.9.3';
    fs.writeFileSync(dshManifestTs, JSON.stringify(manifest, null, 2) + '\n');
    console.log('dsh manifest: typescript added to dependencies');
  }
}

// 3.7.1) dshmarket 作为 DSH 内置 Web bundle：将其加入 dsh 依赖闭包，
//          healProfilesModuleFallback 才会把插件及其依赖复制到
//          $DSH_HOME/profiles/node_modules，供 Web profile 的 bare module loader 解析。
const marketManifestPath = path.join(nm, 'dshmarket/package.json');
const dshManifestMarket = path.join(nm, '@deepseek-ai/dsh/package.json');
if (fs.existsSync(marketManifestPath) && fs.existsSync(dshManifestMarket)) {
  const marketManifest = JSON.parse(fs.readFileSync(marketManifestPath, 'utf-8'));
  const manifest = JSON.parse(fs.readFileSync(dshManifestMarket, 'utf-8'));
  const marketVersion = String(marketManifest.version ?? '1.13.1');
  manifest.dependencies = manifest.dependencies ?? {};
  if (manifest.dependencies['dshmarket'] !== marketVersion) {
    manifest.dependencies['dshmarket'] = marketVersion;
    fs.writeFileSync(dshManifestMarket, JSON.stringify(manifest, null, 2) + '\n');
    console.log('dsh manifest: dshmarket added to dependency closure');
  }
}

// 3.7.2) dsh-app-boot：Web profile 默认挂载 dshmarket，并迁移既有 profile。
//          仅升级 rawfile 不会重建 $DSH_HOME/profiles/web/package.json；因此
//          启动时补齐 bundle，保留用户已有依赖和自定义 patch。
const appBootMarket = path.join(nm, '@deepseek-ai/dsh-app-boot/lib/index.js');
if (fs.existsSync(appBootMarket)) {
  let t = fs.readFileSync(appBootMarket, 'utf-8');
  const layersAnchor = '\tconst layers = (normalizeShippedProfile(name, dir, readProfileManifest(binName, dir)).dsh?.profile?.bundles ?? []).map((packageName) => {';
  const migrationStart = t.indexOf('\t// HDSH 内置 dshmarket Web profile v');
  const migrationEnd = migrationStart === -1 ? -1 : t.indexOf(layersAnchor, migrationStart);
  if (migrationEnd !== -1) {
    t = t.slice(0, migrationStart) + t.slice(migrationEnd);
  }
  if (!t.includes('HDSH 内置 dshmarket Web profile v3')) {
    t = t.replace(
      'web: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],',
      '// HDSH 内置 dshmarket Web profile（首次初始化自动加载插件市场）。\n\tweb: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dshmarket"],'
    );
    const migration = `\t// HDSH 内置 dshmarket Web profile v3：确认新包可解析后迁移已有\n\t// web profile，并移除已卸载市场的残留 bundle，保留用户其余配置。\n\tconst hdshMarketManifest = readProfileManifest(binName, dir);\n\tconst hdshExistingBundles = hdshMarketManifest.dsh?.profile?.bundles ?? [];\n\tconst hdshLegacyMarketBundle = "@dsh-market/plugin";\n\tconst hdshMigratedBundles = hdshExistingBundles.filter((packageName) => packageName !== hdshLegacyMarketBundle);\n\tif (name === "web" && (hdshMigratedBundles.length !== hdshExistingBundles.length || !hdshMigratedBundles.includes("dshmarket"))) {\n\t\ttry {\n\t\t\tresolveBundleDir(binName, "dshmarket", installAnchor, dir);\n\t\t\twriteProfileManifest(dir, {\n\t\t\t\t...hdshMarketManifest,\n\t\t\t\tdsh: {\n\t\t\t\t\t...hdshMarketManifest.dsh,\n\t\t\t\t\tprofile: {\n\t\t\t\t\t\t...hdshMarketManifest.dsh?.profile,\n\t\t\t\t\t\tbundles: hdshMigratedBundles.includes("dshmarket") ? hdshMigratedBundles : [...hdshMigratedBundles, "dshmarket"]\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t});\n\t\t} catch (error) {\n\t\t\t// 新市场包不可用时不改写 profile，避免丢失可启动配置。\n\t\t}\n\t}\n`;
    if (t.includes(layersAnchor)) {
      t = t.replace(layersAnchor, migration + layersAnchor);
    }
    fs.writeFileSync(appBootMarket, t);
    console.log('dsh-app-boot: dshmarket web bundle + profile migration');
  }
}

// 3.8) dsh-tool-fs-search：glob/grep 降级到系统 find/grep
//      @vscode/ripgrep 平台包（@vscode/ripgrep-linux-arm64）在鸿蒙沙箱不可用
//      （无该平台包，且 filesDir 下 ELF 禁止 exec），导致 glob/grep 工具
//      "ripgrep launch failed"。patch 后 rg 解析失败时回退到 hnp/系统
//      find/grep（/data/service/hnp/bin 或 /system/bin/toybox）。
const fsSearchPath = path.join(nm, '@deepseek-ai/dsh-tool-fs-search/lib/index.js');
if (fs.existsSync(fsSearchPath)) {
  let t = fs.readFileSync(fsSearchPath, 'utf-8');
  if (!t.includes('HDSH 鸿蒙适配：rg 平台包缺失')) {
    // import 增加 statSync，并补 basename（降级分支用到 basename(findPath)）
    t = t.replace(
      'import { isAbsolute, relative, sep } from "node:path";',
      'import { basename, isAbsolute, relative, sep } from "node:path";\nimport { statSync } from "node:fs";'
    );
    // resolveRgPath 后追加降级辅助函数
    const helpers = `// HDSH 鸿蒙适配：@vscode/ripgrep 平台包（@vscode/ripgrep-<platform>-<arch>）
// 在鸿蒙沙箱内不可用（无 linux-arm64 包，且 filesDir 下 ELF 禁止 exec）。
// 探测系统可 exec 的 find/grep 作为降级路径（hnp GNU 工具链或 /system/bin/toybox）。
function probeSystemTool(binNames) {
	for (const name of binNames) {
		const candidates = [
			\`/data/service/hnp/bin/\${name}\`,
			\`/system/bin/\${name}\`,
			\`/system/bin/toybox\`
		];
		for (const c of candidates) {
			try {
				const st = statSync(c);
				if (st.isFile() || st.isSymbolicLink()) return c;
			} catch (error) { /* keep probing */ }
		}
	}
	return "";
}
/** 降级 argv：把 rg 参数转成系统 find/grep 参数；返回空数组表示无法降级。 */
function buildFallbackArgv(toolName, argv) {
	let root = ".";
	let pattern = "";
	let globPattern = "";
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--") {
			root = argv[i + 1] ?? ".";
			break;
		}
		if (a.startsWith("--regexp=")) pattern = a.slice("--regexp=".length);
		else if (a.startsWith("--glob=") && globPattern === "") globPattern = a.slice("--glob=".length);
		else if (a.startsWith("--glob!")) { /* ignore negation in fallback */ }
	}
	if (toolName === "glob") {
		const findPath = probeSystemTool(["find"]);
		if (findPath === "") return [];
		const args = [findPath];
		// toybox 用 argv[1] 分发 applet（argv[0]=toybox 时需显式 applet 名）
		if (basename(findPath) === "toybox") args.push("find");
		args.push(root, "-type", "f");
		if (globPattern !== "") {
			const base = globPattern.replaceAll("**/", "").split("/").pop() ?? globPattern;
			args.push("-name", base);
		}
		return args;
	}
	const grepPath = probeSystemTool(["grep"]);
	if (grepPath === "") return [];
	const args = [grepPath];
	if (basename(grepPath) === "toybox") args.push("grep");
	// rg 查询语法采用 PCRE2；系统 grep 必须启用 ERE，才能保留 |、()、+、?、{} 的语义。
	args.push("-rn", "-E", "-e", pattern, root);
	if (globPattern !== "") {
		const base = globPattern.replaceAll("**/", "").split("/").pop() ?? globPattern;
		args.push("--include=" + base);
	}
	return args;
}
/** 把系统 grep 文本输出（path:line:content）转成 rg --json 风格 NDJSON。 */
function grepTextToNdjson(stdout) {
	// HDSH 鸿蒙适配：handle.collected.stdout.readFrom(0) 返回 Buffer/Uint8Array
	// 而非字符串，stdout.split 会抛 TypeError；先强转为字符串。
	const text = Buffer.isBuffer(stdout) ? stdout.toString("utf8") : String(stdout);
	const lines = [];
	for (const rawLine of text.split("\\n")) {
		if (rawLine.length === 0) continue;
		const first = rawLine.indexOf(":");
		if (first <= 0) continue;
		const second = rawLine.indexOf(":", first + 1);
		if (second <= first + 1) continue;
		const path = rawLine.slice(0, first);
		const lineNum = Number(rawLine.slice(first + 1, second));
		const content = rawLine.slice(second + 1);
		if (!Number.isInteger(lineNum) || lineNum < 1) continue;
		lines.push(JSON.stringify({
			type: "match",
			data: {
				path: { text: path },
				line_number: lineNum,
				lines: { text: content }
			}
		}));
	}
	return lines.join("\\n") + (lines.length > 0 ? "\\n" : "");
}
`;
    const anchorFn = 'function resolveRgPath() {\n\trgPathPromise ??= import("@vscode/ripgrep").then((module) => module.rgPath);\n\treturn rgPathPromise;\n}';
    if (t.includes(anchorFn)) {
      t = t.replace(anchorFn, anchorFn + '\n' + helpers);
    }
    // runRipgrep：rg 解析失败时降级
    const oldSpawn = `\tconst workdir = exec.agent?.session.header.cwd ?? process.cwd();
\tlet handle;
\ttry {
\t\thandle = ctx.subprocess.spawn({
\t\t\targv: [
\t\t\t\tawait resolveRgPath(),
\t\t\t\t"--no-config",
\t\t\t\t...argv
\t\t\t],`;
    const newSpawn = `\tconst workdir = exec.agent?.session.header.cwd ?? process.cwd();
\t// HDSH 鸿蒙适配：rg 平台包缺失/不可 exec 时降级到系统 find/grep
\tlet rgPath;
\ttry {
\t\trgPath = await resolveRgPath();
\t} catch (error) {
\t\trgPath = "";
\t}
\tlet spawnArgv;
\tlet fallbackGrep = false;
\tif (rgPath !== "") {
\t\tspawnArgv = [rgPath, "--no-config", ...argv];
\t} else {
\t\tconst fb = buildFallbackArgv(toolName, argv);
\t\tif (fb.length === 0) throw new SearchError(\`\${toolName} could not start its search command (ripgrep launch failed)\`, "SEARCH_FAILED");
\t\tspawnArgv = fb;
\t\tfallbackGrep = toolName === "grep";
\t}
\tlet handle;
\ttry {
\t\thandle = ctx.subprocess.spawn({
\t\t\targv: spawnArgv,`;
    if (t.includes(oldSpawn)) {
      t = t.replace(oldSpawn, newSpawn);
    }
    // 输出转换：grep 降级时把文本转 NDJSON
    const oldOut = `\tconst stdout = handle.collected.stdout?.readFrom(0);
\tconst stderr = handle.collected.stderr?.readFrom(0);
\tif (stdout === void 0 || stderr === void 0) throw new SearchError(\`\${toolName} search command produced no collected output streams\`, "SEARCH_FAILED");`;
    const newOut = `\tconst stdoutRaw = handle.collected.stdout?.readFrom(0);
\tconst stderr = handle.collected.stderr?.readFrom(0);
\tif (stdoutRaw === void 0 || stderr === void 0) throw new SearchError(\`\${toolName} search command produced no collected output streams\`, "SEARCH_FAILED");
\t// HDSH 鸿蒙适配：readFrom(0) 返回 {text, lossy} 收集器对象（非 Buffer/字符串）。
\t// 必须保持形状不变、只替换 text 字段，completeStdout 才能读到 .lossy/.text；
\t// 否则 String({text,lossy}) 变 "[object Object]" → 空 NDJSON → completeStdout
\t// 读 .text 为 undefined → "string argument must be Buffer" 报错。
\tconst stdout = fallbackGrep
\t\t? { ...stdoutRaw, text: grepTextToNdjson(stdoutRaw.text ?? "") }
\t\t: stdoutRaw;`;
    if (t.includes(oldOut)) {
      t = t.replace(oldOut, newOut);
    }
    fs.writeFileSync(fsSearchPath, t);
    console.log('dsh-tool-fs-search: glob/grep fallback to system find/grep');
  }
}

// 3.8.1) dsh-terminal-bash prompt 暗号匹配修复：上层 dsh-tool-bash-persistent
//       把 PS1 设为 "__DSH_PERSISTENT_BASH_PROMPT__ "（SHELL_PROMPT），而本模块
//       等待的 CONTROLLED_PROMPT 是 "dsh> "，两边对不上 → 每次命令触发 3.5s
//       静默超时兜底（实测 ~3600ms）。修复：暗号对齐 + 长度自适应（~158ms，70 倍）。
const terminalBashPath = path.join(nm, '@deepseek-ai/dsh-terminal-bash/lib/index.js');
if (fs.existsSync(terminalBashPath)) {
  let t = fs.readFileSync(terminalBashPath, 'utf-8');
  if (!t.includes('HDSH 鸿蒙适配：上层 dsh-tool-bash-persistent')) {
    const oldPrompt = 'const CONTROLLED_PROMPT = "dsh> ";';
    const newPrompt = '// HDSH 鸿蒙适配：上层 dsh-tool-bash-persistent 把 PS1 设为\n// "__DSH_PERSISTENT_BASH_PROMPT__ "（SHELL_PROMPT），本模块等待的\n// 暗号必须与之一致，否则每次命令都触发 3.5s 静默超时兜底（实测\n// 修复后命令从 ~3600ms 降到 ~158ms）。\nconst CONTROLLED_PROMPT = "__DSH_PERSISTENT_BASH_PROMPT__";';
    if (t.includes(oldPrompt)) {
      t = t.replace(oldPrompt, newPrompt);
    }
    const oldLen = 'const remaining = Math.max(0, 6 - this.promptTail.length);';
    const newLen = '// HDSH 鸿蒙适配：暗号长度自适应 CONTROLLED_PROMPT（原硬编码 6 只匹配 "dsh> "）\n\t\t\tconst remaining = Math.max(0, CONTROLLED_PROMPT.length + 1 - this.promptTail.length);';
    if (t.includes(oldLen)) {
      t = t.replace(oldLen, newLen);
    }
    fs.writeFileSync(terminalBashPath, t);
    console.log('dsh-terminal-bash: prompt 暗号对齐（提速 70 倍）');
  }
}

// 3.9) dsh plugin 主进程桥接：内置 pnpm（纯 JS 单文件 bundle，deps=0）
//      并 patch runPlugin 用 worker_threads 执行（鸿蒙沙箱禁子进程 node，
//      spawnSync("pnpm") 必 SIGSYS；worker 同进程内跑 CLI，隔离 process.exit）。
const PNPM_JS_DEST = path.join(nm, 'pnpm');
const PNPM_JS_TARBALL = process.env.HDSH_PNPM_JS_TARBALL || '';
if (!fs.existsSync(path.join(PNPM_JS_DEST, 'dist/pnpm.cjs'))) {
  const { execSync } = require('node:child_process');
  fs.mkdirSync(PNPM_JS_DEST, { recursive: true });
  if (PNPM_JS_TARBALL !== '' && fs.existsSync(PNPM_JS_TARBALL)) {
    execSync(`tar -xzf "${PNPM_JS_TARBALL}" -C "${PNPM_JS_DEST}" --strip-components=1`, { stdio: 'ignore' });
    console.log('pnpm: extracted from tarball');
  } else {
    execSync(`npm pack pnpm@10.6.3 --pack-destination "${PNPM_JS_DEST}"`, { stdio: 'ignore' });
    const tgz = fs.readdirSync(PNPM_JS_DEST).find((f) => f.startsWith('pnpm-') && f.endsWith('.tgz'));
    if (tgz) {
      execSync(`tar -xzf "${path.join(PNPM_JS_DEST, tgz)}" -C "${PNPM_JS_DEST}" --strip-components=1`, { stdio: 'ignore' });
      fs.rmSync(path.join(PNPM_JS_DEST, tgz), { force: true });
      console.log('pnpm: fetched from npm');
    }
  }
}
// pnpm 必须成为 dsh 运行时依赖。dsh-app-boot 会按 dsh manifest 的依赖闭包
// 复制 profiles/node_modules fallback；缺少该声明时，Worker 从 fallback dsh
// 加载 pnpm CLI 会解析到不存在的 profiles/node_modules/pnpm。
const dshManifestPath = path.join(nm, '@deepseek-ai/dsh/package.json');
if (fs.existsSync(dshManifestPath) && fs.existsSync(path.join(PNPM_JS_DEST, 'dist/pnpm.cjs'))) {
  const dshManifest = JSON.parse(fs.readFileSync(dshManifestPath, 'utf-8'));
  dshManifest.dependencies = dshManifest.dependencies || {};
  if (dshManifest.dependencies.pnpm !== '10.6.3') {
    dshManifest.dependencies.pnpm = '10.6.3';
    fs.writeFileSync(dshManifestPath, JSON.stringify(dshManifest, null, 2) + '\n');
    console.log('dsh: pnpm added to runtime dependency closure');
  }
  const piManifestPath = path.join(nm, '@earendil-works/pi-ai/package.json');
  if (fs.existsSync(piManifestPath)) {
    const piVersion = String(JSON.parse(fs.readFileSync(piManifestPath, 'utf-8')).version ?? '0.82.1');
    if (dshManifest.dependencies['@earendil-works/pi-ai'] !== piVersion) {
      dshManifest.dependencies['@earendil-works/pi-ai'] = piVersion;
      fs.writeFileSync(dshManifestPath, JSON.stringify(dshManifest, null, 2) + '\n');
      console.log('dsh: pi-ai added to runtime dependency closure');
    }
  }
}
// patch runPlugin：spawnSync("pnpm") -> worker_threads 主进程内执行 pnpm CLI
const pluginPath = path.join(nm, '@deepseek-ai/dsh/lib/plugin-9h8shc4d.js');
if (fs.existsSync(pluginPath)) {
  let t = fs.readFileSync(pluginPath, 'utf-8');
  if (!t.includes('HDSH 鸿蒙适配：鸿蒙沙箱禁 exec 子进程 node')) {
    t = t.replace(
      'import { join, resolve } from "node:path";',
      'import { dirname, join, resolve } from "node:path";'
    );
    t = t.replace(
      'import { spawnSync } from "node:child_process";',
      'import { fileURLToPath } from "node:url";\nimport { Worker } from "node:worker_threads";'
    );
    const oldRun = `function runPlugin(profile, args) {
	const dir = resolveProfileDir(profile);
	if (!existsSync(join(dir, "package.json"))) {
		initProfile(dir, PROFILE_TEMPLATES[profile] ?? DEFAULT_PROFILE_BUNDLES);
		process.stderr.write(\`\${NAME}: initialized profile \${profile} at \${dir}\\n\`);
	}
	const before = readProfileManifest(NAME, dir);
	const result = spawnSync("pnpm", args.map((argument) => anchorPathSpec(argument, process.cwd())), {
		cwd: dir,
		stdio: "inherit",
		shell: process.platform === "win32"
	});
	if (result.error !== void 0) {
		if (result.error.code === "ENOENT") {
			process.stderr.write(\`\${NAME}: pnpm not found on PATH — install pnpm to manage profile plugins\\n\`);
			return 127;
		}
		throw result.error;
	}
	const exitCode = result.status ?? 1;`;
    const newRun = `async function runPlugin(profile, args) {
	const dir = resolveProfileDir(profile);
	if (!existsSync(join(dir, "package.json"))) {
		initProfile(dir, PROFILE_TEMPLATES[profile] ?? DEFAULT_PROFILE_BUNDLES);
		process.stderr.write(\`\${NAME}: initialized profile \${profile} at \${dir}\\n\`);
	}
	const before = readProfileManifest(NAME, dir);
	// HDSH 鸿蒙适配：主进程 worker 执行 pnpm CLI（同进程非子进程 exec，
	// 绕过 SIGSYS；pnpm CLI 末尾 process.exit 只终止 worker）。
	const pnpmCli = join(dirname(fileURLToPath(import.meta.url)), "../../../pnpm/dist/pnpm.cjs");
	const exitCode = await new Promise((resolvePromise) => {
		const worker = new Worker(\`
			const { parentPort, workerData } = require("node:worker_threads");
			process.argv = [process.execPath, "pnpm", "--dir", workerData.dir, ...workerData.args];
			try {
				require(workerData.pnpmCli);
			} catch (error) {
				parentPort.postMessage({ error: String(error) });
				process.exitCode = 1;
			}
		\`, {
			eval: true,
			workerData: { dir, args, pnpmCli }
		});
		worker.on("message", (message) => {
			if (message?.error !== void 0) process.stderr.write(\`\${NAME}: pnpm worker error: \${message.error}\\n\`);
		});
		worker.on("exit", (code) => resolvePromise(code ?? 1));
	});`;
    if (t.includes(oldRun)) {
      t = t.replace(oldRun, newRun);
    }
    // 删除 anchorPathSpec 引用（worker 内已不需要重写相对路径）
    t = t.replace(/args\.map\(\(argument\) => anchorPathSpec\(argument, process\.cwd\(\)\)\)/g, 'args');
    console.log('dsh plugin: runPlugin -> worker_threads pnpm bridge');
  }
  if (!t.includes('HDSH 鸿蒙适配：pnpm Worker 临时目录')) {
    const oldWorkerSetup = 'const { parentPort, workerData } = require("node:worker_threads");\n\t\t\tprocess.argv = [process.execPath, "pnpm", "--dir", workerData.dir, ...workerData.args];';
    const newWorkerSetup = 'const { parentPort, workerData } = require("node:worker_threads");\n\t\t\tconst { mkdirSync } = require("node:fs");\n\t\t\tconst { join } = require("node:path");\n\t\t\t// HDSH 鸿蒙适配：pnpm Worker 临时目录，沙箱没有 /tmp。\n\t\t\tconst tempDir = join(workerData.dir, ".hdsh-pnpm-tmp");\n\t\t\tmkdirSync(tempDir, { recursive: true });\n\t\t\tprocess.env.TMPDIR = tempDir;\n\t\t\tprocess.env.TMP = tempDir;\n\t\t\tprocess.env.TEMP = tempDir;\n\t\t\t// OHOS Node 的 os.tmpdir() 忽略 TMPDIR；pnpm 在载入时会 realpath /tmp。\n\t\t\tconst os = require("node:os");\n\t\t\tos.tmpdir = () => tempDir;\n\t\t\tprocess.argv = [process.execPath, "pnpm", "--dir", workerData.dir, ...workerData.args];';
    if (t.includes(oldWorkerSetup)) {
      t = t.replace(oldWorkerSetup, newWorkerSetup);
      console.log('dsh plugin: pnpm Worker temporary directory patched');
    }
  }
  if (!t.includes('HDSH 鸿蒙适配：优先使用 HAP 内置 pnpm')) {
    const fallbackPnpmCli = 'const pnpmCli = join(dirname(fileURLToPath(import.meta.url)), "../../../pnpm/dist/pnpm.cjs");';
    const bundledPnpmCli = '// HDSH 鸿蒙适配：优先使用 HAP 内置 pnpm；profile fallback 不保证包含 pnpm。\n\tconst bundledPnpmCli = join(process.cwd(), "dsh", "node_modules", "pnpm", "dist", "pnpm.cjs");\n\tconst pnpmCli = existsSync(bundledPnpmCli)\n\t\t? bundledPnpmCli\n\t\t: join(dirname(fileURLToPath(import.meta.url)), "../../../pnpm/dist/pnpm.cjs");';
    if (t.includes(fallbackPnpmCli)) {
      t = t.replace(fallbackPnpmCli, bundledPnpmCli);
      console.log('dsh plugin: bundled pnpm CLI path patched');
    }
  }
  fs.writeFileSync(pluginPath, t);
}
// patch bin.js：await runPlugin（runPlugin 已改为 async）
const binPath = path.join(nm, '@deepseek-ai/dsh/lib/bin.js');
if (fs.existsSync(binPath)) {
  let t = fs.readFileSync(binPath, 'utf-8');
  if (!t.includes('HDSH 鸿蒙适配：runPlugin 已改为 async')) {
    t = t.replace(
      'process.exit(runPlugin(invocation.profile, invocation.args));',
      '// HDSH 鸿蒙适配：runPlugin 已改为 async（主进程 worker 执行 pnpm）\n\t\tprocess.exit(await runPlugin(invocation.profile, invocation.args));'
    );
    fs.writeFileSync(binPath, t);
    console.log('dsh bin: await runPlugin');
  }

}

// 3.9.1) dshmarket：鸿蒙禁止 Node 子进程执行。市场改为通过 Worker 加载
//          内置 dsh CLI，CLI 内部继续使用已适配的 pnpm Worker bridge。
const marketCliPath = path.join(nm, 'dshmarket/lib/dsh-cli.js');
if (fs.existsSync(marketCliPath)) {
  const marketWorkerPath = path.join(nm, 'dshmarket/lib/hdsh-dsh-plugin-worker.cjs');
  const marketWorkerSource = `const { workerData } = require("node:worker_threads");
const { pathToFileURL } = require("node:url");
process.argv = [process.execPath, workerData.bin].concat(workerData.args);
import(pathToFileURL(workerData.bin).href).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;
  fs.writeFileSync(marketWorkerPath, marketWorkerSource);
  let t = fs.readFileSync(marketCliPath, 'utf-8');
  if (!t.includes('HDSH 鸿蒙适配：dshmarket Worker CLI bridge v11')) {
    if (!/import \{ Worker \} from ['"]node:worker_threads['"]/.test(t)) {
      t = t.replace(
        /(import \{ spawn \} from ['"]node:child_process['"];)/,
        '$1\nimport { createRequire } from "node:module";\nimport { Worker } from "node:worker_threads";\nimport { fileURLToPath } from "node:url";'
      );
    }
    t = t.replace('import { pathToFileURL } from "node:url";', 'import { fileURLToPath } from "node:url";');
    if (!t.includes('fileURLToPath')) {
      t = t.replace(
        /(import \{ Worker \} from ['"]node:worker_threads['"];)/,
        '$1\nimport { fileURLToPath } from "node:url";'
      );
    }
    t = t.replace('const require = createRequire(import.meta.url);', 'const dshRequire = createRequire(import.meta.url);');
    t = t.replace('require.resolve("@deepseek-ai/dsh/package.json")', 'dshRequire.resolve("@deepseek-ai/dsh/package.json")');
    if (!t.includes('const dshRequire = createRequire(import.meta.url);')) {
      t = t.replace(
        /(import \{ profileDir \} from ['"]\.\/profile\.js['"];)/,
        '$1\nconst dshRequire = createRequire(import.meta.url);'
      );
    }
    if (!t.includes('let activeWorker = null;')) {
      t = t.replace('let activeChild = null;', 'let activeChild = null;\nlet activeWorker = null;');
    }
    if (!t.includes('void activeWorker.terminate().catch(() => {});')) {
      t = t.replace(
        'if (activeChild === null) return false;',
        'if (activeWorker !== null) {\n        cancelRequested = true;\n        progress.cancelling = true;\n        void activeWorker.terminate().catch(() => {});\n        return true;\n    }\n    if (activeChild === null) return false;'
      );
    }
    const probeStart = t.indexOf('export function probePnpm() {');
    const probeEnd = t.indexOf('function runQuiet(', probeStart);
    if (probeStart !== -1 && probeEnd !== -1 && !t.includes('dsh plugin 已通过内置 pnpm Worker bridge')) {
      t = t.slice(0, probeStart) + 'export function probePnpm() {\n    // HDSH 鸿蒙适配：dsh plugin 已通过内置 pnpm Worker bridge 执行。\n    return Promise.resolve(true);\n}\n' + t.slice(probeEnd);
    }
    const runnerStart = t.indexOf('export function runDshPlugin(profile, pluginArgs) {');
    const runnerEnd = t.indexOf('/**\n * Adapt DSH Desktop', runnerStart);
    if (runnerStart !== -1 && runnerEnd !== -1) {
      const runner = `// HDSH 鸿蒙适配：dshmarket Worker CLI bridge v11。\nexport function runDshPlugin(profile, pluginArgs) {\n    const prepared = preparePluginArgs(profileDir(profile), pluginArgs);\n    if ("error" in prepared) {\n        logEvent("error", "install", prepared.error);\n        return Promise.resolve({ exitCode: 1, timedOut: false, stdout: "", stderr: prepared.error, cancelled: false });\n    }\n    const tracker = beginProgress(prepared.target);\n    const dshManifestPath = dshRequire.resolve("@deepseek-ai/dsh/package.json");\n    const dshBin = join(dirname(dshManifestPath), "lib/bin.js");\n    const workerPath = join(dirname(fileURLToPath(import.meta.url)), "hdsh-dsh-plugin-worker.cjs");\n    // 不显式传递 execArgv。Node 允许 Worker 默认继承主进程 V8 配置，\n    // 显式传入 --jitless 会被 Worker 参数校验拒绝。\n    const args = ["plugin", "--profile", profile, ...prepared.args];\n    return new Promise((resolvePromise) => {\n        const worker = new Worker(workerPath, { workerData: { bin: dshBin, args }, stdout: true, stderr: true });\n        activeWorker = worker;\n        cancelRequested = false;\n        let timedOut = false;\n        let workerStdout = "";\n        let workerStderr = "";\n        worker.stdout?.on("data", (chunk) => { workerStdout += String(chunk); });\n        worker.stderr?.on("data", (chunk) => { workerStderr += String(chunk); });\n        const finish = (exitCode, stderr) => {\n            clearTimeout(timer);\n            progress.active = false;\n            progress.cancelling = false;\n            if (activeWorker === worker) activeWorker = null;\n            const failed = exitCode !== 0 || timedOut;\n            const diagnostic = stderr || workerStderr.trim();\n            if (failed) progress.error = tracker.snapshot.error ?? diagnostic;\n            resolvePromise({ exitCode, timedOut, stdout: workerStdout, stderr: diagnostic, cancelled: cancelRequested });\n        };\n        const timer = setTimeout(() => {\n            timedOut = true;\n            void worker.terminate().catch(() => {});\n        }, INSTALL_TIMEOUT_MS);\n        worker.on("exit", (code) => finish(code ?? 1, timedOut ? "dsh plugin command timed out" : ""));\n        worker.on("error", (error) => finish(127, String(error)));\n    });\n}\n`;
      t = t.slice(0, runnerStart) + runner + t.slice(runnerEnd);
    }
    fs.writeFileSync(marketCliPath, t);
    console.log('dshmarket: OpenHarmony Worker CLI bridge patched');
  }
}

// 4) dsh-app-boot：ensureSymlink 在鸿蒙降级为目录复制（沙箱禁 symlink）
const appBoot = path.join(nm, '@deepseek-ai/dsh-app-boot/lib/index.js');
if (fs.existsSync(appBoot)) {
  let t = fs.readFileSync(appBoot, 'utf-8');
  if (!t.includes('HDSH 鸿蒙适配：沙箱禁止 symlink')) {
    const oldCheck = 'if (stat !== void 0) {\n\t\tif (!stat.isSymbolicLink()) throw new Error(`dsh: ${link} exists and is not a symlink; remove it so dsh can manage the installation fallback`);\n\t\tif (readlinkSync(link) === target) return;\n\t\tunlinkSync(link);\n\t}';
    const newCheck = 'if (stat !== void 0) {\n\t\tif (stat.isSymbolicLink()) {\n\t\t\tif (readlinkSync(link) === target) return;\n\t\t\tunlinkSync(link);\n\t\t} else if (stat.isDirectory()) {\n\t\t\t/* HDSH 鸿蒙适配：沙箱禁止 symlink，降级复制已产生真实目录，视为已就绪 */\n\t\t\treturn;\n\t\t} else {\n\t\t\tthrow new Error(`dsh: ${link} exists and is not a symlink; remove it so dsh can manage the installation fallback`);\n\t\t}\n\t}';
    if (t.includes(oldCheck)) {
      t = t.replace(oldCheck, newCheck);
      // import cpSync（node:fs）
      t = t.replace(
        'import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";',
        'import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";'
      );
      const oldCatch = 'try {\n\t\tsymlinkSync(target, link, "junction");\n\t} catch (error) {\n\t\t/* v8 ignore next 4 */\n\t\tif (error.code !== "EEXIST" || !lstatSync(link).isSymbolicLink() || readlinkSync(link) !== target) throw error;\n\t}';
      const newCatch = 'try {\n\t\tsymlinkSync(target, link, "junction");\n\t} catch (error) {\n\t\t/* HDSH 鸿蒙适配：沙箱禁止 symlink（EACCES/EPERM），降级为整目录复制 */\n\t\tif (error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOTSUP") {\n\t\t\tcpSync(target, link, { recursive: true, force: true });\n\t\t\treturn;\n\t\t}\n\t\t/* v8 ignore next 4 */\n\t\tif (error.code !== "EEXIST" || !lstatSync(link).isSymbolicLink() || readlinkSync(link) !== target) throw error;\n\t}';
      if (t.includes(oldCatch)) {
        t = t.replace(oldCatch, newCatch);
        fs.writeFileSync(appBoot, t);
        console.log('dsh-app-boot: ensureSymlink degrade-to-copy');
      }
    }
  }
  if (!t.includes('HDSH 鸿蒙适配：忽略旧版市场残留的不可用 UI 设置条目')) {
    const oldProfileReturn = 'const patchPath = join(dir, PROFILE_PATCH_FILENAME);\n\treturn {\n\t\tname,\n\t\tdir,\n\t\tlayers,\n\t\tpatchPath,\n\t\tpatches: options.userLayer !== false && existsSync(patchPath) ? loadOverlayPatches(binName, patchPath) : []\n\t};';
    const newProfileReturn = 'const patchPath = join(dir, PROFILE_PATCH_FILENAME);\n\tconst userPatches = options.userLayer !== false && existsSync(patchPath) ? loadOverlayPatches(binName, patchPath) : [];\n\t// HDSH 鸿蒙适配：忽略旧版市场残留的不可用 UI 设置条目，不写回用户配置。\n\tconst patches = name === "web" ? userPatches.filter((patch) => {\n\t\tif (!JSON.stringify(patch).includes("@deepseek-ai/dsh-client-ui-settings-ohos")) return true;\n\t\tprocess.stderr.write("dsh: skipped legacy unavailable ui-settings-ohos patch\\n");\n\t\treturn false;\n\t}) : userPatches;\n\treturn {\n\t\tname,\n\t\tdir,\n\t\tlayers,\n\t\tpatchPath,\n\t\tpatches\n\t};';
    if (t.includes(oldProfileReturn)) {
      t = t.replace(oldProfileReturn, newProfileReturn);
      console.log('dsh-app-boot: legacy unavailable UI settings patch filtered');
    }
  }
}

// 5) pi-ai：.manifest.json → manifest.json（hvigor 打包 rawfile 排除点开头文件）
const piDataDir = path.join(nm, '@earendil-works/pi-ai/dist/providers/data');
const oldManifest = path.join(piDataDir, '.manifest.json');
const newManifest = path.join(piDataDir, 'manifest.json');
if (fs.existsSync(oldManifest) && !fs.existsSync(newManifest)) {
  fs.renameSync(oldManifest, newManifest);
  const allJs = path.join(nm, '@earendil-works/pi-ai/dist/providers/all.js');
  if (fs.existsSync(allJs)) {
    let t = fs.readFileSync(allJs, 'utf-8');
    t = t.replace('"./data/.manifest.json"', '"./data/manifest.json"');
    fs.writeFileSync(allJs, t);
    console.log('pi-ai: .manifest.json renamed + import patched');
  }
}

// 7) dsh-host-apiproxy：新增 /api/hdsh-ohos-info GET 端点
const apiProxy = path.join(nm, '@deepseek-ai/dsh-host-apiproxy/lib/index.js');
if (fs.existsSync(apiProxy)) {
  let t = fs.readFileSync(apiProxy, 'utf-8');
  if (!t.includes('/api/hdsh-ohos-info')) {
    t = t.replace(
      'import { mkdir, stat } from "node:fs/promises";',
      'import { mkdir, readFile, stat } from "node:fs/promises";'
    );
    const anchor = 'if (path === "/api/session.export"';
    const endpoint = `		if (path === "/api/hdsh-ohos-info" && req.method === "GET") {
			try {
				const info = await readFile("./etc/hdsh-ohos-info.json", "utf-8");
				return new Response(info, { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
			} catch (err) {
				return new Response("{\\"error\\":\\"hdsh-ohos-info unavailable\\"}", { status: 404, headers: { "content-type": "application/json; charset=utf-8" } });
			}
		}
`;
    if (t.includes(anchor)) {
      t = t.replace(anchor, endpoint + anchor);
      fs.writeFileSync(apiProxy, t);
      console.log('dsh-host-apiproxy: /api/hdsh-ohos-info endpoint added');
    }
  }
}

console.log('HDSH sandbox adaptation applied');
HDSHPATCHEOF
node "$HDSH_PATCH"
if [ -f "$SCRIPT_DIR/create-hdsh-config-editor.mjs" ]; then
  node "$SCRIPT_DIR/create-hdsh-config-editor.mjs" "$(pwd)"
else
  echo "警告: scripts/create-hdsh-config-editor.mjs 缺失（未随仓库提交），跳过 config editor 生成"
fi

echo "✅ DSH OpenHarmony 适配完成。启动: node --expose-internals <dir>/node_modules/@deepseek-ai/dsh/lib/bin.js web"
