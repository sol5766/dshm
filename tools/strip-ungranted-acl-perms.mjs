#!/usr/bin/env node
/*
 * strip-ungranted-acl-perms.mjs —— 把「HAP 里声明了、但签名 profile 的 allowed-acls 没有」的 ACL 权限
 * 从包内 module.json 的 requestPermissions 里摘掉（**必须在签名之前**做：签名覆盖 module.json）。
 *
 * 【为什么必须有这一步】设备侧安装时 BMS 会调 InitHapToken 做 ACL 检查
 * （bundlemanager_bundle_framework: bundle_permission_mgr.cpp `CreateHapPolicyParam()` 把
 * profile 的 allowed-acls 塞进 `hapPolicy.aclRequestedList`，AccessToken 在 `InitHapToken` 里比对），
 * 一旦「请求的 ACL 权限不在 allowed-acls 里」就按 `PERMISSION_ACL_RULE` 拒装
 * （`GetCheckResultMsg()` 回 `PermissionName: <那个权限>`；设备侧呈现为「grant request permissions failed」）。
 * 调试 profile 有 5 条 ACL 所以能装；发布 profile 只有 2 条 ⇒ 声明里多出来的那几条会把发布包**堵在安装/上传**。
 *
 * 判据：权限级别取自 SDK 的 `PermissionDefinitions.json`；只摘 `system_basic` / `system_core` 两级里
 * **不在** allowed-acls 中的那些；`normal` / `user_grant` 一律不动；表里查不到的权限**保留**并告警（fail-open）。
 *
 * 用法：
 *   node tools/strip-ungranted-acl-perms.mjs --in <unsigned.hap> --profile <release.p7b> --out <patched.hap>
 *   node tools/strip-ungranted-acl-perms.mjs --in <unsigned.hap> --profile <p7b> --dry-run
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { resolveDevecoSdkHome } from "./lib/deveco-home.mjs";

/**
 * DevEco SDK 自带的权限表路径；解析不到返回 null。
 *
 * 【为什么不写死】原先写死 `C:\Program Files\Huawei\DevEco Studio\...`；2026-10-10 用户把 DevEco
 * 从 C 盘卸载、改装到 `D:\Program Files\Huawei\DevEco Studio`，本工具当场失效。解析口见
 * tools/lib/deveco-home.mjs（`DEVECO_SDK_HOME` / `OHOS_SDK_HOME` → `<DevEco 安装根>/sdk`）。
 * 解析不到**不静默退回旧路径**：下面那条存在性判定会给出人话错误。
 */
function defaultDefinitionsFile() {
  const sdk = resolveDevecoSdkHome();
  if (sdk === null) return null;
  return path.join(sdk, "default", "openharmony", "toolchains", "lib", "PermissionDefinitions.json");
}

function argOf(name, def = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
}
const inFile = argOf("--in");
const profileFile = argOf("--profile");
const outFile = argOf("--out");
const dryRun = process.argv.includes("--dry-run");
const defFile = argOf("--definitions", defaultDefinitionsFile());
if (!inFile || !profileFile) {
  console.error("用法: node tools/strip-ungranted-acl-perms.mjs --in <unsigned.hap> --profile <p7b> --out <out.hap> [--dry-run]");
  process.exit(2);
}
function die(m) { console.error("FAIL " + m); process.exit(1); }

// ---------- profile ----------
const p7bText = fs.readFileSync(profileFile, "latin1");
const aclMatch = p7bText.match(/"allowed-acls"\s*:\s*\[(.*?)\]/);
const allowed = new Set(
  (aclMatch ? aclMatch[1] : "")
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
);
const profType = (p7bText.match(/"type"\s*:\s*"(\w+)"/) || [, "?"])[1];
console.log(`profile: ${path.basename(profileFile)}  type=${profType}  allowed-acls=${allowed.size}`);
for (const a of allowed) console.log(`  - ${a}`);

// ---------- permission levels ----------
if (!defFile || !fs.existsSync(defFile)) die(`缺权限表：${defFile}（可用 --definitions <路径> 指定，或设 DEVECO_SDK_HOME）`);
const defs = JSON.parse(fs.readFileSync(defFile, "utf8"));
const list = Array.isArray(defs) ? defs : defs.definePermissions || [];
const levelOf = new Map();
for (const p of list) if (p && p.name) levelOf.set(p.name, p.availableLevel);

// ---------- crc32 ----------
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
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

// ---------- zip read ----------
const src = fs.readFileSync(inFile);
let eocd = src.length - 22;
while (eocd >= 0 && src.readUInt32LE(eocd) !== 0x06054b50) eocd--;
if (eocd < 0) die("找不到 EOCD（不是 zip）");
const total = src.readUInt16LE(eocd + 10);
const cdOff = src.readUInt32LE(eocd + 16);
const cdSize = src.readUInt32LE(eocd + 12);
const commentLen = src.readUInt16LE(eocd + 20);

const entries = [];
let o = cdOff;
for (let i = 0; i < total; i++) {
  if (src.readUInt32LE(o) !== 0x02014b50) die("中央目录记录头不对 @" + o);
  const flags = src.readUInt16LE(o + 8);
  const method = src.readUInt16LE(o + 10);
  const time = src.readUInt16LE(o + 12);
  const date = src.readUInt16LE(o + 14);
  const crc = src.readUInt32LE(o + 16);
  const csize = src.readUInt32LE(o + 20);
  const usize = src.readUInt32LE(o + 24);
  const nlen = src.readUInt16LE(o + 28);
  const elen = src.readUInt16LE(o + 30);
  const clen = src.readUInt16LE(o + 32);
  const attrExt = src.readUInt16LE(o + 36);
  const attrInt = src.readUInt32LE(o + 38);
  const lho = src.readUInt32LE(o + 42);
  const name = src.toString("utf8", o + 46, o + 46 + nlen);
  const extra = src.subarray(o + 46 + nlen, o + 46 + nlen + elen);
  const cmt = src.subarray(o + 46 + nlen + elen, o + 46 + nlen + elen + clen);
  if (flags & 0x08) die(`条目 ${name} 带 data descriptor（bit3），本工具不处理`);
  entries.push({ name, flags, method, time, date, crc, csize, usize, extra, cmt, attrExt, attrInt, lho });
  o += 46 + nlen + elen + clen;
}
if (o !== cdOff + cdSize) console.warn(`warn: 中央目录长度对不上（算出 ${o - cdOff} / 声明 ${cdSize}）`);

// ---------- patch module.json ----------
const mi = entries.findIndex((e) => e.name === "module.json");
if (mi < 0) die("包里没有 module.json");
const ent = entries[mi];
if (ent.method !== 0 && ent.method !== 8) die(`module.json 压缩方式 ${ent.method} 不支持`);
const lhlen = src.readUInt16LE(ent.lho + 26);
const lhelen = src.readUInt16LE(ent.lho + 28);
const rawStart = ent.lho + 30 + lhlen + lhelen;
const rawComp = src.subarray(rawStart, rawStart + ent.csize);
const jsonBuf = ent.method === 8 ? zlib.inflateRawSync(rawComp) : rawComp;
const moduleJson = JSON.parse(jsonBuf.toString("utf8"));
const perms = moduleJson?.module?.requestPermissions;
if (!Array.isArray(perms)) die("module.json 里没有 module.requestPermissions 数组");

const dropped = [], kept = [], unknown = [];
const keptPerms = perms.filter((p) => {
  const name = p && p.name;
  const lvl = levelOf.get(name);
  if (lvl === undefined) { unknown.push(name); kept.push(`${name}(表里没有，保留)`); return true; }
  const aclLevel = lvl === "system_basic" || lvl === "system_core";
  if (aclLevel && !allowed.has(name)) { dropped.push(`${name} [${lvl}]`); return false; }
  kept.push(`${name} [${lvl}]`);
  return true;
});
moduleJson.module.requestPermissions = keptPerms;

console.log(`\nrequestPermissions: 共 ${perms.length} 条`);
console.log(`摘掉 ${dropped.length} 条：`);
for (const d of dropped) console.log(`  - ${d}`);
console.log(`保留 ${kept.length} 条：`);
for (const k of kept) console.log(`  + ${k}`);
if (unknown.length) console.log(`⚠ 未在权限表里查到的（已保留）：${unknown.join(", ")}`);

if (dryRun) { console.log("\n--dry-run：不写文件。"); process.exit(0); }

const newJson = Buffer.from(JSON.stringify(moduleJson), "utf8");
// 【为什么保留原来的压缩方式】DevEco 打出来的包里 module.json 是 **stored(0)**；跟着它走最省心，
// 免得去赌设备侧解析器对 deflate 的 module.json 有没有额外约束。
const origMethod = ent.method;
ent.data = origMethod === 0 ? newJson : zlib.deflateRawSync(newJson, { level: 9 });
ent.crc = crc32(newJson);
ent.csize = ent.data.length;
ent.usize = newJson.length;
ent.method = origMethod;

// ---------- rebuild zip ----------
const chunks = [];
let off = 0;
const recs = [];
for (const e of entries) {
  const nameBuf = Buffer.from(e.name, "utf8");
  let data;
  if (e.data) data = e.data;
  else {
    const lhlen2 = src.readUInt16LE(e.lho + 26);
    const lhelen2 = src.readUInt16LE(e.lho + 28);
    data = src.subarray(e.lho + 30 + lhlen2 + lhelen2, e.lho + 30 + lhlen2 + lhelen2 + e.csize);
  }
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(e.flags & ~0x08, 6);
  lh.writeUInt16LE(e.method, 8);
  lh.writeUInt16LE(e.time, 10);
  lh.writeUInt16LE(e.date, 12);
  lh.writeUInt32LE(e.crc, 14);
  lh.writeUInt32LE(e.csize, 18);
  lh.writeUInt32LE(e.usize, 22);
  lh.writeUInt16LE(nameBuf.length, 26);
  lh.writeUInt16LE(0, 28); // 本地头不带 extra（原样重建，避免 extra 里的 zip64 残留）
  chunks.push(lh, nameBuf, data);
  off += 30 + nameBuf.length + data.length;
  recs.push({ e, nameBuf, offset: off - (30 + nameBuf.length + data.length) });
}
const cdStart = off;
const cdChunks = [];
let cdLen = 0;
for (const r of recs) {
  const { e, nameBuf } = r;
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4);
  ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(e.flags & ~0x08, 8);
  ch.writeUInt16LE(e.method, 10);
  ch.writeUInt16LE(e.time, 12);
  ch.writeUInt16LE(e.date, 14);
  ch.writeUInt32LE(e.crc, 16);
  ch.writeUInt32LE(e.csize, 20);
  ch.writeUInt32LE(e.usize, 24);
  ch.writeUInt16LE(nameBuf.length, 28);
  ch.writeUInt16LE(0, 30);
  ch.writeUInt16LE(e.cmt.length, 32);
  ch.writeUInt16LE(0, 34);
  ch.writeUInt16LE(e.attrExt, 36);
  ch.writeUInt32LE(e.attrInt, 38);
  ch.writeUInt32LE(r.offset, 42);
  cdChunks.push(ch, nameBuf, e.cmt);
  cdLen += 46 + nameBuf.length + e.cmt.length;
}
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(recs.length, 8);
end.writeUInt16LE(recs.length, 10);
end.writeUInt32LE(cdLen, 12);
end.writeUInt32LE(cdStart, 16);
end.writeUInt16LE(0, 20);

const outBuf = Buffer.concat([...chunks, ...cdChunks, end]);
fs.writeFileSync(outFile, outBuf);
console.log(`\n写出：${outFile}  ${outBuf.length} B（条目 ${recs.length}，中央目录 ${cdLen} B，注释 ${commentLen} B 已丢弃）`);
