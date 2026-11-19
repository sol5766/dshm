#!/usr/bin/env node
/**
 * 门禁：bash / tmux wrapper 的 TERMINFO 路径与 TERM 回退（2026-11-11，2in1 终端专项）。
 *
 * 【为什么要有这条】真机诊断日志（2026-11-11 22:23）暴露了一个纯运行期缺陷：
 *   Alpine 的 ncurses-terminfo-base 把档案装到 `etc/terminfo`，而两个 wrapper 都把
 *   TERMINFO 指向 `usr/share/terminfo`（不存在）。于是 xterm-256color 下交互式 bash
 *   6 次里 5 次以 SIGSYS(-31) 静默消失；tmux 同样会报 "terminal not found"。
 * 这类错误既不进编译、也不进任何既有门禁，只会在真机上表现为"打开 bash 就退出"。
 *
 * 【判据】
 *   ① bash wrapper：同时探测 `$R/etc/terminfo` 与 `$R/usr/share/terminfo`，不能只写后者；
 *   ② tmux wrapper：同上；
 *   ③ 两个 wrapper 都要有 TERM 回退到 `xterm`（库里没有当前 TERM 条目时）；
 *   ④ 随包归档里真的存在 `etc/terminfo/x/xterm-256color` 与 `etc/terminfo/x/xterm`
 *      （bashroot / tmuxroot / guest 三处都查）。
 *
 * 【离线】只读本地文件与随包 tar.gz；不联网、不跑设备。
 *
 * 用法：
 *   node tools/check-bash-terminfo.mjs
 *   node tools/check-bash-terminfo.mjs --self-test
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const MAIN = 'hostcore/app/main.js';
const ARCHIVES = {
  bash: 'hostruntime/src/main/resources/resfile/toolchain/bash/ncurses-terminfo-base-alpine.tar.gz',
  tmux: 'hostruntime/src/main/resources/resfile/toolchain/tmux/ncurses-terminfo-base-alpine.tar.gz',
  guest: 'hostruntime/src/main/resources/resfile/vm/guestpkgs/ncurses-terminfo-base-6.5_p20250503-r0.tar.gz',
};
const NEED = ['etc/terminfo/x/xterm-256color', 'etc/terminfo/x/xterm'];

/** 只读 tar 头，够列文件名即可（Alpine 包没有长文件名 / PAX 头）。 */
export function listTarGz(file) {
  const buf = gunzipSync(readFileSync(file));
  const names = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeField = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    if (type === 'L') {
      /* GNU longname：下一块数据就是真名 */
      const data = buf.subarray(off + 512, off + 512 + size).toString('utf8').replace(/\0.*$/, '');
      name = data;
    }
    const clean = name.replace(/^\.\//, '').replace(/\/$/, '');
    if (clean) names.push(clean);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

function blockOf(text, startMarker, endMarker) {
  const a = text.indexOf(startMarker);
  if (a < 0) return '';
  const b = text.indexOf(endMarker, a);
  return text.slice(a, b < 0 ? text.length : b);
}

export function judge(text, archives) {
  const problems = [];
  const bash = blockOf(text, "'# DSHM bash wrapper", "exec /system/bin/sh \"$@\"");
  const tmux = blockOf(text, "'# DSHM tmux wrapper", '_e=$( ( exec');
  if (!bash) problems.push('找不到 bash wrapper 生成段');
  if (!tmux) problems.push('找不到 tmux wrapper 生成段');

  const wrapperRules = [
    ['bash', bash],
    ['tmux', tmux],
  ];
  for (const [name, block] of wrapperRules) {
    if (!block) continue;
    const root = name === 'bash' ? '$R' : '$T';
    if (!block.includes(`${root}/etc/terminfo`)) {
      problems.push(`${name} wrapper 没有探测 ${root}/etc/terminfo（Alpine 的 terminfo 真实位置）`);
    }
    if (!block.includes(`${root}/usr/share/terminfo`)) {
      problems.push(`${name} wrapper 没有保留 ${root}/usr/share/terminfo 兜底探测`);
    }
    if (!block.includes('TERM=xterm')) {
      problems.push(`${name} wrapper 缺少 TERM 回退到 xterm（当前 TERM 无条目会打不开）`);
    }
    /* 反例：退回"只写 usr/share/terminfo"的老写法必须判红（新写法只经 _ti 赋值）。 */
    if (block.includes(`TERMINFO="${root}/usr/share/terminfo"`)) {
      problems.push(`${name} wrapper 又写死到 usr/share/terminfo`);
    }
  }

  for (const [key, names] of Object.entries(archives)) {
    for (const need of NEED) {
      if (!names.includes(need)) problems.push(`${key} 随包归档缺少 ${need}`);
    }
  }
  return problems;
}

const selfTest = process.argv.includes('--self-test');
const raw = readFileSync(MAIN, 'utf8');
const archives = {};
for (const [k, f] of Object.entries(ARCHIVES)) archives[k] = listTarGz(f);
const base = judge(raw, archives);

if (!selfTest) {
  if (base.length > 0) {
    console.error(`❌ bash/tmux terminfo 接线不完整（${base.length} 处）：`);
    for (const p of base) console.error(`   · ${p}`);
    process.exit(1);
  }
  console.log('✅ 通过：bash / tmux wrapper 优先 etc/terminfo、保留兜底、TERM 可回退 xterm；三处随包归档含 xterm 条目。');
  process.exit(0);
}

console.log('--self-test：变异体必须判红 --');
let failures = 0;
if (base.length !== 0) {
  failures += 1;
  console.error(`基线应为 0 处，实际 ${base.length}`);
}
const arms = [
  ['bash 退回只写 usr/share/terminfo', (t) => t.replace(
    "      '  _ti=\"\"',\n      '  if [ -d \"$R/etc/terminfo\" ]",
    "      '  TERMINFO=\"$R/usr/share/terminfo\"',\n      '  if [ -d \"$R/etc/terminfo\" ]")],
  ['去掉 bash 的 TERM 回退', (t) => t.replace(
    "      '  if [ -n \"$TERM\" ]; then _fc=${TERM%${TERM#?}}; if [ -z \"$_ti\" ] || [ ! -e \"$_ti/$_fc/$TERM\" ]; then TERM=xterm; export TERM; fi; fi',\n",
    '')],
  ['去掉 tmux 的 TERM 回退', (t) => t.replace(
    "      'if [ -n \"$TERM\" ]; then _fc=${TERM%${TERM#?}}; if [ -z \"$_ti\" ] || [ ! -e \"$_ti/$_fc/$TERM\" ]; then TERM=xterm; export TERM; fi; fi',\n",
    '')],
];
for (const [name, mutate] of arms) {
  const mutated = mutate(raw);
  if (mutated === raw) {
    failures += 1;
    console.error(`  ✗ ${name}：变异未生效（锚点漂了，门禁自身要修）`);
    continue;
  }
  const problems = judge(mutated, archives);
  if (problems.length === 0) {
    failures += 1;
    console.error(`  ✗ ${name}：判据没判红`);
  } else {
    console.log(`  ✓ ${name} ⇒ 判红（${problems.length} 处：${problems[0]}）`);
  }
}
/* 归档缺失也要判红：把三条清单都清空 */
{
  const empty = { bash: [], tmux: [], guest: [] };
  const problems = judge(raw, empty);
  if (problems.length === 0) {
    failures += 1;
    console.error('  ✗ 归档缺 xterm：判据没判红');
  } else {
    console.log(`  ✓ 归档缺 xterm ⇒ 判红（${problems.length} 处：${problems[0]}）`);
  }
}
console.log(failures === 0 ? '✅ 自检通过' : `❌ 自检失败（${failures}）`);
process.exit(failures === 0 ? 0 : 1);
