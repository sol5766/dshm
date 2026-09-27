/**
 * `@Builder` 自递归门禁：**任何一个 `@Builder` 体内都不许出现自己的名字**。
 *
 * ## 存在理由（E343，真机实测）
 *
 * 2026-09-15，Mate 70 Pro+（PLA-AL10 / API 24）冷启后点一下界面即被系统杀掉：
 *
 *   RangeError: Stack overflow!
 *       at mainContent entry (entry/src/main/ets/view/shell/MainShell.ets:407:4)
 *       at anonymous entry  (entry/src/main/ets/view/shell/MainShell.ets:405:7)   ← `this.mainContent(...)`
 *       at ifElseBranchUpdateFunction (…/stateMgmt.js:5356:1)
 *       at anonymous entry  (entry/src/main/ets/view/shell/MainShell.ets:404:12)  ← `} else {`
 *       …（同一组帧重复 250+ 次）
 *
 * 根因是一行"看起来像交回上层继续分派"的兜底：
 *
 *   @Builder mainContent(compact: boolean) {
 *     if (…) { … } else if (…) { … } else {
 *       this.mainContent(this.compact)   // ❌ 兜底又把自己叫一遍
 *     }
 *   }
 *
 * 这类写法**编译通过、静态阅读也像对的**（人脑把它读成"继续往上走"），
 * 只在运行时以"栈溢出 + 进程被杀"的形式暴露；而 `@Builder` 体内的 `if/else`
 * 每帧只占几十字节，栈要几千帧才炸——**症状与代码位置离得极远**。
 *
 * ## 判定规则
 *
 * 对每个 `@Builder` 方法体（含成员装饰器形式的 `@Builder foo() {}`），
 * 在**剥掉注释与字符串**之后，若出现 `this.<自己>(`，即为违规。
 *
 * 不算违规的两种写法（都**不是**自递归）：
 *   - `build() { this.tabContent(this.compact) }`：`build` 不是 `@Builder`，是组件入口，调别的 Builder 正常；
 *   - 不同组件里的同名 Builder（各文件独立判定）。
 *
 * ## 兜底分支该写成什么
 *
 * **把剩下的面板交给真正拥有它们的那一束组件**，而不是回头再问自己。典型：
 *   兜底 → `WorkspacePane(...)` / `TabContentView({ f: this.f.tabFacade })`；
 * 若某次分派确实"没有剩下的情况"，就写空分支并注明为什么不可能是空。
 *
 * 用法：
 *   node tools/check-builder-recursion.mjs              # 检查，有违规则非零退出
 *   node tools/check-builder-recursion.mjs --self-test  # 自检：注入一段自递归，证明检测器会命中
 *   node tools/check-builder-recursion.mjs --list       # 打印扫到的 @Builder 数
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();

/** 被扫描的源码根：视图层都在 `entry`，`appstate` 是纯模型（无 UI 语法）但一并扫无妨 */
const SCAN_ROOTS = ['entry/src/main/ets', 'appstate/src/main/ets'];

/**
 * 剥掉注释与字符串字面量。
 *
 * 为什么必须剥：说明性注释里写"这里曾经是 `this.mainContent(this.compact)`"是**必要的**
 * （E343 的始末要写在代码旁边），不剥注释的门禁会把它当成违规，
 * 于是人就会去删注释——**门禁把文档逼没了**。字符串同理（提示文案里可能有 `this.x(`）。
 */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 从 `{` 开始做花括号配平，返回方法体（含花括号）。
 *
 * 【为什么不用正则】`@Builder` 体里嵌套的 `Column() { … }` 会立刻骗过任何非配平的匹配，
 * 而"配平错了"的表现是**漏报**（把体切短），正是最危险的方向（门禁看起来是绿的）。
 */
function braceSpan(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return { start: openIdx, end: i + 1 };
    }
  }
  return undefined;
}

/**
 * 找出文件里所有 `@Builder` 方法。
 *
 * 只认两条形态（本仓的既有写法）：
 *   `@Builder\n  name(args) {`（方法装饰器）
 * 其余形态（`@BuilderParam`、`@Builder` 局部函数）不在此门禁范围：
 * `@BuilderParam` 是**注入点**不是定义，且本仓真机实测其注入会崩（E118），已不采用。
 */
function findBuilders(src) {
  const found = [];
  const re = /@Builder\s+(?:public\s+|private\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    const open = src.indexOf('{', m.index + m[0].length);
    if (open < 0) continue;
    const span = braceSpan(src, open);
    if (span === undefined) continue;
    found.push({ name, line: src.slice(0, m.index).split('\n').length, body: src.slice(span.start, span.end) });
  }
  return found;
}

/** 在已剥注释/字符串的 Builder 体里找 `this.<自己>(` */
function selfCalls(builder) {
  const hits = [];
  const re = new RegExp(`this\\s*\\.\\s*${builder.name}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(builder.body)) !== null) {
    hits.push({
      name: builder.name,
      line: builder.line + builder.body.slice(0, m.index).split('\n').length - 1,
      column: m.index - builder.body.lastIndexOf('\n', m.index - 1)
    });
  }
  return hits;
}

/** 扫描入口：返回 {builders, violations} */
export function scanText(text) {
  const stripped = stripCommentsAndStrings(text);
  const builders = findBuilders(stripped);
  const violations = [];
  for (const b of builders) {
    for (const v of selfCalls(b)) violations.push(v);
  }
  return { builders, violations };
}

function collect(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (e.name.endsWith('.ets')) out.push(p);
  }
}

/** 注入式自检：证明"注入的自递归会被命中、注释与合法调用不被误判" */
function selfTest() {
  const cases = [
    {
      what: '兜底又把自己叫一遍（E343 的真实形态）',
      text: `@Component\nstruct A {\n  @Builder\n  mainContent(c: boolean) {\n    if (x) {\n      Text('a')\n    } else {\n      this.mainContent(this.compact)\n    }\n  }\n}`,
      expect: 1
    },
    {
      what: '注释里的同一行（必须不命中——否则门禁会把说明性文档逼没）',
      text: `struct A {\n  @Builder\n  mainContent(c: boolean) {\n    // 曾经是 this.mainContent(this.compact)，真机栈溢出\n    /* this.mainContent(c) */\n    Text('a')\n  }\n}`,
      expect: 0
    },
    {
      what: '合法形态：build 调 Builder、兜底调别的 Builder',
      text: `struct A {\n  @Builder\n  mainContent(c: boolean) {\n    if (x) {\n      Text('a')\n    } else {\n      TabContentView({ f: this.f.tabFacade })\n    }\n  }\n  build() {\n    this.mainContent(this.compact)\n  }\n}`,
      expect: 0
    },
    {
      what: '同名字符串字面量（不命中）',
      text: `struct A {\n  @Builder\n  p() {\n    Text('this.p(')\n  }\n}`,
      expect: 0
    },
    {
      what: '同名 Builder 在别的组件里（不命中：各文件独立）',
      text: `struct A {\n  @Builder\n  p() {\n    Text('a')\n  }\n}`,
      expect: 0
    }
  ];
  let bad = 0;
  for (const c of cases) {
    const got = scanText(c.text).violations.length;
    const ok = got === c.expect;
    if (!ok) bad++;
    console.log(`${ok ? '✅' : '❌'} ${c.what}：期望 ${c.expect} 命中，实得 ${got}`);
  }
  console.log('');
  if (bad > 0) {
    console.log(`❌ 自检失败 ${bad} 项：检测器本身不可信，不能用来判代码。`);
    process.exit(1);
  }
  console.log('✅ 自检通过：检测器会命中自递归，且不误判注释 / 字符串 / 跨组件同名。');
}

/** 主流程。**只在被直接执行时跑**（`import` 本模块只为了拿 `scanText` 做回归验证时不该有副作用）。 */
function main(argv) {
  if (argv.includes('--self-test')) {
    console.log('# Builder 自递归门禁自检（注入式）\n');
    selfTest();
    process.exit(0);
  }

  const files = [];
  for (const r of SCAN_ROOTS) {
    const abs = join(ROOT, r);
    try {
      statSync(abs);
    } catch {
      continue;
    }
    collect(abs, files);
  }

  const violations = [];
  let builderCount = 0;
  for (const f of files) {
    const rel = relative(ROOT, f).replace(/\\/g, '/');
    const { builders, violations: vs } = scanText(readFileSync(f, 'utf8'));
    builderCount += builders.length;
    for (const v of vs) violations.push({ file: rel, ...v });
  }

  console.log('# Builder 自递归门禁：@Builder 体内不许出现自己的名字\n');
  console.log(`扫描文件 ${files.length} 个（${SCAN_ROOTS.join(', ')}）· @Builder ${builderCount} 个`);
  if (argv.includes('--list')) {
    for (const f of files) {
      const { builders } = scanText(readFileSync(f, 'utf8'));
      if (builders.length > 0) {
        console.log(`  ${relative(ROOT, f).replace(/\\/g, '/')}  [${builders.map((b) => b.name).join(', ')}]`);
      }
    }
    console.log('');
  }

  if (violations.length === 0) {
    console.log('✅ 无违规：没有 @Builder 直接或间接地把自己叫回来。');
    process.exit(0);
  }

  console.log(`❌ 检测到 ${violations.length} 处 @Builder 自递归（真机上表现为 RangeError: Stack overflow 杀进程）：\n`);
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line}:${v.column}  this.${v.name}(…)`);
  }
  console.log('\n处置：兜底分支改成渲染**真正拥有这些内容的那一束组件**（例如 TabContentView / WorkspacePane），');
  console.log('      或在确实没有剩余情况时写空分支并注明原因；不要"交回给自己继续分派"。');
  process.exit(1);
}

// 入口判定：`import.meta.main` 在较新 Node 可用；老版本回退到"脚本真实路径比对"。
const isMain = (import.meta.main === true)
  || (process.argv[1] !== undefined
    && fileURLToPath(import.meta.url) === resolve(process.argv[1]));
if (isMain) main(process.argv.slice(2));
