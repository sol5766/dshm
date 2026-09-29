'use strict';

/**
 * 【P1-3（2026-09-28）】兼容性豁免通道（端侧可达的 `dsh plugin allow-version`）。
 *
 * 【为什么需要这个文件】0.2.0-rc.1 起，上游对 peerDependencies 里锁 `@deepseek-ai/dsh`
 * 0.1.x 的插件会**拒绝挂载**，并给出唯一出路：grant the exact-version exemption with
 * `dsh plugin allow-version` or the plugin manager。端侧两条路都是死的：
 *   · `dsh` 假壳只实现了 `plugin install` / `plugin remove`（无 allow-version）；
 *   · 插件管理器恰好就是那个被跳过的插件（鸡生蛋）。
 * 于是用户面对"插件被静默跳过"没有任何自助手段，只能等作者适配。
 *
 * 【为什么是"薄封装"而不是自己实现一份】豁免存储机制上游本来就有，且是
 * **先于任何插件加载**读取的（core `@deepseek-ai/dsh-app-boot` 的
 * `PROFILE_COMPATIBILITY_FILENAME = "compatibility.json"`，读 profile 目录）。
 * 自己按 schema 写文件的风险：格式细节（精确版本校验、`isVersionList`、
 * 坏记录跳过但保留其余、`rewritable` 语义）一旦偏离，上游会**静默不认**——
 * 用户以为授予了、实际仍被跳过，比没有通道更难排查。所以这里直接
 * `import()` 上游那三个导出，把"写"这件事完全交给它：
 *   · `getDshRuntimeVersion()`   —— 当前运行时版本（= app-boot 包自身版本）
 *   · `readProfileCompatibility()` —— 读（含 warnings / rewritable）
 *   · `setProfileVersionExemption()` —— 校验 + 文件锁 + 原子写
 * 上游自带的三道闸一并继承：`enabled && !acceptRisk` 必须显式确认风险；
 * `runtimeVersion !== current` 拒绝（防止批准一个当前根本没在跑的版本）；
 * 文件被读坏（`rewritable === false`）时拒绝改写（改写会丢掉用户内容）。
 *
 * 【为什么单独成文件（与 dshm-skills.js 同因）】main.js 末尾是
 * `start().catch(...)`，require 它会真起一个 Host ⇒ 那些逻辑在 PC 侧无法回归。
 * 本文件只依赖 node:path / node:url 与 `opts.appBoot`（可注入），
 * 因此 tools/check-compat-exemption.cjs 能对"授予/撤销/拒绝"的全部分支做断言。
 *
 * 【profile 目录从哪来】调用方给（队列的 `.dir` 优先，否则宿主 PROFILE）。
 * 与安装通道同源：市场的 profile 可能是 `web` 而非宿主 `ondevice`，写错目录
 * 等于没授权。
 */

const path = require('node:path');
const { pathToFileURL } = require('node:url');

/** 与上游同名同值：profile 目录下的豁免文件名（不要另起名字）。 */
const COMPAT_FILENAME = 'compatibility.json';

/** coreDir → app-boot 模块。同一个 coreDir 只 import 一次（ESM 本身也会缓存）。 */
const appBootCache = new Map();

/**
 * 解析 `<包名>@<精确版本>`。作用域包（`@scope/name@1.0.0`）取**最后一个** `@`，
 * 与上游 `validatePluginVersionExemption` 的 `lastIndexOf("@")` 口径一致。
 * 只做"有没有两半"的形状判定，精确性（是否 canonical semver）交给上游。
 */
function splitPackageVersion(token) {
  if (typeof token !== 'string') {
    return null;
  }
  const trimmed = token.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) {
    return null;
  }
  return { name: trimmed.slice(0, at), version: trimmed.slice(at + 1) };
}

function requireCoreDir(opts) {
  const coreDir = opts && typeof opts.coreDir === 'string' ? opts.coreDir : '';
  if (coreDir.length === 0) {
    throw new Error('缺少 coreDir（或注入 appBoot），无法加载上游 dsh-app-boot 的豁免实现');
  }
  return coreDir;
}

/**
 * 动态 import 核心树里的 `@deepseek-ai/dsh-app-boot`（豁免 API 的来源）。
 * 与 main.js 起 profile 时用的是同一个模块实例（ESM 缓存），不额外付费。
 */
async function loadAppBoot(coreDir) {
  const cached = appBootCache.get(coreDir);
  if (cached !== undefined) {
    return cached;
  }
  const entry = path.join(coreDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
  const mod = await import(pathToFileURL(entry).href);
  appBootCache.set(coreDir, mod);
  return mod;
}

async function appBootOf(opts) {
  const o = opts || {};
  if (o.appBoot) {
    return o.appBoot;
  }
  return await loadAppBoot(requireCoreDir(o));
}

/** 读 profile 的豁免表（不加载任何插件，坏文件不抛错而是带 warnings 返回）。 */
async function readCompat(profileDir, opts) {
  const appBoot = await appBootOf(opts);
  return appBoot.readProfileCompatibility(profileDir);
}

/**
 * 授予/撤销一条**精确版本**豁免。
 *
 * `runtimeVersion` 留空 ⇒ 用当前运行时（`getDshRuntimeVersion()`）。这让端侧命令
 * `dsh plugin allow-version <pkg@ver> --accept-risk` 不必知道运行时版本号，
 * 同时保持"批准的必须是当前正在跑的那个版本"这条上游约束不被绕过。
 */
async function setExemption(profileDir, packageVersion, runtimeVersion, enabled, acceptRisk, opts) {
  const appBoot = await appBootOf(opts);
  const runtime = typeof runtimeVersion === 'string' && runtimeVersion.trim().length > 0
    ? runtimeVersion.trim()
    : appBoot.getDshRuntimeVersion();
  const on = enabled !== false;
  await appBoot.setProfileVersionExemption(profileDir, packageVersion, runtime, on, acceptRisk === true);
  const after = appBoot.readProfileCompatibility(profileDir);
  return {
    packageVersion,
    runtimeVersion: runtime,
    enabled: on,
    exemptions: after.exemptions,
    warnings: after.warnings,
    rewritable: after.rewritable,
  };
}

/**
 * 豁免表的人类可读摘要（启动日志与 UI 都用它，避免两处各写一套措辞）。
 * 空表 ⇒ `''`（调用方据此不打印）。
 */
function describeCompat(state) {
  const exemptions = state && state.exemptions ? state.exemptions : {};
  const keys = Object.keys(exemptions).sort();
  if (keys.length === 0) {
    return '';
  }
  return keys.map((k) => {
    const versions = Array.isArray(exemptions[k]) ? exemptions[k] : [];
    return k + ' → dsh ' + versions.join('、');
  }).join('；');
}

/**
 * 队列入口：处理一条 `.compat-req` 的 JSON 载荷。
 *
 * 【契约与安装通道一致：**绝不抛错**】失败走返回值 `{ok:false, error}`，
 * 由 main.js 的队列段写成 `.fail`（假壳/UI 读回）。抛错会让"一次坏请求"
 * 变成"轮询异常"，请求方只能等到超时。
 */
async function applyRequest(req, opts) {
  const o = opts || {};
  const log = typeof o.log === 'function' ? o.log : function () {};
  try {
    const profileDir = typeof o.profileDir === 'string' && o.profileDir.length > 0 ? o.profileDir : '';
    if (profileDir.length === 0) {
      return { ok: false, error: '缺少 profileDir（无法确定把豁免写进哪个 profile）' };
    }
    if (req === null || typeof req !== 'object' || Array.isArray(req)) {
      return { ok: false, error: 'compat 请求必须是对象（含 packageVersion / acceptRisk）' };
    }
    // 只读动作：`dsh plugin version-exemptions` 与设置页刷新都走它。
    // 【为什么也要过队列】读的必须是**同一个** profile 目录（市场可能操作 web profile，
    // 而非宿主 ondevice）——"读 A、写 B"会让用户看到成功的假象。
    if (req.action === 'list') {
      const state = await readCompat(profileDir, o);
      const summary = describeCompat(state);
      log('兼容性豁免清单（' + profileDir + '）：'
        + (summary.length > 0 ? summary : '空')
        + (state.rewritable ? '' : '（文件不可改写，需先修复）'));
      return {
        ok: true,
        action: 'list',
        profileDir,
        exemptions: state.exemptions,
        warnings: state.warnings,
        rewritable: state.rewritable,
      };
    }
    const packageVersion = typeof req.packageVersion === 'string' ? req.packageVersion.trim() : '';
    if (packageVersion.length === 0) {
      return { ok: false, error: '缺少 packageVersion（需 <包名>@<精确版本>，如 dshmarket@1.66.2）' };
    }
    const parts = splitPackageVersion(packageVersion);
    if (parts === null) {
      return { ok: false, error: 'packageVersion 必须是 <包名>@<精确版本>：' + packageVersion };
    }
    const enabled = req.enabled !== false;
    const acceptRisk = req.acceptRisk === true;
    const runtimeVersion = typeof req.runtimeVersion === 'string' ? req.runtimeVersion.trim() : '';
    log((enabled ? '授予' : '撤销') + '兼容性豁免：' + packageVersion
      + (runtimeVersion.length > 0 ? ' @ dsh ' + runtimeVersion : ' @ 当前运行时')
      + (enabled ? (acceptRisk ? '（用户已确认风险）' : '（未确认风险）') : ''));
    const r = await setExemption(profileDir, packageVersion, runtimeVersion, enabled, acceptRisk, o);
    const summary = describeCompat({ exemptions: r.exemptions });
    log('兼容性豁免已写入 ' + path.join(profileDir, COMPAT_FILENAME)
      + '（现存 ' + Object.keys(r.exemptions).length + ' 条'
      + (summary.length > 0 ? '：' + summary : '') + '）');
    return {
      ok: true,
      name: parts.name,
      version: parts.version,
      packageVersion: r.packageVersion,
      runtimeVersion: r.runtimeVersion,
      enabled: r.enabled,
      // 【为什么把 profileDir 回传】这是整条通道最安静的失败点：写错 profile 目录时
      // 上游读不到、插件仍被跳过，而界面只看到"授予成功"。回传落点让 UI 能把它
      // 显示出来（"写入 <目录>"），用户才有可核对的东西。
      profileDir,
      exemptions: r.exemptions,
      warnings: r.warnings,
      note: enabled
        ? '豁免已登记，重启应用后该插件随 profile 挂载生效'
        : '豁免已撤销',
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = {
  COMPAT_FILENAME,
  splitPackageVersion,
  loadAppBoot,
  readCompat,
  setExemption,
  describeCompat,
  applyRequest,
};
