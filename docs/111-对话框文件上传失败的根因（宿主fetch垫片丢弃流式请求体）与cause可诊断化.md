# 111 · 对话框文件上传失败的根因（宿主 fetch 垫片丢弃流式请求体）与 cause 可诊断化

> 用户原话：**「接着先看下这个上传文件报错的问题，你自己也检测一下，双边结合修复这个问题，最后我们再出新的侧载包」**
>
> 输入：仓库外报告 `dshm-upload-failure-report.md`（2026-10-06 22:33–22:45 CST，鸿蒙 PC 档，核心 `+dshm.10`）。
> 它的**证据链全部正确**（服务端确实失败、附件存储自 2026-09-25 起从未写入成功、与中文名/鉴权无关），
> **但结论方向错了**：它把嫌疑钉在 2026-09-26 那次 `DSHM_ATTACHMENT_SANDBOX` 端侧补丁（`link` → `copyFile`）上，
> 并建议"扩 `syncDirectory()` 白名单 / 改 `copyFile`/`chmod` 的 errno 处理"。
> 本轮**双边结合**（报告 + 开发端自查 + 真机受控实验）把真因定到**我们自己的宿主 fetch 垫片**，
> 与那次补丁、与鸿蒙沙箱的 errno 全都无关。
>
> **一句话根因**：`hostcore/app/fetch-shim.js` 的 `DshmRequest` 把**流式请求体一律吞掉**且不设 `body` 属性
> （原注释写着"dsh 的 /api 走 buffered 模式，用不到"）；而全仓**唯一**的 `streaming` 路由
> `/api/session/uploadFileBinary`（对话框上传文件）正是靠 `request.body` 拿字节 ⇒
> 处理器在 `undefined.getReader()` 上抛 TypeError ⇒ 被上游包成 `ATTACHMENT_WRITE_FAILED`，
> **真因在报文里被吃掉**，于是症状与"沙箱禁止写文件"逐字相同。

---

## 1 结论先行

| # | 事实 | 判据 |
|---|---|---|
| 1 | 失败点**不在**任何 fs 系统调用上 | 同进程内（Python 桥，**宿主进程内嵌 CPython**、同一 uid、同一挂载）把 `mkdir`/`chmod`/`open(O_CREAT\|O_EXCL\|O_WRONLY,0600)`/`write`/`fsync`/`close`/`copyFile`/`chmod 0400`/`unlink`/`fsync(parent)` **逐项全绿**（§3.3） |
| 2 | 也**不在** 2026-09-26 的 `link`→`copyFile` 补丁上 | 见事实 3：失败发生在**发布之前**（`file-objects/` 从未被创建），补丁改的两处发布点根本还没走到 |
| 3 | 失败发生在**暂存阶段**（stage），不是发布阶段 | 受控实验：一次上传后只有 `attachments/v1/tmp` 的 mtime 变了（`file-objects/`、`files/`、`objects/` 全无变化）⇒ 暂存文件被建出来又删掉了（§3.2） |
| 4 | 真因是**请求体在到达处理器前就没了** | `requestBodyChunks(request.body)` 拿到 `undefined`；`DshmRequest` 收到的是 `ReadableStream`（日志 `DSHM-REQDIAG body kind=object:ReadableStream bodyNull=true`）却没有把它放到 `body` 上（§4） |
| 5 | 影响面 = **全平台**（不是鸿蒙特有） | 垫片在 `--jitless` 下**必然**接管 `Request`（原生 fetch 依赖 WASM，jitless 下 `WebAssembly is not defined`）⇒ PC / 手机 / 平板 一样中招 |

---

## 2 双边结合：报告给了什么、开发端补了什么

| 环节 | 来源 | 结论 |
|---|---|---|
| 复现与"服务端确实失败" | 报告 §1 | `curl` + ASCII 文件名 + `application/octet-stream` 也得到 `{"ok":false,…,"reason":"ATTACHMENT_WRITE_FAILED"}` ⇒ 与浏览器、与中文名无关 |
| 存储从未写入成功 | 报告 §1（本轮复验） | `attachments/v1/objects/77/7777bc6e…`（769,662 B，mtime **2026-09-25 17:31**，应用首日）是唯一对象；`tmp/` 空；`file-objects/`、`files/` **根本不存在** |
| 失败阶段 | **开发端新增（受控实验）** | 见 §3.2 —— 一次上传 ⇒ 只有 `tmp` 的 mtime 变化 ⇒ 死在**暂存**（发布前） |
| 是不是 errno/沙箱 | **开发端新增（Python 桥探针）** | 见 §3.3 —— 同一进程里这些 syscall 全部成功 ⇒ **不是 errno** |
| 真因 | **开发端新增（代码对照）** | 见 §4 —— `DshmRequest` 丢掉流式体 |

> 报告 §4 的建议（把 `cause` 打出来）**方向是对的**，本轮也照做了（§5.2）；但真因不必等那一步 ——
> 报告的证据（"**只有 tmp 变、file-objects 从没出现**"）已经把失败阶段锁死在暂存之前，
> 而暂存阶段里**唯一**与 fs 无关、只在 Node 层可能消失的东西就是**请求体本身**。

---

## 3 开发端自查（三个实测）

### 3.1 读数的通道（为什么不能用 `hdc shell`）

`~/dsh/home` 是 `0700`（owner = 应用 uid `20020292`），`shell` 用户读不到：

```
$ hdc shell ls -la .../entry/files/dsh/home/attachments
ls: ... Permission denied
```

⇒ 一切"存储里到底有什么"的读数都走**应用自身的 Python 桥**（`GET /dshm-python/run-get?token&code`，
token 取 `dshm-host.log` 里最后一条 `dsh web: …token=`；`hdc fport tcp:3120 tcp:3120`）。
这本来就是 `AGENTS.md`「真机读数的三个坑」第 3 条的做法。

### 3.2 受控实验：一次上传到底改了哪个目录

```text
BEFORE                                   AFTER（同一次 curl 上传之后）
v1            D mode=700 mtime=22:43:30  v1            D mode=700 mtime=22:43:30   ← 没变
v1/tmp        D mode=700 mtime=22:40:45  v1/tmp        D mode=700 mtime=22:49:45   ← 变了
v1/objects    D mode=700 mtime 09-25     v1/objects    D mode=700 mtime 09-25      ← 没变
v1/file-objects  MISSING                 v1/file-objects  MISSING                ← 仍然是"不存在"
v1/files         MISSING                 v1/files         MISSING
```

判读：
* `tmp` 的 mtime 变化只有两种可能 —— 里面**建过**一个目录项（然后被删）或**删过**一个；
  `stageImmutableObject()` 的失败清理（`removeTemporary`）正是"建了再删"。
* `file-objects/` 仍然不存在 ⇒ `publishStagedObject()` 的第一句
  `ensureDurableDirectory(parent, …)`（`mkdir -p .../file-objects/<aa>`）**一次都没成功执行**。
  这条同时**排除**了报告怀疑的三个发布期 syscall（`copyFile`/`chmod 0400`/目录 `fsync`）：
  它们在 `mkdir` 之后，而 `mkdir` 连目录都没留下。

⇒ 失败被夹在 `ensureDurableDirectory(staging)` 成功之后、`ensureDurableDirectory(parent)` 生效之前，
即**暂存文件的 open/write/sync/close** 这四步里（或它们的输入）。

### 3.3 Python 桥探针：这些 syscall 在**同一进程**里全是绿的

```text
=== ancestor open/fsync lineage（root = v1，从 v1 一路往上到 /）===
.../files/dsh/home/attachments/v1      open=OK fsync=OK
.../files/dsh/home/attachments         open=OK fsync=OK
.../files/dsh/home                     open=OK fsync=OK
.../files/dsh/home/dsh … /hap/entry    open=OK fsync=OK      ← 沙箱内各级全部可 fsync
/data/storage/el2                      open=FAIL(EACCES)     ← 已由 2026-09-26 补丁白名单放行
/data/storage, /data, /                open=FAIL(EACCES)

=== scratch sequence（逐字复刻 stage/publish 的原语）===
OK   mkdir recursive 0700 / chmod 0700
OK   open tmp 'wx' 0600 / write / fsync / close
OK   copy -> obj / chmod obj 0400 / fsync(parent) / unlink tmp / read back
```

两条硬结论：
1. **沙箱不是问题**：能 fsync 的层级全都成功，不能的只有 `/data/storage/el2` 及以上，
   而这四级**早已**在 `syncDirectory()` 的白名单里（EACCES）⇒ 报告建议的"扩白名单"无处可扩。
2. **errno 不是问题**：`chmod 0400`、`copyFile`、目录 `fsync` 在本机（本档）全部成功。
   ⇒ 既然 syscall 全绿、而流程照样失败，剩下的只能是**我们喂给这些 syscall 的东西**。

---

## 4 真因：垫片把流式请求体吞掉了

### 4.1 这条路由**就是**流式的

```js
// dsh-client-file-upload/lib/index.js:173（服务端注册）
… registerRoute({ … requestBody: "streaming" })

// dsh-client-connection/lib/index.js:75-81（桥：streaming 路由怎么造 Request）
} else request = new Request(url, {
	method, headers,
	body: Readable.toWeb(req),          // ← 请求体是一条文流
	signal: abort.signal,
	duplex: "half"
});

// dsh-client-file-upload/lib/index.js:28（处理器怎么拿字节）
data: requestBodyChunks(request.body),   // ← 唯一的读点
// :56  async function* requestBodyChunks(body) {
//       if (body === null) return;
//       const reader = body.getReader();      ← body 是 undefined 时在这里炸
```

本轮用 `rg` 核过：**全核心树只有这一条** `requestBody: "streaming"` 路由（其余全是 `buffered`）。
换言之，这个洞的影响面 = 附件上传这一个功能，且**从垫片存在那天起就一直是坏的**。

### 4.2 垫片恰好在这一处不保真

```js
// hostcore/app/fetch-shim.js（**修复前**）
const raw = init.body;
if (raw === undefined || raw === null) this._body = null;
else if (Buffer.isBuffer(raw)) this._body = raw;
…
else this._body = null;   // 流式 body 不支持：dsh 的 /api 走 buffered 模式，用不到   ← 这句是错的
```

* 类里**没有任何** `body` 属性 ⇒ 处理器读到 `undefined`（不是 `null`，所以连
  `if (body === null) return` 这道兜底都躲过了，直接掉进 `undefined.getReader()`）。
* 而这句注释的推理错误在于：`buffered` 是**绝大多数**路由的形态，但**不是全部** ——
  附件上传恰恰是那条例外，而且它是**唯一**一条。

### 4.3 症状为什么长得像"沙箱禁止落盘"

`TypeError: Cannot read properties of undefined (reading 'getReader')` 在
`stageImmutableObject()` 的 `for await (const chunk of data)` 上抛出 ⇒ 该函数的 `catch`：
先 `removeTemporary(temporary)`（**tmp 目录项建了又删 —— 正是 §3.2 读到的现象**），
再 `throw new AttachmentError("Unable to persist attachment.", "ATTACHMENT_WRITE_FAILED", { cause: error })`。
到 `dsh-client-file-upload` 的 `commit()` 只剩 `{ reason: error.code }` ⇒ HTTP 200 + `ATTACHMENT_WRITE_FAILED`。
**cause 全程没落进任何日志**，所以报告的两轮排查都只能对着"落盘失败"这四个字猜。

---

## 5 修法

### 5.1 主修：`DshmRequest` 保住流式体（`hostcore/app/fetch-shim.js`）

```js
else if (typeof raw.getReader === 'function') {   // 鸭子类型：Readable.toWeb 的产物
	this._body = null;
	this._stream = raw;                             // ← 保住
} else this._body = null;
this.body = this._stream;                          // 无体/非流式 ⇒ null（与原生 Fetch 同义）
```

* 判据用**鸭子类型**而不是 `instanceof ReadableStream`：调方给的是 `Readable.toWeb(nodeStream)`，
  与 `encodeRequestBody` 里已有的那把尺子（`typeof body.getReader === 'function'`）保持同一口径。
* `body` 取 `null` 而不是留 `undefined`：原生 Fetch 对"没有体"的请求就是 `null`，
  而 `requestBodyChunks` 的早退判据正是 `body === null`。**不留 undefined 是这条判据的意义所在。**
* 诊断行加一栏 `stream=`：`bodyNull=true` 的两种情形（"流式体保住了" 与 "体被吞了"）
  从此在日志里可区分 —— 这一栏就是本次两周边际成本的直接产物。

### 5.2 加固：⑪b —— 失败 cause 必须进报文（`tools/pack-core.mjs` 新注入）

新增 `patchAttachmentLocalCause()`（与 ⑪ 同文件、独立标记 `DSHM_ATTACHMENT_CAUSE`）：
在 `dsh-attachment-local` 里插入一个助手，并把**三处** `ATTACHMENT_WRITE_FAILED` 抛出点改走它：

```js
function attachmentPersistFailure(error) {
	const code = …error.code…;
	const detail = error instanceof Error ? error.message : String(error);
	const cause = code === "" ? detail : code + ": " + detail;
	console.error("[attachment-local] 落盘失败：" + cause);        // ← 落宿主日志（node-output.log）
	return "Unable to persist attachment. (" + cause + ")";       // ← message 进 HTTP 报文
}
```

* **message** 而不是 details：`commit()` 把 `error.message` 原样放进响应体的 `error.message`，
  用户界面与日志都看得到，且**不改** `code`/`details` 形状 ⇒ 既有口径
  （`session/attachment-invalid` + `reason=ATTACHMENT_WRITE_FAILED`）一字不变。
* 代价可控：只在下 failure 路径执行；`console.error` 只在失败时打一行。

### 5.3 门禁

| 门禁 | 新增判据 |
|---|---|
| `tools/check-fetch-shim.cjs` | **⑧′**：`new Request(url,{body: Readable.toWeb(...), duplex:'half'})` 的 `request.body` 必须可读且字节一致；**⑧″ 对照臂**：一个"照旧实现"（吞掉流式体、不设 `body`）必须被判**红**（证明探针量得到这件事） |
| `tools/check-core-openharmony-patches.mjs` ⑪ 组 | 新增标记 `DSHM_ATTACHMENT_CAUSE ×1`；正向 2 条（助手 + 3 处抛出点）；反向 1 条（上游 `new AttachmentError("Unable to persist attachment."…)` 必须 **0 处**） |
| `tools/check-resfile-core-zip.mjs` | 换了容器 ⇒ 必须仍只有 1 份、且与配方/本次产出一致 |

`coreVersion` `+dshm.10` → **`+dshm.11`**（核心树内容变了：⑪b 是新的注入）。

---

## 6 端侧验证

### 6.1 环境与读数通道

* 档位：**鸿蒙 PC（2in1）**，`MNTXM-24B` / `HUAWEI MateBook 14`，`const.ohos.apiversion = 26`，
  hdc 序列号 `86E0226429000417`。
* `~/dsh/home` 是 `0700` ⇒ 一切「存储里有什么」用应用自身 Python 桥读（§3.1）；
  日志一律 `hdc file recv` 取回宿主侧按字节看（`AGENTS.md`「真机读数的三个坑」第 2、3 条）。
* 装机走 `.\tools\update-device.ps1`（**只覆盖安装**，全程无 uninstall）：`install -r` 成功、冷启动，
  home 指纹 `links=13 size=3440` 装前装后**一字不变**（会话 21 个、插件、工作区全在）。
* 端侧核心树 `dshm/cores/0.2.1-alpha.1+dshm.11` **在**；exec 探测 **10/10**（`python3.12`、`git`、
  `git-core/git`、`git-remote-http`、`rg`、`ash`、`bash`、`system-sh`、`toybox`、`git-ls-remote` 全 ok）。

### 6.2 上传前 → 上传后（受控对照）

`attachments/v1/` 的目录读数（Python 桥）：

```text
上传前（修复后首次）                      上传后（同一次 curl 之后）
file-objects   MISSING                    file-objects   D mode=700   ← 出现了
files          MISSING                     files          D mode=700   ← 出现了
tmp            D 空                        tmp            D 空         ← 无残留
```

对照 §3.2：**修复前**同样的 curl 只让 `tmp` 的 mtime 动一下，`file-objects/` 永远 MISSING。

### 6.3 四条上传逐字读数

| 输入 | 字节 | HTTP 报文（节选） | 落盘校验 |
|---|---|---|---|
| `probe-111.txt` | 31 | `{"ok":true,…"attachmentId":"sha256:a98189425e0d96e78880d3bb65c88e48868e16d014d73db55b2da088d6afcdf5","bytes":31}` | `file-objects/a9/a981…cdf5` 31 B mode 400；`files/a9/a981…cdf5/probe-111.txt` 31 B mode 400 |
| `big.bin`（随机体） | 2,097,152 | `…"attachmentId":"sha256:6ea73b45c3b229e3eed35f8cd4c82f6c4bb8e11db2fcf0f98c78921e8b20c562","bytes":2097152}` | attachmentId **等于**本地 `Get-FileHash`（多分块拼装正确） |
| `王志豪.pdf`（**中文名**，报告原始症状） | 31 | `…"name":"王志豪.pdf","bytes":31}` `ok:true` | `files/a9/a981…cdf5/王志豪.pdf` |
| `verify2.bin`（收尾复验） | 777 | `…"attachmentId":"sha256:146df055237d058478a4f4e862b44ef19896ebd0b4609d378bb3ee2edc48e0f8","bytes":777}` | 回读 777 B mode 400、sha256 `146df055…e0f8` **与本地逐字节一致** |

`verify2.bin` 的本地哈希 = 响应里的 `attachmentId` = 回读内容的哈希，三者同一；
`tmp/` 为空、`file-objects/14` 与 `files/14` 各 1 项、无临时件残留。

> 另有 4 次上传被 `session/agent-busy`（`owned by subagent routing`）拒回 —— 那是**会话路由守卫**，
> 与本次修复无关；它们同样以 `stream=true` 到达垫片，正说明「流式体已被保住」与「能否入该会话」是两件事。

### 6.4 日志三栏判据（`node-output.log`）

| 判据 | 读数 | 含义 |
|---|---|---|
| `DSHM-REQDIAG … stream=true` | **8** 次（= 本轮全部上传请求） | 流式体到垫片时被**保住**了（修复前 `body` 是 `undefined`，这一栏根本没机会出现） |
| `DSHM-REQDIAG … stream=false` | **49** 次（`workspaceFiles/list\|read\|stat`、`session/canOpenWorkspacePath` 等 buffered 路由） | 垫片对既有 buffered 形状**零回归** |
| `[attachment-local] 落盘失败` | **0** | 修复前每发一次上传必打一行；现在一次都没有 |

### 6.5 明确不做的事

* 报告建议的 `/data/storage/el2` 白名单扩项、`copyFile`/`chmod` 的 errno 特判：**不改**。
  同一进程内的 Python 桥已逐项实测这些 syscall 全绿（§3.3），改它们只会制造新的分歧面。
* 4 次 `session/agent-busy`：属会话路由守卫的既有语义，不在本轮改动范围。
