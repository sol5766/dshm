/**
 * DSHM 端侧的 **Office 系统预览** 插件（宿主半边）。
 *
 * ── 为什么需要它（缺口的事实，已核实）──────────────────────
 * · 上游内置 office 预览的实现只认四个后缀，且**只走宿主转换**：
 *   `@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js:5651-5656`
 *   `const id = ".../office"; const extensions = ["doc","docx","ppt","pptx"];`
 *   `let read = unavailable;`（`:5652` 就是那个恒 reject 的桩），
 *   真正的读只在
 *   `:5700 ctx.inject(["remote","remote.officeToPdf","remote.workspaceFiles"], …)`
 *   完备后才被换上——而 `remote.officeToPdf` 端侧从未注册。
 * · 提供 `remote.officeToPdf` 的宿主路由是 `dsh-office-to-pdf` → `libreoffice-kit`，
 *   它的引擎解析在 `@deepseek-ai/libreoffice-kit/lib/index.js:1267 resolveEngine()`
 *   只认 darwin / win32 / linux（`platformTarget()` `:1241-1246`），
 *   其余一律 `:1288 throw new Error(\`Unsupported LibreOfficeKit host: ${platform}-${arch}\`)`
 *   ⇒ 在 openharmony-arm64 上**结构性不可达**，不是配置问题。
 * · 结果：侧边栏打开 doc/docx/ppt/pptx 时选中内置 office 实现，
 *   正文恒为 `Office 预览不可用。请在运行 DeepSeek Harness 的主机上启用文档预览服务。`
 *   （zh 字典 `:5112`，ns `sidebarOffice`）——用户看到的就是这个。
 * · 而 `Platform/PreviewKit`（`platform/src/main/ets/system/FilePreview.ets`）
 *   真机实测可用：`diag-office-probe` 对 docx/doc/pptx/ppt/xlsx/csv/pdf 全绿，
 *   系统预览窗能弹出（`diag-file-preview ok …`）。缺的只是**侧边栏把它接上**。
 *
 * ── 本插件做什么 ──────────────────────────────────────────
 * · 宿主半边**什么都不做**（纯 UI 插件）。浏览器半边见 `lib/client.js`：
 *   注册一个 `documentPreviews` 定义认领这四个后缀（外部实现带优先于 `builtin`），
 *   正文与工具栏各给一个「用系统预览打开」的入口，经 ArkTS 桥
 *   `__DSHM_BRIDGES__.openFilePreview(path)` 调 PreviewKit。
 * · 与 open-in-app 同构：空的 `apply` 只是为了让本包出现在宿主 cordis.yml / Loader 里；
 *   浏览器半边通过 `package.json` 的 `dsh.client` + `exports["./client"]` 被发现。
 *
 * ── 纪律 ──────────────────────────────────────────────────
 * · **不改上游 dsh、不新增权限、不碰任何既有目录**。
 * · **绝不阻断启动**：`apply()` 是同步空体，不读环境变量、不建文件、不联网。
 * · 只认领 `doc/docx/ppt/pptx`。`xls/xlsx/csv/tsv` 归内置 Excel
 *   （纯客户端实现，端侧本来就正常），认领会把它顶掉。
 *
 * @module dshm-office-system-preview
 */

/** Loader 条目的诊断名（与 cordis.patch.yml 里的 `id` 一致）。 */
const name = "dshm-office-system-preview";

/** Host plugin body — no host-side behavior for this surface plugin. */
function apply() {}

export { apply, name };
