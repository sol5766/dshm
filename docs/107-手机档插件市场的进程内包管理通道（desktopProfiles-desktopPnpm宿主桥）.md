# 107 · 手机档插件市场的「进程内包管理」通道（`desktopProfiles` / `desktopPnpm` 宿主桥）

> 2026-10-06（真机 HUAWEI Mate 80 / `VYG-AL00` / OH 7.0.0.105 / API 26 / `deviceType=phone`，设备号 `62T0225B18039433`）。
> 用户报障原话：**「手动检测了下，pnpm 自动配置依旧是失败的，侧边栏及预览没问题」**。
> 一句话结论：**不是市场在报错那一刻坏，而是它走的那条路在手机档根本不存在** —— 市场把
> 「探测 pnpm / 装 pnpm / 跑插件安装」全部实现成 `spawn`，而手机档的沙箱**拒绝一切随包可执行文件的 execve**
> （`docs/104` 六条判决性读数）。修法不是"把 spawn 修好"（无解），而是**接上上游为这种情况留的正规缝**：
> 宿主发布 `desktopProfiles` + `desktopPnpm`，市场改用**进程内**包管理运行时。

---

## 1. 现象与判据：坏在响应体，不在路由

| 读数 | 出处 | 说明 |
|---|---|---|
| 市场页横幅「pnpm 自动配置失败」+ 建议 `sudo npm i -g pnpm` | 用户端 | 建议本身在鸿蒙上执行不了 —— 上游文案假定的是桌面环境 |
| `IN-REQ POST /dsh-market/setup-pnpm` → `IN-DONE … status=200` | 宿主日志 | **200 是 HTTP 层的成功**；失败写在响应体里（`{ok:false,error:hint}`），所以"看状态码"会误判成没事 |
| `routes.js:4553` → `commands.provisionPnpm()` | `dshmarket/lib` | 该路由只做一件事：把 `provisionPnpm()` 的结论原样回给前端 |
| `dsh-cli.js:742-783` `provisionPnpm()` | 同上 | 顺序是：`corepack enable pnpm` → 探针 → `npm install -g pnpm` → 探针 → `npm prefix -g` 补 PATH → 仍失败则 `{ok:false,hint}` |
| 探针 = `spawnShim('pnpm', ['--version'])`（`:705`） | 同上 | **整条链的每一步都是 spawn**，所以在手机档是"每一步都失败"，不是"配置缺了一步" |

> 关键理解：**`provisionPnpm()` 不是坏在逻辑上，而是它没有任何一步能在手机档执行**。上表最后一行决定了
> 后面所有事：`corepack` / `npm` / `pnpm` 三个名字在手机档都解析到随包假壳，而假壳是 **POSIX sh 脚本**
> （`#!/system/bin/sh` 解释，见 `hostcore/app/main.js` 的 `CLI 假壳` 段），app 域里连 `/system/bin/sh`
> 的 execve 都被系统拒绝 ⇒ 探针必然失败。

---

## 2. 为什么不在手机档"把 spawn 修好"

`docs/104` 的判决（两条独立 boot 读数逐字相同）已经把这条路口径钉死：

| 路径 | 读数 | 结论 |
|---|---|---|
| 随包 ELF（`rg` / `ash` / `bash` / HAP `libs/*.so`） | `denied`（`EACCES`） | stat 拿得到、execve 被拒 |
| 系统 `sh` | 连 `stat` 都被拒（`toybox stat /system/bin/sh` = `Permission denied`） | 不是"缺文件"，是 MAC 标签不许 |
| `toybox` | `ok`（真跑起来了），但**域仍是 app 域** | execve 不做域转换 ⇒ 不能拿它当启动器；且 149 个 applet 里**没有 sh / bash / ash** |

⇒ **真 shell 无解**，那么"探针通过"这件事在手机档就不可能发生；更关键的是**即便探针侥幸通过，
`pnpm add <spec>` 同样起不来** —— 也就是说这条路上市场一个插件都装不上，横幅只是最先暴露的那一格。

---

## 3. 上游留的正规缝（不是我们自造的）

`dshmarket/lib/index.js:235-271` 是**明文契约**（注释里直接引了上游
`dsh-plugin-desktop/docs/plugin-services.md` 的行号）：

```js
// Desktop's supported cross-environment contract guarantees that
// desktopProfiles exists before Loader entries mount, and prescribes this
// presence check plus a nested desktopPnpm injection:
hostCtx.inject(['desktopPnpm'], (desktopCtx) => {
    const current = desktopProfiles.current;          // { name, dir }
    const runtime = createDesktopPluginRuntime(desktopCtx.desktopPnpm, current.dir);
    …
});
```

而 `createDesktopPluginRuntime()`（`dsh-cli.js:1066`）给出的运行时里，这两项是**常量真**：

```js
// The service is backed by Desktop's packaged pnpm; system discovery and
// global provisioning are neither needed nor allowed in this mode.
probePnpm:     () => Promise.resolve(true),          // :1226
provisionPnpm: () => Promise.resolve({ ok: true }),   // :1227
```

⇒ **在这个契约下，「pnpm 自动配置」这一步根本不会发生**（前端拿到的永远是 `ok:true`）。同处还有两条硬要求，
它们决定了本桥的实现形态：

1. **两个服务必须在 Loader 条目挂载之前就位**（契约原文见上引注释）；
2. `runPlugin` **必须同步返回句柄**，市场拿到返回值后**同一 tick** 就 `handle.stdout.on(...)`
   （`dsh-cli.js:1146-1147`）⇒ 返回 Promise 会当场 `TypeError`；
   且 `done` 的 `signal` **必须恰好是 `null`** —— 市场用 `outcome.signal !== null` 判失败（`:1153`），
   缺字段（`undefined`）会被当成"被信号杀死"。

---

## 4. 本端实现

### 4.1 自带插件：`hostcore/plugins/dshm-market-bridge/`

纯 JS、**不 spawn 任何东西**，只把命令映射到**已经在手机档跑通的那条安装通道**上：

| 命令 | 落点 | 说明 |
|---|---|---|
| `add <target>`（含 `-w` / `--force` / `--config.*=` 等市场选项） | `$DSH_HOME/install-queue/<base>.req` + `<base>.dir` | Host 进程内安装器（`hostcore/app/dshm-installer.js`）接单，**市场插件本机就是靠它装进来的** |
| `remove <name>` | `$DSH_HOME/install-queue/<base>.rem` | 同一队列的卸载通道 |
| 结果 | `<base>.done` / `<base>.fail`（JSON，Host 写、桥读后自删） | `ok:true` ⇒ `exitCode 0`；失败 ⇒ `exitCode 1` 并把安装器给的原因原样写进 stderr |
| 其余（含恢复备份用的无目标 `install`） | **`exitCode 127`** | 如实拒绝，**不假装成功**（无目标 `install` 要展开清单，而安装器一次只吃一个 spec、且解析不了 `^1.2.3` 这类 range） |

选项口径与 `bin/pnpm` 假壳的 `shimSkipOptValuesLines()` **逐条对齐**：`--dir <path>` / `--profile <name>`
**连取值一起跳过**，其余 `-*` 单跳过。这条不是洁癖 —— 真机上踩过：`--dir /tmp/x` 的 `/tmp/x`
被当成第二个包名投递，装出一个不存在的包。

### 4.2 只在"假壳真跑不起来"时才接管（PC 档零变化）

启用判据是一次同步探针：`spawnSync('<sandbox>/bin/pnpm', ['--version'])`。

| 档位 | 探针 | 行为 |
|---|---|---|
| PC / 2in1 | 假壳真能跑（退出 0） | **不接管** ⇒ 市场照旧走已验收的假壳链路，行为一个字节不变 |
| 手机 / 平板 | 假壳被拒（`EACCES`，`status === null`） | 接管（`desktopProfiles` + `desktopPnpm` 就位） |
| 调试 | —— | `DSHM_MARKET_BRIDGE=force` 强制接管 / `=off` 强制不接管 |

`provideMarketBridge()` 全程 `try/catch`：**任何失败只打一行日志、返回 `false`**，绝不阻断启动
（桥是增量能力，不许把已验收的启动链路拖下水）。

### 4.3 注入点：打包期的 `profile-boot-*.js` 补丁

`tools/pack-core.mjs` 的 `patchMarketDesktopRuntime()` 把

```js
const mkt = await import("@deepseek-ai/dshm-market-bridge");
mkt.provideMarketBridge(hostCtx, profileContext);
```

注入到核心树 `node_modules/@deepseek-ai/dsh/lib/profile-boot-<hash>.js` 的 boot 回调里 ——
**与 `hostCtx.provide("profileContext", …)` 同一处、同一时机**（该时刻在
`await hostCtx.plugin(PluginPackages, …)` **之前**，正好满足契约第 1 条）。

**为什么不写成一条 cordis 行**：bundle 行（市场自己）排在 profile patch 行**之前**，行序赌不赢；
而契约要求的是"在 Loader 条目挂载之前" —— 只有 boot 回调这个时刻是确定的。

补丁按标记 `DSHM_MARKET_BRIDGE_BOOT` 幂等，**找不到锚点即 `die`**：上游改了这段要在打包期当场暴露，
而不是静默失效成"手机档市场又装不上了"（那种回归只能靠用户复现）。

`hostcore/core-recipe.json` 的 `coreVersion` 随之 `0.2.1-alpha.1+dshm.6` → **`+dshm.7`**：
树里多了一个包（且 `dist/core/work/<ver>` 复用会静默跳过新增复制），必须换树。

---

## 5. 两个实现坑（都已在离线门禁里钉住）

1. **等待结果的轮询定时器不能 `unref`**。`unref` 掉的定时器不保活事件循环 ⇒ 在"等队列结果"期间，
   进程会被判定成无事可做：离线门禁里表现为 `Detected unsettled top-level await` 直接退出，
   真机上则是**在 Host 恰好没有其它待办时把一次安装吊死**。Host 有 HTTP 服务常年保活，所以这个坑
   只在"看起来一切正常"的场合发作 —— 正是必须钉死的那类。
2. **主体异步逻辑必须 `setImmediate` 延后一个宏任务**再跑。市场拿到句柄后是**同一 tick**才挂监听，
   若桥同步跑，拒绝面（缺目标 / 不支持的命令）的 `emit` 会发生在"还没有听众"的时刻 ⇒
   用户只看到退出码、看不到原因（成功路径的首行同理会被丢掉）。

---

## 6. 门禁与接线（三处必须一致）

| 处 | 内容 |
|---|---|
| `tools/pack-core.mjs` | `DSHM_PLUGIN_PACKAGES` 新增 `@deepseek-ai/dshm-market-bridge`；`patchMarketDesktopRuntime()` 定义 + 调用 |
| `tools/check-market-bridge.mjs`（新增，**离线**，不需要核心树 / 设备 / SDK） | **44 条断言**：启用判据（含"假壳真能跑 ⇒ 不接管"的对照臂）/ argv 口径 / 成功链路（`.req`+`.dir` 逐字、`exitCode:0 signal:null`、结果文件被消费）/ 失败链路 / `.rem` / 拒绝面（stderr 必须非空）/ 取消（≤3s）/ 打包三处接线 |
| `tools/check-core-openharmony-patches.mjs` | 新增 ⑫ 判据块（标记 ×1 + `provideMarketBridge` 在 + 上游锚点在）+ 变异用例 **M11**；横幅 `19 处` → **`20 处`注入** |

---

## 7. 本轮验证读数

| 项 | 读数 |
|---|---|
| `node tools/check-market-bridge.mjs` | **44 passed, 0 failed** |
| `node tools/check-core-openharmony-patches.mjs` | **151 passed, 0 failed**（20 处注入 + 1 处撤除守卫）；`--self-test` **143 用例 / 0 不合格**（含 M11） |
| `node tools/check-resfile-core-zip.mjs` | resfile 只有 **1 份**容器，`8,5136,302 B`，sha256 `65168c90ab192430…`，与配方、与本次产出三方一致 |
| 打包预检 | 锚点命中 `profile-boot-BZ2ZjNWi.js`；注入后 12587 → 13093 字节，`node --check` 语法通过 |
| 覆盖安装（`62T0225B18039433`） | 装机成功；**home 指纹 `links 8 → 8`**（用户数据保留）；**核心树 `0.2.1-alpha.1+dshm.7` 在**；exec 探测手持档判据通过（`toybox=ok`） |

> **未取到的一项（据实登记）**：`[dshm-market-bridge] 已接管市场包操作：profile=… 队列=…` 这行落在
> `files/dshm-host.log`，而该文件对 `hdc shell` 是 `Permission denied`（`0700` / 应用私有），
> 且**成功 boot 的 stdout 不回流 hilog**（`dshhost.cc` 只在 `node::Start` 返回后才把 stdout 文件
> 转 hilog 打印）⇒ 桥是否在真机上接管，**本端日志判据取不到**。可替代的端侧判据：
> 在手机市场里装一次插件 —— 不再出现「pnpm 自动配置失败」、且插件行写入成功，即为接管生效
> （若未接管，横幅会照旧出现，因为在手机档那条链路的每一步都不可能成功）。

---

## 8. 未做项（如实登记，不假装收口）

- 上游 `provisionHint` 的文案（"鸿蒙上执行不了的 `sudo npm i -g pnpm`"）本端**不改上游树**；
  接管生效后该文案不会被触达，属"路径绕开"而非"文案修好"。
- `packageManager` 契约、`bin/pnpm` 的**能力声明**（`docs/106` 四项未做项之二）仍未做：
  两者都会影响"市场如何得知宿主自带包管理器"，与本案同源，但需要另做一轮（改的是假壳与上游契约面）。
- 手机档 Python 桥（解包要 `spawn(bin/busybox)` ⇒ `EACCES`）**本轮未动**，与本案同属"手机档 spawn 边界"
  的后果，修法方向是**纯 JS tar/gzip 解包器**（可行性扫描已做过，见 `docs/106` §4）。

