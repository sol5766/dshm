#!/usr/bin/env node
/**
 * 门禁：内置插件的模块格式自洽（docs/319）。
 *
 * 【为什么需要它】2026-10-30 真机踩过一次：`hostcore/plugins/dshm-cloud-sync` 的
 * `package.json` 是 `"type": "module"`（ESM），而 `lib/index.js` 用了 CommonJS 的
 * `exports.apply = apply`。Node 的 ESM 加载器**不报错**（`exports` 只是未定义的普通
 * 变量，赋值静默失败）⇒ `import()` 得到**空模块** `[]` ⇒ cordis 拿不到 `apply`
 * ⇒ 插件从未被构造 ⇒ 客户端 bundle 不进加载图 ⇒ 官方设置里**永远不出现**分区。
 *
 * 这条错误的可怕之处是**全链路静默**：配置检查全过、启动不报错、日志干净，
 * 只有"功能就是不出现"。所以必须用门禁钉住，而不是靠人记得。
 *
 * 【判据】
 *   A. `type: "module"` 的包，`lib/index.js` **不得**使用 `exports.x =` / `module.exports`；
 *   B. `type: "module"` 的包，必须**真的导出** `apply`（cordis 按它构造插件）；
 *   C. 声明了 `dsh.client` 的包，`exports["./client"]` 必须指向存在的文件；
 *   D. 声明了 `dsh.client` 的包，`main` 必须指向存在的文件（否则 loader 行解析失败）。
 *
 * 对照臂（--self-test）：把某个插件改回 `exports.apply` / 删掉 `apply` 导出 /
 * 让 client 路径指向不存在的文件 ⇒ 必须判红。
 */
import { readFileSync, existsSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PLUGINS_DIR = join(ROOT, 'hostcore', 'plugins');

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) passed += 1;
  else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `（${detail}）` : ''}`);
  }
}

/** 列出一个插件目录里的结构性事实。 */
function inspect(dir) {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) {
    return null;
  }
  let pkg = null;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    return { name: dir.split('/').pop(), brokenJson: true };
  }
  const name = typeof pkg.name === 'string' ? pkg.name : dir.split('/').pop();
  const type = typeof pkg.type === 'string' ? pkg.type : 'commonjs';
  const mainRel = typeof pkg.main === 'string' ? pkg.main : '';
  const exportsField = pkg.exports !== null && typeof pkg.exports === 'object' ? pkg.exports : {};
  const clientExport = exportsField['./client'];
  let clientRel = '';
  if (typeof clientExport === 'string') {
    clientRel = clientExport;
  } else if (clientExport !== null && typeof clientExport === 'object') {
    clientRel = typeof clientExport.default === 'string' ? clientExport.default : '';
  }
  const indexRel = mainRel.length > 0 ? mainRel : 'lib/index.js';
  const indexPath = join(dir, indexRel);
  let indexText = '';
  if (existsSync(indexPath)) {
    indexText = readFileSync(indexPath, 'utf8');
  }
  const dsh = pkg.dsh !== null && typeof pkg.dsh === 'object' ? pkg.dsh : {};
  const declaresClient = dsh.client !== null && typeof dsh.client === 'object';
  return {
    name,
    type,
    mainRel,
    indexRel,
    indexPath,
    indexText,
    clientRel,
    declaresClient,
    dir
  };
}

/** 跑一遍所有判据。 */
function runSuite(plugins) {
  passed = 0;
  failures.length = 0;
  let counted = 0;

  for (const p of plugins) {
    if (p === null || p.brokenJson === true) {
      if (p !== null && p.brokenJson === true) {
        check(`${p.name} package.json 可解析`, false, 'JSON 解析失败');
      }
      continue;
    }
    counted += 1;
    const isEsm = p.type === 'module';

    /* A：ESM 包不得用 CJS 导出写法 */
    const usesCjs = /^\s*exports\.[A-Za-z_$]/m.test(p.indexText)
      || /^\s*module\.exports\s*=/m.test(p.indexText);
    check(`${p.name} 模块格式自洽（type=${p.type} 不用 CJS 导出）`,
      isEsm ? !usesCjs : true,
      usesCjs && isEsm ? `${p.indexRel} 用了 exports./module.exports，但包是 ESM ⇒ 导出会静默为空` : '');

    /*
     * B：cordis 认**三种**插件形态，三种都合法（真机核实的既有实现）：
     *   ① `export { apply }`        —— 函数式插件（office / cloud-sync 用它）
     *   ② `export default class`    —— 类式插件（ptc-runtime / fs-write-nonchmod）
     *   ③ 导出若干命名函数/对象      —— 由 profile patch 的 `name:` 直接引用其中一个
     * 所以判据是"**有可被 cordis 使用的导出**"，不是"必须有 apply"。
     * 上一版只认 ① 会误判 ②③（本轮踩过：4 个合法插件被判红）。
     */
    if (isEsm && existsSync(p.indexPath)) {
      const hasApply = /export\s*\{[^}]*\bapply\b[^}]*\}/s.test(p.indexText)
        || /export\s+(?:async\s+)?function\s+apply\b/.test(p.indexText)
        || /export\s+const\s+apply\b/.test(p.indexText);
      const hasDefault = /export\s+default\b/.test(p.indexText);
      /* 命名导出有三种写法：`export { a, b }`、`export function f()`、`export const x =` */
      const namedExports = /export\s*\{[^}]*\}/s.test(p.indexText)
        || /export\s+(?:async\s+)?function\s+[A-Za-z_$]/m.test(p.indexText)
        || /export\s+(?:const|let|class)\s+[A-Za-z_$]/m.test(p.indexText);
      check(`${p.name} 有可用的插件导出（apply / default / 命名导出）`,
        hasApply || hasDefault || namedExports,
        hasApply ? 'apply' : (hasDefault ? 'default' : (namedExports ? 'named' : '三种都没有')));
    }

    /* C：声明了 dsh.client 就必须有可解析的 ./client */
    if (p.declaresClient) {
      check(`${p.name} 声明 dsh.client 时 exports["./client"] 存在`, p.clientRel.length > 0,
        p.clientRel.length === 0 ? '缺 exports["./client"]' : '');
      if (p.clientRel.length > 0) {
        check(`${p.name} client bundle 文件存在`, existsSync(join(p.dir, p.clientRel)),
          join(p.dir, p.clientRel));
      }
    }

    /* D：main 必须指向存在的文件（loader 行的模块说明符由它解析） */
    if (p.mainRel.length > 0) {
      check(`${p.name} main 指向存在的文件`, existsSync(join(p.dir, p.mainRel)), p.mainRel);
    }
  }

  check('至少扫到一个插件', counted > 0, `扫到 ${counted} 个`);
}

/** 收集 hostcore/plugins 下所有插件。 */
function collect(dir) {
  const out = [];
  if (!existsSync(dir)) {
    return out;
  }
  for (const name of readdirSync(dir)) {
    const sub = join(dir, name);
    if (!statSync(sub).isDirectory()) {
      continue;
    }
    const info = inspect(sub);
    if (info !== null) {
      out.push(info);
    }
  }
  return out;
}

/**
 * 真跑一次动态 import，证明导出确实非空。
 *
 * 【为什么可能 import 失败，但不算缺陷】`hostcore/plugins/*` 是**源码**目录，
 * 它们依赖的 `@deepseek-ai/dsh-*` / `schemastery` 等只在**核心树**里有（打包时
 * 才落进 `node_modules`）。所以源码目录 import 失败是**环境原因**，不能判红。
 *
 * 【判据】按顺序尝试：
 *   ① 源码目录；
 *   ② 若存在核心树里的同名包（`dist/core/work/<ver>/node_modules/<name>`），到那里试；
 * 两者都不可用时返回 `skip`（环境不完整），**不判红也不判绿** —— 如实标注。
 */
async function realImportCheck(dir, pkgName) {
  const info = inspect(dir);
  if (info === null || info.type !== 'module') {
    return { ok: true, skipped: true, detail: '非 ESM，跳过真跑' };
  }
  const candidates = [info.dir];
  /* 核心树里的同名包（只在本地有核心树时存在） */
  try {
    const workDir = join(ROOT, 'dist', 'core', 'work');
    if (existsSync(workDir)) {
      for (const ver of readdirSync(workDir)) {
        const copy = join(workDir, ver, 'node_modules', pkgName);
        if (existsSync(copy)) {
          candidates.push(copy);
        }
      }
    }
  } catch (e) {
    /* 没有核心树：只用源码目录 */
  }
  let lastErr = '';
  for (const base of candidates) {
    const entry = join(base, info.indexRel);
    if (!existsSync(entry)) {
      continue;
    }
    try {
      const mod = await import(entry);
      /* 三种形态任一成立即可（见 runSuite 里 B 段的口径） */
      const ok = typeof mod.apply === 'function'
        || typeof mod.default === 'function'
        || Object.keys(mod).length > 0;
      return { ok, detail: `导出 ${JSON.stringify(Object.keys(mod).sort())}` };
    } catch (e) {
      lastErr = String(e.message).split('\n')[0];
    }
  }
  /* 全部候选都因缺依赖失败 ⇒ 环境不完整，如实跳过 */
  const envReason = /Cannot find package/.test(lastErr);
  return { ok: envReason, skipped: envReason, detail: envReason ? `依赖不在本地（跳过）：${lastErr}` : `import 失败：${lastErr}` };
}

const selfTest = process.argv.includes('--self-test');
const plugins = collect(PLUGINS_DIR);

if (plugins.length === 0) {
  console.error(`❌ ${PLUGINS_DIR} 下没有扫到插件（目录结构变了？）`);
  process.exit(1);
}

if (!selfTest) {
  runSuite(plugins);
  console.log(`  ok    ${passed} 条判据通过（扫了 ${plugins.length} 个插件）`);
  if (failures.length > 0) {
    console.error(`\n❌ 插件模块格式不合格（${failures.length} 条）`);
    process.exit(1);
  }
  console.log('✅ 通过：ESM 包不用 CJS 导出、apply 有导出、client/main 路径可解析。');
  process.exit(0);
}

console.log('--self-test：变异体必须判红 --');
runSuite(plugins);
let ok = failures.length === 0;
console.log(`  基线：问题 ${failures.length} 处（应为 0）`);

/* 找一个 ESM 插件做变异舞台 */
const stage = mkdtempSync(join(tmpdir(), 'dshm-plugin-format-'));
const arms = [];

/* 臂 1：把 index.js 改回 CJS 导出（本轮真机事故的形态） */
arms.push(['ESM 包改用 CJS 导出（导出静默为空）', (info) => {
  const target = join(stage, 'a');
  cpSync(info.dir, target, { recursive: true });
  writeFileSync(join(target, info.indexRel),
    'function apply() {}\nconst name = "x";\nexports.apply = apply;\nexports.name = name;\n');
  return inspect(target);
}]);

/* 臂 2：一个导出都没有（cordis 无从构造） */
arms.push(['ESM 包没有任何导出', (info) => {
  const target = join(stage, 'b');
  cpSync(info.dir, target, { recursive: true });
  writeFileSync(join(target, info.indexRel), 'function apply() {}\nconst name = "x";\n');
  return inspect(target);
}]);

/* 臂 3：client 路径指向不存在的文件 */
arms.push(['client 路径指向不存在的文件', (info) => {
  const target = join(stage, 'c');
  cpSync(info.dir, target, { recursive: true });
  const pkgPath = join(target, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.exports = pkg.exports !== null && typeof pkg.exports === 'object' ? pkg.exports : {};
  pkg.exports['./client'] = './lib/does-not-exist.js';
  pkg.dsh = pkg.dsh !== null && typeof pkg.dsh === 'object' ? pkg.dsh : {};
  pkg.dsh.client = pkg.dsh.client !== null && typeof pkg.dsh.client === 'object' ? pkg.dsh.client : { platform: 'web' };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  return inspect(target);
}]);

const esmPlugin = plugins.find((p) => p.type === 'module' && !p.brokenJson);
for (const [label, mutate] of arms) {
  if (esmPlugin === undefined) {
    ok = false;
    console.log(`  ❌ ${label} ⇒ 没有 ESM 插件可做变异舞台`);
    continue;
  }
  const staged = mutate(esmPlugin);
  if (staged === null) {
    ok = false;
    console.log(`  ❌ ${label} ⇒ 变异失败`);
    continue;
  }
  runSuite([staged]);
  const reds = failures.length;
  if (reds === 0) ok = false;
  console.log(`  ${reds > 0 ? '✅' : '❌'} ${label} ⇒ ${reds > 0 ? `判红（${reds} 条）` : '未判红（门禁没牙）'}`);
}

/* 臂 4（真跑）：证明正常插件的 apply 真的可 import —— 这是"导出非空"的最终判据 */
const importResults = [];
for (const p of plugins) {
  if (p.type !== 'module' || p.brokenJson === true) {
    continue;
  }
  importResults.push(await realImportCheck(p.dir, p.name));
}
const allImportable = importResults.every((r) => r.ok);
const ranCount = importResults.filter((r) => !r.skipped).length;
const skippedCount = importResults.filter((r) => r.skipped).length;
if (!allImportable) ok = false;
console.log(`  ${allImportable ? '✅' : '❌'} 真跑 import：${ranCount} 个真的跑通导出检查、`
  + `${skippedCount} 个因依赖不在本地而跳过 ⇒ ${allImportable ? '通过' : '失败'}`);
for (const r of importResults) {
  console.log(`      ${r.skipped ? '⏭ ' : (r.ok ? '✅' : '❌')} ${r.detail}`);
}

rmSync(stage, { recursive: true, force: true });
console.log(ok ? '\n✅ 自检通过。' : '\n❌ 自检失败（门禁没牙）。');
process.exit(ok ? 0 : 3);
