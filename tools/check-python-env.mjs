#!/usr/bin/env node
/*
 * check-python-env.mjs —— 端侧 Python「可安装、可运行」环境门禁。
 *
 * 背景（2026-11-24）：用户要的是像桌面一样 `git clone 项目 && pip install -r requirements.txt`
 * 就能跑。实测三个坑必须同时钉住：
 *   1. 随包 CPython 的 platform tag 是 harmonyos_..._aarch64，pip 默认匹配不到 PyPI 轮子
 *      ⇒ pip wrapper 必须显式 `--platform musllinux_1_2_aarch64 --abi cp312 --only-binary --target`；
 *   2. 端侧直连 pypi.org 超时 ⇒ 默认源必须是可用镜像，且允许 PIP_INDEX_URL 覆盖；
 *   3. 装进来的 .so/.node 未签名会被 dlopen 拒绝 ⇒ 安装后必须调 selfsign.js 补 .codesign。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = join(ROOT, 'hostcore', 'app', 'main.js');
const SIGN = join(ROOT, 'hostruntime', 'src', 'main', 'resources', 'resfile', 'toolchain', 'python', 'selfsign.js');
const TAR = join(ROOT, 'hostruntime', 'src', 'main', 'resources', 'resfile', 'toolchain', 'python',
  'cpython-3.12.14-aarch64-musl.tar.gz');

let pass = 0;
let fail = 0;
function ok(name, detail = '') {
  pass += 1;
  console.log(`  ok   ${name}${detail ? `（${detail}）` : ''}`);
}
function bad(name, detail = '') {
  fail += 1;
  console.log(`  FAIL ${name}${detail ? `（${detail}）` : ''}`);
}

const src = readFileSync(MAIN, 'utf8');

const checks = [
  ['pip 显式 musllinux 平台', src.includes('--platform musllinux_1_2_aarch64')],
  ['pip 显式 abi cp312', src.includes('--abi cp312')],
  ['pip 仅用二进制轮子', src.includes('--only-binary=:all:')],
  ['pip 安装到沙盒 py-site', src.includes('--target "$PY_SITE"')],
  ['pip 默认走镜像', src.includes('PIP_INDEX_URL="${PIP_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple/}"')],
  ['python 注入 py-site 到 PYTHONPATH', src.includes('export PYTHONPATH="$PY_SITE')],
  ['python 设置 LD_LIBRARY_PATH', src.includes('export LD_LIBRARY_PATH="$P/lib')],
  ['安装后调用 selfsign', src.includes('"$P/selfsign.js"')],
  ['python 解包后投放 selfsign', src.includes("'toolchain', 'python', 'selfsign.js'")],
  ['pip 应用端侧约束文件', src.includes('constraints.txt')],
  ['wheel 自带 .libs 进 LD 路径', src.includes('"$PY_SITE"/*.libs')],
  ['首次启动解 Python 预设', src.includes('ensurePythonSitePreset')],
  ['工具链解包延后到 READY 之后', src.includes("startupWork.request('toolchain'")],
  ['解包后补挂 Python 桥', src.includes('解包后补挂 Python 桥失败')],
];
for (const [name, v] of checks) (v ? ok : bad)(name);

if (existsSync(TAR)) ok('随包 CPython 归档在位'); else bad('随包 CPython 归档在位');
const PRESET = join(ROOT, 'hostruntime', 'src', 'main', 'resources', 'resfile', 'toolchain', 'python', 'dshm-pysite.tar.gz');
if (existsSync(PRESET)) ok('手机预设包在位', `${Math.round(statSync(PRESET).size / 1048576)} MB`);
else bad('手机预设包在位');
if (existsSync(SIGN)) ok('selfsign.js 已随包'); else bad('selfsign.js 已随包');
const CONS = join(ROOT, 'hostruntime', 'src', 'main', 'resources', 'resfile', 'toolchain', 'python', 'constraints.txt');
if (existsSync(CONS)) {
  const c = readFileSync(CONS, 'utf8');
  (c.includes('Pillow==10.4.0') ? ok : bad)('约束锁定 Pillow 10.4.0（13 与 pptx 冲突）');
} else {
  bad('约束文件 constraints.txt 在位');
}

console.log(`\n# python 环境门禁：${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
