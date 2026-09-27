#!/usr/bin/env node
/**
 * 从核心树里的官方 primitives 包生成鲸鱼 SVG 资源。
 *
 * 产物：`entry/src/main/resources/base/media/fish_logo.svg`
 * 用法：`node tools/gen-fish-logo.mjs`
 *
 * 【为什么要"生成"而不是把路径内联在 ArkTS 里】
 * 此前 ArkTS 侧内联了一份 3449 字符的 path 字面量（拆两段拼接）。它出过两个问题：
 *   ① **手抄错 1 位**：`12.6435` 应为 `12.643`（差 0.0005，但那是控制点，轮廓会变形）；
 *   ② **无法核对**：内联后没人会去逐字节比，错了也不知道。
 * 改成生成式 + 资源文件后，"路径与官方是否一致"变成一条可执行的自检（见下方断言）。
 *
 * 【为什么用官方 viewBox 0 0 23.16 17.04，而不是"墨迹包围盒"】
 * 曾经算过一个"墨迹盒"（x=-0.2229 w=23.3967）并据此设 ArkUI viewPort——**那是错的**：
 * 它取的是**贝塞尔控制点**的包围盒，而控制点可以落在曲线**外面**。把每段 C 曲线
 * 离散成 400 点采样后，真实紧包围盒 = x 0.0000 w 23.1600 h 17.0434，
 * **恰好等于官方 viewBox**（零溢出）。本脚本会把这个断言也跑一遍。
 *
 * 【为什么要 SVG 而不是 ArkUI Shape 自绘】真机实测：`Shape.viewPort` 并没有把路径
 * 缩放进组件盒（组件盒 42×31px，墨迹只占左上角 25×18px，左留白 0 / 右留白 18px）
 * ⇒ 用户看到的"歪"。改用 SVG + `Image` 后等比缩放由图片组件负责，问题消失。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** 在 `dist/core/work/dsh-core-<ver>/` 里找 primitives 包（目录名随版本变，不写死）。 */
function findPrimitives() {
  const work = join(ROOT, 'dist', 'core', 'work');
  if (!existsSync(work)) {
    return '';
  }
  const dirs = readdirSync(work).filter((n) => n.startsWith('dsh-core-')).sort();
  for (let i = dirs.length - 1; i >= 0; i -= 1) {
    const p = join(work, dirs[i], 'node_modules', '@deepseek-ai', 'dsh-client-ui-primitives', 'lib', 'index.js');
    if (existsSync(p)) {
      return p;
    }
  }
  return '';
}

const srcPath = findPrimitives();
if (srcPath.length === 0) {
  console.error('[gen-fish-logo] 找不到 primitives 包；请先跑 tools/pack-core.mjs 物化核心树');
  process.exit(1);
}
const src = readFileSync(srcPath, 'utf8');

const pm = /const FISH_LOGO_PATH = "([^"]+)"/.exec(src);
const vm = /const FISH_LOGO_VIEWBOX = \{\s*width:\s*([\d.]+),\s*height:\s*([\d.]+)\s*\}/.exec(src);
if (pm === null || vm === null) {
  console.error('[gen-fish-logo] primitives 里没找到 FISH_LOGO_PATH / FISH_LOGO_VIEWBOX（上游结构变了？）');
  process.exit(1);
}
const [, path, w, h] = [pm[0], pm[1], vm[1], vm[2]];

/* ── 自检：验证"真实紧包围盒 == 官方 viewBox"这个前提 ──────────────────────
 * 把路径解析成命令流、把每段三次贝塞尔离散成 400 点取极值。若这个断言不成立，
 * 说明上游换了几何（或我的"零溢出"结论有误），此时**应停下来人工确认**，
 * 而不是默默生成一个可能偏心的资源。
 */
function lex(d) {
  return d.match(/[MLCZmlcz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
}
function cubic(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
  ];
}
function tightBBox(d) {
  const toks = lex(d);
  let cur = [0, 0];
  let start = [0, 0];
  let i = 0;
  const bb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const add = (p) => {
    bb.minX = Math.min(bb.minX, p[0]); bb.maxX = Math.max(bb.maxX, p[0]);
    bb.minY = Math.min(bb.minY, p[1]); bb.maxY = Math.max(bb.maxY, p[1]);
  };
  while (i < toks.length) {
    const c = toks[i];
    if (!/^[MLCZmlcz]$/.test(c)) { i += 1; continue; }
    i += 1;
    if (c === 'Z' || c === 'z') { cur = start; add(cur); continue; }
    const nums = [];
    while (i < toks.length && !/^[MLCZmlcz]$/.test(toks[i])) { nums.push(parseFloat(toks[i])); i += 1; }
    if (c === 'M') { cur = [nums[0], nums[1]]; start = cur; add(cur); }
    else if (c === 'L') { for (let k = 0; k + 1 < nums.length; k += 2) { cur = [nums[k], nums[k + 1]]; add(cur); } }
    else if (c === 'C') {
      for (let k = 0; k + 5 < nums.length; k += 6) {
        const p1 = [nums[k], nums[k + 1]], p2 = [nums[k + 2], nums[k + 3]], p3 = [nums[k + 4], nums[k + 5]];
        for (let s = 0; s <= 400; s += 1) add(cubic(cur, p1, p2, p3, s / 400));
        cur = p3;
      }
    }
  }
  return bb;
}
const bb = tightBBox(path);
const eps = 0.01;
const ok = Math.abs(bb.minX) < eps && Math.abs(bb.minY) < eps
  && Math.abs((bb.maxX - bb.minX) - parseFloat(w)) < eps
  && Math.abs((bb.maxY - bb.minY) - parseFloat(h)) < eps;
console.log(`[gen-fish-logo] 真实紧包围盒 x=${bb.minX.toFixed(4)}..${bb.maxX.toFixed(4)} `
  + `y=${bb.minY.toFixed(4)}..${bb.maxY.toFixed(4)}  (官方 viewBox 0 0 ${w} ${h})`);
if (!ok) {
  console.error('[gen-fish-logo] ✗ 紧包围盒与官方 viewBox 不符 —— 上游几何可能变了，请人工确认后再生成');
  process.exit(1);
}
console.log('[gen-fish-logo] ✓ 零溢出，直接用官方 viewBox');

/* ── 生成 SVG ─────────────────────────────────────────────────────────────
 * fill 给一个占位实色：HarmonyOS 的 `Image.fillColor` 会**整体重着色**单色 SVG
 * （把非透明像素统一替换成指定色），等价官方 Web 层的 `fill: currentColor`。
 * 所以这里的色值只是"必须有个合法值"，运行时由 ArkTS 侧按主题覆盖。
 * 【为什么不用 currentColor】ArkUI 的 Image 不解析 CSS 关键字，必须是具体色值。
 */
const out = join(ROOT, 'entry', 'src', 'main', 'resources', 'base', 'media', 'fish_logo.svg');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`
  + `<path d="${path}" fill="#151517"/></svg>\n`;
writeFileSync(out, svg, 'utf8');

// 落盘后回读自检：确认写进去的就是官方那串（防编码/转义悄悄改动）
const back = /d="([^"]+)"/.exec(readFileSync(out, 'utf8'))[1];
if (back !== path) {
  console.error('[gen-fish-logo] ✗ 落盘后路径与官方不一致（写入过程被改动？）');
  process.exit(1);
}
console.log(`[gen-fish-logo] ✓ 已生成 ${out.replace(ROOT + '\\', '').replace(ROOT + '/', '')}`);
console.log(`[gen-fish-logo]   path ${path.length} 字符，与官方逐字节一致；文件 ${svg.length} 字节`);
