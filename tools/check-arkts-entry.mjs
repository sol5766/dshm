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
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const MODULE = 'entry';
const LOG_DIR = join(ROOT, 'dist', 'arkts-entry');

/** CLT 根目录：环境变量优先，其次本机既定安装位置 */
function resolveClt() {
  const candidates = [];
  if (process.env.DEVECO_CLI_CLT_PATH) candidates.push(process.env.DEVECO_CLI_CLT_PATH);
  candidates.push('/home/node/deveco-clt/command-line-tools');
  for (const c of candidates) {
    if (existsSync(join(c, 'hvigor', 'bin', 'hvigorw.js'))) return c;
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
const javaHome = process.env.JAVA_HOME || '/home/node/jdk/jdk-17.0.20.1+1';
if (!existsSync(javaHome)) {
  console.error(`环境受阻：找不到 JDK（JAVA_HOME=${javaHome}）。⚠️ 退出码 3 = 没跑成，不是通过。`);
  process.exit(3);
}

mkdirSync(LOG_DIR, { recursive: true });
const logFile = join(LOG_DIR, 'compile.log');
const nodeBin = join(clt, 'tool', 'node', 'bin', 'node');
const hvigorw = join(clt, 'hvigor', 'bin', 'hvigorw.js');
const childEnv = {
  ...process.env,
  DEVECO_CLI_CLT_PATH: clt,
  DEVECO_SDK_HOME: join(clt, 'sdk'),
  JAVA_HOME: javaHome,
  PATH: `${join(javaHome, 'bin')}:${process.env.PATH || ''}`
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
