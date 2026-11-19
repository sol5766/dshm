/**
 * dshm-market-patch.cjs —— 「市场刚装完」那一跳的挂载契约补丁**重放**入口。
 *
 * 【为什么要有这份文件（2026-10-14 真机回归）】
 * 皮肤市场（`dsh-skin-market`）的挂载契约补丁由 `tools/pack-core.mjs` 注入核心树
 * profile-boot 的 boot 回调，**启动那一刻**只贴一次（判据本体见
 * `hostcore/plugins/dshm-market-bridge/lib/index.js` 的 `patchMarketCliBranch()`）。
 * 可是市场常常是**启动之后**才装进来的 —— 它就是「设置 → 插件 → 项目地址」里的一个包。
 * 真机 `node-output.log` 留下的原话（唯一证据，12:27:13）：
 *
 *     [dshm-market-bridge] 皮肤市场挂载契约改写：未安装（ENOENT: …/profiles/ondevice/node_modules/dsh-skin-market/lib/index.js）
 *     [dshm-market-bridge] 已接管市场包操作：profile=ondevice，队列=…/dsh/home/install-queue
 *
 * 而市场是 12:35:09 才经安装队列装进来的 ⇒ 落盘的 `dsh-skin-market/lib/index.js` 永远是
 * **上游原形** ⇒ 市场把宿主当官方 Desktop（`hostKind:'desktop'`）⇒ 302 条皮肤里只有 41 条
 * 能一键装、其余一律「需手动安装」，点「使用」还报「请从官方 Desktop 重启应用后生效」。
 * （同一缺陷的首次修复见 docs/129；本次是它的**重放**缺口，见 docs/159。）
 *
 * 【接线位置】`main.js` 的安装队列：`installSpec()` 成功之后、`<queue>/<id>.done` 写出**之前**
 * 调一次。放在 `.done` 之前是有意义的：写入方（市场/假壳）拿到 `.done` 就可能立刻去挂载，
 * 那一刻读到的必须已经是改写过的文件；万一它已经挂载过，改写也仍然落盘、下次冷启动生效
 * （boot 补丁幂等，两处不打架）。
 *
 * 【凭什么这里可以就地改用户的插件文件】与 boot 那处**同一份判据函数**：本文件不自己判断
 * 形状，而是 `import` 核心树里那份自带插件
 * （`<coreDir>/node_modules/@deepseek-ai/dshm-market-bridge/lib/index.js`）的
 * `patchMarketCliBranch`。它自带的那套纪律照旧生效：幂等（目标形态逐字节不写）、锚点唯一才写、
 * 失败一个字节都不写、认得上一代补丁整段并就地升级（不叠加 `const`）。
 *
 * 【两个市场，同一个重放入口（2026-10-14 扩充）】皮肤市场（`dsh-skin-market`）与插件市场
 * （`dshmarket`）都是「设置 → 插件 → 项目地址」里的包，都有**启动之后才装进来**这条时间线，
 * 都需要各自那一份就地改写：前者是挂载契约（`patchMarketCliBranch`），后者是预览图出网
 * （`patchDshmarketThumbs`，见 docs/160）。两处的判据函数都在同一个桥模块里 —— 所以这里也
 * 只留一个重放入口，按「这个 profile 里现在有哪个市场」逐个调；**两份判据各自独立判定**，
 * 一个形状不对不影响另一个（谁该改就改谁，reason 逐项拼出来）。
 * 两个市场都不在 ⇒ 仍然返回 `null`（**连模块都不 import**，调用方保持静默）。
 *
 * 【失败面】任何异常都只变成一行 reason 返回，**绝不抛给安装队列** —— 皮肤市场的挂载契约
 * 与「插件装没装上」是两件事，后者不该被前者带下水。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/** 市场本体在 profile 里的落点（与 `patchMarketCliBranch()` 的取值口径逐字同源）。 */
const MARKET_ENTRY = ['node_modules', 'dsh-skin-market', 'lib', 'index.js'];

/** 插件市场本体在 profile 里的落点（与 `patchDshmarketThumbs()` 的取值口径逐字同源）。 */
const DSHMARKET_ENTRY = ['node_modules', 'dshmarket', 'client', 'client.js'];

/** 桥本体在核心树里的落点（`embedDshmToolPackages()` 的产物）。 */
const BRIDGE_ENTRY = ['node_modules', '@deepseek-ai', 'dshm-market-bridge', 'lib', 'index.js'];

/** 已 import 过的桥模块（按入口路径缓存；ESM 本身也缓存，这里只是省掉 existsSync 之后的重入）。 */
const bridgeCache = new Map();

/** 市场文件路径（导出供门禁与排查对齐口径）。 */
function marketEntryPath(profileDir) {
  return path.join(profileDir, ...MARKET_ENTRY);
}

/** 插件市场文件路径（导出供门禁与排查对齐口径）。 */
function dshmarketEntryPath(profileDir) {
  return path.join(profileDir, ...DSHMARKET_ENTRY);
}

/** 桥模块路径（导出供门禁与排查对齐口径）。 */
function bridgeEntryPath(coreDir) {
  return path.join(coreDir, ...BRIDGE_ENTRY);
}

/** 取桥模块（带缓存；入口文件不存在时不 import，交给调用方返回人话 reason）。 */
async function loadBridge(entry) {
  const hit = bridgeCache.get(entry);
  if (hit !== undefined) return hit;
  const promise = import(pathToFileURL(entry).href);
  bridgeCache.set(entry, promise);
  try {
    return await promise;
  } catch (error) {
    bridgeCache.delete(entry); // 失败不缓存：下次安装还有机会（例如核心树刚换版本）
    throw error;
  }
}

/**
 * 装完一个包之后，重放一次市场挂载契约补丁。
 *
 * @param {string} profileDir 本次安装的落点（安装队列的 `.dir`，缺省为宿主 profile 目录）
 * @param {{ coreDir?: string, entry?: string }} [opts] `coreDir` = 当前已激活的核心树目录；
 *   `entry` 仅门禁/排查用（直接指定桥模块入口，跳过 `coreDir` 拼装）
 * @returns {Promise<null | { ok: boolean, reason: string }>} 两个市场都不在这个 profile ⇒ `null`
 *   （**无事可做**，连模块都不 import，调用方据此保持静默）；其余情况必回一行 reason
 *   （两个市场都在时按「皮肤市场：…；插件市场预览图：…」拼成一行）。
 */
async function replayMarketContractPatch(profileDir, opts) {
  try {
    if (typeof profileDir !== 'string' || profileDir.length === 0) return null;
    const skinHere = fs.existsSync(marketEntryPath(profileDir));
    const dshmarketHere = fs.existsSync(dshmarketEntryPath(profileDir));
    if (!skinHere && !dshmarketHere) return null;
    const o = opts && typeof opts === 'object' ? opts : {};
    const entry = typeof o.entry === 'string' && o.entry.length > 0
      ? o.entry
      : bridgeEntryPath(typeof o.coreDir === 'string' ? o.coreDir : '');
    if (entry.length === 0 || !fs.existsSync(entry)) {
      return { ok: false, reason: `市场已装、但桥模块不在（${entry || '未给 coreDir'}）⇒ 留待下次冷启动` };
    }
    const bridge = await loadBridge(entry);
    // 两个市场**各自独立**：谁在就调谁，谁形状不对就只回谁那一条 reason（不影响另一个）。
    const parts = [];
    let allOk = true;
    if (skinHere) {
      if (typeof bridge.patchMarketCliBranch !== 'function') {
        return { ok: false, reason: `桥模块没有 patchMarketCliBranch 导出（${entry}）` };
      }
      const result = bridge.patchMarketCliBranch(profileDir);
      allOk = allOk && Boolean(result && result.ok);
      parts.push(`皮肤：${result && typeof result.reason === 'string' ? result.reason : ''}`);
    }
    if (dshmarketHere) {
      if (typeof bridge.patchDshmarketThumbs !== 'function') {
        return { ok: false, reason: `桥模块没有 patchDshmarketThumbs 导出（${entry}）` };
      }
      const result = bridge.patchDshmarketThumbs(profileDir);
      allOk = allOk && Boolean(result && result.ok);
      parts.push(`插件市场预览图：${result && typeof result.reason === 'string' ? result.reason : ''}`);
    }
    return {
      ok: allOk,
      // 只装了一个市场时 reason 与老形态**逐字一致**（不加前缀）—— 老日志与老断言因此照旧可读。
      reason: parts.length === 1
        ? parts[0].replace(/^(?:皮肤|插件市场预览图)：/, '')
        : parts.join('；'),
    };
  } catch (error) {
    return { ok: false, reason: `重放异常（${error && error.message ? error.message : error}）` };
  }
}

module.exports = {
  BRIDGE_ENTRY,
  DSHMARKET_ENTRY,
  MARKET_ENTRY,
  bridgeEntryPath,
  dshmarketEntryPath,
  marketEntryPath,
  replayMarketContractPatch,
};
