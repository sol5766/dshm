#!/usr/bin/env node
/*
 * 门禁：**随包核心树里的三处端侧补丁必须真的在**（一条命令确认）
 *
 * ---------------------------------------------------------------------------
 * 为什么要有它（2026-10-05 审计）
 * ---------------------------------------------------------------------------
 * `tools/pack-core.mjs` 里有三组"端侧（鸿蒙）运行时补丁"，它们唯一的兜底是
 * **打包那一刻的 `die()`**：
 *
 *   ① `patchResourceAddressArmor()`（tools/pack-core.mjs:2427-2535）
 *      ArkWeb 把未注册的 `dsh-resource:` 当 opaque URL（hostname === ""、authority 被并进
 *      path、query 被并进 path），三处 client 侧解析各打一个标记：
 *        · `DSHM_RESOURCE_ARMOR_PROTOCOL` → dsh-client-resources/lib/client.js（protocolOf）
 *        · `DSHM_RESOURCE_ARMOR_PATH`     → dsh-client-ui-sidebar-right/lib/client.js（pathOf）
 *        · `DSHM_RESOURCE_ARMOR_SUBAGENT` → dsh-client-ui-subagent/lib/client.js（parseSubagentChatAddress）
 *   ② `patchPdfMapCompat()`（tools/pack-core.mjs:2599-2632）
 *      `Map/WeakMap.getOrInsert(Computed)` 在 ArkWeb 上缺失 ⇒ PDF 预览挂。主线程 chunk 工厂
 *      （`factory: (require) => {`）注入一次，内联 pdf worker 的 Blob 分片数组最前面再注入一次
 *      （worker 是独立 realm，不继承主线程原型补丁）⇒ `DSHM_MAP_COMPAT` **总共恰好 2 处**。
 *   ③ `patchSubprocessOpenharmony()`（tools/pack-core.mjs:2634-2682）
 *      终端巡检器在鸿蒙上"unsupported on platform openharmony" ⇒
 *        · `runner-launch-*.js` 的 createProcessInspector：`platform === "linux"` → 加 `|| "openharmony"`
 *        · `index.js` prepareShellActivity()：鸿蒙上跳过 shellActivity 注入
 *        · `index.js` inspectActivity()：idle 分支接受 `openharmony`
 *      三处各带 `DSHM_OPENHARMONY_SUBPROCESS`。
 *
 * 这三组补丁**只在"打包这一次"被校验**：`die()` 只在 pack-core 真的跑到那一步才有意义。
 * 一旦上游改版导致待替换片段漂移、或有人拿旧树/半成品树出包、或补丁被后来者改坏，
 * 仓库层没有任何独立门禁会红 —— 而同批的侧栏页签守卫有 `tools/check-sidebar-tab-id-guard.mjs`。
 * 本门禁把这个洞补上：**只读随包核心树**，逐条断言"标记在"且"上游反例已消失"。
 *
 * 判据分两类，缺一不可：
 *   · 正向：标记字符串在（补丁确实注入过）。
 *   · 反向：**上游原文的反例不得残留**（否则说明"补丁被半途回退/重复注入"，
 *     而正向的标记还留着 —— 只看正向会漏掉这种情况，这就是 `--self-test` 里 M4 用例的存在理由）。
 *
 * 用法：
 *   node tools/check-core-openharmony-patches.mjs              # 门禁
 *   node tools/check-core-openharmony-patches.mjs --self-test  # 变异自检（临时副本，跑完即删）
 * 退出码：0 通过 / 1 有真实问题 / 3 环境不具备（核心树未就位，不是失败）
 */
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
/*
 * 【目录名跟随配方，不写死版本】同 tools/check-sidebar-tab-id-guard.mjs:35-39 的同一课：
 * 写死 `dsh-core-<版本>` 会在升核心时静默指向旧树。
 */
const RECIPE = JSON.parse(readFileSync(join(ROOT, 'hostcore', 'core-recipe.json'), 'utf8'));
const CORE = join(ROOT, 'dist', 'core', 'work', `dsh-core-${RECIPE.coreVersion}`,
  'node_modules', '@deepseek-ai');

const SELF_TEST = process.argv.includes('--self-test');

/* ───────────────────────── 判据表（字符串逐字取自 pack-core 的注入函数） ───────────────────────── */

// ① 资源地址装甲：三处落地文件
const ARMOR_SITES = [
  {
    rel: 'dsh-client-resources/lib/client.js',
    marker: 'DSHM_RESOURCE_ARMOR_PROTOCOL',
    name: '资源地址装甲 · client-resources protocolOf() 的 opaque-URL authority 兜底',
    // pack-core.mjs:2438-2439 的 before（注入后必须整体消失）
    upstream: 'return parsed.hostname === "" ? void 0 : parsed.hostname.toLowerCase();',
    // pack-core.mjs:2449-2451 的 after 里的可判据片段
    patched: 'const armor = parsed.hostname === "" ? /^[a-z][a-z\\d+.-]*:\\/\\/([^/?#]*)/iu.exec(address) : null;',
  },
  {
    rel: 'dsh-client-ui-sidebar-right/lib/client.js',
    marker: 'DSHM_RESOURCE_ARMOR_PATH',
    name: '资源地址装甲 · sidebar-right pathOf() 剥掉被并进 path 的 authority',
    // pack-core.mjs:2468 的 before
    upstream: 'return new URL(address).pathname;',
    patched: 'if (parsed.hostname === "" && parsed.pathname.startsWith("//")) {',
  },
  {
    rel: 'dsh-client-ui-subagent/lib/client.js',
    marker: 'DSHM_RESOURCE_ARMOR_SUBAGENT',
    name: '资源地址装甲 · subagent parseSubagentChatAddress() 的 host/path/query 兜底',
    // pack-core.mjs:2507 的 before 里的判定（注入后改成用兜底出来的 host）
    upstream: 'url.hostname.toLowerCase() !== "subagentchat"',
    patched: 'const searchParams = new URLSearchParams(query);',
  },
];

// ② PDF：`DSHM_MAP_COMPAT` 恰好两处注入，且两处形态可区分
const PDF_REL = 'dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js';
const PDF_MARKER = 'DSHM_MAP_COMPAT';
// 主线程：MAP_COMPAT_SOURCE 每行加 `\t\t` 前缀（pack-core.mjs:2615-2617）⇒ 标记独占一行、前缀是真 tab
const PDF_MAIN_SITE_RE = /(^|\n)\t\t\/\* DSHM_MAP_COMPAT \*\//g;
// worker：同一份源码被 JSON.stringify 塞进 Blob 分片数组（pack-core.mjs:2621-2628）⇒ 标记被 `\n` 两个字面字符夹住
const PDF_WORKER_SITE = '\\n/* DSHM_MAP_COMPAT */\\n';
const PDF_FACTORY_ANCHOR = 'factory: (require) => {';
// 反向：注入后这个"裸 Blob 数组首元素"形态必须消失（pack-core.mjs:2621 的 blobAnchor 被整体替换）
const PDF_BARE_BLOB_ANCHOR = 'new Blob([_dsh_pdf_worker_default, ';

// ③ 终端：runner-launch-*.js + index.js
const SUBPROCESS_LIB = 'dsh-subprocess-local/lib';
const SUBPROCESS_MARKER = 'DSHM_OPENHARMONY_SUBPROCESS';
const INSPECTOR_PATCHED = 'if (platform === "linux" || platform === "openharmony" /* DSHM_OPENHARMONY_SUBPROCESS */) return new LinuxProcessInspector(arch, internals);';
const INSPECTOR_UPSTREAM = 'if (platform === "linux") return new LinuxProcessInspector(arch, internals);';
const SHELL_ACTIVITY_PATCHED = 'if (spec.shellActivity !== true || platform === "win32" || platform === "openharmony" /* DSHM_OPENHARMONY_SUBPROCESS */ || spec.argv.length !== 2 || spec.argv[1] !== "-i") return void 0;';
const SHELL_ACTIVITY_UPSTREAM = 'if (spec.shellActivity !== true || platform === "win32" || spec.argv.length !== 2 || spec.argv[1] !== "-i") return void 0;';
const IDLE_PATCHED = '(this.platform === "linux" || this.platform === "openharmony") /* DSHM_OPENHARMONY_SUBPROCESS */ && observed.complete === true && root === void 0';
const IDLE_UPSTREAM = 'this.platform === "linux" && observed.complete === true && root === void 0';

/* ───────────────────────── 审计（scope = node_modules/@deepseek-ai 目录；可重定向到临时副本） ───────────────────────── */

const countOf = (text, needle) => text.split(needle).length - 1;
const countRe = (text, re) => (text.match(re) ?? []).length;

function audit(scope) {
  const notes = [];
  const fails = [];
  const ok = (msg) => notes.push(`ok    ${msg}`);
  const bad = (msg) => fails.push(msg);

  const read = (rel) => {
    const p = join(scope, ...rel.split('/'));
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf8');
  };

  /* ── ① 资源地址装甲 ── */
  for (const site of ARMOR_SITES) {
    const text = read(site.rel);
    if (text === null) {
      bad(`${site.name}：缺文件 ${site.rel}`);
      continue;
    }
    const n = countOf(text, site.marker);
    if (n >= 1) ok(`${site.name}：${site.marker} ×${n}`);
    else bad(`${site.name}：${site.rel} 里没有 ${site.marker} —— pack-core 的资源地址补丁没跑（或上游实现已变而补丁静默失效）`);
    if (!text.includes(site.patched)) {
      bad(`${site.name}：找不到注入后的判据片段（${JSON.stringify(site.patched.slice(0, 60))}…）—— 补丁形态已变，门禁需同步复核`);
    }
    if (text.includes(site.upstream)) {
      bad(`${site.name}：**上游原文仍在**（${JSON.stringify(site.upstream.slice(0, 60))}…）—— 补丁被回退或被后续改动覆盖`);
    }
  }

  /* ── ② PDF Map 兼容：两处注入各一次 ── */
  {
    const text = read(PDF_REL);
    if (text === null) {
      bad(`PDF Map 兼容：缺文件 ${PDF_REL}`);
    } else {
      const total = countOf(text, PDF_MARKER);
      if (total === 2) ok(`PDF Map 兼容：${PDF_MARKER} 共 2 处（主线程 + 内联 worker 各一）`);
      else bad(`PDF Map 兼容：${PDF_REL} 里 ${PDF_MARKER} 出现 ${total} 次，规定 2 次 —— 两处注入至少少了一处（worker 少注入 ⇒ 端侧 PDF 仍然白屏）`);

      const mainSite = countRe(text, PDF_MAIN_SITE_RE);
      if (mainSite === 1) ok('PDF Map 兼容：主线程 chunk 工厂处 1 处（真换行 + tab 缩进形态）');
      else bad(`PDF Map 兼容：主线程 chunk 工厂处出现 ${mainSite} 次（规定 1 次）`);

      const workerSite = countOf(text, PDF_WORKER_SITE);
      if (workerSite === 1) ok('PDF Map 兼容：内联 pdf worker 的 Blob 字面量处 1 处（JSON 转义形态）');
      else bad(`PDF Map 兼容：内联 pdf worker 的 Blob 字面量处出现 ${workerSite} 次（规定 1 次）—— worker 是独立 realm，漏了它就是端侧 PDF 仍然白屏`);

      const factory = countOf(text, PDF_FACTORY_ANCHOR);
      if (factory === 1) ok(`PDF Map 兼容：chunk 工厂入口唯一（${JSON.stringify(PDF_FACTORY_ANCHOR)} ×1）`);
      else bad(`PDF Map 兼容：chunk 工厂入口 ${JSON.stringify(PDF_FACTORY_ANCHOR)} 出现 ${factory} 次（pack-core 的 die 要求恰好 1 次）`);

      const bareBlob = countOf(text, PDF_BARE_BLOB_ANCHOR);
      if (bareBlob === 0) ok('PDF Map 兼容：上游裸 Blob 锚点已消失（反向断言）');
      else bad(`PDF Map 兼容：上游裸锚点 ${JSON.stringify(PDF_BARE_BLOB_ANCHOR)} 仍在（×${bareBlob}）—— worker 处的注入被回退`);
    }
  }

  /* ── ③ 终端：runner-launch-*.js + index.js ── */
  {
    const libDir = join(scope, ...SUBPROCESS_LIB.split('/'));
    if (!existsSync(libDir)) {
      bad(`终端 openharmony 补丁：缺目录 ${SUBPROCESS_LIB}`);
    } else {
      const runners = readdirSync(libDir).filter((n) => /^runner-launch-.*\.js$/.test(n));
      if (runners.length === 0) {
        bad(`终端 openharmony 补丁：${SUBPROCESS_LIB} 下找不到 runner-launch-*.js（pack-core 的 die 条件之一）`);
      }
      for (const name of runners) {
        const text = readFileSync(join(libDir, name), 'utf8');
        const n = countOf(text, SUBPROCESS_MARKER);
        if (n >= 1) ok(`终端 openharmony 补丁 · ${name}：${SUBPROCESS_MARKER} ×${n}`);
        else bad(`终端 openharmony 补丁 · ${name}：没有 ${SUBPROCESS_MARKER} —— createProcessInspector 的 openharmony 分支没打上`);
        if (text.includes(INSPECTOR_PATCHED)) ok(`终端 openharmony 补丁 · ${name}：平台判定已含 openharmony（复用 LinuxProcessInspector）`);
        else bad(`终端 openharmony 补丁 · ${name}：找不到含 openharmony 的巡检器判定 —— 端侧会报 unsupported on platform openharmony`);
        // 反向：上游那条"裸 linux 判定"不得残留（注意：同文件另有 1 处无关的 `platform === "linux" &&`
        // 上游逻辑，所以这里只否掉**这一条完整语句**，不能泛化成"任何 linux 判定"）
        if (text.includes(INSPECTOR_UPSTREAM)) {
          bad(`终端 openharmony 补丁 · ${name}：上游裸判定 ${JSON.stringify(INSPECTOR_UPSTREAM)} 仍在 —— 补丁被回退`);
        }
      }

      const indexRel = `${SUBPROCESS_LIB}/index.js`;
      const text = read(indexRel);
      if (text === null) {
        bad(`终端 openharmony 补丁：缺文件 ${indexRel}`);
      } else {
        const n = countOf(text, SUBPROCESS_MARKER);
        if (n >= 2) ok(`终端 openharmony 补丁 · index.js：${SUBPROCESS_MARKER} ×${n}（shellActivity + idle 两处注入）`);
        else bad(`终端 openharmony 补丁 · index.js：${SUBPROCESS_MARKER} 只出现 ${n} 次，规定 2 次（shellActivity 跳过 + idle 分支）`);

        if (text.includes(SHELL_ACTIVITY_PATCHED)) ok('终端 openharmony 补丁 · index.js：prepareShellActivity() 已含 openharmony 短路');
        else bad('终端 openharmony 补丁 · index.js：prepareShellActivity() 没有 openharmony 短路 —— 鸿蒙上仍会注入 shellActivity');
        if (text.includes(IDLE_PATCHED)) ok('终端 openharmony 补丁 · index.js：inspectActivity() 的 idle 分支已含 openharmony');
        else bad('终端 openharmony 补丁 · index.js：inspectActivity() 的 idle 分支不含 openharmony');

        // 反向：三条上游原文都不得残留
        for (const [label, upstream] of [
          ['prepareShellActivity() 的裸判定', SHELL_ACTIVITY_UPSTREAM],
          ['inspectActivity() 的裸 linux 分支', IDLE_UPSTREAM],
          ['createProcessInspector() 的裸 linux 判定', INSPECTOR_UPSTREAM],
        ]) {
          if (text.includes(upstream)) {
            bad(`终端 openharmony 补丁 · index.js：上游原文仍在（${label}）—— ${JSON.stringify(upstream.slice(0, 70))}…`);
          }
        }
      }
    }
  }

  return { notes, fails };
}

/* ───────────────────────── 正常门禁 ───────────────────────── */

function runGuard() {
  if (!existsSync(CORE)) {
    console.error(`前置条件缺失（exit 3，不算失败）：核心树未就位 —— ${CORE} 不存在。`);
    console.error('先跑 `node tools/pack-core.mjs --skip-install` 生成核心工作树，再跑本门禁。');
    process.exit(3);
  }
  const { notes, fails } = audit(CORE);
  console.log('════════ 核心树端侧补丁门禁（资源地址装甲 · PDF Map 兼容 · 终端 openharmony） ════════');
  console.log(`核心树：${CORE}`);
  for (const n of notes) console.log(n);
  if (fails.length > 0) {
    console.log('\n失败项：');
    for (const f of fails) console.log(`  FAIL  ${f}`);
    console.log(`\nRESULT: ${notes.length} passed, ${fails.length} failed`);
    process.exit(1);
  }
  console.log(`\nRESULT: ${notes.length} passed, 0 failed —— 三处端侧补丁都在树里，且上游反例均已消失。`);
}

/* ───────────────────────── --self-test：变异副本，证明门禁真的会红 ───────────────────────── */

// 自检要覆盖的落地文件（与 audit() 的判据一一对应）
const SELFTEST_FILES = [
  ...ARMOR_SITES.map((s) => s.rel),
  PDF_REL,
  `${SUBPROCESS_LIB}/index.js`,
];

function copyInto(scope, rel) {
  const src = join(CORE, ...rel.split('/'));
  const dst = join(scope, ...rel.split('/'));
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, readFileSync(src));
  return dst;
}

function selfTest() {
  if (!existsSync(CORE)) {
    console.error(`前置条件缺失（exit 3）：自检需要真核心树作基线 —— ${CORE} 不存在。`);
    process.exit(3);
  }
  const tmp = mkdtempSync(join(tmpdir(), 'dshm-core-openharmony-patches-selftest-'));
  const scope = join(tmp, 'node_modules', '@deepseek-ai');
  let failures = 0;
  const case_ = (name, pass, detail) => {
    if (!pass) failures += 1;
    console.log(`${pass ? 'ok  ' : 'FAIL'}：${name}（${detail}）`);
  };

  try {
    for (const rel of SELFTEST_FILES) copyInto(scope, rel);
    // subprocess-local 的 runner-launch-*.js 文件名是哈希，按真树复制（注意 lib/ 下还有 types/ 子目录）
    const libDir = join(CORE, ...SUBPROCESS_LIB.split('/'));
    for (const ent of readdirSync(libDir, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      const rel = `${SUBPROCESS_LIB}/${ent.name}`;
      if (!SELFTEST_FILES.includes(rel)) copyInto(scope, rel);
    }

    // 基线：未变异的副本必须全绿 —— 否则"变异后变红"不能归因于变异
    const base = audit(scope);
    case_('基线：未变异的临时副本全绿（证明变异才是变红的原因）',
      base.fails.length === 0, `fails=${base.fails.length}${base.fails.length ? ' :: ' + base.fails[0] : ''}`);

    const restore = new Map(); // path → 原始字节
    const mutate = (rel, fn) => {
      const p = join(scope, ...rel.split('/'));
      if (!restore.has(p)) restore.set(p, readFileSync(p, 'utf8'));
      writeFileSync(p, fn(readFileSync(p, 'utf8')), 'utf8');
      return p;
    };
    const restoreAll = () => {
      for (const [p, text] of restore) writeFileSync(p, text, 'utf8');
      restore.clear();
    };

    // 变异体：每个用例 mutate(scope) 后必须让 audit() 变红，且失败里含期望关键词。
    // 【注意变异要真的把标记"改没"】不能改成 `原标记 + "_X"` —— 那是原标记的超串，
    // 计数类判据照样命中，用例会变成假绿。
    const mutantRunner = () => readdirSync(libDir).filter((n) => /^runner-launch-.*\.js$/.test(n))[0];
    const cases = [
      {
        name: 'M1 资源装甲标记（client-resources）被改名 → ①红',
        run: () => mutate(ARMOR_SITES[0].rel,
          (t) => t.replace('DSHM_RESOURCE_ARMOR_PROTOCOL', 'DSHM_RESOURCE_ARMOR_PR0TOCOL')),
        expect: /client-resources/,
      },
      {
        name: 'M2 侧栏装甲标记被改名 → ①红',
        run: () => mutate(ARMOR_SITES[1].rel,
          (t) => t.replace('DSHM_RESOURCE_ARMOR_PATH', 'DSHM_RESOURCE_ARMOR_P4TH')),
        expect: /sidebar-right/,
      },
      {
        name: 'M3 pdf worker 那处注入被抹掉（总数 2→1）→ ②红',
        run: () => mutate(PDF_REL,
          (t) => t.replace('\\n/* DSHM_MAP_COMPAT */\\n', '\\n/* DSHM_MAP_C0MPAT */\\n')),
        expect: /出现 1 次，规定 2 次|Blob 字面量处出现 0 次/,
      },
      {
        name: 'M4 runner-launch 补丁被整体回退（标记与 openharmony 判定一起没）→ ③红',
        run: () => {
          const rel = `${SUBPROCESS_LIB}/${mutantRunner()}`;
          mutate(rel, (t) => t
            .replace(INSPECTOR_PATCHED, INSPECTOR_UPSTREAM)
            .replace(/\s*\/\* DSHM_OPENHARMONY_SUBPROCESS \*\//g, ''));
          return rel;
        },
        expect: /没有 DSHM_OPENHARMONY_SUBPROCESS|找不到含 openharmony 的巡检器判定/,
      },
      {
        name: 'M5 **只**把上游裸判定塞回去（标记仍在）→ 反向断言单独红',
        run: () => {
          const rel = `${SUBPROCESS_LIB}/${mutantRunner()}`;
          mutate(rel, (t) => t + '\n' + INSPECTOR_UPSTREAM + '\n');
          return rel;
        },
        expect: /上游裸判定/,
        // 这一条是"反向断言不是摆设"的证据：正向标记全在，只有反例残留
        expectMarkerStillOk: true,
      },
    ];

    for (const c of cases) {
      restoreAll();
      const rel = c.run();
      const res = audit(scope);
      const hit = res.fails.some((f) => c.expect.test(f));
      case_(c.name, res.fails.length > 0 && hit,
        `rel=${rel} fails=${res.fails.length}${res.fails.length ? ' :: ' + res.fails[0].slice(0, 110) : '（没红 —— 该判据是恒真的摆设）'}`);
      if (c.expectMarkerStillOk) {
        const markerNotes = res.notes.filter((n) => n.includes('DSHM_OPENHARMONY_SUBPROCESS'));
        case_('M5 前提复核：M5 之后正向标记断言仍为 ok（所以这次红只可能来自反向断言）',
          markerNotes.length >= 2, `markerNotes=${markerNotes.length}`);
      }
    }
    restoreAll();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  case_('变异件已删除（不留在树里、也不留在临时目录）', !existsSync(tmp), `tmp=${tmp} exists=${existsSync(tmp)}`);

  console.log(`\nRESULT: self-test ${failures === 0 ? 'PASS' : 'FAIL'}（${failures} 项不合格）`);
  process.exit(failures === 0 ? 0 : 1);
}

if (SELF_TEST) selfTest();
else runGuard();
