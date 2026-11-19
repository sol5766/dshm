#!/usr/bin/env node
/**
 * 门禁：**升级不得动用户数据**。
 *
 * ---------------------------------------------------------------------------
 * 为什么要有这条（上架前必答的问题）
 * ---------------------------------------------------------------------------
 * 应用每次升级都换一棵核心树（`<filesDir>/dsh/cores/<version>/`，实测约 350 MB/棵），
 * 而**用户的东西全在 `<filesDir>/dsh/home/`**：会话、设置、凭据、工作区注册、插件。
 * 两者的关系只有一句话：
 *
 *   `home/` 是**跨版本共享的唯一一份**；`cores/` 才是可换、可删的。
 *
 * 只要有任何一处代码把 `rmdir/rmSync/unlink` 指向 `home/`（或 `DSH_HOME`、`sessions`），
 * 一次升级就能把用户几年的数据清空 —— 这与 AGENTS.md 里那次 `hdc uninstall`
 * 事故是同一类不可逆损失。所以这条门禁判三件事：
 *
 *   A **静态无删除面**：产品代码（.ets / .js / .cjs / .mjs）里，凡是删除型调用
 *     （`rmdir*` / `unlink*` / `rmSync` / `rm(`,删除目录）**同一行或紧邻上下文**出现
 *     `home` / `DSH_HOME` / `HOME_DIR` / `sessions` / `workspace` 的，一律判红
 *     （白名单见 `ALLOW`，每条都要写清"删的是什么、为什么不是用户数据"）。
 *   B **布局不变量**：`CoreStore` 的层级注释里必须仍有
 *     「`home/` …跨版本共享，唯一一份」这句话 —— 它是这套设计的**书面契约**，
 *     改布局的人必须同时改这条判据（而不是悄悄把 home 挪进 cores/）。
 *   C **清理范围**：`CoreStore.evict()` 只允许删 `this.coreDir(v)`（即 `cores/<version>`）；
 *     出现别的删除目标即判红。
 *
 * ---------------------------------------------------------------------------
 * 为什么是静态判据而不是跑一遍
 * ---------------------------------------------------------------------------
 * "删了用户数据"在测试里是不可观测的（跑完看不出丢了什么，且测试环境本来就没有用户数据）。
 * 静态判据能覆盖**全部**删除调用点，而运行时判据只能覆盖走到的分支。
 * 行为层由真机验收（覆盖安装后核对 `files/dsh/home` 的会话数）兜底，见 docs/329。
 *
 * 用法：
 *   node tools/check-user-data-preserved.mjs
 *   node tools/check-user-data-preserved.mjs --self-test   # 变异体自检（必须判红）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');

/** 扫哪些目录（产品代码面）。`dist/`、`build/`、`node_modules` 是产物或三方，不进判据。 */
const SCAN_DIRS = ['hostruntime/src', 'entry/src', 'phone/src', 'platform/src', 'appstate/src', 'dshcompat/src', 'hostcore'];
const SCAN_EXT = new Set(['.ets', '.js', '.cjs', '.mjs', '.ts']);
const SKIP_SEG = ['/build/', '/node_modules/', '/oh_modules/', '/dist/'];

/**
 * 删除型调用的识别式。
 *
 * 只认"删目录/删文件"这几个 API 名，不做语义推断 —— 判据要能一眼看懂，
 * 而不是"看起来像在删"。`rm(` 单独列出是因为 `node:fs/promises` 的 `rm` 不带 Sync 后缀。
 */
const DELETE_RE = /\b(rmdirSync|rmdir|unlinkSync|unlink|rmSync|rm\(|deleteDir|removeDir)/;

/** 用户数据的识别式（出现在删除调用的同一行或紧邻注释里即视为可疑）。 */
const USER_DATA_RE = /(\bhome\b|DSH_HOME|HOME_DIR|sessions|workspace)/i;

/**
 * 白名单：这些删除**不是**用户数据，每条都写清"删的是什么"。
 *
 * 判据：命中行必须能在这张表里找到"文件名 + 删除目标"的对应项；
 * 找不到就判红 —— 新增删除调用的人必须来这里登记并说明理由，不能默默加。
 */
const ALLOW = [
  {
    file: 'hostruntime/src/main/ets/core/CoreStore.ets',
    what: 'staging 壳子与旧核心树',
    why: '`rmdir(staging)` / `rmdir(this.coreDir(v))` 删的全是 `cores/` 下的解包目录，'
      + '与 `home/` 并列而不相交；`home/` 在这份文件里只出现在**布局注释**中。',
    /**
     * 允许条件：该行的删除参数里**必须**是这两者之一。
     * 用正则卡死，避免"这条文件在白名单里 ⇒ 它删什么都放行"。
     */
    argOk: /rmdir\(\s*(staging|this\.coreDir\(v\))/,
  },
  {
    file: 'hostcore/app/dshm-user-rows.js',
    what: '市场配置行 / 过期隔离副本 / 启动失败标记',
    why: '`rmSync(rowsPath)` 删的是自动生成的 `MARKET_ROWS_FILENAME`（包卸载后的坏行）；'
      + '`rmSync(full, {recursive})` 只在 `KEEP_MS` 取证窗口**之外**删 `*.quarantine-<stamp>` 副本；'
      + '`rmSync(markerPath)` 删的是 `BOOT_FAIL_MARKER`。三者都是本进程自己写的中间产物，'
      + '`home/` 只作为它们的父目录出现。',
    argOk: /rmSync\(\s*(rowsPath|full|markerPath)/,
  },
  {
    file: 'hostcore/plugins/dshm-boot-rescue/lib/index.js',
    what: '原子重写的临时文件',
    why: '`mutateTextFile()` 先写 `<file>.tmp-<uuid>`，复核未被外部修改后 rename 到目标；'
      + '任何一步失败只 `unlink(temporary)` 清理这个**自己刚写的临时文件**。'
      + '用户行文件 / profile patch 本体只做 read / write / copyFile / rename，从不 unlink；'
      + '备份是 `.dshm-boot-rescue.bak`，同样只复制不删除。',
    argOk: /unlink\(\s*temporary\s*\)/,
  },
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (SKIP_SEG.some((s) => (full + '/').includes(s))) continue;
    if (ent.isDirectory()) walk(full, out);
    else if (SCAN_EXT.has(ent.name.slice(ent.name.lastIndexOf('.')))) out.push(full);
  }
  return out;
}

function failsOf(files) {
  const fails = [];
  const allowByFile = new Map(ALLOW.map((a) => [a.file, a]));

  /* ── A 静态无删除面 ── */
  for (const [rel, text] of Object.entries(files)) {
    const lines = text.split('\n');
    const allow = allowByFile.get(rel);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!DELETE_RE.test(line)) continue;
      /*
       * 跳过**注释行**：注释里出现 `unlink` 只是文字说明（本轮实测两条就是
       * "create+write+unlink 全部成功才算真能当工作区"这句解释性文案）。
       * 只判真正的代码行 —— 判据宁可窄一点，也不要靠白名单去吞掉注释噪音
       * （白名单一膨胀就没人看了）。
       */
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      /*
       * 跳过 **import / require 行**：`import { unlink } from 'node:fs/promises'`
       * 只是把函数引进作用域，本身不删任何东西；真正删哪里由调用行判。
       * 2026-11-08 新增 boot-rescue 时实测：导入行与文件头 `$DSH_HOME` 说明相邻，
       * 会被误判成"在用户数据上删除"。
       */
      if (/^\s*import\b/.test(line) || /^\s*(const|let|var)\s+.*\brequire\(/.test(line)) continue;
      /*
       * 跳过**字符串续行**：以 `+ '…'` 开头或整行只有字面量的行，是拼给人看的文案
       * （本轮剩下那两条就是 `+ '选择理由=lstat 判为目录且 …unlink 全部通过）'`）。
       * 它不是可执行的删除调用 —— 真调用一定带 `(` 紧跟标识符、且不以 `+` 开头。
       */
      if (/^\+\s*['"`]/.test(trimmed) || /^['"`]/.test(trimmed)) continue;
      /*
       * 上下文 = 本行 + 前两行。前两行是为了接住"先把路径拼到变量、下一行再删"的写法
       * （`const p = join(home, 'x'); rmSync(p)`）—— 那种形态本行没有 home 字样。
       */
      const ctx = [lines[i - 2] ?? '', lines[i - 1] ?? '', line].join('\n');
      if (!USER_DATA_RE.test(ctx)) continue;
      /* 白名单：文件名对得上，且**参数形态**也对得上才算安全 */
      if (allow !== undefined && allow.argOk.test(line)) continue;
      const reason = allow === undefined
        ? '该文件未在 ALLOW 登记'
        : `参数形态不匹配（期望 ${allow.argOk}）`;
      fails.push(`${rel}:${i + 1} 删除调用紧邻用户数据标识（${reason}）：${line.trim().slice(0, 110)}`);
    }
  }

  /* ── B 布局不变量（书面契约） ── */
  const coreStore = files['hostruntime/src/main/ets/core/CoreStore.ets'] ?? '';
  if (!/home\/\s+\$DSH_HOME：.*跨版本共享，唯一一份/.test(coreStore)) {
    fails.push('CoreStore.ets 的层级注释里缺少「home/ … 跨版本共享，唯一一份」这条契约'
      + '（改布局必须同步改本判据，而不是悄悄把 home 挪进 cores/）');
  }

  /* ── C 清理范围 ── */
  const evictAt = coreStore.indexOf('async evict(');
  if (evictAt < 0) {
    fails.push('CoreStore.ets 里找不到 evict()（清理旧树的唯一入口）');
  } else {
    const body = coreStore.slice(evictAt, evictAt + 1200);
    const rm = [...body.matchAll(/(?:fs\.)?(?:rmdir|rmSync|rm)\(\s*([^)\n]+)/g)];
    if (rm.length === 0) {
      fails.push('evict() 里没有任何删除调用（判据需要跟着实现走，请复核）');
    }
    for (const m of rm) {
      if (!/this\.coreDir\(/.test(m[1])) {
        fails.push(`evict() 删的不是 cores/<version>：${m[0].trim().slice(0, 90)}`);
      }
    }
  }
  return fails;
}

function loadFiles() {
  const files = {};
  for (const d of SCAN_DIRS) {
    for (const full of walk(join(ROOT, d))) {
      files[relative(ROOT, full).split('\\').join('/')] = readFileSync(full, 'utf8');
    }
  }
  return files;
}

function runGate(files, label) {
  const fails = failsOf(files);
  if (fails.length > 0) {
    console.log(`❌ ${label}：${fails.length} 项`);
    for (const f of fails) console.log('  · ' + f);
    return fails.length;
  }
  console.log(`✅ ${label}：产品代码零删除面指向 home/DSH_HOME/sessions；布局契约在位；evict 只删 cores/<version>`);
  return 0;
}

const files = loadFiles();
console.log(`# 门禁：升级不得动用户数据（扫 ${Object.keys(files).length} 个源文件）`);

if (!SELF_TEST) {
  const n = runGate(files, '用户数据保全');
  process.exit(n === 0 ? 0 : 1);
}

/* ── 自检：把代码改坏，断言必须判红 ── */
const mutations = [
  ['在 CoreStore 里加一条删 home 的调用（未登记）', (f) => {
    const k = 'hostruntime/src/main/ets/core/CoreStore.ets';
    f[k] = f[k].replace('async evict(', 'async nukeHome() {\n    await fs.rmdir(`${this.rootDir}/home`);\n  }\n  async evict(');
  }],
  ['在白名单文件里换掉删除参数（应被参数形态卡住）', (f) => {
    const k = 'hostruntime/src/main/ets/core/CoreStore.ets';
    f[k] = f[k].replace('await fs.rmdir(this.coreDir(v));', 'await fs.rmdir(`${this.rootDir}/home/sessions`);');
  }],
  ['删掉布局契约那句话', (f) => {
    const k = 'hostruntime/src/main/ets/core/CoreStore.ets';
    f[k] = f[k].replace(/跨版本共享，唯一一份/, '每版本各一份');
  }],
  ['让 evict 去删 home', (f) => {
    const k = 'hostruntime/src/main/ets/core/CoreStore.ets';
    f[k] = f[k].replace('await fs.rmdir(this.coreDir(v));', 'await fs.rmdir(`${this.rootDir}/home`);');
  }],
];
let failed = 0;
for (const [label, mutate] of mutations) {
  const copy = { ...files };
  const before = copy.hostruntime !== undefined ? JSON.stringify(copy) : '';
  mutate(copy);
  const changed = JSON.stringify(copy) !== before;
  const fails = changed ? failsOf(copy).length : 0;
  /* "改坏却没判红" 或 "变异没生效" 都算自检失败 */
  const ok = changed && fails > 0;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  判红：${label}（问题数 ${fails}${changed ? '' : '，变异未生效'}）`);
  if (!ok) failed += 1;
}
if (failed > 0) {
  console.log(`❌ 自检失败：${failed} 个变异体没有被判红`);
  process.exit(1);
}
console.log(`✅ 自检通过：${mutations.length} 个变异体全部判红`);
