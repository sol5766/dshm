'use strict';
/**
 * 纯 JS 的 tar / tar.gz 解包（ustar + GNU longname + PAX）——**单份实现**。
 *
 * 【为什么存在】端侧有两条路都需要解 tar，而且都**不能 spawn**：
 *   1. `dshm-installer.js`（插件安装队列）从 registry 拉 npm tarball 落位；
 *   2. `main.js` 的工具链解包（CPython stdlib 25MB tar.gz / git apk）。
 * 第 2 条原先走的是 `spawn <busybox> ash -c "tar xmzf …"`：**在 PC/2in1 档可用，
 * 在手机/平板档必失败**——本档 SELinux 域下应用自带可执行文件一律 `EACCES`
 * （判决性读数见 `docs/104` §2/§3）。于是本档表现为：每次启动都删掉
 * `<toolchain>/python`、spawn 报错、`.extract.log` 落 0 字节、`runtime.python`
 * 永远 `stdlib=false`（2026-10-07 手机端体检报告 P0-2）。
 *   ⇒ 解包必须有一条**不创建任何进程**的等价实现；tar.gz = gzip(ustar)，
 *     `node:zlib.gunzipSync` + 512 字节头解析是零依赖的确定性路径。
 *
 * 【与 dshm-installer 旧实现的合并】旧实现（`extractTar(tarBuf, destDir)`）只支持
 * ustar + GNU longname，**PAX 头直接跳过**。CPython 归档里有 9 条 PAX `path=`
 * （pip 内置 license 的超长路径）⇒ 忽略 PAX 会把这 9 个条目落到**错误的路径**。
 * 故本模块补上 PAX（path/linkpath/size），并保留旧实现的三条语义：
 *   ① 逐段校验路径（`..` / 绝对路径 ⇒ 抛错，tar-slip 防护，不静默跳过）；
 *   ② npm tarball 的 `package/` 根前缀剥离（由调用方以 stripPrefixes 指定）；
 *   ③ symlink/hardlink **不建链**（沙箱禁 link，真机探针 13900012）⇒ 如实跳过并报告。
 *
 * 【为什么会有 async 入口】安装器的 `extractTar` 是同步契约（既有门禁
 * `tools/check-dshm-installer.cjs` 同步调用它、并断言恶意条目**抛出**），
 * 而工具链要解 4530 个条目 / 80MB，同步写会把 Host 事件循环钉住（本项目的
 * `LOOP-GAP` 已经在另一处踩过）。故：核心走**生成器**，对外提供
 *   · `extractTar(buf, destDir, opts)`       —— 同步（安装器 / 门禁契约不变）
 *   · `extractTarGzFile(archive, destDir, opts)` —— 异步，按批 `await` 让出事件循环
 * 两者共用同一个 walker，不存在第二份解析逻辑。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BLOCK = 512;

/** 读 tar 头里的定长字符串（NUL 截断）。 */
function readStr(buf, start, len) {
  const s = buf.subarray(start, start + len).toString('utf8');
  const nul = s.indexOf('\0');
  return nul >= 0 ? s.slice(0, nul) : s;
}

/** 八进制 size 字段；GNU base-256（最高位为 1）也接受。 */
function readSize(header) {
  if ((header[124] & 0x80) !== 0) {
    let v = 0;
    for (let i = 124; i < 136; i++) {
      v = v * 256 + (i === 124 ? header[i] & 0x7f : header[i]);
    }
    return v;
  }
  const s = readStr(header, 124, 12).trim();
  return s.length > 0 ? (parseInt(s, 8) || 0) : 0;
}

/**
 * 解析 pax 扩展头正文：一串 `<len> <key>=<value>\n` 记录（len 含自身）。
 * 返回 Map；畸形记录整条忽略（不抛错——pax 只是元数据，不该阻断解包）。
 */
function parsePax(text) {
  const out = new Map();
  let pos = 0;
  while (pos < text.length) {
    const sp = text.indexOf(' ', pos);
    if (sp < 0) {
      break;
    }
    const len = parseInt(text.slice(pos, sp), 10);
    if (!Number.isFinite(len) || len <= 0 || pos + len > text.length) {
      break;
    }
    const rec = text.slice(sp + 1, pos + len - 1); // 去掉结尾 \n
    const eq = rec.indexOf('=');
    if (eq > 0) {
      out.set(rec.slice(0, eq), rec.slice(eq + 1));
    }
    pos += len;
  }
  return out;
}

/** 路径安全校验 + 前缀剥离；返回 null 表示该条目应被忽略（根目录条目等）。 */
function normalizeEntryPath(name, stripPrefixes) {
  let rel = name;
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const pre of stripPrefixes) {
      if (rel === pre || rel === pre + '/') {
        return null; // 前缀目录条目本身
      }
      if (rel.startsWith(pre + '/')) {
        rel = rel.slice(pre.length + 1);
        stripped = true;
      }
    }
  }
  rel = rel.replace(/\/+$/, '');
  if (rel.length === 0) {
    return null;
  }
  const segs = rel.split('/');
  if (rel.startsWith('/') || rel.startsWith('\\') || segs.indexOf('..') >= 0) {
    throw new Error('tar 条目路径不安全，拒绝解包：' + name);
  }
  return segs;
}

/**
 * 遍历 tar，逐个产出条目。**不落盘**，只做解析与路径校验。
 * @param {Buffer} tarBuf
 * @param {{stripPrefixes?: string[], ignoreTypes?: string[]}} [opts]
 */
function* walkTar(tarBuf, opts) {
  const stripPrefixes = (opts && opts.stripPrefixes) || [];
  let off = 0;
  let gnuLongName = null;
  let gnuLongLink = null;
  let globalPax = new Map();
  let nextPax = null;
  while (off + BLOCK <= tarBuf.length) {
    const header = tarBuf.subarray(off, off + BLOCK);
    if (header.every((b) => b === 0)) {
      return; // 结束块
    }
    let name = readStr(header, 0, 100);
    const prefix = readStr(header, 345, 155);
    const size = readSize(header);
    const type = String.fromCharCode(header[156] || 0x30);
    const linkname = readStr(header, 157, 100);
    off += BLOCK;
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    const body = tarBuf.subarray(off, off + size);

    if (type === 'L') { // GNU long name：正文是下一个条目的名字
      gnuLongName = readStr(tarBuf, off, size);
      off += padded;
      continue;
    }
    if (type === 'K') { // GNU long linkname
      gnuLongLink = readStr(tarBuf, off, size);
      off += padded;
      continue;
    }
    if (type === 'x') { // pax：作用于下一个条目
      nextPax = parsePax(readStr(tarBuf, off, size));
      off += padded;
      continue;
    }
    if (type === 'g') { // pax：全局
      for (const [k, v] of parsePax(readStr(tarBuf, off, size))) {
        globalPax.set(k, v);
      }
      off += padded;
      continue;
    }

    const pax = nextPax === null ? globalPax : new Map([...globalPax, ...nextPax]);
    nextPax = null;
    let entryName = gnuLongName !== null ? gnuLongName : (prefix.length > 0 ? prefix + '/' + name : name);
    let entryLink = gnuLongLink !== null ? gnuLongLink : linkname;
    let entrySize = size;
    gnuLongName = null;
    gnuLongLink = null;
    if (pax.has('path')) {
      entryName = pax.get('path');
    }
    if (pax.has('linkpath')) {
      entryLink = pax.get('linkpath');
    }
    if (pax.has('size')) {
      const n = parseInt(pax.get('size'), 10);
      if (Number.isFinite(n)) {
        // 只影响本条目的数据长度（pax size 用于 >8GB 的巨型文件）
        entrySize = n;
      }
    }

    const segs = normalizeEntryPath(entryName, stripPrefixes);
    off += padded;
    if (segs === null) {
      continue;
    }
    yield { type: type === '\0' ? '0' : type, segs: segs, name: entryName, link: entryLink, size: entrySize, body: body };
  }
}

/**
 * 解包统计。`links` = 被跳过的链接类条目数（tar type '1' hardlink + '2' symlink），
 * 与 `skipped` 的长度不是一回事：`skipped` 还含设备节点等其它被跳过的罕见类型。
 */
function newStats() {
  return { written: 0, dirs: 0, skipped: [], links: 0, refused: [] };
}

/** 把一条条目落盘。type 语义同 tar typeflag。 */
function writeEntry(entry, destDir, stats) {
  const target = path.join(destDir, ...entry.segs);
  if (entry.type === '5') {
    fs.mkdirSync(target, { recursive: true });
    stats.dirs += 1;
    return;
  }
  if (entry.type === '0' || entry.type === '7') {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.body.subarray(0, entry.size));
    stats.written += 1;
    return;
  }
  // '1'/'2' = hardlink/symlink（沙箱禁 link，13900012）；其余罕见类型（设备节点等）一律跳过
  stats.skipped.push(entry.name + '（type=' + entry.type + '）');
  if (entry.type === '1' || entry.type === '2') {
    stats.links += 1;
  }
}

/**
 * 同步解 tar（**契约与旧实现一致**：恶意路径抛错、返回 {written, skipped}）。
 * @param {Buffer} tarBuf @param {string} destDir
 * @param {{stripPrefixes?: string[]}} [opts]
 */
function extractTar(tarBuf, destDir, opts) {
  const stats = newStats();
  for (const entry of walkTar(tarBuf, opts)) {
    writeEntry(entry, destDir, stats);
  }
  return stats;
}

/**
 * 异步解 tar.gz 文件：gunzip 之后逐条落盘，每 `yieldEvery` 条 `await` 一次让出事件循环。
 * 【为什么不是流式】gunzipSync 一次 84MB 的峰值是确定的、可接受的；流式解析的
 * 回压状态机反而更容易出错，而这条路径只在首次解包跑一次。
 * @param {string} archivePath @param {string} destDir
 * @param {{stripPrefixes?: string[], yieldEvery?: number, onProgress?: (n:number)=>void}} [opts]
 */
async function extractTarGzFile(archivePath, destDir, opts) {
  const o = opts || {};
  const yieldEvery = typeof o.yieldEvery === 'number' && o.yieldEvery > 0 ? o.yieldEvery : 64;
  const raw = zlib.gunzipSync(fs.readFileSync(archivePath));
  const stats = newStats();
  let seen = 0;
  const breathe = () => new Promise((r) => setImmediate(r));
  for (const entry of walkTar(raw, o)) {
    writeEntry(entry, destDir, stats);
    seen += 1;
    if (seen % yieldEvery === 0) {
      if (typeof o.onProgress === 'function') {
        o.onProgress(seen);
      }
      await breathe();
    }
  }
  return stats;
}

module.exports = { extractTar, extractTarGzFile, walkTar };