#!/usr/bin/env node
/**
 * 启动提速「钉死」门禁（2026-11-26）。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────────
 * 这轮启动提速不是一处改动，而是一条**跨 6 个文件的链**：
 *   A 核心容器 sha256 缓存（BundledCore）
 *   B 启动后延迟 import（tools/lib/post-startup-imports.mjs + pack-core 接线）
 *   C 前台 64ms 端口轮询（NodeRuntime）
 *   D 启动期同步环默认开启 + 锁快扫（main.js）
 *   E 用户安装 bundle 延迟挂载（dshm-deferred-bundles.js → 清单 → dshm-boot-extras）
 *   F 移动端「在文件夹显示」桥（tools/lib/open-in-app-reveal.mjs）
 * 任何一环被"顺手重构"掉，速度都会静默退回，而单测/功能测试都不会红。
 * 本门禁把这些**接线事实**写成断言：删了、顺序反了、种子 bundle 又被写回
 * `dsh.profile.bundles`、清单文件被漏出 resfile……都在这里判红。
 *
 * ── 判据纪律 ─────────────────────────────────────────────────────────────
 *   · 只读仓库源码，不依赖核心树 / 真机 / SDK（CI 干净检出可跑）。
 *   · 每条断言对应一个**真实踩过的坑**（见 JD/DSHM-启动提速-经验与护栏-20261126.md）。
 *   · 不检查"实现细节的美观"，只检查"速度链是否还接着"。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];

function read(relative) {
  return readFileSync(join(ROOT, relative), 'utf8');
}

function must(relative, needle, why) {
  const text = read(relative);
  if (!text.includes(needle)) {
    throw new Error(`启动锁断裂：${relative} 缺少「${needle}」\n  原因：${why}`);
  }
  results.push(`${relative}  ✓ ${why}`);
}

function mustNot(relative, needle, why) {
  const text = read(relative);
  if (text.includes(needle)) {
    throw new Error(`启动锁断裂：${relative} 仍含「${needle}」\n  原因：${why}`);
  }
  results.push(`${relative}  ✓ ${why}`);
}

function order(relative, first, second, why) {
  const text = read(relative);
  const a = text.indexOf(first);
  const b = text.indexOf(second);
  if (a < 0 || b < 0 || a >= b) {
    throw new Error(`启动锁断裂：${relative} 顺序不正确（${first} 必须在 ${second} 之前）\n  原因：${why}`);
  }
  results.push(`${relative}  ✓ ${why}`);
}

/* ── A：核心容器 sha256 缓存（BundledCore.ets）────────────────────────── */
must('hostruntime/src/main/ets/core/BundledCore.ets', 'preverifyBundledCore',
  'A 层：安装期/启动前预校验必须还在（命中缓存就跳过 208MB 全量哈希）');
must('hostruntime/src/main/ets/core/BundledCore.ets', 'archiveCacheKey',
  'A 层：缓存键必须仍由安装批次 + 文件 stat 指纹生成');
must('hostruntime/src/main/ets/core/BundledCore.ets', 'readArchiveCache',
  'A 层：读缓存入口必须还在');
must('hostruntime/src/main/ets/core/BundledCore.ets', 'writeArchiveCache',
  'A 层：写缓存入口必须还在');

/* ── B：启动后延迟 import（pack-core 接线）─────────────────────────────── */
must('tools/lib/post-startup-imports.mjs', "register('dsh-tool-cordis/lib/types/providers.js'",
  'B 层：cordis api-catalog 延迟 import 补丁必须还在');
must('tools/lib/post-startup-imports.mjs', 'webConverter()',
  'B 层：turndown 必须仍是首用才初始化');
must('tools/lib/post-startup-imports.mjs', 'await import("fflate")',
  'B 层：fflate 必须仍是首用才加载');
must('tools/pack-core.mjs', 'patchPostStartupImports(STAGE)',
  'B 层：pack-core 必须在打包期应用延迟 import 补丁');
must('tools/lib/post-startup-imports.mjs', 'Review upstream import and first-use behavior',
  'B 层：上游漂移必须 die，不许静默跳过');

/* ── C：前台 64ms 端口轮询 + 监听回调（NodeRuntime.ets）───────────────── */
must('hostruntime/src/main/ets/runtime/NodeRuntime.ets', 'FOREGROUND_READY_POLL_INTERVAL_MS: number = 64;',
  'C 层：前台端口等待必须仍是 64ms（250ms 会重新拖慢启动尾段）');
must('hostruntime/src/main/ets/runtime/NodeRuntime.ets', 'setStartupListeningCallback',
  'C 层：端口监听回调必须还在（壳层用它打 DSHM-TRACE）');

/* ── D：启动期仪表 + 锁快扫（main.js）─────────────────────────────────── */
must('hostcore/app/main.js', "const DSHM_BOOT_RING_ON = process.env.DSHM_BOOT_RING !== '0';",
  'D 层：启动期同步环必须默认开启（否则 SYNC-COUNT 归因永远测不到）');
must('hostcore/app/main.js', 'recoverOrphanLocks(HOME_DIR, 4000)',
  'D 层：启动路径必须只做 4000 项快扫（完整巡检放 host-ready 之后）');

/* ── E：用户安装 bundle 延迟挂载 ───────────────────────────────────────── */
must('hostcore/app/dshm-deferred-bundles.js', 'function collectInsertRows',
  'E 层：必须只延迟「纯 insert」bundle（有 id 覆盖的保持同步，不改语义）');
must('hostcore/app/dshm-deferred-bundles.js', 'dsh.profile.bundles',
  'E 层：必须从 dsh.profile.bundles 移出用户 bundle');
must('hostcore/app/dshm-deferred-bundles.js', 'dependencies',
  'E 层：必须保留 dependencies（插件页/卸载仍要认得已安装）');
must('hostcore/app/dshm-deferred-bundles.js', 'writeJsonAtomic',
  'E 层：清单必须原子写（半截 JSON 会让下次启动丢延迟计划）');
must('hostcore/app/main.js', "require('./dshm-deferred-bundles.js')",
  'E 层：main.js 必须接上延迟清单生成器');
must('hostcore/app/main.js', 'const profileInfo = ensureProfile();',
  'E 层：main.js 必须拿到 profile 目录/种子 bundle 清单');
must('hostcore/app/main.js', 'return { dir: dest, seedBundles };',
  'E 层：ensureProfile 必须返回 seedBundles（用于区分用户 bundle）');
order('hostcore/app/main.js', 'deferredBundles.deferUserBundles(profileInfo.dir', 'profileBoot.runProfile(',
  'E 层：延迟清单必须在 runProfile **之前**生成（否则 loader 已经同步加载完用户 bundle）');
must('hostcore/plugins/dshm-boot-extras/lib/index.js', "const DEFERRED_FILENAME = '.dshm-deferred-bundles.json';",
  'E 层：boot-extras 必须读同一份清单文件名');
must('hostcore/plugins/dshm-boot-extras/lib/index.js', 'function readDeferredManifest()',
  'E 层：boot-extras 必须自动读清单（不是只吃 profile 里的静态空数组）');
must('hostcore/plugins/dshm-boot-extras/lib/index.js', 'loader.create(options)',
  'E 层：延迟行必须走真实的 ctx.loader.create()');
must('hostcore/profile/ondevice/cordis.patch.yml', 'autoDeferUserBundles: true',
  'E 层：profile 种子必须默认开启自动延迟（关掉等于这轮优化白做）');
must('hostcore/profile/ondevice/cordis.patch.yml', 'delayMs: 3000',
  'E 层：延迟起点必须仍是 3000ms（太短会抢宿主/首屏 CPU）');
must('tools/place-host-app.mjs', "'dshm-deferred-bundles.js'",
  'E 层：新 Host 模块必须进 HSP 打包清单（漏了就是静默白修）');
must('tools/assert-resfile-sync.mjs', "'dshm-deferred-bundles.js'",
  'E 层：resfile 快照门禁必须覆盖新模块');

/* 种子 profile 只放核心 bundle；用户 bundle 由安装器写设备侧 package.json。 */
{
  const seed = JSON.parse(read('hostcore/profile/ondevice/package.json'));
  const bundles = seed?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) {
    throw new Error('启动锁断裂：种子 profile 的 dsh.profile.bundles 不是数组');
  }
  for (const core of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
    if (!bundles.includes(core)) {
      throw new Error(`启动锁断裂：种子 profile 缺少核心 bundle ${core}`);
    }
  }
  if (bundles.includes('dshmarket')) {
    throw new Error('启动锁断裂：dshmarket 又回到了种子 dsh.profile.bundles'
      + '（用户 bundle 必须由设备侧清单延迟挂载，不能随种子同步加载）');
  }
  results.push('hostcore/profile/ondevice/package.json  ✓ 种子只含核心 bundle，用户 bundle 不入种子');
}

/* ── F：移动端「在文件夹显示」桥（客户端补丁）─────────────────────────── */
must('tools/lib/open-in-app-reveal.mjs', '__dshmRevealBridge',
  'F 层：客户端 reveal 必须识别壳层 openFileLocation 桥');
must('tools/lib/open-in-app-reveal.mjs', "PATCHED = '",
  'F 层：补丁后 sha256 必须钉死（上游漂移要 die）');
must('tools/pack-core.mjs', 'patchOpenInAppReveal(STAGE)',
  'F 层：pack-core 必须在打包期应用 reveal 补丁');
must('platform/src/main/ets/system/FilePreview.ets', 'com.huawei.hmos.files',
  'F 层：移动端 reveal 必须走系统「文件」App（DocumentViewPicker 只能选不能看）');
must('platform/src/main/ets/system/FilePreview.ets', 'fileUri',
  'F 层：Files App 的定位参数必须是 fileUri（传文件 URI 才会打开父目录并列出文件）');

/* ── 构建/安装链 ───────────────────────────────────────────────────────── */
must('tools/build-beta.mjs', 'function resignArtifact',
  'beta 侧载件必须用 signing/debug 重签（否则设备 9568322 装不上）');
must('tools/build-beta.mjs', 'BETA_SIGN_P12',
  'beta 重签必须指向 signing/debug 的 P12（与 BETA_PROFILE 的证书同源）');

console.log(`✅ 启动提速锁通过：${results.length} 条接线断言全绿`);
console.log('   覆盖 A sha256 缓存 / B 延迟 import / C 64ms 轮询 / D 仪表+锁快扫 / E 用户 bundle 延迟 / F 移动端 reveal');
console.log('   详细规则见 JD/DSHM-启动提速-经验与护栏-20261126.md');
