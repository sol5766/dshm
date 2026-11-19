#!/usr/bin/env node
/**
 * 门禁：同步数据模型与冲突规则（docs/313 §2、§3.2、§5，批次 A）。
 *
 * 【为什么需要它】这是整个同步功能的**判据源头**。这里错了，后果是**用户数据被覆盖或丢失**：
 *   · 冲突规则写成"谁新用谁" ⇒ 云端旧内容盖掉本机正在写的会话；
 *   · sha 校验放行空串 ⇒ 完整性闸门形同虚设，半截文件进了会话目录；
 *   · 进度比例只算成功率 ⇒ 有一项失败进度条永远 99%，用户以为卡死；
 *   · metadata 未知 schema 被硬解 ⇒ 旧端把新格式当老格式读，改写用户数据。
 * 这些都不会报编译错，只会安静地把坏数据写进用户的会话树。
 *
 * 【判据（纯离线，真跑函数体）】
 *   A. `decideAction` 的五种结局与"不覆盖"原则
 *   B. `progressRatio` 把失败/跳过也算作"已处理"
 *   C. `decodeMetadata` 对未知 schema / 非法 JSON 一律拒绝
 *   D. `isValidSha256` 拒绝空串/畸形值
 *   E. `parseUnitId` 三段式，非法形态返回 null
 *
 * 对照臂（--self-test）：冲突改判为"覆盖" / 比例只算成功 / 未知 schema 硬解 /
 * 空 sha 放行 ⇒ 必须判红。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = 'platform/src/main/ets/sync/SyncModel.ets';

/**
 * 剥类型：用 Node 自带的官方类型擦除（docs/310 §7.1 的教训——手写正则连错两次）。
 */
function stripTypes(code) {
  return stripTypeScriptTypes(code, { mode: 'strip' });
}

/** 抽出若干 export function 的函数体，拼成一个可求值的模块。 */
function buildModule(src) {
  const pick = (name) => {
    /* 私有函数（如 asText）没有 export 前缀：两种形态都认 */
    let at = src.indexOf(`export function ${name}(`);
    if (at < 0) at = src.indexOf(`\nfunction ${name}(`);
    if (at < 0) return '';
    if (src[at] === '\n') at += 1;
    const open = src.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) return src.slice(at, i + 1);
      }
    }
    return '';
  };
  const fns = ['asText', 'decideAction', 'progressRatio', 'hasRemaining',
    'decodeMetadata', 'encodeMetadata', 'isValidSha256', 'parseUnitId', 'makeUnitId',
    'isKnownKind', 'initialProgress', 'isAutomatic', 'actionLabel'];
  /*
   * 只剥**函数体**：Node 的 `strip` 模式不支持 TypeScript enum
   * （实测报 `TypeScript enum is not supported in strip-only mode`），
   * 所以枚举与常量不交给它，而是在求值时以字面量注入（见下方 new Function）。
   */
  const bodies = fns.map((n) => {
    const raw = pick(n);
    if (raw === '') return '';
    return stripTypes(raw.replace(/^export function /, 'function '));
  });
  if (bodies.some((b) => b === '')) return null;

  /* 枚举与常量：源码里是 `export enum X {...}` / `export const K: number = n;` */
  /*
   * 枚举体里**含块注释**（`/* ... *\/`），用 `[^}]*` 整段抓会被注释里的 `}` 提前截断
   * ⇒ 抓到空数组 ⇒ `{ }` 成为非法对象字面量（本轮踩过：`UnitAction` 抽成 []）。
   * 改为按行扫：从 `export enum X {` 起逐行收集，遇到只有 `}` 的行结束，
   * 再逐行剥掉注释、只留 `NAME = value` 形态的成员。
   */
  const enumOf = (name) => {
    const lines = src.split('\n');
    const startAt = lines.findIndex((l) => l.trim().startsWith(`export enum ${name} {`));
    if (startAt < 0) return null;
    const out = [];
    let inBlock = false;
    for (let i = startAt + 1; i < lines.length; i++) {
      let line = lines[i];
      /* 处理跨行块注释 */
      if (inBlock) {
        const end = line.indexOf('*/');
        if (end < 0) continue;
        line = line.slice(end + 2);
        inBlock = false;
      }
      const open = line.indexOf('/*');
      if (open >= 0) {
        const close = line.indexOf('*/', open + 2);
        if (close < 0) {
          inBlock = true;
          line = line.slice(0, open);
        } else {
          line = line.slice(0, open) + line.slice(close + 2);
        }
      }
      const trimmed = line.trim();
      if (trimmed.startsWith('}')) break;
      if (trimmed.length === 0 || trimmed.startsWith('//')) continue;
      /* 去掉行尾逗号，只保留合法成员 */
      const member = trimmed.replace(/,\s*$/, '').trim();
      if (/^[A-Z_][A-Z0-9_]*\s*=\s*.+$/.test(member)) out.push(member);
    }
    return out.length > 0 ? out : null;
  };
  const unitAction = enumOf('UnitAction');
  const unitKind = enumOf('UnitKind');
  if (unitAction === null || unitKind === null) return null;
  const schemaMatch = /export const UNIT_METADATA_SCHEMA: number = (\d+);/.exec(src);
  if (schemaMatch === null) return null;

  const assembled = `
      const UnitAction = { ${unitAction.map((m) => m.replace(/\s*=\s*/, ': ')).join(', ')} };
      const UnitKind = { ${unitKind.map((m) => m.replace(/\s*=\s*/, ': ')).join(', ')} };
      const UNIT_METADATA_SCHEMA = ${schemaMatch[1]};
      ${bodies.join('\n')}
      /* 显式 key: value —— 简写属性里若混入未声明名会报 Invalid shorthand property initializer */
      return { decideAction: decideAction, progressRatio: progressRatio,
        hasRemaining: hasRemaining, decodeMetadata: decodeMetadata, encodeMetadata: encodeMetadata,
        isValidSha256: isValidSha256, parseUnitId: parseUnitId, makeUnitId: makeUnitId,
        isKnownKind: isKnownKind, initialProgress: initialProgress,
        isAutomatic: isAutomatic, actionLabel: actionLabel,
        UnitAction: UnitAction, UnitKind: UnitKind,
        UNIT_METADATA_SCHEMA: UNIT_METADATA_SCHEMA };
    `;
  try {
    // eslint-disable-next-line no-new-func
    return new Function(assembled)();
  } catch (e) {
    console.error(`模块求值失败：${e.message}`);
    if (process.env.DSHM_DEBUG_ASSEMBLE === '1') {
      console.error('--- assembled ---');
      console.error(assembled);
    }
    return null;
  }
}

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) passed += 1;
  else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `（${detail}）` : ''}`);
  }
}

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function runSuite(mod) {
  passed = 0;
  failures.length = 0;
  const A = mod.UnitAction;

  // ── A 冲突规则 ────────────────────────────────────────────────────
  check('A 本机有云端无 ⇒ 上传', mod.decideAction(SHA_A, '', false) === A.UPLOAD);
  check('A 云端有本机无 ⇒ 可拉取', mod.decideAction('', SHA_B, false) === A.PULL);
  check('A 一致 ⇒ 跳过', mod.decideAction(SHA_A, SHA_A, false) === A.SKIP);
  check('A 不一致 ⇒ 冲突（不覆盖）', mod.decideAction(SHA_A, SHA_B, false) === A.CONFLICT);
  check('A 会话使用中 ⇒ 待导入而非抢写', mod.decideAction('', SHA_B, true) === A.DEFER);
  check('A sha 大小写视为同一内容', mod.decideAction(SHA_A, SHA_A.toUpperCase(), false) === A.SKIP);
  check('A 冲突/待导入不是自动动作',
    mod.isAutomatic(A.CONFLICT) === false && mod.isAutomatic(A.DEFER) === false);
  check('A 上传/拉取/跳过是自动动作',
    mod.isAutomatic(A.UPLOAD) && mod.isAutomatic(A.PULL) && mod.isAutomatic(A.SKIP));

  // ── B 进度比例 ────────────────────────────────────────────────────
  const p = mod.initialProgress('upload');
  p.total = 10; p.succeeded = 6; p.failed = 2; p.skipped = 2;
  check('B 失败与跳过也算已处理 ⇒ 比例 1', mod.progressRatio(p) === 1);
  check('B 无剩余', mod.hasRemaining(p) === false);
  const p2 = mod.initialProgress('upload');
  p2.total = 4; p2.succeeded = 1; p2.failed = 1;
  check('B 一半已处理 ⇒ 0.5', Math.abs(mod.progressRatio(p2) - 0.5) < 1e-9);
  const p3 = mod.initialProgress('pull');
  p3.total = 0;
  check('B 总数 0 ⇒ 0（不产生 NaN）', mod.progressRatio(p3) === 0);

  // ── C metadata ────────────────────────────────────────────────────
  const good = mod.encodeMetadata({ displayName: '会话 A', fileName: 'a.jsonl.zstd', formatVersion: 2 });
  const dec = mod.decodeMetadata(good);
  check('C 合法 metadata 能解出', dec !== null && dec.displayName === '会话 A' && dec.formatVersion === 2);
  check('C 未知 schema 拒绝', mod.decodeMetadata('{"schema":999,"displayName":"x"}') === null);
  check('C 非法 JSON 拒绝', mod.decodeMetadata('{not json') === null);
  check('C 空串拒绝', mod.decodeMetadata('') === null);
  check('C 空 displayName 被安全处理', mod.decodeMetadata(mod.encodeMetadata(
    { displayName: undefined, fileName: '', formatVersion: -1 })) !== null);

  // ── D sha256 ──────────────────────────────────────────────────────
  check('D 合法 64 位十六进制通过', mod.isValidSha256(SHA_A) === true);
  check('D 大写形式通过（比较时再归一）', mod.isValidSha256(SHA_A.toUpperCase()) === true);
  check('D 空串拒绝', mod.isValidSha256('') === false);
  check('D 长度不足拒绝', mod.isValidSha256('abc123') === false);
  check('D 非十六进制拒绝', mod.isValidSha256('z'.repeat(64)) === false);

  // ── E unitId ──────────────────────────────────────────────────────
  const uid = mod.makeUnitId(mod.UnitKind.SESSION, 'ws-1', 'abc:v2');
  check('E 三段式可解析', uid === 'session/ws-1/abc:v2');
  const parsed = mod.parseUnitId(uid);
  check('E 解析回原值', parsed !== null && parsed.kind === 'session'
    && parsed.workspaceId === 'ws-1' && parsed.key === 'abc:v2');
  check('E 缺 key 拒绝', mod.parseUnitId('session/ws-1') === null);
  check('E 无分隔符拒绝', mod.parseUnitId('garbage') === null);
  check('E 空 workspace 回退 global', mod.makeUnitId(mod.UnitKind.SKILL, '', 'k') === 'skill/global/k');
  check('E kind 合法性判定', mod.isKnownKind('session') === true && mod.isKnownKind('bogus') === false);
}

const selfTest = process.argv.includes('--self-test');
const src = readFileSync(join(ROOT, SRC), 'utf8');
const mod = buildModule(src);
if (mod === null) {
  console.error(`❌ 无法从 ${SRC} 抽出同步模型函数`);
  process.exit(1);
}

if (!selfTest) {
  runSuite(mod);
  console.log(`  ok    ${passed} 条判据通过`);
  if (failures.length > 0) {
    console.error(`\n❌ 同步模型不合格（${failures.length} 条）`);
    process.exit(1);
  }
  console.log('✅ 通过：冲突不覆盖、进度含失败、未知 schema 拒绝、sha 门禁有效。');
  process.exit(0);
}

console.log('--self-test：变异体必须判红 --');
runSuite(mod);
let ok = failures.length === 0;
console.log(`  基线：问题 ${failures.length} 处（应为 0）`);

const arms = [
  ['冲突改成"覆盖"（会盖掉本机会话）', (s) => s.replace(
    '/* 同 ID 不同内容：不猜谁对，标冲突 */\n  return UnitAction.CONFLICT;',
    'return UnitAction.PULL;')],
  ['进度只算成功（失败时进度条卡 99%）', (s) => s.replace(
    'const processed: number = p.succeeded + p.failed + p.skipped;',
    'const processed: number = p.succeeded;')],
  ['未知 schema 硬解（旧端改写新数据）', (s) => s.replace(
    'if (schema !== UNIT_METADATA_SCHEMA) {',
    'if (false) {')],
  ['空 sha 放行（完整性闸门失效）', (s) => s.replace(
    'if (v.length !== 64) {',
    'if (false) {')],
];
for (const [label, mutate] of arms) {
  const mutated = mutate(src);
  const changed = mutated !== src;
  const m = changed ? buildModule(mutated) : null;
  if (m === null) {
    ok = false;
    console.log(`  ❌ ${label} ⇒ 变异未生效或模块不可求值`);
    continue;
  }
  runSuite(m);
  const reds = failures.length;
  if (reds === 0) ok = false;
  console.log(`  ${reds > 0 ? '✅' : '❌'} ${label} ⇒ ${reds > 0 ? `判红（${reds} 条）` : '未判红（门禁没牙）'}`);
}
console.log(ok ? '\n✅ 自检通过。' : '\n❌ 自检失败（门禁没牙）。');
process.exit(ok ? 0 : 3);
