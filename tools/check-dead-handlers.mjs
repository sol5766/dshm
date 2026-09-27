/**
 * 死按钮扫描器（E130）。
 *
 * 【为什么需要它】"界面上有、点了没反应"是本项目反复出现的缺陷形态：
 * 早期是「添加」工作区（死入口）、「市场」按钮、`onPickModel` 空实现……
 * 每一次都是**靠人眼在截图里发现**的。这个脚本把这件事变成可复跑的检查。
 *
 * ─────────────── 2026-09-27 收紧判据（重要）───────────────
 *
 * 【旧判据的问题】它报"所有跨行空箭头"，于是报出 **180 处** —— 而其中
 * **177 处是回调 prop 的必需默认值**，不是死按钮：
 *
 *     onPickFolder: () => void = () => {     ← 声明处的默认值
 *     };
 *
 * ArkTS 组件若回调 prop 无默认值，父组件不传就编译失败。所以这种写法是**规定动作**，
 * 与"点了没反应"无关。180 处的报告量会让这个门禁**彻底失去信号**
 * （人不再逐条看，真问题就淹在里面了 —— 本文件的历史教训正是"假阳性比漏报更糟"）。
 *
 * 【新判据：只看"调用处"，不看"声明处"】
 *   · **声明默认值** = `名字: (…) => void = () => {…}`（有 `= () =>` 且体为空）
 *     ⇒ 看它在**本文件 build 里有没有被调用**；调用了就是正常默认值，不报。
 *   · **调用处内联空实现** = 在组件构造里 `onX: () => { },`
 *     ⇒ 这是把子组件的回调**主动接成空**，子组件一调就"点了没反应"，
 *       **这才是要找的死按钮**（真实案例：`MainShell` 把 `ConnectPane` 的
 *       `onStartDiscovery` 接成空 ⇒ "开始发现"按钮点了没反应）。
 *
 * 【仍保留的能力】空箭头若出现在**既不是声明默认值、也不在组件构造参数里**的位置，
 * 一律照报（宁可多问一句）。
 *
 * 用法：node tools/check-dead-handlers.mjs [--all]
 *   默认只报 UI 目录（entry/platform 的 ets 视图与页面）；
 *   `--all` 扫全部 ets 源码（含 appstate/dshcompat，那里的空实现可能是**有意**的默认值）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** 仓库相对路径（正斜杠），用于与豁免清单比对。 */
const rel2 = (f) => relative(process.cwd(), f).replace(/\\/g, '/');

const ROOT = process.cwd();
const ALL = process.argv.includes('--all');
const ROOTS = ALL
  ? ['entry/src/main/ets', 'platform/src/main/ets', 'appstate/src/main/ets', 'dshcompat/src/main/ets']
  : ['entry/src/main/ets', 'platform/src/main/ets'];

/** 递归收集 .ets 文件 */
function filesUnder(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...filesUnder(full));
    } else if (name.endsWith('.ets')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 去掉注释与字符串字面量，避免把 `=> {}` 写在注释里误报。
 *
 * 【必须保留换行】第一版把块注释整段换成空格 ⇒ 行号与原文错位，
 * 于是报出一堆"空实现"其实指向 `@Prop`、注释行（假阳性比漏报更糟：
 * 它会让人不再相信这份报告）。这里按字符替换、**保留每个 `\n`**。
 */
function stripNoise(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * 【豁免清单：有意为空的"回调 prop 默认值"】
 *
 * 有些空箭头是**必需的默认值**，不是"点了没反应"：
 * ArkTS 组件若回调 prop 无默认值，父组件**不传就会编译失败**（而父组件本来
 * 可能不关心这个回调）。所以子组件写 `onX: () => void = () => {};` 是**规定动作**。
 *
 * 它们与"死按钮"的区别：**回调是否被 build 里的控件调用**。
 * 已逐条核对（2026-09-27）：下面每个都**确实被本文件 build 调用**：
 *   · WorkspacePane: onSelectWorkspace@214 onPickFolder@172 onToggleDirectory@247
 *                    onOpenFile@250 onAttachFile@265 onBack@119,135
 *   · InputDevices:  `return () => {}` 是"监听注册失败时返回一个**空的解绑函数**"，
 *                    与 `inputDevice.off` 的正常解绑形成同一契约（调用方无需判空）。
 *
 * 【为什么不干脆删掉这些空实现】删了会让父组件必须传值 ⇒ 编译失败；
 * 或者改成 `onX?: () => void` 可选 ⇒ 调用点全要加 `?.` 判空，改动面更大且更易错。
 * 因此**豁免 + 写明理由**，而不是为了门禁变绿去改能跑的代码。
 *
 * 【豁免必须带理由】只写文件+行号会让后来人无法判断该不该续期；
 * 每条都注明"为什么它是有意的"。
 */
const ALLOW = [
  { file: 'platform/src/main/ets/system/InputDevices.ets', line: 92, why: '监听注册失败时返回的"空解绑函数"，与正常解绑同一契约' },
];

const isAllowed = (file, line) => {
  const norm = rel2(file);
  return ALLOW.some((a) => norm === a.file && a.line === line);
};

/**
 * 该行（或其紧邻上一行）是否为"回调 prop 的**声明默认值**"形态。
 *
 * 单行形态：`onX: (a: T) => void = () => {`
 * 跨行形态（MessageRow 的 onSubmitFeedback 就是这种）：
 *     onX: (a: T, b: U) => void =
 *       (a: T, b: U) => {
 * ⇒ 判据要**同时看本行与上一行**，否则跨行形态会被误判成"调用处空实现"。
 */
const isPropDefault = (rawLines, i) => {
  const cur = rawLines[i] ?? '';
  const prev = rawLines[i - 1] ?? '';
  /* 本行含 `= () =>` */
  if (/\)\s*=>\s*void\s*=\s*\(\)\s*=>\s*\{\s*$/.test(cur)) return true;
  if (/\)\s*=>\s*void\s*=\s*\(\)\s*=>\s*\{\s*\}\s*;?\s*$/.test(cur)) return true;
  /* 跨行：上一行以 `= ` 结尾（参数类型那行），本行是裸箭头体 */
  if (/\)\s*=>\s*void\s*=\s*$/.test(prev) && /\)\s*=>\s*\{\s*$/.test(cur)) return true;
  return false;
};

const hits = [];
for (const dir of ROOTS) {
  for (const file of filesUnder(join(ROOT, dir))) {
    const raw = readFileSync(file, 'utf8');
    const clean = stripNoise(raw);
    const lines = clean.split('\n');
    const rawLines = raw.split('\n');
    const cleanLines = clean.split('\n');

    /**
     * 声明的名字在本文件里**除了声明行本身**是否还有别的出现（`this.<名字>`）。
     *
     * 【为什么要看"整份文件"而不是"声明行之后"】踩过：最初只扫声明行之后，
     * 而 ArkTS 组件里 **build() 常在成员声明之前**（`@Builder` 与方法写在后面），
     * 于是 `this.onCoreAction(id)` 出现在 202 行、声明却在 322 行 ⇒ 判成"无人使用"，
     * 误报 6 处。改成扫**全文件**、只**排除声明那一行**。
     *
     * 【为什么不用"只看 this.<名字>(" 而允许"任意出现"】回调 prop 的常见用法是
     * **透传给子组件**：`Composer({ onDraftChange: this.onDraftChange })` 不是调用。
     * 只看"调用"会漏掉这类在用形态。口径与 `check-dead-code.mjs` 的"零使用成员"一致：
     * **除声明处外一次都不出现**才算死。
     */
    const declaredAndUsed = (idx) => {
      const m = /^\s+(?:private\s+)?([A-Za-z_$][\w$]*)\s*:/.exec(rawLines[idx]);
      if (m === null) return false;
      const name = m[1];
      const re = new RegExp('this\\.' + name + '\\b');
      return cleanLines.some((l, n) => n !== idx && re.test(l));
    };

    for (let i = 0; i < lines.length; i++) {
      // 空箭头函数体：`=> {}` 或 `=> {` 紧跟 `}`
      if (/=>\s*\{\s*\}/.test(lines[i])) {
        if (!isAllowed(file, i + 1)) hits.push({ file, line: i + 1, kind: '空箭头函数体', text: rawLines[i].trim() });
        continue;
      }
      if (/=>\s*\{\s*$/.test(lines[i])) {
        const next = (lines[i + 1] ?? '').trim();
        if (next === '}' || next === '},' || next === '};') {
          /*
           * 分流：
           *   · 声明默认值 **且**本文件别处用到过它 ⇒ 正常兜底，跳过。
           *   · 声明默认值但从未被用到 ⇒ 报（可疑的"死声明"）。
           *   · 非声明默认值（调用处内联空实现）⇒ 报（真·死按钮）。
           */
          const propDefault = isPropDefault(rawLines, i)
            || isPropDefault(rawLines, i - 1);   // 跨行形态：箭头体那行也要试
          if (propDefault && declaredAndUsed(i)) continue;
          if (propDefault && declaredAndUsed(i - 1)) continue;
          if (!isAllowed(file, i + 1)) {
            hits.push({
              file,
              line: i + 1,
              kind: propDefault ? '空默认值（本文件无人使用）' : '调用处空实现（点了没反应）',
              text: rawLines[i].trim(),
            });
          }
        }
      }
      // 空方法体：`name(...) {` 紧跟 `}`
      if (/^\s{2,}[a-zA-Z_$][\w$]*\([^)]*\)\s*\{\s*$/.test(lines[i])) {
        const next = (lines[i + 1] ?? '').trim();
        if (next === '}') {
          if (!isAllowed(file, i + 1)) hits.push({ file, line: i + 1, kind: '空方法体', text: rawLines[i].trim() });
        }
      }
    }
  }
}

const rel = (f) => relative(ROOT, f).replace(/\\/g, '/');
if (hits.length === 0) {
  console.log(`死按钮扫描：未发现空实现（范围 ${ROOTS.join(', ')}）`);
  process.exit(0);
}
console.log(`死按钮扫描：发现 ${hits.length} 处空实现（需逐条判断：空实现常常就是"点了没反应"）`);
for (const h of hits) {
  console.log(`  ${rel(h.file)}:${h.line}  [${h.kind}]  ${h.text.slice(0, 90)}`);
}
process.exit(1);
