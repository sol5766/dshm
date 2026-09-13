/**
 * patch-terminal-pty-host.mjs —— 让 dshm-terminal 在**宿主模式**也能加载 PTY addon。
 *
 * ## 背景（2026-09-13 设备实测）
 *
 * 鸿蒙沙箱只允许 dlopen **el1 bundle 库目录**（`/data/storage/el1/bundle/libs/arm64`）
 * 里的原生库；el2 用户数据区（filesDir 解压/镜像产物）一律报
 * `ERR_DLOPEN_FAILED ... Permission denied`。
 *
 * dshm-terminal 原本只靠 `/proc/self/maps` 里的 **libnode 映射**推导该目录：
 *   - 内嵌模式：libnode.so.137 就映射在那里 → 命中 → `pty: true`；
 *   - 宿主模式：跑的是 brew node，进程里没有 libnode → 推导失败 →
 *     回退 `vendor/pty_host.node`（el2）→ dlopen 被拒 → `pty: false`，
 *     终端退化成管道会话（无 Tab 补全、无行编辑、无 Ctrl-C）。
 *
 * ## 做法
 *
 * 由 `dsh_host.cpp` 的 `InjectBusyboxEnv()` 在父进程导出 `DSHM_LIB_DIR`
 * （从 /proc/self/maps 里 libdsh_host/libnode 的映射路径算出，两种模式都会继承），
 * 本补丁把它作为**最高优先级**候选插进 ptyCandidates。
 *
 * ## 用法
 *
 *     node scripts/patch-terminal-pty-host.mjs            # 打补丁（幂等）
 *     node scripts/patch-terminal-pty-host.mjs --check    # 只检查状态
 *
 * 目标文件是暂存环境树（git 忽略、由 prepare-dsh-env.sh 生成），改完必须提升
 * DshBootstrap.ets 的 ENV_VERSION，设备才会重新解压。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(
  REPO_ROOT,
  'entry/src/main/resources/rawfile/dsh/node_modules/dshm-terminal/lib/index.js',
);

const MARKER = 'DSHM 宿主模式 pty 候选 v2：DSHM_LIB_DIR + napi 变体';

/** 旧版本补丁块（v1 只推 libpty_host.so）——升级时先还原，避免候选重复。 */
const LEGACY_MARKER = 'DSHM 宿主模式 pty 候选：DSHM_LIB_DIR';

const ANCHOR = `  const ptyCandidates = [];
  try {
    // 通过本进程已加载的 libnode.so 映射解析 el1 bundle 库目录
`;

const INSERT = `  const ptyCandidates = [];
  // ==== ${MARKER} ====
  // 宿主模式（brew node）进程里没有 libnode 映射，下面的 maps 推导必然失败；
  // native 侧已在父进程导出 DSHM_LIB_DIR（el1 bundle 库目录），直接用它。
  // 候选顺序即加载优先级：
  //   1. libpty_host.so      —— 链接了 libnode.so.137，只在内嵌模式可用；
  //   2. libpty_host_napi.so —— 不链接 libnode（N-API 符号交给宿主 node 解析），
  //                             宿主模式专用；内嵌模式下也会解析成功，互为兜底；
  //   3. vendor/pty_host.node —— 旧环境/桌面平台。
  // 加载循环对失败候选会继续尝试下一个，因此无需在插件里判断模式。
  try {
    const libDir = (process.env.DSHM_LIB_DIR ?? "").trim();
    if (libDir !== "") {
      for (const name of ["libpty_host.so", "libpty_host_napi.so"]) {
        const libSo = path.join(libDir, name);
        if (existsSync(libSo)) {
          ptyCandidates.push(libSo);
        } else {
          console.warn("[dshm-terminal] DSHM_LIB_DIR 下没有 " + name + ": " + libSo);
        }
      }
    }
  } catch (envErr) {
    console.warn("[dshm-terminal] DSHM_LIB_DIR 候选失败: " + String(envErr));
  }
  // ==== ${MARKER} 结束 ====
  try {
    // 通过本进程已加载的 libnode.so 映射解析 el1 bundle 库目录
`;

const RAW_MARKER = 'DSHM: raw=true 时不补换行';

const ANCHORS_EXTRA = [
  {
    label: 'write 支持原始模式（不补换行）',
    find:
      '          let text = typeof body.text === "string" ? body.text : "";\n' +
      '          if (!text.endsWith("\\n")) text += "\\n";\n',
    replace:
      '          let text = typeof body.text === "string" ? body.text : "";\n' +
      '          // ' + 'DSHM: raw=true 时不补换行' + '。Tab 补全 / 方向键 / Ctrl-C 必须原样\n' +
      '          // 送进 pty；补了 \\n 会变成「补全后立刻执行」（实测 ec<Tab> 直接跑了 echo）。\n' +
      '          const rawWrite = body.raw === true;\n' +
      '          if (!rawWrite && !text.endsWith("\\n")) text += "\\n";\n',
  },
];

function main() {
  const checkOnly = process.argv.includes('--check');
  if (!fs.existsSync(TARGET)) {
    console.error(`[terminal-pty] 目标文件不存在: ${TARGET}`);
    console.error('[terminal-pty] 先运行 scripts/prepare-dsh-env.sh 生成暂存环境树。');
    process.exit(2);
  }
  let source = fs.readFileSync(TARGET, 'utf8');
  let changed = false;

  // ── 补丁 1：pty 候选（DSHM_LIB_DIR + napi 变体）──
  if (source.includes(LEGACY_MARKER) && !source.includes(MARKER)) {
    // 升级路径：v1 只推 libpty_host.so，先从备份还原再打 v2，否则候选会叠加。
    const backup = `${TARGET}.bak-ptyhost`;
    if (fs.existsSync(backup)) {
      source = fs.readFileSync(backup, 'utf8');
      console.log('[terminal-pty] 检测到 v1 补丁，已从备份还原后重打 v2');
    } else {
      console.error('[terminal-pty] 检测到 v1 补丁但没有备份，无法安全升级；请重建环境树。');
      process.exit(5);
    }
  }
  if (!source.includes(MARKER)) {
    const hits = source.split(ANCHOR).length - 1;
    if (hits !== 1) {
      console.error(`[terminal-pty] pty 候选锚点命中 ${hits} 次（期望 1 次），dshm-terminal 版本可能已变化。`);
      process.exit(3);
    }
    source = source.replace(ANCHOR, INSERT);
    changed = true;
  }

  // ── 补丁 2：write 原始模式（Tab/方向键不补换行）──
  if (!source.includes(RAW_MARKER)) {
    for (const anchor of ANCHORS_EXTRA) {
      const n = source.split(anchor.find).length - 1;
      if (n !== 1) {
        console.error(`[terminal-pty] 锚点「${anchor.label}」命中 ${n} 次（期望 1 次），中止。`);
        process.exit(4);
      }
      source = source.replace(anchor.find, anchor.replace);
    }
    changed = true;
  }

  if (!changed) {
    console.log('[terminal-pty] 已打过补丁（幂等跳过）');
    return;
  }
  if (checkOnly) {
    console.log('[terminal-pty] 未打补丁');
    process.exit(1);
  }
  const backup = `${TARGET}.bak-ptyhost`;
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(TARGET, backup);
  }
  fs.writeFileSync(TARGET, source, 'utf8');
  console.log(`[terminal-pty] 补丁完成: ${path.relative(REPO_ROOT, TARGET)}`);
  console.log('[terminal-pty] 提醒：必须提升 DshBootstrap.ets 的 ENV_VERSION，设备才会重新解压。');
}

main();
