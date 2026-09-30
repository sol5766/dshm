/**
 * entry（UI 层）ArkTS 编译门禁。
 *
 * 存在理由：
 *   `entry/src/main/ets` 里是 `Index.ets`（4613 行）与全部 Pane —— **P1~P3 的主要改动面**。
 *   而 2026-09-14 之前它在本环境**零自动验证**：没有编译器（原生构建需要不入库的头文件），
 *   codelinter 又**检不出语法错误**（注入实测：往 `appstate` 塞 `return a +;`，codelinter 一条不报，
 *   真编译器立刻 BUILD FAILED）。于是"改 UI"只能靠人眼，劣化没有任何症状。
 *
 *   hvigor 的 `default@CompileArkTS` 任务**只编 ArkTS、不碰原生**，因此不需要
 *   `libnode.so` 之类运行期产物即可跑通 —— 这把 UI 层重新纳入可自动验证的范围。
 *   本脚本就是把那条命令固定下来，免得它退回成"某次聊天里提过的一句命令"。
 *
 * 退出码：0 通过；1 编译失败；3 **环境受阻**（找不到 CLT / SDK / JDK），沿用本项目既有约定
 *         —— **不把"没跑成"说成"通过"**。
 *
 * 用法：
 *   node tools/check-arkts-entry.mjs              # 编 entry 的 ArkTS
 *   node tools/check-arkts-entry.mjs --verbose    # 打印完整 hvigor 输出
 *   node tools/check-arkts-entry.mjs --self-test  # 判定器自检（注入式正/负样例）
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const MODULE = 'entry';
const LOG_DIR = join(ROOT, 'dist', 'arkts-entry');

/* ───────────────────────── 路径解析（Linux CLT 与 Windows IDE 两套布局） ─────────────────────────
 *
 * 【为什么要有这一段】本脚本最初只认 Linux CLT 布局（`/home/node/deveco-clt/command-line-tools`
 * + `<CLT>/tool/node/bin/node` + `JAVA_HOME=/home/node/jdk/...`），于是在 Windows 上恒 exit 3。
 * `docs/90-DSH鸿蒙原生实现全流程.md` §2.4（:4336-4360）把这件事查清并写明：
 *   · `join(clt,'tool','node','bin','node')` —— Linux 布局；Windows 上是 `<IDE>\tools\node\node.exe`，
 *     且**必须带 `.exe`**：`execFileSync` 在 Windows 上不会为无扩展名的路径补 `.exe`
 *     （该章实测 `spawnSync <shim>/tool/node/bin/node ENOENT`，换显式 `node.exe` 立刻成功）。
 *   · `JAVA_HOME` 默认值写死 Linux 路径 ⇒ 不设环境变量就 exit 3。
 *   · 之后 `DEVECO_SDK_HOME=join(clt,'sdk')` 同样是 Linux 布局（Windows 上是 `<IDE>\sdk`）。
 *
 * 后果不只是"跑不起来"：本脚本守的是 `entry/src/main/ets`（`Index.ets` 与全部 Pane，
 * 也就是 P1~P3 与本次外链外开改动的主要落点），它长期 exit 3
 * ⇒ **这一层的 ArkTS 编译在本机等于从未被验证过**，而"exit 3"很容易被读成"环境限制，没办法"。
 * 写法照抄 `tools/place-toolchain.mjs` 的 `findHostPython()`：**候选列表 + 逐个验证存在性**，
 * 找不到仍 **exit 3**（不把"没跑成"说成"通过"）。
 *
 * 教训（该章原话）：**"环境受限"这四个字要先验证**，否则会把"可修的脚本缺陷"永久正当化。 */

/** CLT 根目录候选：环境变量 → Linux 既定安装位置 → Windows IDE 自带布局 */
function cltCandidates() {
  const list = [];
  if (process.env.DEVECO_CLI_CLT_PATH) list.push(process.env.DEVECO_CLI_CLT_PATH);
  list.push('/home/node/deveco-clt/command-line-tools');
  const programFiles = process.env.ProgramFiles ?? process.env.PROGRAMFILES;
  if (programFiles !== undefined && programFiles.length > 0) {
    list.push(join(programFiles, 'Huawei', 'DevEco Studio', 'tools'));
  }
  return list;
}

function resolveClt() {
  for (const c of cltCandidates()) {
    if (existsSync(join(c, 'hvigor', 'bin', 'hvigorw.js'))) return c;
  }
  return null;
}

/** 跑 hvigor 的 node：CLT 自带优先，最后回落到"正在跑本脚本的 node"（打印说明，不静默） */
function resolveNodeBin(clt) {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    join(clt, 'tool', 'node', 'bin', 'node' + exe),  // Linux CLT 布局（原有）
    join(clt, 'node', 'node' + exe),                 // Windows IDE 布局：<IDE>\tools\node\node.exe
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // 回落并不削弱判定：容器换了布局时门禁仍能跑，而"通过"依旧要求真的看到 BUILD SUCCESSFUL；
  // 用错 node 只会造成**诚实的失败**（exit 1），不会造成假的通过。
  console.log(`注：CLT 里没找到自带 node（试过 ${candidates.join(' / ')}），改用运行本脚本的 ${process.execPath}`);
  return process.execPath;
}

/** JDK 候选：环境变量 → Linux 既定安装位置 → IDE 自带 jbr（`<IDE>\jbr`） */
function resolveJavaHome(clt) {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(process.env.JAVA_HOME);
  candidates.push('/home/node/jdk/jdk-17.0.20.1+1');
  candidates.push(join(clt, 'jbr'));
  candidates.push(join(clt, '..', 'jbr'));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** SDK 根：环境变量 → Windows IDE 布局（`<IDE>\sdk`）→ Linux CLT 布局（`<CLT>/sdk`） */
function resolveSdkHome(clt) {
  const candidates = [];
  for (const v of [process.env.DEVECO_SDK_HOME, process.env.OHOS_SDK_HOME]) {
    if (v !== undefined && v.length > 0) candidates.push(v);
  }
  candidates.push(join(clt, '..', 'sdk'));
  candidates.push(join(clt, 'sdk'));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * 从 hvigor 输出里判定结果（纯函数，便于自检注入样例）。
 *
 * 【为什么不用退出码判断】hvigorw 在本环境下**即使编译失败也可能以 0 退出**
 * （实测：`COMPILE RESULT:FAIL {ERROR:8 WARN:33}` 之后 process 仍返回 0），
 * 因此必须解析它自己打印的结论行，否则门禁会永远"通过"。
 */
export function classify(output) {
  const errors = [...output.matchAll(/Error Message:\s*(.+)/g)].map((m) => m[1].trim());
  const resultLine = (output.match(/COMPILE RESULT:(\w+)\s*\{([^}]*)\}/) || [])[1] || '';
  const buildOk = /BUILD SUCCESSFUL/.test(output);
  const buildFailed = /BUILD FAILED/.test(output);
  const warnCount = Number(((output.match(/COMPILE RESULT:\w+\s*\{[^}]*WARN:(\d+)/) || [])[1]) || 0);
  const errorCount = Number(((output.match(/COMPILE RESULT:\w+\s*\{[^}]*ERROR:(\d+)/) || [])[1]) || 0);
  // 任务到底有没有跑：成功时 hvigor 打印 `Finished :…@CompileArkTS…`，
  // 内容哈希未变时打印 `UP-TO-DATE :…@CompileArkTS…`。
  // 【实测】`COMPILE RESULT:` 这一行**只在失败时出现**——最初把"成功"判成"有 COMPILE RESULT:PASS"
  // 是错的，会把每一次真实的成功都判成"没跑成"（本门禁第一版就这样红过）。
  const taskFinished = /Finished :\S*@CompileArkTS/.test(output);
  const upToDate = /UP-TO-DATE :\S*@CompileArkTS/.test(output);

  // 判定顺序：先看明确的失败信号，再看通过信号；两者都没有 = 没跑成（不判通过）
  if (buildFailed || resultLine.toUpperCase() === 'FAIL' || errorCount > 0) {
    return { ok: false, errorCount: errorCount || errors.length, warnCount, errors, upToDate };
  }
  if (buildOk && (taskFinished || upToDate)) {
    return { ok: true, errorCount: 0, warnCount, errors: [], upToDate };
  }
  return { ok: false, inconclusive: true, errorCount: 0, warnCount, errors, upToDate };
}

function selfTest() {
  const cases = [
    // 真实的"通过"形态：任务跑完了、BUILD SUCCESSFUL，**没有 COMPILE RESULT 行**（那行只在失败时出现）
    { why: '通过：Finished :…@CompileArkTS + BUILD SUCCESSFUL（实测的真实成功形态）', text: '> hvigor Finished :entry:default@CompileArkTS... after 22 s 340 ms\n> hvigor BUILD SUCCESSFUL in 44 s', want: true },
    { why: '通过：CompileArkTS 被 UP-TO-DATE 跳过 + BUILD SUCCESSFUL（增量复用）', text: 'UP-TO-DATE :entry:default@CompileArkTS...\n> hvigor BUILD SUCCESSFUL in 13 s', want: true },
    { why: '失败：COMPILE RESULT:FAIL（即便没有 BUILD FAILED 字样）', text: 'COMPILE RESULT:FAIL {ERROR:8 WARN:33}', want: false },
    { why: '失败：出现 BUILD FAILED', text: '> hvigor ERROR: BUILD FAILED in 4 s', want: false },
    { why: '失败：有 Error Message 明细', text: 'COMPILE RESULT:FAIL {ERROR:1 WARN:0}\nError Message: Cannot find module \'x\'', want: false },
    { why: '失败：UP-TO-DATE 也救不了 BUILD FAILED', text: 'UP-TO-DATE :entry:default@CompileArkTS...\n> hvigor BUILD FAILED', want: false },
    { why: '不可判定：BUILD SUCCESSFUL 但 CompileArkTS 既没跑也没被跳过（不是本次的结论）', text: '> hvigor BUILD SUCCESSFUL in 2 s', want: false },
    { why: '不可判定：输出里什么都没有 ⇒ 不得当成通过', text: '(hvigor 什么也没打印)', want: false },
    // 关键回归样例：本环境实测过 hvigorw 编译失败仍返回退出码 0，所以判定不能依赖退出码
    { why: '失败但进程退出码为 0（实测形态）⇒ 仍须判失败', text: '1 ERROR: 10605008 ArkTS Compiler Error\nCOMPILE RESULT:FAIL {ERROR:8 WARN:33}\n> hvigor BUILD FAILED', want: false }
  ];
  let failed = 0;
  for (const c of cases) {
    const got = classify(c.text).ok;
    const ok = got === c.want;
    if (!ok) failed++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  期望${c.want ? '通过' : '失败'} 实际${got ? '通过' : '失败'}  ${c.why}`);
  }
  console.log(failed === 0
    ? `\n✅ 判定器自检通过（${cases.length} 个样例）。`
    : `\n❌ 判定器自检失败 ${failed} 项——门禁不可信。`);
  process.exit(failed === 0 ? 0 : 1);
}

const argv = process.argv.slice(2);
if (argv.includes('--self-test')) {
  console.log('# entry ArkTS 编译门禁 · 判定器自检\n');
  selfTest();
}

const clt = resolveClt();
if (!clt) {
  console.error('环境受阻：找不到 DevEco Command Line Tools（需含 hvigor/bin/hvigorw.js）。');
  console.error('  设置 DEVECO_CLI_CLT_PATH 后重跑。⚠️ 退出码 3 = 没跑成，不是通过。');
  process.exit(3);
}
const javaHome = resolveJavaHome(clt);
if (javaHome === null) {
  console.error('环境受阻：找不到 JDK（试过 JAVA_HOME、/home/node/jdk/jdk-17.0.20.1+1、<IDE>/jbr）。');
  console.error('  ⚠️ 退出码 3 = 没跑成，不是通过。');
  process.exit(3);
}
const sdkHome = resolveSdkHome(clt);
if (sdkHome === null) {
  console.error('环境受阻：找不到 SDK（试过 DEVECO_SDK_HOME、OHOS_SDK_HOME、<IDE>/sdk、<CLT>/sdk）。');
  console.error('  ⚠️ 退出码 3 = 没跑成，不是通过。');
  process.exit(3);
}

mkdirSync(LOG_DIR, { recursive: true });
const logFile = join(LOG_DIR, 'compile.log');
const nodeBin = resolveNodeBin(clt);
const hvigorw = join(clt, 'hvigor', 'bin', 'hvigorw.js');
const childEnv = {
  ...process.env,
  DEVECO_CLI_CLT_PATH: clt,
  DEVECO_SDK_HOME: sdkHome,
  OHOS_SDK_HOME: sdkHome,
  JAVA_HOME: javaHome,
  // 【必须是平台分隔符】原来写死 `:`：Windows 的 PATH 分隔符是 `;`，
  // 拼出来的值会被整段当成**一个**目录 ⇒ java 找不到，报的是 `spawn java ENOENT`
  // （与本机基线构建时踩过的坑同一个），与"没有 JDK"完全无关，极易误判。
  PATH: `${join(javaHome, 'bin')}${delimiter}${process.env.PATH || ''}`
};

const args = [
  hvigorw,
  'default@CompileArkTS',
  '--mode', 'module',
  '-p', `module=${MODULE}@default`,
  '-p', 'product=default',
  '-p', 'buildMode=debug',
  '--no-daemon'
];

console.log('# entry（UI 层）ArkTS 编译门禁\n');
console.log(`模块 ${MODULE} · CLT ${clt}`);
console.log('命令 hvigorw default@CompileArkTS --mode module -p product=default -p buildMode=debug\n');

/** 跑一次 hvigorw，返回 stdout+stderr 合并输出。
 *
 * 【为什么必须显式合并 stderr】`execFileSync` 默认把子进程 stderr **透传到父进程**，
 * 而 hvigor 的进度与结论行有相当一部分走 stderr（实测：透传时日志文件里只剩 stdout，
 * 出现"看起来什么都没跑"的假象）。不合并就会把成功的构建判成"没跑成"。 */
function runHvigor(argv) {
  try {
    return execFileSync(nodeBin, argv, {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    return `${e.stdout || ''}${e.stderr || ''}`;
  }
}

// --clean：先清掉构建产物，强制**真正重新编译**。
// 存在的理由：增量构建会让 CompileArkTS 被 UP-TO-DATE 跳过（本环境下实测），
// 那种"通过"是复用旧结果——CI 或不信任缓存时应当显式 --clean。
if (argv.includes('--clean')) {
  console.log('--clean：先清理构建产物，强制重新编译\n');
  const cleanOut = runHvigor([hvigorw, 'clean', '--mode', 'module', '-p', 'product=default', '--no-daemon']);
  if (/BUILD FAILED/.test(cleanOut)) {
    console.error('清理失败，终止（不得在未知状态下继续）：');
    console.error(cleanOut.split('\n').slice(-8).join('\n'));
    process.exit(1);
  }
}

const output = runHvigor(args);

writeFileSync(logFile, output, 'utf8');
if (argv.includes('--verbose')) console.log(output);

const r = classify(output);
const warns = r.warnCount ? ` · ${r.warnCount} warning` : '';

if (r.ok) {
  if (r.upToDate) {
    console.log(`✅ entry 的 ArkTS 编译通过（**增量复用**：CompileArkTS 被 UP-TO-DATE 跳过，内容哈希未变）${warns}。`);
    console.log('   要强制真正重新编译：node tools/check-arkts-entry.mjs --clean');
  } else {
    console.log(`✅ entry 的 ArkTS 编译通过（0 error${warns}）。`);
  }
  console.log('   完整日志：dist/arkts-entry/compile.log');
  process.exit(0);
}

if (r.inconclusive) {
  console.error('❌ 没拿到结论行（hvigor 可能没跑起来）。**不得当作通过**。');
  console.error(`   完整日志：dist/arkts-entry/compile.log`);
  process.exit(1);
}

console.error(`❌ entry 的 ArkTS 编译失败（${r.errorCount} error${warns}）：\n`);
for (const m of r.errors.slice(0, 20)) console.error(`  - ${m}`);
if (r.errors.length > 20) console.error(`  …还有 ${r.errors.length - 20} 条，见 dist/arkts-entry/compile.log`);
console.error('\n处置：先修编译错误。**不要用 codelinter 代替本门禁**——它检不出语法错误（实测）。');
process.exit(1);
