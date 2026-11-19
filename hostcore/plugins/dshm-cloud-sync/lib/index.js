/**
 * DSHM 云同步插件 —— 宿主半边。
 *
 * 【为什么几乎是空的】本插件的能力全部在**浏览器半边**（`lib/client.js` 注册设置分区）
 * 与 **ArkTS 原生侧**（登录/扫描/上传/导入）。宿主进程不需要参与，所以这里只导出一个
 * 最小的 `apply()`，作用是把插件挂进 cordis 生命周期。
 *
 * 【为什么必须导出 `name`】与 `@deepseek-ai/dshm-office-system-preview` 同一契约：
 * cordis 的行需要知道插件名。两处都要有 —— 导出的 `name` 与 package.json 的包名一致。
 *
 * ── 【2026-10-30 关键修正：ESM 而不是 CJS】────────────────────────────
 * 本包 `package.json` 是 `"type": "module"`，所以本文件按 **ESM** 解析。
 * 上一版写的是 CommonJS 的 `exports.apply = apply` —— 在 ESM 里 `exports` 只是
 * **未定义的普通变量**，赋值**静默失败**（不是语法错误，Node 不报错），
 * 于是 `import()` 拿到的是**空模块**（`Object.keys()` 为 `[]`）。
 *
 * 后果链：cordis 拿不到 `apply` ⇒ 插件行**从未被构造** ⇒
 * `dsh-client-modules` 扫描"活跃 Loader entries"时看不到它 ⇒
 * client bundle 不进加载图 ⇒ 设置面板里**永远不会出现**「云同步」分区。
 * 这也是前面所有配置检查都通过、却始终看不到分区的真正原因。
 *
 * **证据**（真机实测，同日）：
 * ```text
 * import('./lib/index.js') → []
 * office 插件同一调用      → ['apply', 'name']
 * ```
 *
 * @module dshm-cloud-sync
 */

/** 插件名（与 package.json 的包名逐字一致；与 office 插件同款导出）。 */
const name = '@deepseek-ai/dshm-cloud-sync';

/**
 * 宿主侧无操作：本插件不需要宿主参与。
 *
 * 【为什么仍然要 export 它】cordis 按 `apply` 构造插件；没有它就等于没这个插件。
 * 留空是**有意的**：能力在浏览器半边与 ArkTS 桥里，宿主不需要任何行为。
 */
function apply() {
  /* 有意留空：能力在 client.js 与 ArkTS 桥里。 */
}

export { apply, name };
