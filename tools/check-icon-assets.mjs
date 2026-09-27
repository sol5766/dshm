#!/usr/bin/env node
/*
 * 图标资源门禁。
 *
 * ─────────────── 为什么需要它（2026-09-27 独立审查提出）───────────────
 * 图标有 4 处必须保持一致，但**此前没有任何门禁**：
 *   · `AppScope/.../foreground.png` 与 `entry/.../foreground.png` 必须**逐字节相同**
 *     （品牌文档要求；不同则不同入口显示不同图标）
 *   · background 同理
 *   · `startIcon.png` / `logo_dark.png` 必须是**原版**（用户明确要求启动画面不动）
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

/** 原版启动资源的 sha256（`third_party/brand-original/` 里的正本）。 */
const ORIGINAL_SPLASH_SHA256 = '5a1a1ac3885f100842e555131586357429ce241c95974a405db3a383d7d24b1a';

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

/* ── ② 启动资源必须是原版（用户明确要求"启动画面用原版"）── */
for (const name of ['startIcon.png', 'logo_dark.png']) {
  const p = join(MEDIA, name);
  if (!requireFile(p, '启动画面资源')) continue;
  const o = join(ORIG, name);
  if (!existsSync(o)) {
    notes.push(`${name}：无 brand-original 正本可比（跳过内容校验，仅记存在）`);
    continue;
  }
  const cur = sha256(p);
  if (cur === sha256(o)) {
    notes.push(`${name}：与原版一致`);
  } else {
    problems.push(`${name}：**已被改动**（与原版不符）。启动画面要求用原版；`
      + '若确有意图要改，请同步更新本门禁的预期与 docs/brand/README.md');
  }
}

/* ── ③ APP 图标必须存在且是"新版"（有角标 ⇒ 尺寸明显大于纯鲸鱼版）── */
const fg = join(MEDIA, 'foreground.png');
if (requireFile(fg, 'APP 图标前景层')) {
  const st = statSync(fg);
  /*
   * 用**文件大小**做一个粗但有效的"是不是新版"判据：
   *   新版（鲸鱼 + 旋转角标）约 57–60KB
   *   旧的纯鲸鱼版约 15–18KB
   * 带宽取 30–120KB：既容得下细节调整，又能区分两代图标。
   */
  const kb = st.size / 1024;
  if (kb < 30 || kb > 120) {
    problems.push(`foreground.png 体积 ${kb.toFixed(1)}KB 不在预期带（30–120KB）`
      + ' —— 可能不是"官方鲸鱼 + HM/OS 角标"那版');
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
