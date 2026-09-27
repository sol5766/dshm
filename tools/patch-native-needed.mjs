#!/usr/bin/env node
/*
 * 原地改写 ELF 共享库的某个 DT_NEEDED 字符串。
 *
 * 【为什么需要它】真机实测（D6 E44/E45）：
 *   koffi 的 .node 由 Node 的 `process.dlopen` 载入时，报
 *       Error relocating …/libs/arm64/libkoffi.so: napi_fatal_error: symbol not found
 *   读数（同一进程内并列打印）：
 *       dlsym(RTLD_DEFAULT, "napi_fatal_error")  -> /system/lib64/platformsdk/libace_napi.z.so
 *       dlsym(RTLD_DEFAULT, "napi_get_undefined") -> 同一个
 *       dlopen(libkoffi.so)                        -> 仍然 symbol not found
 *   而 `napi_fatal_error` 是 libkoffi.dynsym 里**序号最小的** napi 符号（index 5，紧随其后的
 *   index 15/16 是 `uv_poll_start`/`uv_strerror`）⇒ 加载器只是报了第一个失败者，真实情况是
 *   **koffi 的重定位作用域里一个 Node 运行期符号都没有**：dlopen 出来的对象只按
 *   「自身 + 自身依赖闭包 + 全局组」解析，而 libnode 既不（有效地）进全局组，也不在它的闭包里。
 *
 * 【为什么改写而不是新增】新增一条 DT_NEEDED 要动 .dynamic/.dynstr 的结构（需要 patchelf）；
 * 而 `libc++_shared.so`（16 字节）比 `libnode.so.127`（14 字节）长，**原地替换 + NUL 补齐**
 * 不改变任何长度与偏移，是零结构风险的改动。libc++ 不会因此丢失：libnode.so.127 自己就
 * DT_NEEDED libc++_shared.so，会随 libnode 一起进入 koffi 的依赖闭包（传递依赖同样参与解析）。
 *
 * 用法：
 *   node tools/patch-native-needed.mjs <so 路径> <原 NEEDED> <新 NEEDED> [--check|--revert]
 *   --check   只报告当前值，不写文件
 *   --revert  从 <so>.orig 备份还原
 * 幂等：已是目标值时直接跳过；原值不存在时报错而非静默成功。
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const ELF_MAGIC = 0x7f454c46;
const SHT_STRTAB = 3;
const DT_NULL = 0;
const DT_NEEDED = 1;
const DT_RPATH = 15;
const DT_RUNPATH = 29;

function fail(message) {
  console.error(`patch-native-needed: ${message}`);
  process.exit(1);
}

/** 解析 ELF64 LE 的节表，返回 [{name, offset, size, type}] 与总入口数。 */
function readSections(buf) {
  if (buf.readUInt32BE(0) !== ELF_MAGIC) fail('不是 ELF 文件');
  if (buf[4] !== 2) fail('只支持 ELF64');
  if (buf[5] !== 1) fail('只支持小端');
  const eShoff = Number(buf.readBigUInt64LE(0x28));
  const eShentsize = buf.readUInt16LE(0x3a);
  const eShnum = buf.readUInt16LE(0x3c);
  const eShstrndx = buf.readUInt16LE(0x3e);
  if (eShoff === 0 || eShnum === 0) fail('没有节表（被 strip 掉的库无法用本工具）');
  const raw = [];
  for (let i = 0; i < eShnum; i += 1) {
    const base = eShoff + i * eShentsize;
    raw.push({
      nameOff: buf.readUInt32LE(base),
      type: buf.readUInt32LE(base + 4),
      offset: Number(buf.readBigUInt64LE(base + 0x18)),
      size: Number(buf.readBigUInt64LE(base + 0x20)),
    });
  }
  if (eShstrndx >= raw.length) fail('e_shstrndx 越界');
  const shstr = raw[eShstrndx];
  const nameOf = (off) => {
    const start = shstr.offset + off;
    let end = start;
    while (end < buf.length && buf[end] !== 0) end += 1;
    return buf.toString('utf8', start, end);
  };
  for (const section of raw) section.name = nameOf(section.nameOff);
  return raw;
}

const [soPath, oldNeeded, newNeeded, mode] = process.argv.slice(2);
if (!soPath || !oldNeeded || !newNeeded) {
  fail('用法：patch-native-needed.mjs <so 路径> <原 NEEDED> <新 NEEDED> [--check|--revert]');
}
if (newNeeded.length > oldNeeded.length && mode !== '--set-rpath') {
  fail(`新串更长（${newNeeded.length} > ${oldNeeded.length}），原地改写放不下`);
}
if (!existsSync(soPath)) fail(`文件不存在：${soPath}`);

const backupPath = `${soPath}.orig`;
if (mode === '--revert') {
  if (!existsSync(backupPath)) fail(`没有备份可还原：${backupPath}`);
  copyFileSync(backupPath, soPath);
  console.log(`已还原 ${soPath} ← ${backupPath}`);
  process.exit(0);
}

const buf = readFileSync(soPath);
const sections = readSections(buf);
const dynstr = sections.find((s) => s.name === '.dynstr');
const dynamic = sections.find((s) => s.name === '.dynamic');
if (dynstr === undefined || dynamic === undefined) fail('缺少 .dynstr 或 .dynamic');

/** 逐个读 .dynamic 里的 DT_NEEDED，返回 {entryOffset, strOffset, value}。 */
function neededEntries() {
  const out = [];
  for (let off = dynamic.offset; off + 16 <= dynamic.offset + dynamic.size; off += 16) {
    const tag = Number(buf.readBigUInt64LE(off));
    if (tag === DT_NULL) break;
    if (tag !== DT_NEEDED) continue;
    const value = Number(buf.readBigUInt64LE(off + 8));
    const strOffset = dynstr.offset + value;
    let end = strOffset;
    while (end < buf.length && buf[end] !== 0) end += 1;
    out.push({ entryOffset: off, strOffset, value, name: buf.toString('utf8', strOffset, end) });
  }
  return out;
}

const entries = neededEntries();
const names = entries.map((e) => e.name);
const target = entries.find((e) => e.name === oldNeeded);
const already = entries.find((e) => e.name === newNeeded);

if (mode === '--check') {
  console.log(`${soPath} DT_NEEDED = [${names.join(', ')}]`);
  const ok = already !== undefined || target !== undefined;
  console.log(ok ? '补丁可用（原值存在或已是目标值）' : `原值 ${oldNeeded} 不存在，无法改写`);
  process.exit(ok ? 0 : 1);
}

if (mode === '--set-soname') {
  /*
   * 用法：patch-native-needed.mjs <so> <原 SONAME> <新 SONAME> --set-soname [--rename-file]
   *
   * 【为什么需要它】鸿蒙的 hvigor **只打包 `libs/<abi>/*.so`**（E40 实测），而 vips/glib 这类
   * 依赖库的文件名与 SONAME **都带版本号**（`libglib-2.0.so.0.8800.2`，见 E64）。
   * 要把它搬进 HAP 就必须改名成 `*.so`；而**改名后必须同步改它自己的 SONAME**，
   * 否则依赖方按新名字 DT_NEEDED 去加载时，加载器拿库内旧 SONAME 对不上 ⇒
   * `cannot open shared object`。所以"改名 + 改 SONAME + 改依赖方 NEEDED"是一组三件套。
   */
  const DT_SONAME = 14;
  let soname = undefined;
  for (let off = dynamic.offset; off + 16 <= dynamic.offset + dynamic.size; off += 16) {
    const tag = Number(buf.readBigUInt64LE(off));
    if (tag === DT_NULL) break;
    if (tag !== DT_SONAME) continue;
    const value = Number(buf.readBigUInt64LE(off + 8));
    const strOffset = dynstr.offset + value;
    let end = strOffset;
    while (end < buf.length && buf[end] !== 0) end += 1;
    soname = { strOffset, name: buf.toString('utf8', strOffset, end) };
    break;
  }
  if (soname === undefined) fail('该文件没有 DT_SONAME（静态库或可执行文件？）');
  if (soname.name !== oldNeeded) {
    console.log(`注意：实际 SONAME 是 ${soname.name}（你给的原值 ${oldNeeded} 不符），按实际值继续`);
  }
  if (soname.name === newNeeded) {
    console.log(`SONAME 已是 ${newNeeded}，跳过`);
    process.exit(0);
  }
  if (newNeeded.length > soname.name.length) {
    fail(`新 SONAME 更长（${newNeeded.length} > ${soname.name.length}），原地改写放不下`);
  }
  if (!existsSync(backupPath)) {
    copyFileSync(soPath, backupPath);
    console.log(`已备份 → ${backupPath}`);
  }
  buf.write(newNeeded, soname.strOffset, 'utf8');
  buf.fill(0, soname.strOffset + newNeeded.length, soname.strOffset + soname.name.length);
  writeFileSync(soPath, buf);
  console.log(`SONAME: ${soname.name} → ${newNeeded}  (${soPath})`);
  if (process.argv.includes('--rename-file')) {
    const renamed = soPath.replace(/[^/\\]+$/, newNeeded);
    renameSync(soPath, renamed);
    console.log(`文件已改名 → ${renamed}`);
  }
  process.exit(0);
}

if (mode === '--set-rpath') {
  /*
   * 用法：patch-native-needed.mjs <so> - <新 RPATH> --set-rpath
   *
   * 【为什么需要它】鸿蒙的 hvigor 只打包 `libs/<abi>/*.so`，所以 libvips 那 46 个带版本号的
   * 依赖只能**扁平化**到同一个目录。而 sharp 的原生件（`libsharp-openharmony-arm64.so`）
   * 里写死的 RPATH 是一串 `$ORIGIN/../../sharp-libvips-openharmony-arm64/lib:…`（指向
   * npm 安装布局），那个布局在 HAP 里并不存在 ⇒ 即使把库都拷进去，加载器也找不到。
   * 唯一可行且最干净的形态：**把 RPATH 改成 `$ORIGIN`**，让所有依赖就在它自己旁边解析。
   * 新串比旧串短得多，原地改写 + NUL 补齐是零结构风险（与 DT_NEEDED/SONAME 同一套做法）。
   * 找不到 DT_RPATH/DT_RUNPATH 时报错而不是静默——静默会让"改了却没生效"变成设备上才发现的坑。
   */
  let found = undefined;
  for (let off = dynamic.offset; off + 16 <= dynamic.offset + dynamic.size; off += 16) {
    const tag = Number(buf.readBigUInt64LE(off));
    if (tag === DT_NULL) break;
    if (tag !== DT_RPATH && tag !== DT_RUNPATH) continue;
    const value = Number(buf.readBigUInt64LE(off + 8));
    const strOffset = dynstr.offset + value;
    let end = strOffset;
    while (end < buf.length && buf[end] !== 0) end += 1;
    found = { tag: tag === DT_RPATH ? 'RPATH' : 'RUNPATH', strOffset, name: buf.toString('utf8', strOffset, end) };
    break;
  }
  if (found === undefined) fail('该文件没有 DT_RPATH / DT_RUNPATH，无需设置');
  if (found.name === newNeeded) {
    console.log(`${found.tag} 已是 ${newNeeded}，跳过`);
    process.exit(0);
  }
  if (newNeeded.length > found.name.length) {
    fail(`新 RPATH 更长（${newNeeded.length} > ${found.name.length}），原地改写放不下`);
  }
  if (!existsSync(backupPath)) {
    copyFileSync(soPath, backupPath);
    console.log(`已备份 → ${backupPath}`);
  }
  buf.write(newNeeded, found.strOffset, 'utf8');
  buf.fill(0, found.strOffset + newNeeded.length, found.strOffset + found.name.length);
  writeFileSync(soPath, buf);
  console.log(`${found.tag}: ${found.name} → ${newNeeded}  (${soPath})`);
  process.exit(0);
}

if (mode === '--list') {
  /*
   * 用法：patch-native-needed.mjs <so> - - --list
   *
   * 【为什么要有它】把 libvips 那 46 个库搬进 HAP 需要"先读全量事实，再决定怎么改"
   * （文件 → SONAME → 扁平新名 → 依赖闭包）。ELF 解析只应存在一处，否则两处实现对
   * 不上时会以"某个库在设备上打不开"的形态出现。这里输出 JSON，供收集器脚本消费。
   */
  const needed = neededEntries().map((e) => e.name);
  const readStr = (tag) => {
    for (let off = dynamic.offset; off + 16 <= dynamic.offset + dynamic.size; off += 16) {
      const t = Number(buf.readBigUInt64LE(off));
      if (t === DT_NULL) break;
      if (t !== tag) continue;
      const value = Number(buf.readBigUInt64LE(off + 8));
      const strOffset = dynstr.offset + value;
      let end = strOffset;
      while (end < buf.length && buf[end] !== 0) end += 1;
      return buf.toString('utf8', strOffset, end);
    }
    return undefined;
  };
  console.log(JSON.stringify({
    path: soPath,
    soname: readStr(14),
    rpath: readStr(DT_RPATH),
    runpath: readStr(DT_RUNPATH),
    needed: needed,
  }));
  process.exit(0);
}

if (already !== undefined && target === undefined) {
  console.log(`${soPath} 已是 ${newNeeded}，跳过`);
  process.exit(0);
}
if (target === undefined) {
  fail(`DT_NEEDED 里找不到 ${oldNeeded}（现有：${names.join(', ')}）`);
}

if (!existsSync(backupPath)) {
  copyFileSync(soPath, backupPath);
  console.log(`已备份 → ${backupPath}`);
}
buf.write(newNeeded, target.strOffset, 'utf8');
// NUL 补齐到原串长度：多余字节必须清零，否则读出来是原串的尾巴
buf.fill(0, target.strOffset + newNeeded.length, target.strOffset + oldNeeded.length);
writeFileSync(soPath, buf);

const after = neededEntries().map((e) => e.name);
console.log(`${soPath} DT_NEEDED: [${names.join(', ')}] → [${after.join(', ')}]`);
if (!after.includes(newNeeded)) fail('改写后校验失败');
