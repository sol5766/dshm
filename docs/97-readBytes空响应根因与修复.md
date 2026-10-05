# 97 · workspaceFiles/readBytes 空响应根因与修复（2026-10-05）

> 症状：侧边栏打开图片 / PDF / HTML 一律"读取失败：client api: workspaceFiles/readBytes failed: Failed to fetch"。
> 时间线：最后一次成功 2026-10-04 14:17；第一次空响应 2026-10-05 12:27（本地）。

## 1. 根因（一句话）

宿主**纯 JS undici 垫片** `hostcore/app/fetch-shim.js` 的 `DshmResponse` **不认 `new Response(FormData)`**。
上游 `dsh-client-connection` 在 RPC 结果带 attachments（`Uint8Array`）时正是这样构造响应，而 `readBytes` 的 `data` 就是 `Uint8Array`
（`dsh-api-gateway` 的 `encodeRuntimeResult` 把结果里**任何** `Uint8Array` 一律转 attachment，**无大小阈值**）⇒ **只有它**必然踩中；
其余端点都走 `Response.json()`。垫片把 FormData 原样交给 `bridge()` 的 `for await`/`res.write` ⇒ `ERR_INVALID_ARG_TYPE`
⇒ `dsh-host-webserver` 的 catch-all 见 `headersSent` 已真即 `res.destroy()`（一个字节都没 flushed）⇒ 客户端 `net::ERR_EMPTY_RESPONSE(-324)`。

## 2. 证据链

| 证据 | 位置 | 内容 |
|---|---|---|
| **决定性** | ArkWeb 日志 `node-output.log` | `FinalUrlRequestOccursError netCode:ERR_EMPTY_RESPONSE(-324)`，`resourceType:13` = XHR/fetch。**是 EMPTY_RESPONSE 而非 ERR_ABORTED ⇒ 连接由服务端关闭**，客户端 AbortSignal 没动。此一条同时否掉"客户端 abort"与"`[dshm-link]` 包装器"两个怀疑方向 |
| 客户端 | `files/diag-web-console` | 只有 `readBytes` 出现 `fetch fail`（11–26 ms）；`read/stat/list/canOpenWorkspacePath` 全 200 |
| 宿主 | `files/dshm-host.log` | `IN-REQ readBytes` → 几 ms 后 `IN-ABORT`；`IN-DONE … readBytes` 一度**出现 0 次** |
| 桥与兜底 | `dsh-client-connection/lib/index.js`、`dsh-host-webserver/lib/index.js`、`main.js` | `writeHead`→`for await`→`res.write`；`headersSent ⇒ res.destroy()`；`res.on(close) && !writableFinished ⇒ IN-ABORT` —— 三者正好拼出"IN-REQ 后几 ms IN-ABORT + 客户端空响应" |
| 时间线 | `b4bdcb5`（10-05 11:42） | 引入 `installInternalUndiciShim()` 后，`globalThis.Response/FormData/Blob` 由 **Node 原生实现**变成**我们的垫片类**。此前 `new Response(FormData)` 是对的 ⇒ 最后一次成功 10-04、第一次失败 10-05 12:27（该 commit 首次装机冷启动） |

本地对照复现（严格照抄 上游 `fullResponse` + `bridge` + webserver catch-all + 垫片）：

```
修复前： bridge 抛出：TypeError: The "chunk" argument must be of type string or an instance of
         Buffer or Uint8Array. Received an instance of Array                       ← 体是 ["bytes-0", Blob]
         客户端侧： ECONNRESET socket hang up                                     ← 真机为 ERR_EMPTY_RESPONSE(-324)
```

## 3. 修复（最小改动，1 个文件）

- `hostcore/app/fetch-shim.js` 的 `DshmResponse` 增加三支：
  1. `FormData` ⇒ 编 multipart 字节流 + 带 boundary 的 `content-type`；
  2. `Blob/File`（原生，**同一族隐患**）；
  3. **兜底**：任何非流体退化为 UTF-8 文本 —— 保证再也不可能把"非字节流"交给 `bridge` 的 `for await`/`res.write`。
- `DshmFormData._encode(boundary?)` 支持传入 boundary：响应方向必须"**先定 content-type、后编体**"（`bridge` 正是先 `writeHead` 再读体）；缺省仍自生成 ⇒ 请求方向行为不变。
- **未动核心树** ⇒ 不需要升 `coreVersion`、不需要 `pack-core`。
- 门禁：`tools/check-internal-undici.mjs` 新增判定⑤ `responseBody` + 4 条自用用例（14/14）。**判别力用对照臂验过**：把 `fetch-shim.js` stash 回旧版，同一条门禁报
  `FAIL … responseBody:"throw:chunk 不是字节：[object Array]"`；修复后 `ok`。

## 4. 真机验证（闭环）

```
[2026-10-05T10:09:04.469Z] IN-REQ  POST /api/workspaceFiles/readBytes
[2026-10-05T10:09:04.503Z] IN-DONE POST /api/workspaceFiles/readBytes 34ms status=200   ← 成功
```

- 计数：`152 / 3 / 149`（REQ/DONE/ABORT）→ `153 / 4 / 149`：**成功 +1、取消零增长**。
- 修前 298 行 `readBytes` 里仅 3 次成功（全在 2026-10-04）。
- 界面：`sample.html` 作为预览标签打开并**直接内联渲染**（用户确认）。

## 5. 影响面（比预览大得多）

这个洞会让**任何带附件的 RPC**（图片上传/下载等）继续空响应 —— 修 `readBytes` 的同时一并修好。
反之，**plan B（ArkTS `readFileAsDataUri` 同步桥）不做** ✗：它只绕开 `readBytes`，垫片这个洞依旧会让带附件的 RPC 空响应。

## 6. 教训

1. **"修 abort"的思路从一开始就是错的**：症状（取消计数 100%）与真因（服务端一字未写就关连接）都会表现为"客户端失败"，只有 **ArkWeb 自己的错误码**（`EMPTY_RESPONSE` vs `ERR_ABORTED`）能区分主被动方 —— 先看错误码，再谈改谁。
2. **垫片要按"上游真实用法"建用例**：上游用 `new Response(FormData)` 传附件，我们的垫片只实现了 4 种体 ⇒ 门禁必须覆盖"体形态"，而不是只覆盖"接口存在"。
3. **"以前是好的"要对着时间线找那个 commit**：本次`b4bdcb5`（引入内部 undici 垫片）与故障起点"首次装机冷启动"精确对齐 ⇒ 一步定位。
4. **`DSHM_DOC_LOAD_DEDUP` 是无效补丁（**已于 `coreVersion` +dshm.6 撤除**）**：它治的是不存在的病（面板自持 abort + 去重）。其中"失败后清去重键"一行落在 `if (started…) return` 之后，是**死代码**（失败后同键不会自动重试）。撤除方式：`tools/pack-core.mjs` 的 `dedupDocumentLoad()` 定义与调用点整段删除（不靠幂等跳过），`hostcore/core-recipe.json` 的 `coreVersion` 升到 `0.2.1-alpha.1+dshm.6` 让端侧换树；`tools/check-core-openharmony-patches.mjs` 新增 **1 处撤除守卫**（`DSHM_DOC_LOAD_DEDUP`/`dshmLoadKeyRef`/`dshmAbortRef`/`dshmSignal` 必须 **0 处**，且三个加载调用点必须回到上游的 `signal` 形态）—— 防止它被重新注入。

## 7. 当时的另一个改动（同批）

自带插件 `@deepseek-ai/dshm-office-system-preview` 的认领收窄为 **Office-only 9 项**（doc docx ppt pptx xls xlsx odt ods odp）：
图片/PDF/HTML/表格/SVG **交回上游内联渲染器**。此前把它们认领成 `text-pages`，导致"跨进程取字节"那条路**永远不被走到** ——
既拿不到内联，也**掩盖**了本根因（取消计数停留在旧值上，看起来像"客户端在 abort"）。同时去掉 `ico` 越界认领（系统 PreviewKit 与 `hipreview` 都不支持）。
