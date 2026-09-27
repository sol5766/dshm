#!/usr/bin/env node
/*
 * 语音模型在线下载器（host 侧 Node 运行）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么在 host 侧（Node）而不是 ArkTS 侧
 * ══════════════════════════════════════════════════════════════════════════
 * · Node 侧已有可用的 HTTP 通道（fetch 垫片基于 node:http/https）与
 *   `node:crypto` 的 createHash —— 下载 + sha256 校验开箱即用；
 * · ArkTS 侧要引入 cryptoFramework 才能算 sha256，且大文件读写受 ArkTS
 *   单次 write 限制，需自行分块；
 * · 落盘位置同属应用沙箱，ArkTS 侧可直接用绝对路径读取（sherpa-onnx 在不传
 *   resourceManager 时即按文件路径打开模型）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 资源清单与校验
 * ══════════════════════════════════════════════════════════════════════════
 * 清单内置在下方 ASSETS（与 ohosSenseVoice 仓库的 runtime/assets.json 同形）。
 * 每个文件下载后**必须**通过 sha256 + 字节数校验，否则删除并报错 ——
 * 模型损坏在运行时极难定位，必须在下载阶段拦住。
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 资源来源：
 *   model.int8.onnx  —— 228MB，超出 git 单文件上限，故放在 Release 附件
 *   tokens.txt / silero_vad.onnx —— 体积小，随仓库分发
 */
const ORIGIN = 'https://gitcode.com';
const RELEASE_PATH = '/u010189254/ohosSenseVoice/releases/download/v1.13.3/model.int8.onnx';
const REPO_RAW = 'https://gitcode.com/api/v5/repos/u010189254/ohosSenseVoice/raw';

export const ASSETS = [
  {
    name: 'model.int8.onnx',
    url: ORIGIN + RELEASE_PATH,
    bytes: 239233841,
    sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
  },
  {
    name: 'tokens.txt',
    url: `${REPO_RAW}/assets/tokens.txt?ref=main`,
    bytes: 315894,
    sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
  },
  {
    name: 'silero_vad.onnx',
    url: `${REPO_RAW}/assets/silero_vad.onnx?ref=main`,
    bytes: 1807522,
    sha256: 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28',
  },
];

/**
 * 单个资产是否已就位。
 *
 * 【两级校验：先 stat，再（仅当需要时）算 sha256】
 *
 * 早期实现每次调用都 `readFileSync` 整文件算 sha256。对 228MB 的模型，
 * 这带来两个真实问题：
 *   ① **内存尖峰**：`readFileSync` 把整文件读进 Buffer；而下载路径特意做成
 *      "流式写盘、避免 228MB 峰值"（见 downloadAsset 注释）⇒ 两者自相矛盾。
 *   ② **每次识别都付一遍**：`missingAssets()` 被 `transcribe`、
 *      `inspect()`、`preparation.snapshot()` 路径反复调用，
 *      每次都要把 228MB 读一遍 + 哈希一遍。
 *
 * 现行策略：
 *   · 默认只看**存在 + 字节数**（stat，O(1)）—— 这是"就绪"的日常判据；
 *   · 需要强校验时（下载完成、显式 verify）再走完整 sha256。
 * 理由：文件一旦经我们下载并通过 sha256 校验才会被 `renameSync` 到正式名
 * （见 downloadAsset），此后被改写/损坏的概率极低；而每次读 228MB 是**确定**
 * 的代价。用确定的小代价换极小的风险，是这里的正确取舍。
 *
 * @param dir 模型目录
 * @param asset 资产描述
 * @param options `{ verify: true }` 时强制算 sha256（默认 false）
 */
export function isAssetReady(dir, asset, options) {
  const p = join(dir, asset.name);
  if (!existsSync(p)) return false;
  let st;
  try { st = statSync(p); } catch { return false; }
  if (st.size !== asset.bytes) return false;
  const verify = options !== undefined && options.verify === true;
  if (!verify) return true;
  try {
    return createHash('sha256').update(readFileSync(p)).digest('hex') === asset.sha256;
  } catch { return false; }
}

/**
 * 全部资产是否已就位。
 *
 * @param dir 模型目录
 * @param options `{ verify: true }` 时对每个资产做完整 sha256（默认只 stat）
 * @returns 缺失的资产列表（空数组表示全部就绪）
 */
export function missingAssets(dir, options) {
  return ASSETS.filter((a) => !isAssetReady(dir, a, options));
}

/**
 * 下载单个资产到 `dir`，边下边校验。
 *
 * 【为什么先写 `.part` 再改名】直接写目标名时，若中途失败会留下一个
 * 尺寸不对但名字正确的文件 —— 下次启动会把它当成"已存在"而跳过下载。
 * 先写临时名、校验通过后再原子改名，可避免这种污染。
 *
 * @param asset 资产描述
 * @param dir 目标目录
 * @param onProgress 进度回调 (completedBytes, totalBytes)
 * @param signal 取消信号
 */
export async function downloadAsset(asset, dir, onProgress, signal) {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, asset.name);
  const tmp = `${target}.part`;
  rmSync(tmp, { force: true });

  const res = await fetch(asset.url, { signal });
  if (!res.ok) {
    throw new Error(`下载 ${asset.name} 失败：HTTP ${res.status} ${res.statusText}`);
  }

  /*
   * 【边读边写盘】不把整段内容留在内存里。
   *
   * 228MB 若先累积成数组再 Buffer.concat，需要约两倍峰值内存；
   * 端侧 Node 跑在嵌入式运行时上，这种分配可能失败，且失败信息
   * 容易被误读成"磁盘空间不足"。流式写到临时文件：
   *   · 内存占用恒定（几十 KB 的读块）
   *   · 仍能边下边算 sha256 并上报进度
   *   · 校验通过才改名 ⇒ 失败不会留下冒充完整的文件
   */
  const hash = createHash('sha256');
  let completed = 0;
  const declared = Number(res.headers.get('content-length') || 0) || asset.bytes;

  const fd = openSync(tmp, 'w');
  try {
    if (res.body !== null && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        hash.update(buf);
        writeSync(fd, buf);
        completed += buf.length;
        if (onProgress) onProgress(completed, declared);
      }
    } else {
      /* 垫片不支持流式时退化：一次性取回后立刻写盘 */
      const buf = Buffer.from(await res.arrayBuffer());
      hash.update(buf);
      writeSync(fd, buf);
      completed = buf.length;
      if (onProgress) onProgress(completed, declared);
    }
  } finally {
    closeSync(fd);
  }

  const sha = hash.digest('hex');
  if (completed !== asset.bytes || sha !== asset.sha256) {
    rmSync(tmp, { force: true });
    throw new Error(
      `校验失败 ${asset.name}：得到 ${completed}B / ${sha.slice(0, 16)}…，`
      + `期望 ${asset.bytes}B / ${asset.sha256.slice(0, 16)}…`);
  }

  renameSync(tmp, target);
  return target;
}

/**
 * 确保 `dir` 下三个资产齐备；缺失的逐个下载。
 *
 * @param dir 模型目录（应用沙箱内的绝对路径）
 * @param onState 状态回调，用于把进度传给 UI
 * @param signal 取消信号
 */
export async function ensureAssets(dir, onState, signal) {
  const report = (state) => { if (onState) onState(state); };
  const need = missingAssets(dir);

  if (need.length === 0) {
    report({ phase: 'ready' });
    return dir;
  }

  for (const asset of need) {
    report({ phase: 'downloading', resource: asset.name, completedBytes: 0, totalBytes: asset.bytes });
    await downloadAsset(asset, dir, (completed, total) => {
      report({ phase: 'downloading', resource: asset.name, completedBytes: completed, totalBytes: total });
    }, signal);
  }

  /*
   * 收尾核对：这里走**完整 sha256**（`verify: true`）。
   *
   * 【为什么这里不能省】刚下载完正是"最需要强校验"的时刻 —— 网络传输、
   * 磁盘写入都可能让内容与清单不符。而下载路径里 downloadAsset 自己也已
   * 边写边算并比对过，这里是**第二道独立核对**（防"改名成功但内容错"）。
   * 代价：只在下载结束发生一次，不在每次识别路径上。
   */
  const stillMissing = missingAssets(dir, { verify: true });
  if (stillMissing.length > 0) {
    throw new Error(`以下资产校验未通过：${stillMissing.map((a) => a.name).join(', ')}`);
  }
  report({ phase: 'ready' });
  return dir;
}

export { ORIGIN, RELEASE_PATH, REPO_RAW };
