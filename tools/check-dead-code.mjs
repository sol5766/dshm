/**
 * 死代码门禁（P2-6，E350）：搬迁留下的"壳"不许留在原地。
 *
 * ## 存在理由（这一条是好几轮手工查出来的，现在必须自动）
 *
 * 2026-09-15 的两轮重构里，同一类缺陷**反复出现**，而且**编译、界面、既有门禁全都无感**：
 *   · **E345**：`Index.ets` 里三个零调用的 `@Builder`（`hubBanner` / `coreTabContent` / `tabContent`）
 *     ——内容早就搬进 AppShell 与两束组件，只剩宿主这份壳；`@Entry` 组件永远不会渲染它们，
 *     但读代码的人会以为"这里还画着这个"；
 *   · **E346**：拆走「技能」「预设」两段后，宿主那段**唯一的读者**还活着（6 个 prop/回调 + 3 个临时态
 *     + 一个只服务于它的 `agentGroups()`）；
 *   · **E346b**：`settingsStates` 是一条**从头到尾没人读的死链**（中枢快照 → `Index.@State` →
 *     主区门面 → 假门面成员 → `SettingsPane.states`），每一层都在"忠实地转发一个没人要的字段"。
 *
 * 三次都是我手工写 Python 扫出来的。手工会漏、会随轮次漂移 ⇒ 固化成门禁。
 *
 * ## 判定规则（四条，都是"零使用"级别的硬事实）
 *
 * 1. **零使用 import**：`import { A, B } from 'x'` 里的名字在**本文件其余部分**一次都没出现；
 * 2. **零使用 `@Builder`**：与 `tools/check-builder-recursion.mjs` 同源的检测——
 *    体内/全文件都没有 `this.<名字>(` 调用点；
 * 3. **零使用成员**：组件里 `@Prop` / `@State` / `@Provide` / 回调 prop（`name: (…) => void = () => {}`）
 *    / `private` 方法，在本文件里只出现 1 次（= 只有那一行声明）；
 * 4. **门面字段零读点**（跨文件，E367）：`export interface *Facade` 的字段在**整仓**里搜不到一个
 *    `.字段`。前三条只看本文件，而门面通道的写法天生跨文件（**声明与读者在子组件、实现在宿主**）——
 *    只看一个文件既数不到读者也数不到写者。
 *
 * ## 三条刻意写下来的边界（避免误报，也避免"把门禁写成噪音"）
 *
 * · **只看"本文件其余部分"**：跨文件的成员使用不做数据流分析（那会误报）；
 * · **保守排除**：`export` 出来的东西、`build()` / `aboutToAppear` / `onPageShow` 这类**框架回调**、
 *   名字以 `_` 开头的（显式"我知道它没用到"）、以及只有声明没有实现的接口成员，都不判；
 * · **`--self-test` 是注入式的**：样例里既有真缺陷，也有各类**必须不误报**的写法
 *   （被 `as` 改名、只在字符串里出现、被 `.点前缀` 使用、跨文件同名、export 导出；
 *   门面那一条另配 4 例：真死通道 / 读者在别的文件 / 只写不读 / 声明行 `dead-exempt:`）。
 *   门禁必须先在已知坏版本上红过一次才算证明——本轮用 `git show` 取修前的 `Index.ets` 做归真验证。
 *
 * 用法：
 *   node tools/check-dead-code.mjs              # 检查（有死代码即非零退出）
 *   node tools/check-dead-code.mjs --list       # 列出被判定的声明总数
 *   node tools/check-dead-code.mjs --self-test  # 注入式自检
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const SCAN_ROOTS = ['entry/src/main/ets', 'appstate/src/main/ets'];

/** 框架会自己调的生命周期/入口名：即使"没人调"也不是死代码 */
const FRAMEWORK_NAMES = new Set([
  'constructor',
  'build', 'aboutToAppear', 'aboutToDisappear', 'onPageShow', 'onPageHide', 'onBackPress',
  'onWindowStageCreate', 'onWindowStageDestroy', 'onForeground', 'onBackground', 'onDestroy',
  'onCreate', 'onConfigurationUpdate', 'onConfigurationUpdated'
]);

/** 剥掉注释与字符串（与 check-builder-recursion 同一套实现；字符串里的名字不算"使用"） */
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
 * 把字符串字面量换成空串，但**保留模板串里的 `${…}` 插值**。
 *
 * 【为什么不能整段抹掉模板串】`Text(\`Host ${this.authority} · 逻辑流 ${this.streams}\`)`
 * 这类"显示串里的成员"是**真正的使用**；整段抹掉会把 `authority`/`streams`/`jobsTick`
 * 全判成死代码（本门禁第一版就这么误报了 3 处）。
 * 而真正只被调试串读到的调用（`this.record(\`… ${this.countConfiguredCredentials()}\`)`）
 * 因此仍会被判出来，由声明行 `// dead-exempt:` 说明豁免——那正是我们要的那条边界。
 */
function stripStringsOnly(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '`') {
      i++;
      let depth = 0;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          depth++;
          out += ' ${';
          i += 2;
          continue;
        }
        if (depth > 0 && src[i] === '}') {
          depth--;
          out += '}';
          i++;
          continue;
        }
        if (depth === 0 && src[i] === '`') break;
        if (depth > 0) out += src[i];
        i++;
      }
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
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

/** 该名字在 [text] 里出现几次（标识符边界；允许 `.` 前缀——`.borderRadius(Radius.M)` 算使用） */
function countName(text, name) {
  const re = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, '\\$')}(?![\\w])`, 'g');
  const m = text.match(re);
  return m === null ? 0 : m.length;
}

/** 该文件里 `import { … }` 出现的名字（含多行块） */
function importedNames(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^import\s/.test(lines[i])) continue;
    let block = lines[i];
    let j = i;
    while (!/from\s+['"]/.test(block) && j + 1 < lines.length) {
      j++;
      block += ' ' + lines[j];
    }
    const m = block.match(/^import\s+(?:type\s+)?\{([^}]*)\}\s*from/);
    if (m !== null) {
      for (const raw of m[1].split(',')) {
        /*
         * 【必须剥掉行内 `//` 注释，否则假阳性】
         * 真实案例（2026-09-27）：Index.ets 的 appstate import 块里有一行
         *   `// pi-ai 路由（自定义模型 API）：校验、路径与载荷构造都在纯逻辑模块里（有 fixture 断言）`
         * 它被 `split(',')` 当成一个"名字"，于是门禁报
         *   `零使用 import：// pi-ai 路由（自定义模型 API）…`
         * —— 指向的是一句注释，不是符号。**假阳性比漏报更糟**：
         * 它让人不再相信这份报告（本文件头注释已写过同类教训）。
         * 所以先按 `//` 截断；再要求是合法标识符（含 `A as B`），否则视为解析噪声跳过。
         */
        const t = raw.split('//')[0].trim();
        if (t.length === 0) continue;
        if (!/^[A-Za-z_$][\w$]*(\s+as\s+[A-Za-z_$][\w$]*)?$/.test(t)) continue;
        // `A as B` ⇒ 本地名是 B
        const local = t.split(/\s+as\s+/).pop().trim();
        out.push({ name: local, line: i + 1, end: j + 1 });
      }
    }
    i = j;
  }
  return out;
}

/** 组件成员声明（@Prop/@State/回调 prop/private 方法），返回 {name, line, kind} */
function declaredMembers(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m = l.match(/^\s{2}@(?:Prop|State|Provide|Consume|Link|ObjectLink)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (m !== null) {
      out.push({ name: m[1], line: i + 1, kind: 'state/prop' });
      continue;
    }
    m = l.match(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\([^)]*\)\s*=>\s*void\s*=\s*\(\)\s*=>\s*\{/);
    if (m !== null) {
      out.push({ name: m[1], line: i + 1, kind: '回调 prop' });
      continue;
    }
    m = l.match(/^\s{2}private\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (m !== null) {
      out.push({ name: m[1], line: i + 1, kind: '私有方法' });
    }
  }
  return out;
}

/** `@Builder` 方法名（含单行与多行写法） */
function builderNames(stripped) {
  const out = [];
  const re = /@Builder\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    out.push({ name: m[1], line: stripped.slice(0, m.index).split('\n').length });
  }
  return out;
}

/**
 * `export interface XFacade { … }` 的顶层字段（两空格缩进的 `name:` / `name?:`）。
 *
 * 【为什么只盯 `*Facade`】它是本仓约定俗成的**写回通道**（子组件 → 宿主：值快照 + setter +
 * 回调闭包）。这类字段的读者**必然**长成 `this.f.<名字>` 或 `this.f.<名字>(...)`，
 * 所以"整仓搜不到一个 `.名字`"就是死通道的硬事实。数据型接口不能这么判 —— 它们
 * 常被整体传参（`{ title, kind }`）而不是逐字段读，那样判会误报。
 */
export function facadeFields(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^export interface (\w*Facade\w*)\s*\{/);
    if (m === null) continue;
    for (let j = i + 1; j < lines.length && !/^\}/.test(lines[j]); j++) {
      const f = lines[j].match(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\??\s*:/);
      if (f !== null) out.push({ iface: m[1], name: f[1], line: j + 1 });
    }
  }
  return out;
}

/**
 * 门面字段的**读点**检查（跨文件）：`.<字段>` 在整仓里出现 0 次即为死通道。
 *
 * 【为什么必须跨文件】声明的读者在**子组件**里，而实现（`field: this.x`）在宿主里 ——
 * 只看一个文件既数不到读者、也数不到写者。语料 = 本次扫描的全部文件（entry + appstate，
 * 六份 `*Facade` 都在其中）。
 *
 * 【为什么这是"零误报"级别的判据】字段名前面那个 `.` 就是"有人在读它"。搜不到任何
 * `.名字`，只能是**没有任何调用点** —— 那正是本门禁要拦的"通道有、没消费者"。
 * 反方向的漏报（同名点读出现在别的对象上）是已知且可接受的：宁可漏，不可吵。
 */
export function deadFacadeFields(sources) {
  const corpus = sources.map((x) => stripStringsOnly(x.text)).join('\n');
  const out = [];
  for (const src of sources) {
    const lines = src.text.split('\n');
    for (const f of facadeFields(src.text)) {
      const re = new RegExp(`\\.${f.name}(?![\\w$])`, 'g');
      if ((corpus.match(re) || []).length > 0) continue;
      const lineText = lines[f.line - 1];
      const above = f.line >= 2 ? lines[f.line - 2] : '';
      if (lineText.includes('dead-exempt:') || above.includes('dead-exempt:')) continue;
      out.push({ file: src.path, line: f.line, name: f.name, kind: `门面字段零读点（${f.iface}）` });
    }
  }
  return out;
}

/** 分析单个文件的文本，返回违规清单 */
export function scanText(text) {
  const lines = text.split('\n');
  const stripped = stripCommentsAndStrings(text);
  const strippedLines = stripped.split('\n');
  const violations = [];

  // ① 零使用 import
  for (const imp of importedNames(lines)) {
    let count = 0;
    for (let k = 0; k < strippedLines.length; k++) {
      if (k + 1 >= imp.line && k + 1 <= imp.end) continue;
      count += countName(strippedLines[k], imp.name);
    }
    if (count === 0) {
      violations.push({ line: imp.line, name: imp.name, kind: '零使用 import' });
    }
  }

  // ② 零使用 @Builder
  // 【为什么单独再剥一次字符串】`@Builder` 的真实调用点有时在**模板串**里
  // （例如 `ForEach` 的键 `${job.id}:${this.jobsTick}` 读了一个 @Prop）——
  // 那种写法下"名字出现次数"仍只有 1，会被误判。故这一条把字符串也剥掉再数。
  const noStrings = stripStringsOnly(text);
  for (const b of builderNames(stripped)) {
    if (FRAMEWORK_NAMES.has(b.name)) continue;
    if (countName(noStrings, b.name) <= 1 && noStrings.indexOf(`this.${b.name}(`) < 0) {
      violations.push({ line: b.line, name: b.name, kind: '零使用 @Builder' });
    }
  }

  // ③ 零使用成员
  // 【@Watch 回调必须从**原始文本**里取】剥注释/字符串之后 `@Watch('onSessionChanged')` 里的
  // 方法名就没了，于是被 `@Watch` 引用的方法会被误判成"零使用"（本门禁第一版就误报了 2 处）。
  const watchNames = new Set();
  for (const m of text.matchAll(/@Watch\(\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*\)/g)) {
    watchNames.add(m[1]);
  }
  for (const d of declaredMembers(lines)) {
    if (d.name.startsWith('_') || FRAMEWORK_NAMES.has(d.name) || watchNames.has(d.name)) continue;
    // 行内豁免：声明行（或它上面那行注释）写 `dead-exempt: 理由` 即不判。
    // 为什么需要它：有些成员**只被调试轨迹读到**（例如把"快照里已配置几项"写进旁路日志），
    // 剥掉字符串后就"没人用"了——那是**真实的可观测性**，不该为门禁删掉。
    const lineText = lines[d.line - 1];
    const above = d.line >= 2 ? lines[d.line - 2] : '';
    if (lineText.includes('dead-exempt:') || above.includes('dead-exempt:')) continue;
    // 计数同样用**剥掉字符串**的文本：只在显示串里出现的成员（`Host ${this.authority}`）
    // 是真的在用，不该报；而只在调试串里出现的调用会报出来，由声明行写 `// dead-exempt:` 说明豁免。
    if (countName(noStrings, d.name) <= 1) {
      violations.push({ line: d.line, name: d.name, kind: `零使用成员（${d.kind}）` });
    }
  }

  return violations;
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

/** 注入式自检：正例必须命中，五类反例必须不误报 */
function selfTest() {
  const cases = [
    {
      what: '零使用 import（E345 的真实形态：搬迁后宿主还留着导入）',
      text: `import { HubBanner } from '../HubBanner';\nstruct A {\n  build() {\n    Text('x')\n  }\n}`,
      expect: 1
    },
    {
      what: '被 `as` 改名后仍在使用（不误报）',
      text: `import { fileIo as fs } from '@kit.CoreFileKit';\nstruct A {\n  go() {\n    fs.openSync('x');\n  }\n}`,
      expect: 0
    },
    {
      what: '只在点前缀里使用（`.borderRadius(Radius.M)` —— 不误报）',
      text: `import { Radius } from 'appstate';\nstruct A {\n  build() {\n    Column().borderRadius(Radius.M)\n  }\n}`,
      expect: 0
    },
    {
      what: '只在注释/字符串里出现（不误报：剥注释与字符串）',
      text: `import { Sp } from 'appstate';\nstruct A {\n  // Sp 曾经用在这里\n  build() {\n    Text('Sp')\n  }\n}`,
      expect: 1
    },
    {
      what: '零使用 @Builder（E345）',
      text: `struct A {\n  @Builder\n  hubBanner() {\n    Text('x')\n  }\n  build() {\n    Text('y')\n  }\n}`,
      expect: 1
    },
    {
      what: '`build()` 调 Builder（不误报：框架名与真实调用点都在）',
      text: `struct A {\n  @Builder\n  tabContent() {\n    Text('x')\n  }\n  build() {\n    this.tabContent()\n  }\n}`,
      expect: 0
    },
    {
      what: '零使用成员：@State / 回调 prop / private 方法（E346 的真实形态）',
      text: `struct A {\n  @State fbFor: string = '';\n  onPresetCopy: (from: string, name: string) => void = () => {\n  };\n  private agentGroups(): string[] {\n    return [];\n  }\n  build() {\n    Text('x')\n  }\n}`,
      expect: 3
    },
    {
      what: '成员被用（不误报）',
      text: `struct A {\n  @State fbFor: string = '';\n  build() {\n    Text(this.fbFor)\n  }\n}`,
      expect: 0
    },
    {
      what: '框架回调与 `_` 前缀不判（不误报）',
      text: `struct A {\n  aboutToAppear(): void {\n  }\n  private _unused(): void {\n  }\n  build() {\n    Text('x')\n  }\n}`,
      expect: 0
    }
  ];
  const facadeCases = [
    {
      what: '门面字段零读点（E367 的真实形态：写回通道声明了、没人调）',
      sources: [
        { path: 'a.ets', text: 'export interface AFacade {\n  confirmingDeletePath: string;\n  setConfirmingDeletePath: (v: string) => void;\n}\n' },
        { path: 'b.ets', text: 'struct X {\n  @Prop f: AFacade;\n  build() {\n    Text(this.f.confirmingDeletePath)\n  }\n}\n' }
      ],
      expect: 1
    },
    {
      what: '门面字段在**别的文件**里被调用（不误报：读者在子组件）',
      sources: [
        { path: 'a.ets', text: 'export interface AFacade {\n  onToggle: () => void;\n}\n' },
        { path: 'b.ets', text: 'struct X {\n  @Prop f: AFacade;\n  go() {\n    this.f.onToggle();\n  }\n}\n' }
      ],
      expect: 0
    },
    {
      what: '门面字段只被宿主写入、没有任何读者（仍算死通道）',
      sources: [
        { path: 'a.ets', text: 'export interface AFacade {\n  panelId: string;\n}\n' },
        { path: 'b.ets', text: 'const facade: AFacade = {\n  panelId: this.nav.selectedRightPanel\n};\n' }
      ],
      expect: 1
    },
    {
      what: '声明行写 `dead-exempt:` ⇒ 有意保留（不误报）',
      sources: [
        { path: 'a.ets', text: 'export interface AFacade {\n  reserved: string; // dead-exempt: 预留给下一轮的远端面板\n}\n' },
        { path: 'b.ets', text: 'struct X {\n  build() {\n    Text(\'x\')\n  }\n}\n' }
      ],
      expect: 0
    }
  ];
  for (const c of facadeCases) {
    const got = deadFacadeFields(c.sources).length;
    const ok = got === c.expect;
    if (!ok) bad++;
    console.log(`${ok ? '✅' : '❌'} ${c.what}：期望 ${c.expect}，实得 ${got}`);
  }

  let bad = 0;
  for (const c of cases) {
    const got = scanText(c.text).length;
    const ok = got === c.expect;
    if (!ok) bad++;
    console.log(`${ok ? '✅' : '❌'} ${c.what}：期望 ${c.expect}，实得 ${got}`);
  }
  console.log('');
  if (bad > 0) {
    console.log(`❌ 自检失败 ${bad} 项：检测器本身不可信。`);
    process.exit(1);
  }
  console.log('✅ 自检通过：会命中真实缺陷，且各类「看着像使用」的写法都不误报。');
}

function main(argv) {
  if (argv.includes('--self-test')) {
    console.log('# 死代码门禁自检（注入式）\n');
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
  let checked = 0;
  let facadeChecked = 0;
  const sources = [];
  for (const f of files) {
    const rel = relative(ROOT, f).replace(/\\/g, '/');
    const text = readFileSync(f, 'utf8');
    const lines = text.split('\n');
    checked += importedNames(lines).length + declaredMembers(lines).length;
    facadeChecked += facadeFields(text).length;
    sources.push({ path: rel, text: text });
    for (const v of scanText(text)) violations.push({ file: rel, ...v });
  }
  // ④ 门面字段零读点（跨文件）：读者在子组件、写在宿主 —— 必须整仓一起数
  for (const v of deadFacadeFields(sources)) violations.push(v);

  console.log('# 死代码门禁：搬迁留下的壳不许留在原地\n');
  console.log(`扫描文件 ${files.length} 个 · 判定声明 ${checked} 处 · 门面字段 ${facadeChecked} 个`);
  if (argv.includes('--list')) {
    console.log('（--list 只打印统计；逐条清单见违规列表）');
  }

  if (violations.length === 0) {
    console.log('✅ 无死代码：没有零使用的 import / @Builder / 组件成员，也没有零读点的门面字段。');
    process.exit(0);
  }

  console.log(`❌ 检出 ${violations.length} 处零使用声明（E345 / E346 / E346b / E367 都是这一类）：\n`);
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line}  ${v.kind}：${v.name}`);
  }
  console.log('\n处置：搬迁完成时**必须**删掉宿主那份壳（连同它的导入）。');
  console.log('      确认"被搬走的东西仍有人挂载"之后再删；本门禁只看本文件内的使用。');
  process.exit(1);
}

// 入口判定：`import.meta.main` 较新 Node 才有；老版本回退到脚本路径比对
const isMain = (import.meta.main === true)
  || (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]));
if (isMain) main(process.argv.slice(2));
