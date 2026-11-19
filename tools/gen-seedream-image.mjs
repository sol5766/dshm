#!/usr/bin/env node
/**
 * 调用火山方舟（Ark）的 Seedream 图片生成端点，把产物落进工作区。
 *
 * 用法：
 *   $env:ARK_API_KEY = '<方舟 API Key>'
 *   node tools/gen-seedream-image.mjs --prompt "..." --out docs/brand/app-icon-concepts/x.png
 *
 * 可选参数：
 *   --prompt-file=<txt>      从 UTF-8 文本文件读提示词（避免中文经 shell 转码）
 *   --model=<接入点 ID>      默认读 ARK_IMAGE_MODEL，兜底 ep-20261011105932-h579r
 *   --size=1024x1024         方舟 Seedream 支持的尺寸
 *   --n=1                    一次出几张；多张时文件名自动加 -1/-2
 *   --image=<本地 png/jpg>   参考图（可重复传；Seedream 走多图参考时抓构图最稳）
 *   --seed=<整数>
 *   --watermark=true|false   默认 false；方舟 Seedream 需显式关水印
 *   --base-url=<...>         默认 https://ark.cn-beijing.volces.com/api/v3
 *
 * 注意：API Key **只从环境变量 / --api-key 读**，绝不写进本文件。
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API_KEY_ENV = 'ARK_API_KEY';

function parseArgs(argv) {
  const opts = { image: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const [rawKey, inlineValue] = token.slice(2).split('=');
    const key = rawKey.trim();
    const next = argv[i + 1];
    const value = inlineValue !== undefined
      ? inlineValue
      : (next && !next.startsWith('--') ? (i += 1, next) : 'true');
    if (key === 'image') opts.image.push(value);
    else opts[key] = value;
  }
  return opts;
}

function withIndex(filePath, index, total) {
  if (total <= 1) return filePath;
  const ext = path.extname(filePath);
  return `${filePath.slice(0, -ext.length) || filePath}-${index + 1}${ext}`;
}

async function toDataUrl(filePath) {
  const buffer = await readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png'
    : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp'
    : 'application/octet-stream';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.prompt && opts['prompt-file']) {
  opts.prompt = (await readFile(opts['prompt-file'], 'utf8')).trim();
}
const apiKey = opts['api-key'] || process.env[API_KEY_ENV];
if (!apiKey) {
  console.error(`缺少 API Key：请设置环境变量 ${API_KEY_ENV}，或传 --api-key=<key>（不要写进脚本）`);
  process.exit(2);
}
if (!opts.prompt) {
  console.error('缺少 --prompt');
  process.exit(2);
}
if (!opts.out) {
  console.error('缺少 --out=<输出 png 路径>');
  process.exit(2);
}

const baseUrl = opts['base-url'] || process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
const model = opts.model || process.env.ARK_IMAGE_MODEL || 'ep-20261011105932-h579r';
const size = opts.size || '1024x1024';
const n = Number.parseInt(opts.n || '1', 10);

const body = {
  model,
  prompt: opts.prompt,
  size,
  n,
  response_format: 'b64_json',
  watermark: opts.watermark === 'true',
};
if (opts.seed) body.seed = Number.parseInt(opts.seed, 10);
if (opts.image?.length) {
  body.image = await Promise.all(opts.image.map(toDataUrl));
}

const response = await fetch(`${baseUrl}/images/generations`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify(body),
});

const text = await response.text();
if (!response.ok) {
  console.error(`方舟返回 ${response.status}: ${text}`);
  process.exit(1);
}

const payload = JSON.parse(text);
const images = payload.data ?? [];
if (!images.length) {
  console.error(`方舟没有返回图片：${text.slice(0, 800)}`);
  process.exit(1);
}

for (const [index, item] of images.entries()) {
  let buffer;
  if (item.b64_json) {
    buffer = Buffer.from(item.b64_json, 'base64');
  } else if (item.url) {
    buffer = Buffer.from(await (await fetch(item.url)).arrayBuffer());
  } else {
    console.error(`第 ${index + 1} 张没有可保存的数据：${JSON.stringify(item).slice(0, 300)}`);
    continue;
  }
  const target = withIndex(opts.out, index, images.length);
  await writeFile(target, buffer);
  console.log(`${target} (${buffer.length} bytes)`);
}
