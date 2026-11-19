# dshm-boot-rescue — DSHM 启动救援

给 **DSHM（鸿蒙端 DeepSeek Harness）** 用的一把「启动备用钥匙」。

当某个插件把 Web UI 弄成只剩一行 `Failed to load plugins` 的失败页、而插件管理页
也跟着一起打不开时，这个插件会由宿主直接把一段很小的救援脚本注入失败页，让你在
**不依赖其它插件加载链**的情况下找出肇事插件、临时停用，然后把工作区救回来。

> 一句话：**插件的启停只在进程启动时拼装**。救援中心只负责把「停用」写进持久配置，
> 真正生效靠**划掉后台、重新打开 DSHM 应用**，不是重新打开这个页面。

> **本仓库内置版**：包名 `@deepseek-ai/dshm-boot-rescue`，由 `tools/pack-core.mjs`
> 落进核心树，并由 `hostcore/profile/ondevice/cordis.patch.yml` ⑮ 默认启用。
> 用户无需手动安装；下文「安装（DSHM 端侧）」仅适用于插件市场重新安装同一份包的场景。

---

## 它解决什么问题

DSH 的插件是启动时由 `cordis.patch.yml` 拼装加载的。一旦某个插件在加载阶段报错，
Web UI 可能停在失败页，而「设置 → 插件」本身也是 Web UI 的一部分——于是形成一个
死循环：**知道是哪个插件的问题，却没有入口去关它。**

`dshm-boot-rescue` 不依赖正常的客户端插件加载链：

- 它是**纯宿主插件**（只有宿主半身，没有 cordis client 半身）；
- 宿主启动时会注册 `/dshm-boot-rescue/*` 路由，并在 `index.html` 里通过 `tapIndex`
  追加一段**单文件、零依赖**的救援脚本 `lib/rescue-client.js`；
- 即使其它插件全部无法激活，这段脚本仍然会被浏览器执行，从而在失败页上挂出
  「启动恢复中心」。

它和一般的「插件守护」不同，专门处理 DSHM 的端侧现实：

1. DSHM 的**持久启停位置**是 profile 目录下的 `.dshm-plugin-rows.yml`
   （`$DSH_HOME/profiles/<profile>/.dshm-plugin-rows.yml`）；
2. `cordis.patch.yml` **每次进程启动都会被核心种子重新拼装**，直接改它只能撑到下次
   重启，所以默认不写它；
3. 用户行文件里的「行 id」是 **profile patch 的 entry id**（如 `dsh-market`、
   `ui-chat`），**不是包名**，所以必须先做「失败文案里的名字 → 真实行 id」映射；
4. DSHM 的「插件」页会重写用户行文件，只保留它自己的头注释和 `id/disabled` 行，
   **会丢掉其它注释**，所以救援标记不能假设永远存在。

---

## 目录结构

```text
dshm-boot-rescue/
  package.json
  cordis.patch.yml          # bundle patch：注册插件自身（行 id = dshm-boot-rescue）
  lib/index.js              # 宿主插件：路由、状态、用户行读写、注入
  lib/rescue-client.js      # 注入失败页的单文件救援脚本
  README.md                 # 本文件
  test/rescue.test.mjs      # node:test 单元测试
  tools/check.mjs           # 零依赖静态自检脚本
```

---

## 安装（DSHM 端侧）

前置：DSHM 已安装并能正常进入界面。

> 把下面的 `<owner>` 换成该仓库实际的 GitHub 用户/组织名。

### 方式 A：设置里安装（推荐）

1. 打开 DSHM → **设置 → 插件**；
2. 在「安装插件」输入框里填：
   ```text
   github:<owner>/dshm-boot-rescue
   ```
3. 确认安装，等待完成（端侧安装要下载、解包、写 profile，通常需要几十秒）；
4. **划掉后台重新打开应用**（从最近任务里划掉 DSHM，再重新打开）。
   只重新打开页面或切回前台都不算，插件行不会重新拼装。

### 方式 B：端侧命令行安装

DSHM 端侧没有真正的 node/pnpm，`pnpm` 是宿主提供的假壳：它会把安装请求投递给
Host 进程内安装器，并同步返回结果。在 DSHM 的终端/Agent Shell 里执行：

```sh
pnpm add github:<owner>/dshm-boot-rescue
```

成功会打印 `ok:true` 的 JSON，失败会打印 `ok:false` 与原因。
安装完成后同样必须**划掉后台重新打开应用**。

### 安装后确认

重新打开应用后，用浏览器访问（端口以 `$DSH_HOME/host-ready.json` 的 `baseUrl`
为准，本机当前是 `http://127.0.0.1:3120`）：

- 健康检查：`http://127.0.0.1:3120/dshm-boot-rescue/health`
- 只读自检页：`http://127.0.0.1:3120/dshm-boot-rescue/preview`

`/health` 返回 `{"ok":true,...}` 即说明宿主半身已加载、路由已注册。

如果安装后设置 → 插件里看不到它，或者 `/health` 打不开，先看诊断日志
（见下文「诊断日志」），并确认已经**划掉后台重新打开**过应用。

### 卸载

- 优先：DSHM **设置 → 插件** 中停用/卸载 `dshm-boot-rescue`，然后**划掉后台重新打开应用**；
- 如果插件页也打不开：按「只读与手动恢复」里的方法删除本插件写入的标记行，
  再从系统侧卸载插件包（或在能进系统后回到设置页卸载）。

---

## 失败页救援流程

### 救援中心何时出现

同时满足以下条件时，救援脚本会挂出覆盖层面板：

1. 页面根节点（`#root`，或 `document.body`）的文本包含失败标题
   `Failed to load plugins`；
2. 根节点内**没有**任何「健康 UI」信号（树、输入框、可编辑区域等）——
   所以在聊天记录里引用这段错误文本不会误挂面板；
3. 救援脚本由宿主注入成功（`/dshm-boot-rescue/client.js` 可加载）。

面板只挂一次（幂等），挂载成功后停止观察；最多观察 120 秒。

### 操作步骤

1. 失败页出现后，稍等片刻，「启动恢复中心」会覆盖在页面上；
2. 顶部会显示救援服务状态：**在线 / 只读 / 降级模式**，以及版本号；
3. 「疑似故障」标签页会列出从失败文案里解析出的插件，并**自动勾选**可操作的项；
   如果没猜中，可以搜索名称/包名/入口 id，或切到「用户插件」手动勾选；
4. 点击 **「停用所选并等待重启」**；
5. 成功后页面会提示：**「停用后请划掉后台重新打开应用」**；
   插件启停只在进程启动时拼装，重新打开这个页面不会生效；
6. 从最近任务里**划掉 DSHM 后台，重新打开应用**；
7. 界面恢复正常后，**再普通重启一次**，确认停用状态保持（说明已写进持久用户行文件）。

### 修好插件之后恢复

- 单行恢复：在恢复中心列表里点该行的「恢复」；
- 批量恢复：「恢复救援停用项」需要**二次点击确认**；
- 恢复后同样需要**划掉后台重新打开应用**才真正生效。

### 复制诊断

面板上的「复制诊断」会复制：版本、生成时间、模式、只读原因、`rowsPath` /
`profileDir`、疑似插件、已救援项、失败页文本。剪贴板不可用时会退化为文本框选中，
方便贴到 Issue 里排查。

---

## 恢复功能语义（只删本插件标记行）

默认模式写入的是 **`.dshm-plugin-rows.yml`**，追加一个 3 行块：

```yaml
# [dshm-boot-rescue] disabled <id>
- id: <id>
  disabled: true
```

- `<id>` **必须**来自「已知真实 entry id」集合，绝不会直接拿失败文案里的名字乱写；
- 需要 YAML 引号时（以 `@ \` * & ! % # ~ |` 开头、含 ` #` / `@` / `#`、首尾空格等）
  使用单引号规则；标记行里的 id 保持原字符串；
- 写入前会把原文件备份到 `<文件>.dshm-boot-rescue.bak`（覆盖旧备份即可）；
  备份失败则拒绝写入（fail closed）；
- 通过同目录临时文件 + 原子 rename 提交，提交前复核文件未被外部修改，最多重试 4 次；
  同一文件的所有修改串行执行；
- 追加时保留原文件内容：BOM、注释、其它用户行都不动；换行风格会按文件的主导风格
  （CRLF 或 LF）统一归一化，因此「逐字节不动」只对原本就是同一换行风格的文件成立。

恢复时**只删除本插件自己写入的完整块**：

- 标记行 + 下一行 `- id: <同一 id>` + 再下一行严格 `  disabled: true`；
- 且该块后面不能紧跟缩进续行；
- 用户改过的块（加了字段、改了缩进、id 对不上、`disabled` 不是 `true`）一律**拒绝删除**，
  只提示，不猜测。

因为 DSHM 插件页会重写用户行文件、丢掉其它注释：**如果标记注释被 DSHM 插件页抹掉，
恢复功能就无法证明这一行是本插件写的，会拒绝删除**。这不影响正常启停，只是提示你
需要手动处理（见下一节）。

本插件不会删除插件包、不会碰插件数据、不会动 `node_modules`，也不会清理别人的行。

---

## 降级模式（patch-fallback）

如果用户行文件存在但**结构无法安全解析**（出现非注释/非空、又不是 `- id:` /
`  disabled: ...` 的行，空 id，控制字符，非 YAML 标量结构等），为了不猜坏用户文件，
本插件会切换到降级模式：

- 目标文件改为 profile 的 `cordis.patch.yml`，写入带 `fallback-disabled` 标记的块：
  ```yaml
  # [dshm-boot-rescue] fallback-disabled <id>
  - id: <id>
    disabled: true
  ```
- 同样备份、临时文件 + 原子 rename、串行、恢复只删自己标记的行；
- 面板会**显著**展示固定提示（需求指定文案，不能改）：
  > **本次停用重启应用后失效，请进入系统后立即卸载肇事插件**
- 为什么这么说：`cordis.patch.yml` **每次进程启动都会被核心种子重拼**，正常路径下
  写进去的停用最多撑到下一次启动。所以进入系统后第一件事是卸载肇事插件，而不是留着它。
- 实际行为可能更复杂，**不要依赖它持久**：DSHM 拼装用户行时会把旧 patch 里「核心
  seed 没有定义的顶层条目」carry（沿用）到新 patch，因此降级写入的
  `- id: <id>` + `disabled: true` **可能被带到后续启动**；是否延续取决于该 id 是否在
  核心 seed 里以及下次拼装路径。另：`fallback-disabled` 只是一行注释，carry/重拼时
  不再与对应的 `- id:` 行相邻（会被并到上一个条目或作为头部注释丢弃）——之后救援
  面板的 `rescueRows` 会为空、没有「恢复」按钮，但 DSHM 插件页会把该行显示为
  「配置已禁用」。
- 降级写入后的恢复途径（不依赖注释标记）：在 DSHM **设置 → 插件** 里重新启用该插件，
  或手动编辑 profile 的 `cordis.patch.yml` 删除对应的 `- id:` 块，再**划掉后台重新
  打开应用**。
- 如果连 `cordis.patch.yml` 也无法安全追加，则整体进入只读模式。

---

## 只读与手动恢复

### 什么时候是只读

- 找不到数据目录（`DSH_HOME` / `DSHM_HOME` 都没有）；
- 无法证明当前 profile 目录（例如 `host-ready.json` 缺失/不可读、profile 不明确）；
- 用户行文件不可读，或目标文件不可写；
- 降级模式下的 patch 也无法安全追加。

只读时面板按钮禁用，并显示原因与手改指引。state 里会给出
`readOnlyReason`、`readOnlyReasonCode`、`rowsPath`、`profileDir`（能定位到时）。

### 手动删除救援停用行（持久模式）

行文件位置（本机真实路径）：

```text
/data/storage/el2/base/haps/entry/files/dsh/home/profiles/ondevice/.dshm-plugin-rows.yml
```

即 `$DSH_HOME/profiles/<profile>/.dshm-plugin-rows.yml`。手工编辑步骤：

1. 先备份该文件（例如复制一份 `.bak`）；
2. 找到本插件写入的完整块：
   ```yaml
   # [dshm-boot-rescue] disabled <id>
   - id: <id>
     disabled: true
   ```
3. 只删除这 3 行（**不要**动同 id 的其它配置块，如果用户自己还有一行的话）；
4. 保存后**划掉后台重新打开应用**。

> 注意：`<id>` 是 entry id，不是包名。面板「复制诊断」或诊断日志里能看到真实 id。
> 不要把包名当行 id 写。DSHM 的 loader 对「非 `insert:` 的 `- id:` 覆盖行」通常只
> 告警/跳过：目标 entry 不存在时该行可能无效，但一般不会像未加引号的 YAML 那样
> 直接把 profile 卡死；仍建议先备份，并且只删本插件的标记块。

### 手动删除降级模式写入的块

降级模式写的是 profile 的 `cordis.patch.yml`：

```text
/data/storage/el2/base/haps/entry/files/dsh/home/profiles/ondevice/cordis.patch.yml
```

找到 `# [dshm-boot-rescue] fallback-disabled <id>` 标记块并删除；如果注释已经被
carry/重拼丢掉，就按 `- id: <id>` + `disabled: true` 找到对应块删除，再重启应用。
再次强调：这个文件**每次启动会被重拼**，降级写入还可能被 carry 延续；根治办法是
卸载肇事插件，或到 DSHM 插件页重新启用。

### 系统设置卸载

如果面板里没法操作（只读、按钮禁用、页面异常），最稳的路径是：

1. 进入 DSHM **设置 → 插件**，停用/卸载肇事插件；
2. 检查 `.dshm-plugin-rows.yml` 里是否还残留 `[dshm-boot-rescue]` 标记行，按上面方法删除；
3. **划掉后台重新打开应用**。

---

## 安全边界

这个插件会修改本地配置，所以边界写得很死：

- **只写数据目录内**：`DSH_HOME` → `DSHM_HOME` 顺序定位；所有读写限定在该目录内，
  profile 必须是 home 的子目录；不猜路径；
- 写接口只接受**同源 `POST` + JSON**；默认只允许**本机回环**连接
  （`127.*`、`::1`、`::ffff:127.*` 等），非回环直接 403；
- 写接口还要求 `Host` 头本身是回环字面量（`127.*` / `[::1]` / `localhost`），
  防 DNS rebinding（攻击页把 Origin/Host 都写成自己的域名并解析到 127.0.0.1）；
- 校验 `sec-fetch-site` / `origin` 与 `host` 是否一致，防跨站写入；
- 请求体 ≤ 32 KiB；ids ≤ 32 个；每个 id 去空白后 1..200 字符、禁止控制字符、去重；
- 整批 fail closed：一个 id 非法整单拒绝，不做部分执行；
- 只能停用 catalog 里 `actionable` 的真实 entry；**不能停用自己**，`@deepseek-ai/*`
  内置插件一律受保护、不可写；无法映射到真实 entry id 的用户行也拒绝写入；
- 核心 seed 的覆盖行（`web-runtime`、`subprocess`、`sandbox` 这类只有 `- id:` 没有
  `name:` 的 profile 行）**永远不作为候选、也不可停用**——它们只用于 name→行 id 映射，
  避免有人误停掉 `web-runtime` 后连 webServer 都不再启动、救援入口彻底消失；
- 恢复只删本插件自己的标记块，用户手改过的块拒绝删除；
- 写入前备份、临时文件 + 原子 rename、串行队列、提交前复核外部改动；
- **零遥测**：不向外发请求、不埋点、不读 cookie/localStorage；
- 插件自身所有逻辑都在 `try/catch` 里，任何错误只记诊断日志，不影响宿主启动；
- 不静态声明 `inject`，`webServer` / `loader` 都用 `ctx.get(...)` 判空，拿不到就降级，
  不会让插件树进入 pending。

---

## 已知限制

- **只在失败页能被渲染出来时有效**。如果 Host 进程本身起不来、webServer 没监听、
  或失败页根本没有 `Failed to load plugins` 标题，救援脚本没有执行机会。
- **DSHM Host 级启动失败有独立的自愈，可能让救援写入“消失”**：如果上次启动在 Host
  层失败，DSHM 会写 `$DSH_HOME/.dshm-boot-failed`；下次启动时入口脚本/`ensureProfile`
  会调用用户行模块的 `quarantineAfterBootFailure()`，把 `.dshm-plugin-rows.yml`
  **改名**为 `.quarantine-<ts>`（保数据不删），清空 profile `package.json` 的
  `dependencies` / `peerDependencies`（原文件也会备份），再按纯种子启动。这个自愈只发生在 Host 级失败，
  **不是**本插件针对的 client pending 失败页；因此本插件写入的停用行可能在隔离后
  “消失”。排查时先看 `$DSH_HOME/.dshm-boot-failed`；隔离文件原样保留，可在确认环境
  后人工合并恢复。
- **必须依赖 `tapIndex` 注入和 webServer 路由**。DSH 是大版本演进中的 developer
  preview，如果上游改了渲染/注入接口，本插件可能需要跟进；拿不到能力时会降级并写日志。
- **只能停用能映射到真实 entry id 的插件**。未映射到已知 entry id 的用户行会被标为
  「未映射」并禁止直接写入，避免写坏 profile。
- **DSHM 插件页重写用户行会丢注释**，之后救援恢复会拒绝删除（但不会误删）。
- **降级模式的停用不保证跨启动**，也可能被 carry 延续（见「降级模式」一节）；固定
  warning 是保守提示。进入系统后应立即卸载肇事插件；恢复途径是 DSHM 插件页重新启用，
  或手改 patch 删除对应 `- id:` 块。
- **降级模式对「仅含 `[]` 的 patch」不保留 `[]`**：写入时会把只有 `[]` 的
  `cordis.patch.yml` 归一化为空再追加标记块，恢复后不会把 `[]` 原样写回。
  真实 profile 的 patch 总有核心种子，且该文件下次启动会被重写，这是已知边缘限制。
- **不处理插件包本身**：不删除、不隔离 `node_modules`，也不修改插件数据。
  安装包坏掉/入口文件缺失这类问题仍需重装或卸载插件。
- **不做远程救援**：默认只允许本机回环写操作，且没有额外认证，不要暴露到局域网。
- 单元测试需要 PC 上的 **Node.js 24**（`node:test` + ESM）；DSHM 端侧没有 node CLI，
  测试是在 PC 上跑，不是端侧跑。

---

## 诊断日志

启动诊断日志写在：

```text
$DSH_HOME/dshm-boot-rescue.log
```

本机真实路径：

```text
/data/storage/el2/base/haps/entry/files/dsh/home/dshm-boot-rescue.log
```

每次启动至少记录 **5 类**信息（当前实现记录 6 条）：

1. **版本号**：插件当前版本；
2. **数据目录定位**：`DSH_HOME` / `DSHM_HOME` 命中了哪个，`$DSH_HOME` 值；
3. **webServer 获取结果**：拿不到会写降级原因；
4. **路由注册结果**：`/dshm-boot-rescue` 是否注册成功；
5. **tapIndex 结果**：救援脚本注入是否挂上；
6. **用户行文件定位结果**：`rowsPath` 及其是否存在/是否可读。

排查顺序建议：先看日志里这些项是否齐全 → 再看 `/health` → 最后看失败页是否出现。
日志只写本地，不会上传；贴 Issue 前请自行检查是否包含敏感路径。

---

## 只读自检（不用真的弄坏插件）

安装并重启后，直接打开：

- 自检页：`http://127.0.0.1:3120/dshm-boot-rescue/preview`
  （一个假的失败页 + 恢复中心，`<body data-dshm-boot-rescue-preview>` 标记自检模式）
- 健康检查：`http://127.0.0.1:3120/dshm-boot-rescue/health`
- 救援脚本：`http://127.0.0.1:3120/dshm-boot-rescue/client.js`

自检页是**只读**的：搜索、筛选、勾选都能试，但所有写操作都会被禁用，状态会显示
「只读自检：不会修改任何配置」。可以用它确认界面、诊断和交互是否正常，不必故意装
一个坏插件。

预览页 CSP（至少）：

```text
default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self';
img-src 'self' data:; base-uri 'none'; form-action 'none'
```

---

## 开发与测试

要求：**Node.js 24**（PC 上），零依赖，不需要 `npm install`。

```sh
# 1. 语法检查
node --check lib/index.js
node --check lib/rescue-client.js

# 2. 单元测试（node:test + node:assert/strict）
node --test test/rescue.test.mjs

# 3. 静态自检（零依赖；没有 node 时也可人工对照）
node tools/check.mjs
```

`test/rescue.test.mjs` 全部使用 `mkdtemp` 创建的临时目录，**不会读写真机 profile**；
测试覆盖：用户行解析/序列化、标记写入、只删自己标记、其它行内容不动（同换行风格时
逐字节一致）、builtin/self
保护、ids 校验、回环地址判断、profile 定位、catalog 映射、state 结构，以及救援脚本的
文本约束（检测正则、必备文案、无 reload / 无轮询 / 无 import 等）。

`tools/check.mjs` 做的是没有 node 环境时的替代自检：禁止模式、必备文案、
`package.json` 约束、`cordis.patch.yml` 行 id、救援脚本的纯净性（无 import/require/
Worker/WASM/setInterval、无自动刷新引导）。

DSHM 端侧没有 node CLI，因此端侧不跑上述命令；端侧验收见下一节。

---

## 真机验收步骤

> 建议先备份 profile 的 `.dshm-plugin-rows.yml` 和 `cordis.patch.yml`。

1. **安装检查**：按上文安装 → **划掉后台重新打开应用** → 正常进入界面，没有新的
   pending；打开 `/dshm-boot-rescue/health` 返回 `ok:true`；检查
   `$DSH_HOME/dshm-boot-rescue.log` 的诊断项（至少 5 类）齐全；打开 `/dshm-boot-rescue/preview`
   能看到恢复中心且显示「只读自检」。
2. **失败页救援**：安装/保留一个已知会让启动 pending 的插件 → **划掉后台重新打开** →
   出现失败页与「启动恢复中心」；确认「疑似故障」自动选中；点击「停用所选并等待重启」；
   看到「停用后请划掉后台重新打开应用」。
3. **恢复界面**：**划掉后台重新打开应用** → 界面正常进入；再普通重启一次，确认停用
   状态保持（持久模式应跨启动保持）。
4. **恢复语义**：在救援中心恢复该项 → **划掉后台重新打开应用** → 插件重新参与加载；
   对比 `.dshm-plugin-rows.yml`，确认只有本插件的 3 行标记块被删除，其它行、注释、
   BOM/换行风格原样。
5. **降级模式（可选）**：在测试 profile 里构造一个结构非法的用户行文件触发降级 →
   面板显示固定 warning；停用并重启后按「已知限制」判断是否被 carry 延续
   （可能只生效一轮，也可能继续；不要假设持久）；随后卸载肇事插件。
6. **只读（可选）**：临时移走 `host-ready.json` 或让 profile 无法证明 → 面板进入只读，
   按钮禁用，展示原因与手改指引。
7. **自检页**：在 `/dshm-boot-rescue/preview` 上尝试操作，确认不会产生任何文件写入。

---

## License

MIT。插件只修改 DSHM 的本地 profile 配置，不做遥测、不联网上传。
