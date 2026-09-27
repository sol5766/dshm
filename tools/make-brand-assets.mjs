/**
 * ⚠️ **已废弃（2026-09-27）** —— 图标改由 `tools/make-icon.py` 生成。
 *
 * ─────────────────────── 为什么废弃（保留此文件的理由） ───────────────────────
 * 本脚本绘制的是**自研的字母 H 字形标记**（见下方"设计"）。2026-09-27 起，
 * 品牌图标改为 **dsh 官方白底黑鲸 + 右下角 `oh`/`os` 竖排**，
 * 由 `tools/make-icon.py` 生成（它的路径取自核心树的官方 `FISH_LOGO_PATH`，
 * 与官方逐字节一致）。
 *
 * 两个脚本产出**同一批文件**（foreground/background/startIcon/dshm-icon…）
 * ⇒ 若两者都能跑，谁后跑谁生效，图标会"莫名其妙变回去"。
 * 因此这里**直接拒绝执行**，并指向新脚本 —— 不做静默跳过。
 *
 * 保留文件而不删除的原因：下方"设计"一节记录了那套 H 字形标记的完整设计
 * 推导（carabiner 语义、同心波纹、配色理由），是有价值的品牌史资料。
 *
 * 要恢复 H 字形方案时：删掉下面这段守卫即可（但请同时确认 make-icon.py 不再被用）。
 */
console.error([
  '[make-brand-assets] 已废弃：图标改由 tools/make-icon.py 生成。',
  '  新方案 = dsh 官方白底黑鲸 + 右下角 HM/OS 四字母（2×2，O 下加短横线，逆时针 45°）。',
  '  若确实要回到旧的 H 字形标记，请先删除本文件顶部的废弃守卫，',
  '  并确认 tools/make-icon.py 不再被调用（两者产出同一批文件，会互相覆盖）。',
].join('\n'));
process.exit(1);

/* ── 以下为废弃前的原实现（保留供参考） ───────────────────────────────── */

/**
 * 生成 DSHM 的品牌图标资源（桌面图标 / 分层图标 / 启动图标 / README 用图）。
 *
 * ───────────────────────── 为什么是脚本而不是手工导出的 PNG ─────────────────────────
 *   1. **可复现**：图标有 6 个尺寸/形态（1024 分层两层、144 启动图、512 展示图、
 *      256 纯标记），手工导出必然出现「改了其中三个、忘了另外三个」的不一致；
 *      而图标不一致在桌面/任务卡片/关于页同时出现时非常显眼。
 *   2. **可审阅**：形状是**代码**（圆角矩形的半径、弧的圆心与半径），能 diff、
 *      能讨论；二进制 PNG 不能。
 *   3. **零依赖**：只用 Node 内置 `zlib` 写 PNG。不引入 sharp/canvas 这类需要
 *      本地编译的依赖——本仓库的构建链已经够重了。
 *
 * ───────────────────────── 设计（参考官方但刻意不同） ─────────────────────────
 *   DeepSeek 的品牌符号是**鲸鱼**（官方与社区项目一致），主色是偏亮的蓝
 *   （实测模板/生态里的蓝落在 `#1868f8`–`#4d6bfe` 一带）。
 *   本图标因此**不复刻鲸鱼**，也不使用同一色相：
 *     - **构图**：以字母 **H**（DSHM）为主体，是**字形标记**而不是插画；
 *     - **语义**：H 的横杠做成一个**开口的链环（carabiner）**——
 *       产品名就是 "harness"（挂具/绳结），而客户端做的事正是「挂接到 Host」；
 *     - **血缘**：H 的下方内腔放三道**同心波纹**（海/鲸的暗示），
 *       但它们是几何线条，不是任何生物形象；
 *     - **配色**：深靛紫 `#2B2E8F` → 青绿 `#0FB5A0` 的对角渐变，
 *       与 DeepSeek 的亮蓝属于不同色相区间，放在一起不会被误认成同一个图标。
 *
 * 用法：node tools/make-brand-assets.mjs   ← 已废弃，见顶部
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// ═══════════════════════════ 画布与混合 ═══════════════════════════

/** 直通 RGBA 画布（0..1 浮点，非预乘） */
function makeCanvas(w, h) {
  return { w, h, data: new Float32Array(w * h * 4) };
}

/** source-over 混合一个像素（sa 为源 alpha 0..1） */
function blend(canvas, x, y, r, g, b, sa) {
  if (sa <= 0) return;
  const i = (y * canvas.w + x) * 4;
  const d = canvas.data;
  const da = d[i + 3];
  const oa = sa + da * (1 - sa);
  if (oa <= 0) {
    d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
    return;
  }
  d[i] = (r * sa + d[i] * da * (1 - sa)) / oa;
  d[i + 1] = (g * sa + d[i + 1] * da * (1 - sa)) / oa;
  d[i + 2] = (b * sa + d[i + 2] * da * (1 - sa)) / oa;
  d[i + 3] = oa;
}

/**
 * 用有符号距离场（SDF）填一个形状。
 *
 * 为什么用 SDF 而不是「逐像素点在不在形状里」：SDF 的**符号**给出内外，
 * **数值**给出到边界的距离，于是 `coverage = clamp(0.5 - d, 0, 1)` 天然就是
 * 一个线性抗锯齿——不需要单独的超采样循环，边缘也不会出现阶梯。
 * `bbox` 用来跳过形状外的像素（不跳的话每次填充都要遍历整张 1024² 画布）。
 *
 * @param sdf (x, y) => 有符号距离（内部为负）
 * @param colorAt (x, y) => [r, g, b, alpha]（0..1）
 */
function fill(canvas, sdf, bbox, colorAt) {
  const x0 = Math.max(0, Math.floor(bbox[0]));
  const y0 = Math.max(0, Math.floor(bbox[1]));
  const x1 = Math.min(canvas.w - 1, Math.ceil(bbox[2]));
  const y1 = Math.min(canvas.h - 1, Math.ceil(bbox[3]));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = sdf(x + 0.5, y + 0.5);
      const cov = Math.max(0, Math.min(1, 0.5 - d));
      if (cov <= 0) continue;
      const c = colorAt(x + 0.5, y + 0.5);
      blend(canvas, x, y, c[0], c[1], c[2], c[3] * cov);
    }
  }
}

// ═══════════════════════════ SDF 基本体 ═══════════════════════════

/** 圆角矩形（中心 + 半宽半高 + 圆角半径） */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 旋转后的圆角矩形（`rad` 为弧度，正=逆时针） */
function sdRoundRectRot(px, py, cx, cy, hw, hh, r, rad) {
  const dx = px - cx;
  const dy = py - cy;
  const c = Math.cos(-rad);
  const s = Math.sin(-rad);
  return sdRoundRect(dx * c - dy * s, dx * s + dy * c, 0, 0, hw, hh, r);
}

/** 圆 */
function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

/** 交（取最大）：`a ∩ b` */
function sdAnd(a, b) {
  return Math.max(a, b);
}

/** 差：`a - b` */
function sdSub(a, b) {
  return Math.max(a, -b);
}

/** 半平面裁剪：`y >= yMin`（下侧） */
function sdHalfBelow(px, py, yMin) {
  return yMin - py;
}

// ═══════════════════════════ 调色板 ═══════════════════════════

const INDIGO = [0x2b / 255, 0x2e / 255, 0x8f / 255];
const TEAL = [0x0f / 255, 0xb5 / 255, 0xa0 / 255];
const MARK = [0.97, 0.985, 1.0];
const MINT = [0.72, 0.98, 0.93];

// ═══════════════════════════ 背景 ═══════════════════════════

/** 对角渐变 + 左上柔光（整幅不透明，符合分层图标 background 的要求） */
function paintBackground(canvas) {
  const { w, h } = canvas;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = Math.max(0, Math.min(1, (x / w + y / h) / 2));
      // 轻微的 ease-in-out，让中段过渡更长、两端更沉
      const e = t * t * (3 - 2 * t);
      const r = INDIGO[0] + (TEAL[0] - INDIGO[0]) * e;
      const g = INDIGO[1] + (TEAL[1] - INDIGO[1]) * e;
      const b = INDIGO[2] + (TEAL[2] - INDIGO[2]) * e;
      const i = (y * w + x) * 4;
      canvas.data[i] = r;
      canvas.data[i + 1] = g;
      canvas.data[i + 2] = b;
      canvas.data[i + 3] = 1;
    }
  }
  // 左上柔光：给纯渐变一个光源，避免大面积平涂显得"塑料"
  const hl = makeSoftGlow(w * 0.30, h * 0.24, w * 0.55, 0.16);
  fill(canvas, hl.sdf, [0, 0, w, h], () => [1, 1, 1, hl.alpha]);
}

/** 一个软边圆形高光（SDF 返回的是"距离 - 半径"，负数在内） */
function makeSoftGlow(cx, cy, r, alpha) {
  const sdf = (px, py) => {
    const d = Math.hypot(px - cx, py - cy);
    // 半径内 alpha 最大，边缘 r*0.35 的带内线性衰减
    const t = Math.max(0, Math.min(1, (r - d) / (r * 0.55)));
    return 0.5 - t;
  };
  return { sdf, alpha };
}

// ═══════════════════════════ 前景标记 ═══════════════════════════

/** 标记的几何参数（以 1024 画布为基准；安全区取中央 60% = 614px） */
const GEO = {
  legHw: 62,
  legHh: 248,
  legDx: 182,
  legCy: 508,
  /** 横杠：**在两条腿之间**（半宽 < 腿内侧 120），因此它的两端藏在腿后面 */
  barHw: 186,
  barHh: 46,
  barCy: 486,
  /**
   * 横杠上的**斜向开口**（半宽/半高/角度）。
   *
   * 【为什么开口必须是斜的，而且必须开在两腿之间】
   *   1. 开口要落在**有墨**的地方。横杠在内孔区（|dx| < 120）才有墨，
   *      而腿在 |dx| ∈ [120, 244]——把开口放在腿的 x 范围内是无效的：
   *      `fill` 只加墨不减墨，先画的腿会把开口糊掉（第一版就是这么错的）。
   *   2. 斜切读起来像"两个链环互相勾住"，正切读起来像"横杠断了"。
   *      图标在 48px 下只剩几像素，"断"会被当成渲染缺陷，"勾"不会。
   */
  gateHw: 16,
  gateHh: 92,
  gateDeg: -28,
  /**
   * 下腔内的三道同心波纹（半径 / 描边宽 / 透明度）；外径必须 < 腿内侧 120。
   *
   * 透明度刻意偏高（0.62/0.44/0.28）而不是"若隐若现"：图标在 48–144px 下
   * 会被重采样，过淡的细线会直接消失，于是"海"的意象在最需要它的地方没有。
   */
  arcCy: 622,
  arcs: [[46, 15, 0.62], [78, 14, 0.44], [110, 13, 0.28]]
};

/**
 * 横杠（斜开口链环）的 SDF。
 *
 * 独立成函数是为了能被 `--probe` 直接调用：开口有没有真的切穿描边，
 * 在字符画里可能被降采样平均掉，但**算一下就知道**。
 */
function markRingSdf(px, py, cx, cy, s) {
  const g = GEO;
  const bcy = cy + (g.barCy - 512) * s;
  const body = sdRoundRect(px, py, cx, bcy, g.barHw * s, g.barHh * s, g.barHh * s);
  const gap = sdRoundRectRot(px, py, cx, bcy, g.gateHw * s, g.gateHh * s,
    g.gateHw * s, g.gateDeg * Math.PI / 180);
  return sdSub(body, gap) * s;
}

/**
 * 画标记本体（透明背景上）。
 *
 * 三个部分：两条竖腿 + 一个**开口链环**横杠 + 下腔内三道同心波纹。
 * 链环 = 圆角矩形环（外减内），再切一道竖直开口——
 * 开口让它是"挂钩"而不是"闭合环"，这正是 harness/carabiner 的形态。
 */
function paintMark(canvas) {
  const cx = canvas.w / 2;
  const cy = canvas.h / 2;
  const s = canvas.w / 1024; // 尺寸无关：所有几何按 1024 设计，这里统一缩放
  const g = GEO;

  // 两条竖腿
  for (const dx of [-g.legDx, g.legDx]) {
    const lcx = cx + dx * s;
    const lcy = cy + (g.legCy - 512) * s;
    const hw = g.legHw * s;
    const hh = g.legHh * s;
    const r = hw;
    fill(canvas,
      (px, py) => sdRoundRect(px, py, lcx, lcy, hw, hh, r) * s,
      [lcx - hw - 2, lcy - hh - 2, lcx + hw + 2, lcy + hh + 2],
      () => [MARK[0], MARK[1], MARK[2], 0.97]);
  }

  // 横杠：开口链环
  const bcy = cy + (g.barCy - 512) * s;
  const outerHw = g.barHw * s;
  const outerHh = g.barHh * s;
  fill(canvas,
    (px, py) => markRingSdf(px, py, cx, cy, s),
    [cx - outerHw - 3, bcy - outerHh - 3, cx + outerHw + 3, bcy + outerHh + 3],
    () => [MARK[0], MARK[1], MARK[2], 0.97]);

  // 下腔内的三道同心波纹（只取下半弧，像水面涟漪）
  const arcCy = cy + (g.arcCy - 512) * s;
  for (const [radius, thick, alpha] of g.arcs) {
    const R = radius * s;
    const T = thick * s;
    const sdf = (px, py) => {
      const ring2 = Math.abs(Math.hypot(px - cx, py - arcCy) - R) - T / 2;
      return sdAnd(ring2, sdHalfBelow(px, py, arcCy)) * s;
    };
    fill(canvas, sdf, [cx - R - T, arcCy, cx + R + T, arcCy + R + T],
      () => [MINT[0], MINT[1], MINT[2], alpha]);
  }
}

// ═══════════════════════════ 合成与输出 ═══════════════════════════

/** 把两层合成到一张不透明画布（用于启动图/展示图的圆角版本） */
function composite(base, over) {
  const out = makeCanvas(base.w, base.h);
  out.data.set(base.data);
  const d = out.data, o = over.data;
  for (let i = 0; i < d.length; i += 4) {
    const sa = o[i + 3];
    if (sa <= 0) continue;
    const da = d[i + 3];
    const oa = sa + da * (1 - sa);
    d[i] = (o[i] * sa + d[i] * da * (1 - sa)) / oa;
    d[i + 1] = (o[i + 1] * sa + d[i + 1] * da * (1 - sa)) / oa;
    d[i + 2] = (o[i + 2] * sa + d[i + 2] * da * (1 - sa)) / oa;
    d[i + 3] = oa;
  }
  return out;
}

/** 圆角遮罩（展示图用；系统图标会自己加遮罩，所以资源本体不加） */
function roundMask(canvas, radius) {
  const sdf = (px, py) =>
    sdRoundRect(px, py, canvas.w / 2, canvas.h / 2, canvas.w / 2, canvas.h / 2, radius);
  const d = canvas.data;
  for (let y = 0; y < canvas.h; y++) {
    for (let x = 0; x < canvas.w; x++) {
      const cov = Math.max(0, Math.min(1, 0.5 - sdf(x + 0.5, y + 0.5)));
      if (cov < 1) {
        d[(y * canvas.w + x) * 4 + 3] *= cov;
      }
    }
  }
}

/** 盒式降采样（整数倍或任意比例都用面积平均，避免出现摩尔纹） */
function downsample(src, size) {
  const out = makeCanvas(size, size);
  const ratio = src.w / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const y0 = Math.floor(y * ratio), y1 = Math.min(src.h, Math.ceil((y + 1) * ratio));
      const x0 = Math.floor(x * ratio), x1 = Math.min(src.w, Math.ceil((x + 1) * ratio));
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * src.w + sx) * 4;
          const sa = src.data[i + 3];
          // 面积平均必须按 alpha 加权，否则透明区域的黑色会渗进边缘
          r += src.data[i] * sa; g += src.data[i + 1] * sa; b += src.data[i + 2] * sa;
          a += sa; n++;
        }
      }
      const i = (y * size + x) * 4;
      if (a > 0) {
        out.data[i] = r / a; out.data[i + 1] = g / a; out.data[i + 2] = b / a;
      }
      out.data[i + 3] = n > 0 ? a / n : 0;
    }
  }
  return out;
}

// ── PNG 编码（8 位 RGBA，非隔行） ──

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(canvas) {
  const { w, h, data } = canvas;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const o = y * (stride + 1) + 1 + x * 4;
      raw[o] = Math.round(Math.max(0, Math.min(1, data[i])) * 255);
      raw[o + 1] = Math.round(Math.max(0, Math.min(1, data[i + 1])) * 255);
      raw[o + 2] = Math.round(Math.max(0, Math.min(1, data[i + 2])) * 255);
      raw[o + 3] = Math.round(Math.max(0, Math.min(1, data[i + 3])) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function write(path, canvas) {
  mkdirSync(dirname(path), { recursive: true });
  const buf = encodePng(canvas);
  writeFileSync(path, buf);
  console.log(`${path}  ${canvas.w}x${canvas.h}  ${(buf.length / 1024).toFixed(1)} KB`);
}

// ═══════════════════════════ 生成 ═══════════════════════════

/**
 * `--probe`：只做数值校验，不写文件。
 *
 * 存在的理由：本项目的 AI 助手在这个模型下**不能看图**，而"开口有没有切穿描边"
 * 这种判断又不该靠印象。这里直接把关心的坐标点的 SDF 打出来：
 * 开口中心必须是正数（在形状外），开口两侧必须仍是负数（在形状内）。
 */
if (process.argv.includes('--probe')) {
  const s = 1;
  const cx = 512, cy = 512;
  const bcy = cy + (GEO.barCy - 512) * s;
  const points = [
    ['开口中心', cx, bcy],
    ['开口内·上', cx + Math.round(Math.tan(GEO.gateDeg * Math.PI / 180) * -44), bcy - 44],
    ['横杠左段', cx - 90, bcy],
    ['横杠右段', cx + 90, bcy],
    ['左腿', cx - GEO.legDx, cy],
    ['右腿', cx + GEO.legDx, cy],
    ['内孔上方', cx, bcy - 90]
  ];
  console.log('SDF 数值（负=在形状内，正=在形状外）:');
  for (const [label, x, y] of points) {
    console.log(`  ${label.padEnd(12)} (${x}, ${y})  sdf=${markRingSdf(x, y, cx, cy, s).toFixed(1)}`);
  }
  process.exit(0);
}

const SIZE = 1024;

const background = makeCanvas(SIZE, SIZE);
paintBackground(background);

const foreground = makeCanvas(SIZE, SIZE);
paintMark(foreground);

// 1) 分层图标的两层（系统自己加遮罩，因此这里都不裁圆角）
const bgOut = 'AppScope/resources/base/media/background.png';
const fgOut = 'AppScope/resources/base/media/foreground.png';
write(bgOut, background);
write(fgOut, foreground);
// 2) entry 模块自带一份（两份必须一致，否则不同入口显示不同图标）
write('entry/src/main/resources/base/media/background.png', background);
write('entry/src/main/resources/base/media/foreground.png', foreground);

// 3) 启动图（144×144，系统回退用；不带圆角，由系统决定圆角）
write('entry/src/main/resources/base/media/startIcon.png',
  downsample(composite(background, foreground), 144));

// 4) 文档/README 展示图：圆角方形，看起来就是一个应用图标
const showcase = composite(background, foreground);
roundMask(showcase, 224);
write('docs/brand/dshm-icon.png', downsample(showcase, 512));

// 5) 纯标记（透明底）：README 内联、未来做浅色背景时使用
const markOnly = makeCanvas(SIZE, SIZE);
paintMark(markOnly);
write('docs/brand/dshm-mark.png', downsample(markOnly, 256));

console.log('\n完成。形状参数集中在 GEO，改一处即可重新生成全部尺寸。');
