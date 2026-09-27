/**
 * Markdown 解析（P2：会话正文的呈现）。
 *
 * ## 为什么解析在模型里、渲染在视图里
 *
 * 官方 Web 的正文是"Markdown 渲染"（标题/列表/围栏代码/行内代码/链接/强调）。
 * 本仓此前是 `Text(item.body)` —— **原文照显**，于是助手回复里的 `**加粗**`、围栏、
 * 列表全都以星号和反引号的形式出现在屏幕上。
 *
 * 这件事可以拆成互不依赖的两半：
 *   · **切块与行内标注**（纯字符串处理，无 UI 依赖）⇒ 放这里，`tools/check-layout-fixtures.mjs`
 *     能在本机直接跑（本文件因此**不许** import appstate 之外的任何东西，也不许出现 `$r`）；
 *   · **画出来**（字号/颜色/间距/代码块底色）⇒ 放 `entry/view/MarkdownRenderer.ets`。
 *
 * ## 三条刻意的取舍
 *
 * 1. **流式未闭合的围栏不算错误**：模型一边生成一边被渲染，围栏经常"开了一半"。
 *    因此未闭合时把剩余全部当作代码块，并把 `closed: false` 如实标出来
 *    （视图据此可以不做"闭合后才变样式"的闪烁处理）。若把未闭合当普通文本，
 *    半截围栏会把它后面的所有内容吞进一个代码块——那是更糟的失败模式。
 * 2. **不认识的行内标记原样保留**：`**` 只有一个、`` ` `` 没配对的，一律当普通字符。
 *    宁可少强调一次，也不能把用户的原文吃掉。
 * 3. **不做 HTML、不做表格、不做嵌套列表**：这些要么涉及安全（HTML 注入），
 *    要么需要"块级容器"的排版能力（ArkUI 的 `Text`/`Span` 表达不了表格）。
 *    缺的部分**不假装支持**，原文照显——这也是官方在窄栏下的降级方式。
 */

/** 块类型（视图按它分派画法） */
export enum MdBlockKind {
  PARAGRAPH = 'paragraph',
  HEADING = 'heading',
  CODE = 'code',
  LIST_ITEM = 'list-item',
  QUOTE = 'quote',
  RULE = 'rule',
}

/**
 * 行内片段（一段文字 + 它身上的标记）。
 *
 * 【为什么是"标记数组"而不是嵌套结构】ArkUI 的富文本只有一层 `Text > Span`，
 * 表达不了 `**加粗里的*斜体***` 这种嵌套。故这里把标记**拍平**成并列属性：
 * 每个片段自己说"我是不是粗体/斜体/代码/删除线/链接"。渲染层因此不需要递归。
 */
export interface MdSpan {
  text: string;
  bold: boolean;
  italic: boolean;
  code: boolean;
  strike: boolean;
  /** 空串 = 不是链接 */
  href: string;
}

export interface MdBlock {
  kind: MdBlockKind;
  /** 标题级别 1–6；其它块为 0 */
  level: number;
  /** 列表是否有序 */
  ordered: boolean;
  /** 列表项的前缀（`·` 或 `3.`）；非列表为空串 */
  marker: string;
  /** 代码块的语言标注（围栏后那一段）；没有则为空串 */
  lang: string;
  /** 代码围栏是否闭合（流式未结束时为 false） */
  closed: boolean;
  /** 行内片段（代码块为空数组：代码块内不做行内解析） */
  spans: MdSpan[];
  /** 原文（代码块用；其它块用于无障碍文案与降级） */
  text: string;
}

function span(text: string): MdSpan {
  const out: MdSpan = { text: text, bold: false, italic: false, code: false, strike: false, href: '' };
  return out;
}

/** 把紧邻的、标记相同的片段并起来（避免逐字符生成一堆 Span） */
function push(out: MdSpan[], next: MdSpan): void {
  if (next.text.length === 0) {
    return;
  }
  if (out.length > 0) {
    const last: MdSpan = out[out.length - 1];
    if (last.bold === next.bold && last.italic === next.italic && last.code === next.code
      && last.strike === next.strike && last.href === next.href) {
      const merged: MdSpan = {
        text: last.text + next.text, bold: last.bold, italic: last.italic,
        code: last.code, strike: last.strike, href: last.href,
      };
      out[out.length - 1] = merged;
      return;
    }
  }
  out.push(next);
}

function spanOf(text: string, bold: boolean, italic: boolean, code: boolean,
  strike: boolean, href: string): MdSpan {
  const out: MdSpan = {
    text: text, bold: bold, italic: italic, code: code, strike: strike, href: href,
  };
  return out;
}

/** 该位置的字符是否被反斜杠转义（奇数个 `\` 才算转义） */
function escapedAt(line: string, index: number): boolean {
  let count: number = 0;
  let i: number = index - 1;
  while (i >= 0 && line.charAt(i) === '\\') {
    count++;
    i--;
  }
  return count % 2 === 1;
}

/**
 * 行内解析：`` `code` ``、`**粗**`、`*斜*`、`~~删~~`、`[文字](链接)`，以及 `\` 转义。
 *
 * 【为什么手写扫描而不是正则】嵌套与转义的优先级用正则会变成一串互相打架的贪婪匹配
 * （且回溯代价不可控）；逐字符扫描的规则只有"看到标记就找它的闭括号"这一条。
 */
export function parseInline(line: string, href: string = ''): MdSpan[] {
  const out: MdSpan[] = [];
  let plain: string = '';
  let i: number = 0;
  const n: number = line.length;
  while (i < n) {
    const c: string = line.charAt(i);
    // 转义：`\*` ⇒ 字面 `*`（吃掉反斜杠）
    if (c === '\\' && i + 1 < n) {
      plain += line.charAt(i + 1);
      i += 2;
      continue;
    }
    // 行内代码：反引号必须配对，且内部不再解析任何标记
    if (c === '`') {
      const close: number = line.indexOf('`', i + 1);
      if (close > i) {
        push(out, span(plain));
        plain = '';
        push(out, spanOf(line.substring(i + 1, close), false, false, true, false, ''));
        i = close + 1;
        continue;
      }
    }
    // 链接：[文字](目标)
    if (c === '[') {
      const mid: number = line.indexOf('](', i + 1);
      const close: number = mid > 0 ? line.indexOf(')', mid + 2) : -1;
      if (mid > 0 && close > mid) {
        push(out, span(plain));
        plain = '';
        // 链接文字本身可以带强调（不做递归，只取纯文本 —— 一层足够）
        push(out, spanOf(line.substring(i + 1, mid), false, false, false, false,
          line.substring(mid + 2, close)));
        i = close + 1;
        continue;
      }
    }
    // 强调：**粗** / __粗__
    if ((c === '*' || c === '_') && line.charAt(i + 1) === c) {
      const marker: string = c + c;
      const close: number = line.indexOf(marker, i + 2);
      if (close > i + 1) {
        push(out, span(plain));
        plain = '';
        push(out, spanOf(line.substring(i + 2, close), true, false, false, false, href));
        i = close + 2;
        continue;
      }
    }
    // 删除线：~~删~~
    if (c === '~' && line.charAt(i + 1) === '~') {
      const close: number = line.indexOf('~~', i + 2);
      if (close > i + 1) {
        push(out, span(plain));
        plain = '';
        push(out, spanOf(line.substring(i + 2, close), false, false, false, true, href));
        i = close + 2;
        continue;
      }
    }
    // 斜体：*斜* / _斜_（单个标记，且不能是空白开头——`a * b` 那种算式不当斜体）
    if (c === '*' || c === '_') {
      const close: number = line.indexOf(c, i + 1);
      const inner: string = close > i + 1 ? line.substring(i + 1, close) : '';
      if (inner.length > 0 && inner.trim().length > 0 && inner.indexOf(' ') !== 0) {
        push(out, span(plain));
        plain = '';
        push(out, spanOf(inner, false, true, false, false, href));
        i = close + 1;
        continue;
      }
    }
    plain += c;
    i++;
  }
  push(out, span(plain));
  if (out.length === 0) {
    out.push(span(''));   // 空行也返回一个空片段：视图不必为"空数组"写特例
  }
  return out;
}

function trimmedOf(line: string): string {
  return line.trim();
}

/** 围栏行判定：``` 或 ~~~（≥3 个）。返回围栏字符，非围栏返回空串 */
function fenceCharOf(line: string): string {
  const t: string = trimmedOf(line);
  if (t.length < 3) {
    return '';
  }
  const c: string = t.charAt(0);
  if (c !== '`' && c !== '~') {
    return '';
  }
  let count: number = 0;
  while (count < t.length && t.charAt(count) === c) {
    count++;
  }
  return count >= 3 ? c : '';
}

function headingLevelOf(line: string): number {
  const t: string = trimmedOf(line);
  if (t.length === 0 || t.charAt(0) !== '#') {
    return 0;
  }
  let level: number = 0;
  while (level < t.length && t.charAt(level) === '#') {
    level++;
  }
  if (level > 6) {
    return 0;
  }
  // `#标题` 不算标题（CommonMark 要求 `#` 后有空格）——宁可少认一种写法，也不误吃正文
  return level < t.length && t.charAt(level) === ' ' ? level : 0;
}

/** 分隔线：一整行只有 - * _（≥3 个，可含空格） */
function isRuleLine(line: string): boolean {
  const t: string = trimmedOf(line).split(' ').join('');
  if (t.length < 3) {
    return false;
  }
  const c: string = t.charAt(0);
  if (c !== '-' && c !== '*' && c !== '_') {
    return false;
  }
  for (let i = 0; i < t.length; i++) {
    if (t.charAt(i) !== c) {
      return false;
    }
  }
  return true;
}

function quoteTextOf(line: string): string {
  const t: string = trimmedOf(line);
  if (t.charAt(0) !== '>') {
    return '';
  }
  const rest: string = t.substring(1);
  return rest.length > 0 && rest.charAt(0) === ' ' ? rest.substring(1) : rest;
}

/** 列表项（无序 `- * +` / 有序 `1.` `1)`）；非列表返回 null */
function listItemOf(line: string): MdBlock | undefined {
  const t: string = trimmedOf(line);
  if (t.length < 2) {
    return undefined;
  }
  const c: string = t.charAt(0);
  if ((c === '-' || c === '*' || c === '+') && t.charAt(1) === ' ') {
    return {
      kind: MdBlockKind.LIST_ITEM, level: 0, ordered: false, marker: '·', lang: '',
      closed: true, spans: parseInline(t.substring(2)), text: t.substring(2),
    };
  }
  let digits: number = 0;
  while (digits < t.length && t.charAt(digits) >= '0' && t.charAt(digits) <= '9') {
    digits++;
  }
  if (digits > 0 && digits + 1 < t.length) {
    const sep: string = t.charAt(digits);
    if ((sep === '.' || sep === ')') && t.charAt(digits + 1) === ' ') {
      const body: string = t.substring(digits + 2);
      const orderedItem: MdBlock = {
        kind: MdBlockKind.LIST_ITEM, level: 0, ordered: true,
        marker: t.substring(0, digits + 1), lang: '', closed: true,
        spans: parseInline(body), text: body,
      };
      return orderedItem;
    }
  }
  return undefined;
}

/**
 * 把一段文本切成块。**不抛异常、不吃字符**：任何"看不懂"的行都会原样落在段落里。
 */
export function parseMarkdown(src: string): MdBlock[] {
  const out: MdBlock[] = [];
  if (src.length === 0) {
    return out;
  }
  const lines: string[] = src.split('\r\n').join('\n').split('\n');
  let paragraph: string[] = [];
  let i: number = 0;

  const flush = (): void => {
    if (paragraph.length === 0) {
      return;
    }
    const text: string = paragraph.join('\n');
    out.push({
      kind: MdBlockKind.PARAGRAPH, level: 0, ordered: false, marker: '', lang: '',
      closed: true, spans: parseInline(text), text: text,
    });
    paragraph = [];
  };

  while (i < lines.length) {
    const line: string = lines[i];
    const fence: string = fenceCharOf(line);
    if (fence.length > 0) {
      flush();
      const marker: string = trimmedOf(line);
      const lang: string = marker.split(fence).join('').trim();
      const body: string[] = [];
      let closed: boolean = false;
      i++;
      while (i < lines.length) {
        const probe: string = trimmedOf(lines[i]);
        if (probe.length >= 3 && probe.charAt(0) === fence
          && probe.split(fence).join('').trim().length === 0) {
          closed = true;
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      out.push({
        kind: MdBlockKind.CODE, level: 0, ordered: false, marker: '', lang: lang,
        closed: closed, spans: [], text: body.join('\n'),
      });
      continue;
    }
    if (trimmedOf(line).length === 0) {
      flush();
      i++;
      continue;
    }
    const level: number = headingLevelOf(line);
    if (level > 0) {
      flush();
      const text: string = trimmedOf(line).substring(level + 1).trim();
      out.push({
        kind: MdBlockKind.HEADING, level: level, ordered: false, marker: '', lang: '',
        closed: true, spans: parseInline(text), text: text,
      });
      i++;
      continue;
    }
    if (isRuleLine(line)) {
      flush();
      out.push({
        kind: MdBlockKind.RULE, level: 0, ordered: false, marker: '', lang: '',
        closed: true, spans: [], text: '',
      });
      i++;
      continue;
    }
    if (trimmedOf(line).charAt(0) === '>') {
      flush();
      const parts: string[] = [];
      while (i < lines.length && trimmedOf(lines[i]).charAt(0) === '>') {
        parts.push(quoteTextOf(lines[i]));
        i++;
      }
      const text: string = parts.join('\n');
      out.push({
        kind: MdBlockKind.QUOTE, level: 0, ordered: false, marker: '', lang: '',
        closed: true, spans: parseInline(text), text: text,
      });
      continue;
    }
    const item: MdBlock | undefined = listItemOf(line);
    if (item !== undefined) {
      flush();
      out.push(item);
      i++;
      continue;
    }
    paragraph.push(line);
    i++;
  }
  flush();
  return out;
}

/**
 * 无障碍/降级用的纯文本（去掉标记，只留内容）。
 *
 * 【为什么需要】`Text` 里有 `Span` 时读数会把标记也算进去；另外"复制该消息"要的是原文，
 * 而"读出来"要的是可听懂的句子——两者不该共用一份字符串。
 */
export function plainTextOf(blocks: MdBlock[]): string {
  const parts: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b: MdBlock = blocks[i];
    if (b.kind === MdBlockKind.RULE) {
      continue;
    }
    if (b.kind === MdBlockKind.CODE) {
      parts.push(b.text);
      continue;
    }
    let line: string = '';
    for (let k = 0; k < b.spans.length; k++) {
      line += b.spans[k].text;
    }
    parts.push(line);
  }
  return parts.join('\n');
}
