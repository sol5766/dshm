#!/usr/bin/env node
/*
 * check-tar-extract.mjs —— 纯 JS tar / tar.gz 解包（hostcore/app/tar-gz.cjs）的门禁。
 *
 * 【为什么需要】2026-10-07 手机端体检报告 P0-2：手机 / 平板档的 Python 运行时
 * 永远 `stdlib=false`，因为工具链解包原先是 `spawn busybox tar`，而本档禁止创建
 * 进程（docs/104）。修法是把解包改成进程内纯 JS。这条路径一旦坏了，**症状是静默的**
 * ——`runtime.python` 只是永远 pending，不会有任何报错冒到界面上。故用门禁钉住：
 *   · ustar 基本落位 / 嵌套目录自动建立
 *   · npm tarball 的 `package/` 前缀剥离
 *   · **tar-slip 防护**（`..` 段、绝对路径 ⇒ 抛错，不静默跳过）
 *   · symlink / hardlink 不建链（沙箱禁 link，真机探针 13900012）⇒ 跳过并如实报告
 *   · **PAX `path=`**（CPython 归档里有 9 条超长路径就靠它）
 *   · GNU longname（'L'）
 *   · 异步入口 extractTarGzFile 与同步入口产出同一棵树
 *   · **接线**（§10）：修法必须真的被用上 —— 两条 spawn 失败路径都经一次性门闩接到回退、
 *     回退只解 python、插件安装器复用同一份 walker、两个 resfile 快照清单都带上本文件
 * 另含**注入式对照臂**（本项目纪律：未经负测试验证的断言视为没有断言）：
 *   · 对照臂 1：把 PAX 当"跳过即可"的旧实现 ⇒ 超长路径必须**落错位置**（证明该用例真在考 PAX）
 *   · 对照臂 2：去掉 `..` 守卫的朴素实现 ⇒ 必须**真的越界写出文件**（证明 tar-slip 断言有牙）
 *
 * 用法：node tools/check-tar-extract.mjs
 * 输出刻意用 ASCII 前缀（PS 5.1 控制台 GBK 兼容）。
 */
import { gzipSync } from 'node:zlib';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tarGz = require('../hostcore/app/tar-gz.cjs');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('[PASS] ' + label);
  } else {
    fail += 1;
    console.log('[FAIL] ' + label + (detail ? ' -- ' + detail : ''));
  }
}

const BLOCK = 512;

/** 造一个 ustar 头（校验和按标准算，虽然解析器不校验）。 */
function header(name, size, type, linkname) {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 8, 'utf8');   // mode
  h.write('0000000\0', 108, 8, 'utf8');   // uid
  h.write('0000000\0', 116, 8, 'utf8');   // gid
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
  h.write('00000000000\0', 136, 12, 'utf8'); // mtime
  h.write('        ', 148, 8, 'utf8');       // 校验和占位
  h.write(type, 156, 1, 'utf8');
  if (linkname) h.write(linkname, 157, 100, 'utf8');
  h.write('ustar\0' + '00', 257, 8, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  return h;
}

function fileEntry(name, text) {
  const data = Buffer.from(text, 'utf8');
  const pad = Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK - data.length);
  return Buffer.concat([header(name, data.length, '0'), data, pad]);
}

function linkEntry(name, type, target) {
  return header(name, 0, type, target);
}

/** pax 扩展头：正文是 `<len> key=value\n` */
function paxEntry(key, value) {
  const rec = key + '=' + value + '\n';
  let len = Buffer.byteLength(rec) + 2; // 自身长度前缀 + 空格
  while (Buffer.byteLength(String(len)) + 1 + Buffer.byteLength(rec) !== len) {
    len = Buffer.byteLength(String(len)) + 1 + Buffer.byteLength(rec);
  }
  const body = Buffer.from(String(len) + ' ' + rec, 'utf8');
  const pad = Buffer.alloc(Math.ceil(body.length / BLOCK) * BLOCK - body.length);
  return Buffer.concat([header('PaxHeader', body.length, 'x'), body, pad]);
}

const END = Buffer.alloc(BLOCK * 2);
const tmpRoot = mkdtempSync(join(tmpdir(), 'dshm-tar-gate-'));
const made = [];
function dir(name) {
  const d = join(tmpRoot, name);
  made.push(d);
  rmSync(d, { recursive: true, force: true });
  return d;
}

try {
  // ── 1. ustar 基本落位 + 嵌套目录自动建立 ──────────────────────────
  {
    const buf = Buffer.concat([fileEntry('a.txt', 'hello'), fileEntry('d/e/f.txt', 'deep'), END]);
    const dest = dir('basic');
    const r = tarGz.extractTar(buf, dest);
    check('ustar: 顶层文件落位', readFileSync(join(dest, 'a.txt'), 'utf8') === 'hello');
    check('ustar: 嵌套目录自动建立且内容正确', readFileSync(join(dest, 'd', 'e', 'f.txt'), 'utf8') === 'deep');
    check('ustar: written 计数 = 2', r.written === 2, 'written=' + r.written);
  }

  // ── 2. npm tarball 的 package/ 前缀剥离 ──────────────────────────
  {
    const buf = Buffer.concat([fileEntry('package/lib/x.js', 'x1'), fileEntry('package.json', '{}'), END]);
    const dest = dir('npm');
    tarGz.extractTar(buf, dest, { stripPrefixes: ['package'] });
    check('npm: package/ 前缀被剥掉', existsSync(join(dest, 'lib', 'x.js')));
    check('npm: 前缀目录本身不落盘', !existsSync(join(dest, 'package')));
    check('npm: package.json 不被误剥', readFileSync(join(dest, 'package.json'), 'utf8') === '{}');
  }

  // ── 3. tar-slip 防护 ─────────────────────────────────────────────
  {
    const dest = dir('slip-rel');
    let threw = false;
    try {
      tarGz.extractTar(Buffer.concat([fileEntry('../evil.txt', 'boom'), END]), dest);
    } catch (e) {
      threw = true;
    }
    check('tar-slip: `../` 条目抛错', threw);
    check('tar-slip: 没有越界文件', !existsSync(join(tmpRoot, 'evil.txt')));
  }
  {
    const dest = dir('slip-abs');
    let threw = false;
    try {
      tarGz.extractTar(Buffer.concat([fileEntry('/abs-evil.txt', 'boom'), END]), dest);
    } catch (e) {
      threw = true;
    }
    check('tar-slip: 绝对路径抛错', threw);
  }

  // ── 4. symlink / hardlink 不建链，但如实报告 ──────────────────────
  {
    const buf = Buffer.concat([
      fileEntry('real.txt', 'real'),
      linkEntry('link.txt', '2', 'real.txt'),
      linkEntry('hard.txt', '1', 'real.txt'),
      END,
    ]);
    const dest = dir('links');
    const r = tarGz.extractTar(buf, dest);
    check('link: 真身落位', existsSync(join(dest, 'real.txt')));
    check('link: symlink 未创建', !existsSync(join(dest, 'link.txt')));
    check('link: hardlink 未创建', !existsSync(join(dest, 'hard.txt')));
    check('link: 两个链接都进了 skipped', r.skipped.length === 2, 'skipped=' + r.skipped.length);
    check('link: links 计数 = 2（symlink + hardlink）', r.links === 2, 'links=' + r.links);
  }

  // ── 5. PAX path=（超长路径必须落到正确位置） ─────────────────────
  const longPath = 'python/lib/python3.12/site-packages/pip-26.2.1.dist-info/licenses/src/pip/_vendor/distlib/LICENSE.txt';
const truncated = longPath.slice(0, 100); // ustar 名字字段的极限；超长部分只能靠 PAX 承载
  {
    const buf = Buffer.concat([
      paxEntry('path', longPath),
      // ustar 头里放一个**被截断的**名字：只有采纳 PAX 才会落到上面的正确路径
      fileEntry(truncated, 'MIT'),
      END,
    ]);
    check('PAX 夹具本身够长（>100 字符）', longPath.length > 100, 'len=' + longPath.length);
    const dest = dir('pax');
    tarGz.extractTar(buf, dest);
    check('PAX: 超长路径落到正确位置', readFileSync(join(dest, ...longPath.split('/')), 'utf8') === 'MIT');
    check('PAX: 没有落到截断名上', !existsSync(join(dest, ...truncated.split('/'))));
  }

  // ── 6. GNU longname（'L'） ───────────────────────────────────────
  {
    const longName = 'gnu/' + 'x'.repeat(140) + '.txt';
    const lh = header('././@LongLink', longName.length, 'L');
    const buf = Buffer.concat([
      lh, Buffer.from(longName, 'utf8'), Buffer.alloc(Math.ceil(longName.length / BLOCK) * BLOCK - longName.length),
      fileEntry('gnu/truncated', 'LONG'),
      END,
    ]);
    const dest = dir('gnu');
    tarGz.extractTar(buf, dest);
    check('GNU longname: 落到完整路径', readFileSync(join(dest, 'gnu', 'x'.repeat(140) + '.txt'), 'utf8') === 'LONG');
  }

  // ── 7. 异步入口 extractTarGzFile 与同步入口同一棵树 ───────────────
  {
    const buf = Buffer.concat([
      fileEntry('a.txt', 'A'), fileEntry('b/c.txt', 'C'),
      paxEntry('path', longPath), fileEntry(truncated, 'P'),
      linkEntry('l.txt', '2', 'a.txt'), END,
    ]);
    const gz = gzipSync(buf);
    const dest = dir('async');
    const gzPath = join(tmpRoot, 'fixture.tar.gz');
    writeFileSync(gzPath, gz);
    const r = await tarGz.extractTarGzFile(gzPath, dest, { yieldEvery: 1 });
    check('async: 文件落位', readFileSync(join(dest, 'a.txt'), 'utf8') === 'A');
    check('async: 嵌套目录内容正确', readFileSync(join(dest, 'b', 'c.txt'), 'utf8') === 'C');
    check('async: PAX 同样被采纳', readFileSync(join(dest, ...longPath.split('/')), 'utf8') === 'P');
    check('async: 链接同样被跳过', r.skipped.length === 1, 'skipped=' + r.skipped.length);
    check('async: 与同步入口 written 一致', r.written === 3, 'written=' + r.written);
  }

  // ── 8. 对照臂 1：忽略 PAX 的"旧实现"必须把超长路径落错 ────────────
  {
    const buf = Buffer.concat([
      paxEntry('path', longPath),
      fileEntry(truncated, 'MIT'),
      END,
    ]);
    const dest = dir('ctrl-pax');
    let off = 0;
    while (off + BLOCK <= buf.length) {
      const h = buf.subarray(off, off + BLOCK);
      if (h.every((b) => b === 0)) break;
      const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
      const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0/g, '').trim(), 8) || 0;
      const type = String.fromCharCode(h[156] || 0x30);
      off += BLOCK;
      const padded = Math.ceil(size / BLOCK) * BLOCK;
      if (type === 'x' || type === 'g') { off += padded; continue; }  // ← 旧实现：PAX 直接跳过
      if (type === '0' || type === '\0') {
        const segs = name.split('/');
        const target = join(dest, ...segs);
        const { mkdirSync } = require('node:fs');
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, buf.subarray(off, off + size));
      }
      off += padded;
    }
    check('对照臂1: 忽略 PAX ⇒ 正确路径下**没有**文件（证明该用例真在考 PAX）', !existsSync(join(dest, ...longPath.split('/'))));
    check('对照臂1: 忽略 PAX ⇒ 文件落在截断名上（旧行为的形态）', existsSync(join(dest, ...truncated.split('/'))));
  }

  // ── 9. 对照臂 2：去掉 `..` 守卫的朴素实现必须真的越界 ─────────────
  {
    const dest = dir('ctrl-slip');
    const outside = join(tmpRoot, 'ctrl-evil.txt');
    rmSync(outside, { force: true });
    const buf = Buffer.concat([fileEntry('../ctrl-evil.txt', 'boom'), END]);
    let off = 0;
    while (off + BLOCK <= buf.length) {
      const h = buf.subarray(off, off + BLOCK);
      if (h.every((b) => b === 0)) break;
      const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
      const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0/g, '').trim(), 8) || 0;
      off += BLOCK;
      const { mkdirSync } = require('node:fs');
      mkdirSync(join(dest, name, '..'), { recursive: true });
      writeFileSync(join(dest, name), buf.subarray(off, off + size));  // ← 无校验：直接 join
      off += Math.ceil(size / BLOCK) * BLOCK;
    }
    check('对照臂2: 无守卫的朴素实现**越界写出了文件**（证明 tar-slip 断言有牙）', existsSync(outside));
    rmSync(outside, { force: true });
  }

  // ── 10. 接线：修法必须真的被用上（实现对了却没接上 ⇒ 症状与修复前一样静默）──────
  {
    const ROOT = join(import.meta.dirname, '..');
    const appDir = join(ROOT, 'hostcore', 'app');
    const main = readFileSync(join(appDir, 'main.js'), 'utf8');
    const installer = readFileSync(join(appDir, 'dshm-installer.js'), 'utf8');
    const place = readFileSync(join(ROOT, 'tools', 'place-host-app.mjs'), 'utf8');
    const sync = readFileSync(join(ROOT, 'tools', 'assert-resfile-sync.mjs'), 'utf8');

    check('接线: main.js require 进程内解包实现',
      /const tarGz = require\('\.\/tar-gz\.cjs'\)/.test(main));
    // spawn 失败有两条路径（同步抛错 / 异步 'error' 事件）；本档实测走的是后者，漏任一条 ⇒ 那半形态仍哑
    check('接线: 两条 spawn 失败路径都经一次性门闩接上（各 1 处调用）',
      (main.match(/inProcFallback\(/g) || []).length === 2
      && /const inProcFallback = \(why\) => \{/.test(main)
      // 真身只许被引用 2 次：函数定义 + 门闩体内那一次（多一处 = 绕过门闩直呼）
      && (main.match(/inProcessToolchainFallback\(/g) || []).length === 2);
    // 同一个 child 上两条路径可能都触发，而两遍都往同一个 py-stage 写
    check('接线: 回退是一次性门闩（重复触发只留一行 diag）',
      /inProcFallbackDone = true;/.test(main) && /进程内回退已在进行（忽略重复触发/.test(main));
    const fbStart = main.indexOf('function inProcessToolchainFallback(');
    const fbEnd = main.indexOf('function finishToolchainExtraction(');
    const fb = fbStart >= 0 && fbEnd > fbStart ? main.slice(fbStart, fbEnd) : '';
    check('接线: 回退只解 python（git 真身在本档起不来，解它只占磁盘）',
      /extractTarGzFile\(tarball, pyStage/.test(fb)
      && /finishToolchainExtraction\(true, false\)/.test(fb)
      && !/apks/.test(fb));
    check('接线: 插件安装器复用同一份 walker（不是第二份私有 ustar）',
      /require\('\.\/tar-gz\.cjs'\)/.test(installer) && /tarGz\.extractTar\(/.test(installer));
    // 漏进 resfile ⇒ require 抛 MODULE_NOT_FOUND，被调用点吞成一行 diag = 与修复前一模一样
    check('接线: place-host-app 的 FILES 带 tar-gz.cjs',
      /const FILES = \[[^\]]*'tar-gz\.cjs'/.test(place));
    check('接线: assert-resfile-sync 的 FILES 带 tar-gz.cjs',
      /const FILES = \[[\s\S]*?'tar-gz\.cjs'/.test(sync));
  }
} finally {
  for (const d of made) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 尽力 */ }
}

console.log('');
console.log(`check-tar-extract: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);