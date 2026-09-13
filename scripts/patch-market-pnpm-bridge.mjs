/**
 * patch-market-pnpm-bridge.mjs —— 让 dshmarket 在鸿蒙沙箱里用「同进程 pnpm」安装插件。
 *
 * ## 背景（2026-09-13 设备实测）
 *
 * dshmarket 的安装链路全部走 `node:child_process`：
 *   - `probePnpm()`        → spawn('pnpm', ['--version'])
 *   - `provisionPnpm()`    → spawn('corepack'|'npm', …)
 *   - `runDshPlugin()`     → spawn(node, [dsh bin.js, 'plugin', '--profile', p, …])
 *
 * 而鸿蒙应用沙箱里：① PATH 上没有 pnpm/npm/corepack；② filesDir 内的可执行文件
 * spawn/execv 一律 EACCES（历史实测 node_shim / nativespawn 都是这个结论）。
 * 结果就是 `/dsh-market/status` 的 `pnpm` 恒为 `false`，市场能打开但**装不了任何插件**。
 *
 * ## 做法
 *
 * 不自己重写 pnpm 调用，而是复用 dsh 自带的同进程实现：
 * `@deepseek-ai/dsh/lib/plugin-*.js` 导出的 `runPlugin(profile, args)`
 * —— 它在 `worker_threads` 里 require 内置的 `pnpm/dist/pnpm.cjs`，成功后
 * reconcile `dsh.profile.bundles`，与 `dsh plugin --profile <p> add <pkg>` 是同一条路径，
 * 也是内嵌环境本来就适配过的路径（内置 pnpm + TMPDIR 改写 + jitless 兼容）。
 *
 * 触发条件：环境变量 `DSHM_FILES_DIR`（dsh_host.cpp 在两种模式下都会导出）指向的
 * 目录下存在 `<filesDir>/dsh/node_modules/pnpm/dist/pnpm.cjs`。不存在时补丁完全惰性，
 * 一切退回上游行为。
 *
 * ## 用法
 *
 *     node scripts/patch-market-pnpm-bridge.mjs            # 打补丁（幂等）
 *     node scripts/patch-market-pnpm-bridge.mjs --check    # 只检查状态，不写文件
 *
 * 目标文件是**暂存环境树**（git 忽略、由 prepare-dsh-env.sh 生成）：
 *   entry/src/main/resources/rawfile/dsh/node_modules/dshmarket/lib/dsh-cli.js
 * 改完必须提升 DshBootstrap.ets 的 ENV_VERSION，否则设备上已解压的旧副本不会更新。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(
  REPO_ROOT,
  'entry/src/main/resources/rawfile/dsh/node_modules/dshmarket/lib/dsh-cli.js',
);

const MARKER = 'DSHM 鸿蒙适配：同进程 pnpm 桥接';

/** 导入区锚点：把 node:url 的 pathToFileURL 与桥接实现插在最后一条 import 之后。 */
const IMPORT_ANCHOR = "import { fetchNpmLatest } from './updates.js';\n";

const IMPORT_ADDED = "import { pathToFileURL } from 'node:url';\n";

const BRIDGE = `
// ==== ${MARKER} ====
// 见 scripts/patch-market-pnpm-bridge.mjs：鸿蒙沙箱无法 spawn 任何可执行文件，
// 市场的子进程安装链路必然失败，这里改用 dsh 自带的「同进程 worker + 内置 pnpm」。
const DSHM_FILES_DIR = (process.env.DSHM_FILES_DIR ?? '').trim();
/** 内置 pnpm CLI 的绝对路径；取不到时返回空串，桥接整体惰性关闭。 */
function dshmPnpmCli() {
    if (DSHM_FILES_DIR === '')
        return '';
    const cli = join(DSHM_FILES_DIR, 'dsh', 'node_modules', 'pnpm', 'dist', 'pnpm.cjs');
    return existsSync(cli) ? cli : '';
}
/** 是否启用同进程 pnpm。 */
function dshmInProcessPnpm() {
    return dshmPnpmCli() !== '';
}
/** dsh 的 plugin 模块（runPlugin 导出）。 */
function dshmDshPluginModule() {
    return join(DSHM_FILES_DIR, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'plugin-Ddi42qoW.js');
}
/** 用 dsh 的 runPlugin 在同进程内完成一次插件安装/卸载，返回市场要的 InstallResult 形状。 */
async function dshmRunPluginInProcess(profile, pluginArgs) {
    progress.active = true;
    progress.target = pluginArgs.join(' ');
    progress.startedAt = Date.now();
    progress.phase = 'install';
    progress.error = null;
    progress.cancelling = false;
    progress.lastLine = 'DSHM 内置 pnpm（同进程 worker）执行中…';
    let previousCwd = '';
    try {
        previousCwd = process.cwd();
    }
    catch {
        previousCwd = '';
    }
    try {
        // dsh 的 runPlugin 以 <cwd>/dsh/node_modules/pnpm/dist/pnpm.cjs 为首选路径；
        // 宿主模式 cwd 是个人目录，必须临时切到 filesDir 才能命中同一份内置 pnpm。
        try {
            process.chdir(DSHM_FILES_DIR);
        }
        catch {
            /* cwd 不可用时沿用当前目录，交给候选路径兜底 */
        }
        const mod = await import(pathToFileURL(dshmDshPluginModule()).href);
        const exitCode = await mod.runPlugin(profile, [...pluginArgs]);
        return {
            exitCode,
            timedOut: false,
            stdout: '',
            stderr: exitCode === 0 ? '' : \`DSHM: 内置 pnpm 退出码 \${String(exitCode)}（详见设备 node 日志）\`,
            cancelled: false,
        };
    }
    catch (error) {
        return {
            exitCode: 127,
            timedOut: false,
            stdout: '',
            stderr: \`DSHM: 内置 pnpm 执行失败 \${String(error)}\`,
            cancelled: false,
        };
    }
    finally {
        if (previousCwd !== '') {
            try {
                process.chdir(previousCwd);
            }
            catch {
                /* 还原 cwd 失败不影响安装结果 */
            }
        }
        progress.active = false;
        progress.cancelling = false;
        progress.phase = null;
    }
}
// ==== ${MARKER} 结束 ====
`;

const ANCHORS = [
  {
    label: 'probePnpm 短路',
    find: 'export function probePnpm() {\n    if (pnpmReady)\n        return Promise.resolve(true);',
    replace:
      'export function probePnpm() {\n' +
      '    // DSHM: 内置同进程 pnpm 视为已就绪（沙箱里永远探测不到 PATH 上的 pnpm）。\n' +
      '    if (dshmInProcessPnpm()) {\n' +
      '        pnpmReady = true;\n' +
      '        pnpmProbeFailure = null;\n' +
      '        return Promise.resolve(true);\n' +
      '    }\n' +
      '    if (pnpmReady)\n        return Promise.resolve(true);',
  },
  {
    label: 'provisionPnpm 短路',
    find: 'export async function provisionPnpm() {\n    const corepack',
    replace:
      'export async function provisionPnpm() {\n' +
      '    // DSHM: 内置同进程 pnpm 无需 corepack/npm 供应。\n' +
      '    if (dshmInProcessPnpm())\n' +
      '        return { ok: true };\n' +
      '    const corepack',
  },
  {
    label: 'runDshPlugin 改走同进程',
    find: 'export function runDshPlugin(profile, pluginArgs) {\n    const { file, args, cwd, viaShell } = dshArgv();',
    replace:
      'export function runDshPlugin(profile, pluginArgs) {\n' +
      '    // DSHM: 沙箱内无法 spawn dsh CLI，改走同进程 worker 里的内置 pnpm。\n' +
      '    if (dshmInProcessPnpm())\n' +
      '        return dshmRunPluginInProcess(profile, pluginArgs);\n' +
      '    const { file, args, cwd, viaShell } = dshArgv();',
  },
];

function countOf(haystack, needle) {
  if (needle === '') return 0;
  return haystack.split(needle).length - 1;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  if (!fs.existsSync(TARGET)) {
    console.error(`[pnpm-bridge] 目标文件不存在: ${TARGET}`);
    console.error('[pnpm-bridge] 先运行 scripts/prepare-dsh-env.sh 生成暂存环境树。');
    process.exit(2);
  }
  let source = fs.readFileSync(TARGET, 'utf8');

  if (source.includes(MARKER)) {
    console.log('[pnpm-bridge] 已打过补丁（幂等跳过）');
    return;
  }
  if (checkOnly) {
    console.log('[pnpm-bridge] 未打补丁');
    process.exit(1);
  }

  if (countOf(source, IMPORT_ANCHOR) !== 1) {
    console.error('[pnpm-bridge] 未找到唯一的 imports 锚点，dshmarket 版本可能已变化。');
    process.exit(3);
  }
  source = source.replace(IMPORT_ANCHOR, IMPORT_ANCHOR + IMPORT_ADDED + BRIDGE);

  for (const anchor of ANCHORS) {
    const hits = countOf(source, anchor.find);
    if (hits !== 1) {
      console.error(`[pnpm-bridge] 锚点「${anchor.label}」命中 ${hits} 次（期望 1 次），中止。`);
      process.exit(4);
    }
    source = source.replace(anchor.find, anchor.replace);
  }

  const backup = `${TARGET}.bak-prepnpm`;
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(TARGET, backup);
  }
  fs.writeFileSync(TARGET, source, 'utf8');
  console.log(`[pnpm-bridge] 补丁完成: ${path.relative(REPO_ROOT, TARGET)}`);
  console.log('[pnpm-bridge] 提醒：必须提升 DshBootstrap.ets 的 ENV_VERSION，设备才会重新解压。');
}

main();
