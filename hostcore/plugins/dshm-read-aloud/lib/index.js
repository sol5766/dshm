/**
 * DSHM 原生朗读/分享插件 —— 宿主半边（有意为空）。
 *
 * 【为什么存在】cordis 按 `apply` 构造插件；没有它，插件行不会进入 Loader，
 * 浏览器半边也不会进 client bundle。能力全部在 `lib/client.js`（动作条入口）
 * 与 ArkTS 桥（`__DSHM_BRIDGES__.readAloud / shareText`）里。
 *
 * 【为什么用 ESM】package.json 是 `"type": "module"`；CommonJS 的
 * `exports.apply = apply` 在 ESM 里会静默失败（docs/319 的真机事故）。
 *
 * @module @deepseek-ai/dshm-read-aloud
 */

/** 插件名（与 package.json 的包名逐字一致）。 */
const name = '@deepseek-ai/dshm-read-aloud';

/**
 * 宿主侧无操作：朗读/分享都在浏览器半边与 ArkTS 桥。
 */
function apply() {
}

export { apply, name };
