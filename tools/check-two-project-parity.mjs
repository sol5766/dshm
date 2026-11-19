#!/usr/bin/env node
/**
 * ⚠️ 历史门禁（2026-11-06）：对端工作区 DSHM-mobile 已于 2026-11-03 删除，本机必然 rc=2，
 * 依 AGENTS.md 不再作为判据；保留脚本仅供追溯。
 * 门禁：PC 工程与手机工程**必须一致的那部分**，不许漂移。
 *
 * ## 存在理由（2026-10-21 双端分离）
 *
 * 本次分离是**物理复制**：手机工程 `/…/DSHM-mobile` 是 PC 工程的完整副本，
 * 只改了「包名 / deviceTypes / 权限 / 后台能力」四处配置，删了一个 PC 专属 Ability。
 * 复制式拆分最大的风险不是"拆错"，而是**日后只改一侧**：
 *   · 有人在 PC 侧修了 `platform/` 的一个 bug，手机侧没跟上 ⇒ 两端行为分叉；
 *   · 有人在手机侧顺手改了 `hostcore/` 的一个插件 ⇒ 核心不再"只有一个"；
 *   · 两端的 `entry/src/main/ets/` 是同一份业务代码，改了不通知对方尤其危险。
 * 这类漂移**不会让任何一端构建失败**，往往要等到真机上一个端好一个端坏才被发现。
 *
 * 所以本门禁的判据是**白名单式**的：只比对"必须逐字节一致"的目录，
 * 差异清单本身写在 `ALLOWED` 里，任何白名单外的差异一律判红。
 *
 * ## 判据
 *
 * 对 `MUST_MATCH` 里的每个目录：递归列出（相对路径 → 字节数），
 * 两侧集合必须相等；`ALLOWED` 命中的相对路径豁免（那是设计上的差异）。
 *
 * 为什么用**字节数**而不是哈希：一次全量 sha256 要读 ~500 MB × 2（hmdfs 上约数分钟），
 * 每次改一行就跑不动了。字节数 + 路径集合能抓住 99% 的实际漂移（增删文件、改长度）；
 * 需要逐字节确认时用 `--hash`（只对两边都存在且大小相同的文件才算，成本可控）。
 *
 * ## 用法
 *
 *   node tools/check-two-project-parity.mjs              # PC 侧运行（默认找同级 DSHM-mobile）
 *   node tools/check-two-project-parity.mjs --hash       # 追加逐文件 sha256 比对
 *   DSHM_MOBILE_ROOT=/path/to/mobile node tools/...      # 显式指定手机工程
 *   node tools/check-two-project-parity.mjs --self-test  # 变异体自检（造一个漂移文件必须判红）
 *
 * 退出码：0 = 一致；1 = 有漂移；2 = 找不到对端工程 **或对端目录读不到**；3 = 自检失败。
 *
 * ## 2026-10-28 修复：读不到对端曾被误报成漂移（docs/267 P1-1）
 *
 * 旧 `inventory()` 把 `readdirSync` 的异常静默吞掉（`catch { return out }`）。对端工程
 * "存在但读不到"时（本机应用域的实测形态：`DSHM-mobile` 的 `stat` 通、`listdir` **EPERM**），
 * 对端清单恒为空 ⇒ 6,587 个文件全被报成「只在 PC 工程有」的**假漂移**，门禁还照样打印
 * "修复方式：把该文件同步到另一侧" ⇒ 会诱导人去修不存在的问题。
 * 现在：`ENOENT` 仍按"确实没有"（真漂移）处理；其余错误记进 `unreadable` 并 **exit 2**。
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PC_ROOT = resolve(HERE, '..');

/** 手机工程根：环境变量优先，默认兄弟目录（两台工程的实际布局）。 */
function mobileRoot() {
  const env = process.env.DSHM_MOBILE_ROOT;
  if (typeof env === 'string' && env.length > 0) return resolve(env);
  return resolve(PC_ROOT, '..', 'DSHM-mobile');
}

/**
 * 必须一致的目录（相对工程根）。
 *
 * 取舍：`entry/libs` 与 `resfile` 也在内 —— 它们是"核心只有一个"的物证，
 * 只要有一侧换了核心 zip / 原生库而另一侧没换，就必须当场判红。
 */
const MUST_MATCH = [
  'hostcore',
  'connection',
  'dshcompat',
  'appstate',
  'platform',
  'hostruntime',
  'entry/src/main/ets',
  'entry/src/main/cpp',
  'entry/libs',
  'entry/src/main/resources/resfile',
  'tools',
  'third_party'
];

/**
 * 设计上的差异（白名单）。每条都要能说出"为什么允许不同"。
 */
const ALLOWED = [
  // ── 分离的四处正差异 ──
  { test: (p) => basename(p) === 'module.json5', why: 'deviceTypes 不同（PC: tablet/2in1；手机: phone）' },
  { test: (p) => p.startsWith('entry/src/main/ets/backgroundability' + sep), why: '托盘后台 Ability 是 PC 专属，手机工程已删' },
  { test: (p) => p === join('tools', 'check-permission-surface.mjs'), why: '权限基线 PC=8 / 手机=7' },
  { test: (p) => p === join('tools', 'build-profile.template.json5'), why: '模板里的 bundleName 不同（PC 正式名 vs 手机 com.dshm.mobileclient）' },
  { test: (p) => p === join('tools', 'build-profile.beta.template.json5'), why: '同上（beta 模板的 bundleName）' },
  // ── 生成物 / 缓存：不应参与比对（正常情况下也不在扫描范围内，兜底）──
  { test: (p) => p.split(sep).includes('build'), why: '构建产物' },
  { test: (p) => p.split(sep).includes('oh_modules'), why: '依赖目录' },
  { test: (p) => p.split(sep).includes('.hvigor'), why: '构建缓存' }
];

function basename(p) {
  const i = p.lastIndexOf(sep);
  return i < 0 ? p : p.slice(i + 1);
}

function allowed(p) {
  for (const rule of ALLOWED) {
    if (rule.test(p)) return rule.why;
  }
  return null;
}

/** 递归收集「相对路径 → 字节数」。软链接按链接文本记录（不跟随，避免跨工程误判）。
 *
 * `failures` 收集"读不到"的目录（ENOENT 除外 —— 那是真·缺失，仍按漂移判）。
 */
function inventory(root, relDir, out, failures) {
  const abs = join(root, relDir);
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    const code = err && err.code ? err.code : 'UNKNOWN';
    if (code !== 'ENOENT') failures.push(`${abs}（${code}）`);
    return out;
  }
  for (const e of entries) {
    const rel = join(relDir, e.name);
    if (allowed(rel) !== null) continue;
    let st;
    try {
      st = statSync(join(root, rel), { throwIfNoEntry: false });
    } catch {
      st = undefined;
    }
    if (st === undefined) continue;
    if (e.isDirectory()) {
      inventory(root, rel, out, failures);
    } else {
      out.set(rel, st.size);
    }
  }
  return out;
}

function sha256Of(path) {
  const h = createHash('sha256');
  h.update(readFileSync(path));
  return h.digest('hex');
}

function compare(pcRoot, mobRoot, withHash) {
  const problems = [];
  const notes = [];
  const unreadable = [];

  for (const dir of MUST_MATCH) {
    const a = inventory(pcRoot, dir, new Map(), unreadable);
    const b = inventory(mobRoot, dir, new Map(), unreadable);
    const keys = new Set([...a.keys(), ...b.keys()]);
    for (const k of [...keys].sort()) {
      const sa = a.get(k);
      const sb = b.get(k);
      if (sa === undefined) {
        problems.push(`只在手机工程有：${k}（${sb} B）`);
        continue;
      }
      if (sb === undefined) {
        problems.push(`只在 PC 工程有：${k}（${sa} B）`);
        continue;
      }
      if (sa !== sb) {
        problems.push(`大小不同：${k}  PC=${sa} B  MOBILE=${sb} B`);
        continue;
      }
      if (withHash) {
        const ha = sha256Of(join(pcRoot, k));
        const hb = sha256Of(join(mobRoot, k));
        if (ha !== hb) problems.push(`内容不同（同大小）：${k}  ${ha.slice(0, 12)}… vs ${hb.slice(0, 12)}…`);
      }
    }
    notes.push(`  ${dir.padEnd(38)} ${String(a.size).padStart(6)} 个文件`);
  }

  return { problems, notes, unreadable };
}

function main() {
  const argv = process.argv.slice(2);
  const withHash = argv.includes('--hash');
  const selfTest = argv.includes('--self-test');

  const mobRoot = mobileRoot();
  console.log('# 门禁：双端一致性（PC 工程 vs 手机工程）\n');
  console.log(`  PC     = ${PC_ROOT}`);
  console.log(`  MOBILE = ${mobRoot}`);
  console.log(`  模式   = ${withHash ? '大小 + sha256' : '仅大小与路径集合（加 --hash 可逐字节）'}\n`);

  try {
    statSync(mobRoot);
  } catch {
    console.error(`找不到手机工程：${mobRoot}`);
    console.error('用 DSHM_MOBILE_ROOT=<路径> 指定，或把两个工程放成兄弟目录。');
    process.exit(2);
  }

  if (selfTest) {
    /*
     * 臂 1（需要可写对端）：在手机工程里造一个"PC 侧没有"的文件必须判红，删掉后必须恢复绿。
     * 对端不可写时（本机应用域对 DSHM-mobile 就是 EPERM）**如实标注 skip**，
     * 不把它当失败 —— 门禁的自检不该依赖"恰好写得进去"。
     */
    let arm1 = 'skip';
    try {
      const probe = join(mobRoot, 'platform', '__parity_selftest__.ets');
      writeFileSync(probe, '// parity self-test\n');
      const dirty = compare(PC_ROOT, mobRoot, false);
      const injected = dirty.problems.some((p) => p.includes('__parity_selftest__'));
      unlinkSync(probe);
      const clean = compare(PC_ROOT, mobRoot, false);
      const restored = !clean.problems.some((p) => p.includes('__parity_selftest__'));
      arm1 = injected && restored ? 'pass' : 'fail';
    } catch (e) {
      arm1 = `skip（对端不可写：${e && e.code ? e.code : 'err'}）`;
    }

    /*
     * 臂 2（纯本地、可移植）：对端目录**不可枚举**时，门禁必须 **exit 2（无法判定）**
     * 而不是报出一堆"漂移"。用 ENOTDIR 模拟（把必比对目录做成普通文件），
     * 并且**跑真门禁的子进程**来断言退出码 —— 判据是行为，不是内部变量。
     * 这正是 2026-10-28 修的缺陷：旧实现在同一场景下会报出成百上千条假漂移（exit 1）。
     */
    const stage = mkdtempSync(join(tmpdir(), 'parity-arm-'));
    let arm2 = 'fail';
    try {
      const peer = join(stage, 'peer');
      mkdirSync(peer, { recursive: true });
      writeFileSync(join(peer, 'hostcore'), 'not a dir\n');
      const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        env: { ...process.env, DSHM_MOBILE_ROOT: peer },
        encoding: 'utf8',
        timeout: 120000,
      });
      arm2 = run.status === 2 ? 'pass' : 'fail';
      if (arm2 === 'fail') {
        console.log(`     诊断：rc=${run.status}（期望 2）`);
      }
    } catch (e) {
      console.log(`     诊断：${e && e.message ? e.message : e}`);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }

    const ok = arm1 !== 'fail' && arm2 === 'pass';
    console.log(`  ${arm1 === 'pass' ? '✅' : arm1 === 'fail' ? '❌' : '⏭️ '} 臂 1 注入漂移判红 / 移除恢复绿：${arm1}`);
    console.log(`  ${arm2 === 'pass' ? '✅' : '❌'} 臂 2 对端不可枚举 ⇒ 判"无法判定"（不报假漂移）：${arm2}`);
    console.log(ok ? '✅ 自检通过。' : '❌ 自检失败。');
    process.exit(ok ? 0 : 3);
  }

  const { problems, notes, unreadable } = compare(PC_ROOT, mobRoot, withHash);

  /*
   * fail-closed：只要有一侧读不到，就**不下漂移结论**（exit 2）。
   * 两种情形都走这里：① 找不到对端工程（上面 stat 已拦一次）；② 对端存在但读不到。
   */
  if (unreadable.length > 0) {
    console.error(`❌ 无法判定：${unreadable.length} 个目录读不到（**这不是漂移**，是取证面不足）。`);
    for (const u of unreadable.slice(0, 10)) console.error(`   · ${u}`);
    if (unreadable.length > 10) console.error(`   … 另有 ${unreadable.length - 10} 个`);
    console.error('');
    console.error('两边工程都必须可枚举才能比对。在本机应用域里，DSHM-mobile 常见形态是');
    console.error('stat 通、listdir EPERM ⇒ 请在能读两侧的终端里重跑，或把可读副本指定给');
    console.error('DSHM_MOBILE_ROOT=<路径>。**不要**照下面那种"漂移清单"去改代码。');
    process.exit(2);
  }

  console.log('  比对范围（白名单外的文件一个都不放过）：');
  for (const n of notes) console.log(n);
  console.log('');

  if (problems.length === 0) {
    console.log(`✅ 通过：${MUST_MATCH.length} 个必一致目录两侧完全对齐。`);
    process.exit(0);
  }

  console.log(`❌ 不一致 ${problems.length} 处（这些不是设计差异，是漂移）：\n`);
  for (const p of problems.slice(0, 80)) console.log('  · ' + p);
  if (problems.length > 80) console.log(`  … 另有 ${problems.length - 80} 处`);
  console.log('');
  console.log('修复方式：确定哪一侧是"对的"，把该文件同步到另一侧后重跑本门禁。');
  console.log('若差异是设计使然，把它写进 ALLOWED 并注明理由（不要静默放过）。');
  process.exit(1);
}

main();
