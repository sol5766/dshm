'use strict';
/**
 * 内置技能同步：resfile/ohos-skills/*.md → $DSH_HOME/skills/（P0-1 修复，2026-09-28）。
 *
 * 【为什么判等必须用内容哈希，不能用字节数 —— 真机证据（2026-09-28 P0-1）】
 * 原实现在 main.js 里逐文件 `if (statSize(dst) === statSize(src)) continue;`。
 * 那一版把 `hdsh-*` 端点名整体改成 `dshm-*`（等长替换），resfile 侧与设备侧
 * 两份 ohos-python.md **字节数完全相同（6262 B）** ⇒ 判定"已是同一份" ⇒ 永不
 * 复制 ⇒ 设备端 skill 至今写着旧端点 `/hdsh-python/*`，而实际端点是
 * `/dshm-python/*`，模型照文档手调必然 404。任何**等长改动**（改名、大小写、
 * 同长度替换）都会命中同一个坑，所以判据换成内容指纹。
 *
 * 【为什么单列一个文件】main.js 末尾是 `start().catch(...)`，require 它会真的
 * 起一个 Host ⇒ PC 侧无法对它做回归。本模块只依赖 node:fs / node:path /
 * node:crypto，可被 tools/check-skill-sync.cjs 直接 require，把"等长改动必须
 * 被检出"做成常驻断言（新增文件记得同步 place-host-app.mjs 与
 * assert-resfile-sync.mjs 两份 FILES 清单）。
 *
 * 【写入策略】先写同目录临时文件再 rename：dstDir 是可被模型直接读的目录，
 * 半截写入会让模型读到截断的 skill；rename 覆盖是原子的。崩溃残留的临时文件
 * 由一个前缀清扫收尾。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 临时文件名前缀（进度未完成的中间态；同目录内可见，便于崩溃后清扫）。 */
const TMP_PREFIX = '.dshm-skills-tmp-';

/**
 * 内容指纹：sha256(文件字节) 的十六进制。读不到（不存在/是目录/无权限）返回 ''。
 * 返回值 '' 与任何真实指纹都不相等 ⇒ 调用方自然落到"需要复制"分支。
 */
function contentFingerprint(p) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch (e) {
    return '';
  }
}

/** 目录内是否已有该名字的普通文件（`.md` 之外的目录/符号链接一律不算）。 */
function isRegularFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

/** 清扫上次崩溃残留的临时文件（尽力而为，失败不影响同步）。 */
function sweepTmp(dstDir) {
  let names = [];
  try {
    names = fs.readdirSync(dstDir);
  } catch (e) {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(TMP_PREFIX)) {
      continue;
    }
    try {
      fs.rmSync(path.join(dstDir, name), { force: true });
    } catch (e) {
      // 删不掉就留着，下次启动再试
    }
  }
}

/**
 * 把 srcDir 下的 `*.md` 同步到 dstDir（平铺，不递归子目录）。
 *
 * 判等：内容指纹相同 ⇒ 跳过（真幂等，不做任何写入）；否则复制。
 * 因此"等长改动"（大小相同、内容不同）**必定**被复制。
 *
 * @returns {{copied: string[], unchanged: string[], failed: {name: string, error: string}[]}}
 *   三个数组都是文件名（不含目录），copied 有序、与 readdirSync 同序，便于日志点名。
 *   **不抛错**：单个文件失败记入 failed，其余文件继续（skill 同步不该阻塞启动）。
 */
function syncSkills(srcDir, dstDir) {
  const copied = [];
  const unchanged = [];
  const failed = [];
  let names = [];
  try {
    names = fs.readdirSync(srcDir);
  } catch (e) {
    failed.push({ name: '', error: 'readdir 失败：' + String(e && e.message ? e.message : e) });
    return { copied, unchanged, failed };
  }
  try {
    fs.mkdirSync(dstDir, { recursive: true });
  } catch (e) {
    failed.push({ name: '', error: '创建目标目录失败：' + String(e && e.message ? e.message : e) });
    return { copied, unchanged, failed };
  }
  sweepTmp(dstDir);
  for (const name of names.slice().sort()) {
    if (!name.endsWith('.md')) {
      continue;
    }
    const src = path.join(srcDir, name);
    if (!isRegularFile(src)) {
      continue; // 目录名以 .md 结尾之类：不当技能
    }
    const dst = path.join(dstDir, name);
    const srcHash = contentFingerprint(src);
    if (srcHash.length > 0 && isRegularFile(dst) && contentFingerprint(dst) === srcHash) {
      unchanged.push(name); // 内容逐字节相同：真幂等
      continue;
    }
    const tmp = path.join(dstDir, TMP_PREFIX + name);
    try {
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, dst); // 同目录 rename：覆盖原子
      copied.push(name);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch (e2) {
        // 清不掉就算了，sweepTmp 下次收
      }
      failed.push({ name, error: String(e && e.message ? e.message : e) });
    }
  }
  return { copied, unchanged, failed };
}

module.exports = { contentFingerprint, syncSkills, TMP_PREFIX };
