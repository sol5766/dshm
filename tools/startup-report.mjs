/**
 * 启动分段报告：读取 `StartupMarks` 写出的 JSONL，输出 S0→S7 时间轴；
 * 给两个文件即输出「基线 → 本次」的逐段差值。
 *
 * 用法：
 *   node tools/startup-report.mjs <本次.jsonl> [--baseline <基线.jsonl>]
 *
 * 日志位置（设备侧）：
 *   <应用 filesDir>/dsh/logs/startup/<epochMs>-<pid>.jsonl
 * 取回：
 *   hdc file recv /data/app/el2/100/base/com.dshm.dshclient/haps/entry/files/dsh/logs/startup ./dist/startup-logs
 *   （beta 包把包名换成 com.dshm.dshmbeta）
 *
 * 【为什么单独一个脚本】启动优化没有度量就是玄学。这个脚本只做两件事：
 * 把 JSONL 变成人能读的表；把两次启动变成可比较的差值。无外部依赖。
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const PHASE_ORDER = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'];
const PHASE_LABEL = {
  S0: '能力入口 onCreate',
  S1: '静态配置 + 启动参数发布',
  S2: '窗口阶段 onWindowStageCreate',
  S3: '页面树就绪 loadContent 回调',
  S4: '宿主链调度',
  S5: '宿主就绪 URL 已发布',
  S6: 'Web 开始导航 onPageBegin',
  S7: '首屏就绪 onPageEnd',
};

function parse(file) {
  const text = readFileSync(file, 'utf8');
  const marks = [];
  let summary = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.id === 'SUMMARY') summary = obj;
    else marks.push(obj);
  }
  const byId = new Map();
  for (const m of marks) {
    if (!byId.has(m.id)) byId.set(m.id, m);
  }
  return { marks, byId, summary };
}

function fmt(n) {
  if (n === undefined || n === null) return '—';
  return `${n >= 0 ? '+' : ''}${n}`;
}

function render(file, parsed) {
  const { byId, summary } = parsed;
  const boot = parsed.marks.length > 0 ? parsed.marks[0].boot : '?';
  const pid = parsed.marks.length > 0 ? parsed.marks[0].pid : '?';
  console.log(`\n== ${basename(file)}  boot=${boot} pid=${pid}`);
  if (parsed.marks.length === 0) {
    console.log('   （空文件：本次启动未走到任何标记，检查埋点是否被裁剪/日志目录是否可写）');
    return;
  }
  let prev = -1;
  for (const id of PHASE_ORDER) {
    const m = byId.get(id);
    if (!m) {
      console.log(`   ${id}  ${(PHASE_LABEL[id] || '').padEnd(28)}  —（未到达）`);
      continue;
    }
    const delta = prev >= 0 ? Math.round(m.ts - prev) : 0;
    prev = m.ts;
    console.log(`   ${id}  ${(PHASE_LABEL[id] || m.key).padEnd(28)}  ${fmt(Math.round(m.ts)).padStart(7)} ms   Δ${String(delta).padStart(5)} ms  ${m.key}${m.extra ? `  ${m.extra}` : ''}`);
  }
  if (summary) {
    console.log(`   ── total ${summary.totalMs} ms   spans ${summary.spans || '(无)'}   reason=${summary.key}`);
  } else {
    console.log('   ── 无 SUMMARY（未到 S7 或进程提前退出）：只能看已到达段');
  }
}

function compare(baseFile, base, curFile, cur) {
  console.log(`\n== 对比  ${basename(baseFile)} → ${basename(curFile)}`);
  console.log('   段   ' + '基线'.padStart(9) + '本次'.padStart(11) + '差值'.padStart(11));
  let basePrev = -1;
  let curPrev = -1;
  const rows = [];
  for (const id of PHASE_ORDER) {
    const b = base.byId.get(id);
    const c = cur.byId.get(id);
    const bSpan = b ? (basePrev >= 0 ? Math.round(b.ts - basePrev) : 0) : undefined;
    const cSpan = c ? (curPrev >= 0 ? Math.round(c.ts - curPrev) : 0) : undefined;
    if (b) basePrev = b.ts;
    if (c) curPrev = c.ts;
    if (bSpan === undefined && cSpan === undefined) continue;
    const diff = bSpan !== undefined && cSpan !== undefined ? cSpan - bSpan : undefined;
    rows.push({ id, bSpan, cSpan, diff });
  }
  for (const r of rows) {
    const mark = r.diff === undefined ? '' : r.diff < 0 ? '  ↓ 更快' : r.diff > 0 ? '  ↑ 更慢' : '';
    console.log(`   ${r.id}  ${String(r.bSpan ?? '—').padStart(9)} ${String(r.cSpan ?? '—').padStart(10)} ${String(r.diff ?? '—').padStart(10)}${mark}`);
  }
  const bTotal = base.summary ? base.summary.totalMs : undefined;
  const cTotal = cur.summary ? cur.summary.totalMs : undefined;
  if (bTotal !== undefined && cTotal !== undefined) {
    const d = cTotal - bTotal;
    console.log(`   ── total  ${bTotal} → ${cTotal} ms  (${d >= 0 ? '+' : ''}${d} ms)${d < 0 ? '  ↓ 更快' : ''}`);
  }
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  console.log('用法：node tools/startup-report.mjs <本次.jsonl> [--baseline <基线.jsonl>]');
  process.exit(argv.length === 0 ? 2 : 0);
}
const curFile = argv[0];
const bi = argv.indexOf('--baseline');
const cur = parse(curFile);
render(curFile, cur);
if (bi >= 0 && argv[bi + 1]) {
  const baseFile = argv[bi + 1];
  compare(baseFile, parse(baseFile), curFile, cur);
}
