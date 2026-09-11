// DSHM 图标生成：DeepSeek Harness 官方鲸鱼 mark 与品牌字标。
//
// 与旧版的区别：不再用代码硬画一只近似鲸鱼，而是直接光栅化官方矢量路径
// （tools/fish-logo-path.mjs、tools/brand-wordmark-path.mjs，均从官方包提取），
// 保证应用图标、启动页与官方品牌图形完全一致。
//
// 纯 Node（zlib 编码 PNG + 自实现贝塞尔扫描线填充），无外部依赖。
//
// 用法：
//   node tools/gen-icon.mjs --out <dir> [选项]
//
// 选项：
//   --bg <hex>              图标底色，默认 0A0A0D
//   --fg <hex>              鲸鱼/字标前景色，默认 FFFFFF
//   --size <px>             分层图标与单图图标尺寸，默认 512
//   --splash-size <px>      启动页图标尺寸，默认 256
//   --wordmark-height <px>  字标图高度，默认 96
//   --mark-ratio <0-1>      纯 mark 图（无底色方块）中鲸鱼占画布宽度比，默认 0.78
//   --only <list>           只输出指定产物，逗号分隔：
//                           foreground,background,icon,splash,splash-mark,wordmark
//
// 产物：
//   foreground.png     分层图标前景层（透明底 + 鲸鱼，留安全边距）
//   background.png     分层图标背景层（不透明满幅底色）
//   icon.png           单图应用图标（圆角底色方块 + 鲸鱼）
//   splash.png         启动页图标（圆角底色方块，独立尺寸）
//   splash-mark.png    启动页图标·深色模式备选（透明底 + 白鲸，无底色方块）
//   wordmark.png       品牌字标（透明底，仅 "DeepSeek Harness" 字标，不含鲸鱼）
//
// 注：分层图标背景层必须不透明满幅（由系统做遮罩），前景层必须留安全边距，
// 所以 icon.png 与 foreground.png 的鲸鱼占比不同。

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FISH_LOGO_PATH, FISH_LOGO_VIEWBOX } from './fish-logo-path.mjs';
import { BRAND_WORDMARK_PATHS, BRAND_WORDMARK_VIEWBOX } from './brand-wordmark-path.mjs';

// ---------------------------------------------------------------- CLI 参数
function parseArgs(argv) {
  const o = {
    out: '.', bg: '0A0A0D', fg: 'FFFFFF',
    size: 512, splashSize: 256, wordmarkHeight: 96, markRatio: 0.78, only: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i];
    else if (a === '--bg') o.bg = argv[++i];
    else if (a === '--fg') o.fg = argv[++i];
    else if (a === '--size') o.size = parseInt(argv[++i], 10);
    else if (a === '--splash-size') o.splashSize = parseInt(argv[++i], 10);
    else if (a === '--wordmark-height') o.wordmarkHeight = parseInt(argv[++i], 10);
    else if (a === '--mark-ratio') o.markRatio = parseFloat(argv[++i]);
    else if (a === '--only') o.only = argv[++i].split(',').map(s => s.trim());
    else if (!a.startsWith('--')) o.out = a;
  }
  return o;
}

function hexToRGBA(hex, alpha) {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  return [
    parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16),
    alpha === undefined ? 255 : alpha,
  ];
}

// ---------------------------------------------------------------- PNG 编码
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// pixels: Uint8ClampedArray RGBA, width*height
function encodePNG(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  const rb = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- 路径解析
// 官方 mark / 字标只用到绝对指令：M / L / H / V / C / Z。
// 每条三次贝塞尔按固定步数展平成折线，得到子路径多边形。
const CURVE_STEPS = 32;

function parsePathToPolygons(d) {
  const tokens = d.match(/[MmLlCcZzHhVv]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
  const polys = [];
  let cur = null, x = 0, y = 0, startX = 0, startY = 0, cmd = null, i = 0;
  const num = () => parseFloat(tokens[i++]);
  const push = (px, py) => { cur.push([px, py]); x = px; y = py; };

  while (i < tokens.length) {
    const t = tokens[i];
    if (/[MmLlCcZzHhVv]/.test(t)) { cmd = t; i++; }
    else if (cmd === null) { throw new Error('路径以参数开头: ' + t); }

    if (cmd === 'M' || cmd === 'm') {
      const nx = cmd === 'm' ? x + num() : num();
      const ny = cmd === 'm' ? y + num() : num();
      cur = []; polys.push(cur); push(nx, ny);
      startX = nx; startY = ny;
      cmd = cmd === 'm' ? 'l' : 'L';
    } else if (cmd === 'L') push(num(), num());
    else if (cmd === 'l') push(x + num(), y + num());
    else if (cmd === 'H') push(num(), y);
    else if (cmd === 'h') push(x + num(), y);
    else if (cmd === 'V') push(x, num());
    else if (cmd === 'v') push(x, y + num());
    else if (cmd === 'C') {
      const x1 = num(), y1 = num(), x2 = num(), y2 = num(), nx = num(), ny = num();
      flattenCubic(cur, x, y, x1, y1, x2, y2, nx, ny);
      x = nx; y = ny;
    } else if (cmd === 'c') {
      const x1 = x + num(), y1 = y + num(), x2 = x + num(), y2 = y + num();
      const nx = x + num(), ny = y + num();
      flattenCubic(cur, x, y, x1, y1, x2, y2, nx, ny);
      x = nx; y = ny;
    } else if (cmd === 'Z' || cmd === 'z') {
      if (cur && cur.length) cur.push([startX, startY]);
      x = startX; y = startY; cmd = null;
    } else {
      throw new Error('不支持的路径指令: ' + cmd);
    }
  }
  for (const p of polys) {
    if (p.length > 1) {
      const a = p[0], b = p[p.length - 1];
      if (a[0] === b[0] && a[1] === b[1]) p.pop();
    }
  }
  return polys.filter(p => p.length >= 3);
}

function flattenCubic(out, x0, y0, x1, y1, x2, y2, x3, y3) {
  for (let s = 1; s <= CURVE_STEPS; s++) {
    const t = s / CURVE_STEPS, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    out.push([a * x0 + b * x1 + c * x2 + d * x3, a * y0 + b * y1 + c * y2 + d * y3]);
  }
}

// 官方图形只解析一次，后续所有尺寸复用
const WHALE_POLYGONS = parsePathToPolygons(FISH_LOGO_PATH);
const WORDMARK_POLYGONS = BRAND_WORDMARK_PATHS.map(parsePathToPolygons).flat();

// ---------------------------------------------------------------- 光栅化
// 扫描线 + 非零环绕规则（SVG 默认 fill-rule），SS 倍超采样后降采样得到抗锯齿覆盖率。
const SS = 4;

/**
 * 把一组原生坐标多边形按 scale 缩放、平移到画布上。
 * @param {number[][][]} polygons 原生坐标子路径
 * @param {number} w 画布宽
 * @param {number} h 画布高
 * @param {number} scale
 * @param {number} tx 平移 X
 * @param {number} ty 平移 Y
 * @returns {Uint8ClampedArray} w*h 覆盖率（0-255）
 */
function rasterize(polygons, w, h, scale, tx, ty) {
  const dim = w * SS;
  const edges = [];
  for (const poly of polygons) {
    const n = poly.length;
    for (let k = 0; k < n; k++) {
      const a = poly[k], b = poly[(k + 1) % n];
      const x0 = tx + a[0] * scale, y0 = ty + a[1] * scale;
      const x1 = tx + b[0] * scale, y1 = ty + b[1] * scale;
      if (y0 !== y1) edges.push([x0, y0, x1, y1]);
    }
  }

  const hi = new Uint8Array(dim * dim);
  const crosses = [];
  for (let py = 0; py < dim; py++) {
    const yc = (py + 0.5) / SS;
    crosses.length = 0;
    for (let e = 0; e < edges.length; e++) {
      const ed = edges[e], x0 = ed[0], y0 = ed[1], x1 = ed[2], y1 = ed[3];
      const lo = y0 < y1 ? y0 : y1;
      const hiY = y0 < y1 ? y1 : y0;
      if (yc < lo || yc >= hiY) continue;
      crosses.push([x0 + (yc - y0) * (x1 - x0) / (y1 - y0), y1 > y0 ? 1 : -1]);
    }
    if (crosses.length < 2) continue;
    crosses.sort((a, b) => a[0] - b[0]);
    const rowBase = py * dim;
    let winding = 0;
    for (let k = 0; k < crosses.length - 1; k++) {
      winding += crosses[k][1];
      if (winding === 0) continue;
      let from = Math.ceil(crosses[k][0] * SS - 0.5);
      let to = Math.ceil(crosses[k + 1][0] * SS - 0.5);
      if (from < 0) from = 0;
      if (to > dim) to = dim;
      for (let px = from; px < to; px++) hi[rowBase + px] = 1;
    }
  }

  const cov = new Uint8ClampedArray(w * h);
  const inv = 255 / (SS * SS);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let sy = 0; sy < SS; sy++) {
        const base = (y * SS + sy) * dim + x * SS;
        for (let sx = 0; sx < SS; sx++) sum += hi[base + sx];
      }
      cov[y * w + x] = sum * inv;
    }
  }
  return cov;
}

// ---------------------------------------------------------------- 合成
function newPixels(w, h) {
  return new Uint8ClampedArray(w * h * 4);
}

function fillAll(px, w, h, rgba) {
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    px[o] = rgba[0]; px[o + 1] = rgba[1]; px[o + 2] = rgba[2]; px[o + 3] = rgba[3];
  }
}

// 用覆盖率把 fg 以 source-over 叠加到已有像素上
function blendCoverage(px, w, h, cov, rgba) {
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const a = cov[i];
    if (a === 0) continue;
    const o = i * 4;
    const sa = a / 255;
    const da = px[o + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) continue;
    px[o] = Math.round((rgba[0] * sa + px[o] * da * (1 - sa)) / oa);
    px[o + 1] = Math.round((rgba[1] * sa + px[o + 1] * da * (1 - sa)) / oa);
    px[o + 2] = Math.round((rgba[2] * sa + px[o + 2] * da * (1 - sa)) / oa);
    px[o + 3] = Math.round(oa * 255);
  }
}

// 圆角矩形遮罩（只削 alpha）
function applyRoundRectMask(px, w, h, radius) {
  const r = Math.min(radius, Math.min(w, h) / 2);
  const S2 = 3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!((x < r || x >= w - r) && (y < r || y >= h - r))) continue;
      const cx = x < r ? r : w - r;
      const cy = y < r ? r : h - r;
      let hits = 0;
      for (let sy = 0; sy < S2; sy++) {
        for (let sx = 0; sx < S2; sx++) {
          const dx = x + (sx + 0.5) / S2 - cx;
          const dy = y + (sy + 0.5) / S2 - cy;
          if (dx * dx + dy * dy <= r * r) hits++;
        }
      }
      const o = (y * w + x) * 4;
      px[o + 3] = Math.round(px[o + 3] * (hits / (S2 * S2)));
    }
  }
}

// ---------------------------------------------------------------- 配色与比例
// 分层图标前景层：官方规范要求留安全边距，系统遮罩时才不会切到图形
const FG_WIDTH_RATIO = 0.62;
// 圆角底色方块内部：留白更大一点，视觉更稳
const TILE_WIDTH_RATIO = 0.58;
const TILE_RADIUS_RATIO = 0.225;
// 深色模式启动图标不做底色方块，鲸鱼可以更大
const MARK_WIDTH_RATIO = 0.78;
// ---------------------------------------------------------------- 产物
function genForeground(size, fg) {
  const px = newPixels(size, size);
  blendCoverage(px, size, size, rasterizeWhale(size, FG_WIDTH_RATIO), fg);
  return px;
}

function genMark(size, fg, markRatio) {
  const px = newPixels(size, size);
  blendCoverage(px, size, size, rasterizeWhale(size, markRatio), fg);
  return px;
}

function rasterizeWhale(size, widthRatio) {
  const vb = FISH_LOGO_VIEWBOX;
  const scale = size * widthRatio / vb.width;
  const tx = (size - vb.width * scale) / 2;
  const ty = (size - vb.height * scale) / 2;
  return rasterize(WHALE_POLYGONS, size, size, scale, tx, ty);
}

function genBackground(size, bg) {
  const px = newPixels(size, size);
  fillAll(px, size, size, bg);
  return px;
}

function genTile(size, bg, fg) {
  const px = newPixels(size, size);
  fillAll(px, size, size, bg);
  blendCoverage(px, size, size, rasterizeWhale(size, TILE_WIDTH_RATIO), fg);
  applyRoundRectMask(px, size, size, size * TILE_RADIUS_RATIO);
  return px;
}

// 字标：画布严格按 viewBox 宽高比，无多余留白
function genWordmark(height, fg) {
  const vb = BRAND_WORDMARK_VIEWBOX;
  const width = Math.round(height * vb.width / vb.height);
  const scale = height / vb.height;
  const px = newPixels(width, height);
  const cov = rasterize(WORDMARK_POLYGONS, width, height, scale, -vb.x * scale, -vb.y * scale);
  blendCoverage(px, width, height, cov, fg);
  return { width, height, px };
}

// ---------------------------------------------------------------- 主流程
const o = parseArgs(process.argv.slice(2));
const bg = hexToRGBA(o.bg);
const fg = hexToRGBA(o.fg);

if (!existsSync(o.out)) mkdirSync(o.out, { recursive: true });

const want = (n) => !o.only || o.only.includes(n);
const done = [];
const put = (name, w, h, px) => {
  writeFileSync(join(o.out, name), encodePNG(w, h, px));
  done.push(name);
};

if (want('foreground')) put('foreground.png', o.size, o.size, genForeground(o.size, fg));
if (want('background')) put('background.png', o.size, o.size, genBackground(o.size, bg));
if (want('icon')) put('icon.png', o.size, o.size, genTile(o.size, bg, fg));
if (want('splash')) put('splash.png', o.splashSize, o.splashSize, genTile(o.splashSize, bg, fg));
if (want('splash-mark')) {
  put('splash-mark.png', o.splashSize, o.splashSize, genMark(o.splashSize, fg, o.markRatio));
}
if (want('wordmark')) {
  const wm = genWordmark(o.wordmarkHeight, fg);
  put('wordmark.png', wm.width, wm.height, wm.px);
}

console.log('wrote', o.out, '->', done.join(', '));
console.log('  bg #' + o.bg + '  fg #' + o.fg + '  size ' + o.size + '  splash ' + o.splashSize);
