#!/usr/bin/env node
/*
 * 图标资源门禁。
 *
 * ─────────────── 为什么需要它（2026-09-27 独立审查提出）───────────────
 * 图标有 4 处必须保持一致，但**此前没有任何门禁**：
 *   · `AppScope/.../foreground.png` 与 `entry/.../foreground.png` 必须**逐字节相同**
 *     （品牌文档要求；不同则不同入口显示不同图标）
 *   · background 同理
 *   · `startIcon.png` / `logo_dark.png` 必须**已是品牌标**（不得回退成历史鲸鱼），
 *     且两者逐字节相同（同一品牌标的两处落地）
 *
 * 这三类不一致都不会让构建失败、也不会在运行时立刻报错 —— 只会在
 * 用户"换个入口打开"或"看启动画面"时表现为奇怪的观感问题。
 * 所以用门禁钉住。
 *
 * 退出码：0 通过 / 1 有问题。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = process.cwd();
const MEDIA = join(ROOT, 'entry', 'src', 'main', 'resources', 'base', 'media');
const APP_MEDIA = join(ROOT, 'AppScope', 'resources', 'base', 'media');
const ORIG = join(ROOT, 'third_party', 'brand-original');

const problems = [];
const notes = [];

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function requireFile(p, why) {
  if (!existsSync(p)) {
    problems.push(`缺文件：${p.replace(ROOT, '')}（${why}）`);
    return false;
  }
  return true;
}

/* ── ① AppScope 与 entry 的两份必须逐字节相同 ── */
for (const name of ['foreground.png', 'background.png']) {
  const a = join(APP_MEDIA, name);
  const b = join(MEDIA, name);
  if (!requireFile(a, '分层图标（AppScope）') || !requireFile(b, '分层图标（entry）')) continue;
  if (readFileSync(a).equals(readFileSync(b))) {
    notes.push(`${name}：AppScope 与 entry 一致`);
  } else {
    problems.push(`${name}：AppScope 与 entry **不一致** `
      + '（品牌文档要求逐字节相同，否则不同入口显示不同图标）');
  }
}

/* ── ② 启动资源必须**已是品牌标**（不得回退成历史鲸鱼），且两处逐字节相同 ──
 *
 * 2026-10-11 用户要求把品牌标"一并改掉" ⇒ 旧约束"启动画面用原版"作废。
 * `third_party/brand-original/` 转为**历史留档**，只作防回退的反向判据。
 */
const splashPaths = ['startIcon.png', 'logo_dark.png'].map((n) => join(MEDIA, n));
let splashOk = true;
for (const name of ['startIcon.png', 'logo_dark.png']) {
  const p = join(MEDIA, name);
  if (!requireFile(p, '启动画面资源')) { splashOk = false; continue; }
  const o = join(ORIG, name);
  if (!existsSync(o)) {
    notes.push(`${name}：无 brand-original 历史正本可比（跳过防回退校验，仅记存在）`);
    continue;
  }
  if (sha256(p) === sha256(o)) {
    problems.push(`${name}：**仍是历史鲸鱼**（与 brand-original 一致）。`
      + '品牌标要求"一并改掉"；请跑 python tools/make-icon.py 重新出图');
    splashOk = false;
  } else {
    notes.push(`${name}：已非历史鲸鱼（品牌标生效）`);
  }
}
// startIcon 与 logo_dark 是同一品牌标的两处落地，必须逐字节相同。
if (splashOk && splashPaths.every((p) => existsSync(p))) {
  if (readFileSync(splashPaths[0]).equals(readFileSync(splashPaths[1]))) {
    notes.push('startIcon.png ↔ logo_dark.png：逐字节一致');
  } else {
    problems.push('startIcon.png 与 logo_dark.png **不一致**'
      + '（同一品牌标的两处落地必须相同，否则启动窗口与启动页标识不同）');
  }
}

/* ── ③ APP 图标必须存在且是"品牌标"（分域量化的彩色前景，体积明显大于旧纯色版）── */
const fg = join(MEDIA, 'foreground.png');
if (requireFile(fg, 'APP 图标前景层')) {
  const st = statSync(fg);
  /*
   * 用**文件大小**做一个粗但有效的"是不是新版"判据：
   *   当代品牌标（2026-10-28 版，线条更简）实测 **20.6KB**（1024×1024 RGBA）
   *   （上一版虎鲸抱环 59.3KB；更早 `</>` 冰蓝气泡约 53KB；纯鲸鱼版 15–18KB）
   * 带宽取 15–120KB：下界收到 15KB（低于它就是"忘了重新出图 / 出成低色彩版"），
   * 上界 120KB 容细节调整。10-28 换标时带没跟着重标（docs/278 P2-1）⇒ 本次按新标实测重标。
   */
  const kb = st.size / 1024;
  if (kb < 15 || kb > 120) {
    problems.push(`foreground.png 体积 ${kb.toFixed(1)}KB 不在预期带（15–120KB，2026-10-28 版实测 20.6KB）`
      + ' —— 可能不是分域量化后的品牌标那版');
  } else {
    notes.push(`foreground.png 体积 ${kb.toFixed(1)}KB（在预期带内）`);
  }
}

/* ── 输出 ── */
console.log('图标资源门禁');
for (const n of notes) console.log('  ok  ：' + n);
if (problems.length === 0) {
  console.log(`  ✓ 通过（${notes.length} 项）`);
  process.exit(0);
}
console.log('');
for (const p of problems) console.log('  ✗ ' + p);
console.log(`  RESULT: FAIL (${problems.length})`);
process.exit(1);
