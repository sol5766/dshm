# dsh 版本升级手册（升级流程 / 坑点 / 内置升级链路）

> 适用范围：DSHM（本仓库）在鸿蒙设备上内置运行 **DeepSeek Harness（dsh）** 的环境，随 dsh 上游版本变化时的升级作业。
> 本文以 **0.1.2 → 0.1.5-rc.1（2026-09-11）** 这次真实升级为主实例，把「怎么升」「哪里有坑」「App 内如何升级」三件事写清楚。
> 相关文档：`device-runtime-fixes.md`（运行期故障手册）、`plan-lite-env-online.md`（环境包路线，**已停用**）、`dsh-busybox-linux-env.md`（bash 运行时）、`build-notes.md`（构建）、`.agent-rules/bug-log.md`（Bug 档案）。
>
> **2026-09-11 收尾状态**：`ENV_VERSION=20260911-107`；环境已瘦身（253.5MB → 110.7MB）；HAP **238MB**；
> App 内**已移除在线升级**（用户决定暂不做），升级方式 = 换新 HAP。本次新增的关键坑：
> **运行模式分叉**（§5.5 / §4.4 第 22 条）与**环境裁剪规则过激**（§4.1 第 6 条）——两者都曾表现成"玄学故障"，务必先读。

---

## 0. 一句话结论

升级 dsh 版本 = **重建 `rawfile/dsh` 环境树（含瘦身自检）+ bump `ENV_VERSION` + 重装 HAP**，但真正花时间的不是这两步，而是**「壳与新版本之间的适配面」**：dsh 每次大版本都会动**鉴权方式、插件加载协议、客户端 bundle 组织、运行时依赖**，而壳（ArkTS/native/shim）里有若干处是**贴着旧版行为写死**的。本次 0.1.2 → 0.1.5-rc.1 一共踩到 6 类适配失效，每一类都会表现为「白屏 / 设置不可用 / 对话失败 / 更新永不生效」这种看起来很玄的症状。

因此升级的正确姿势是：**先按 §2 的固定流程走一遍，再按 §3 的适配面表逐项核对，最后用 §2.6 的真机清单验收**，而不是「编译过了就发」。此外两条铁律（本次各踩一次）：**验证必须在真正会跑的那条运行模式下做**（host 正常 ≠ embedded 正常），**裁剪运行环境后必须做入口级自检**。

---

## 1. 本次实例：0.1.2 → 0.1.5-rc.1（2026-09-11）

### 1.1 时间线（做了什么 / 发现了什么）

| 阶段 | 动作 | 结果 |
|---|---|---|
| 取产物 | 走镜像源（npmmirror / GitCode，**不是 GitHub**）取 dsh 0.1.5-rc.1 | 25 万+ 文件、253MB node_modules |
| 重建环境 | `scripts/prepare-dsh-env.sh 0.1.5-rc.1` 重建 `rawfile/dsh` | 26,572 文件；DSHM 覆盖层需重新注入 |
| 首启 | 装机后首次启动由 `DshBootstrap` 解压 rawfile → 沙箱 | 解压 6.6–8.8s |
| 症状 1 | 「环境解压不完整」，但 `contentFailed=0 / writeFailed=0` | **哨兵清单对不上**（覆盖层被环境重建冲掉 + 配置编辑器改名） |
| 症状 2 | 「设置里面都不可用、无法选择工作区目录」 | shim 的 `ShRequest` 缺 `text()/json()/arrayBuffer()` → 所有带 body 的 RPC 400 |
| 症状 3 | 白屏，页面只显示 `dsh web authentication required` | 0.1.5 鉴权改成 `?token=` → **303 + Set-Cookie**，ArkWeb 默认不接受 cookie |
| 症状 4 | 更新跑 2% 后没了 / 更新永不生效 | `verifyModules()` 与 `verifyDshSentinel()` 清单不一致 + pnpm 隔离布局 |
| 症状 5 | 对话永远失败（`TRANSPORT`） | shim 的响应体没有 `pipeThrough`，SSE 解析链挂掉 |
| 症状 6 | 对话报 `flock is not supported on openharmony-arm64` | `node-addon-system` 只给 linux/darwin 提供 `system.node` |
| 症状 7 | 冷启动 26–87s | `dsh-client-modules` 的 `newlineCount` 逐码点遍历 11MB 字符串（占 57.8%） |
| 收尾 1 | 品牌统一 `hdsh/HDSH` → `dshm/DSHM`（目录/类名/脚本/环境包 `dshm-config-editor`/marker） | 两个启动崩溃：存量 profile 仍写旧 bundle 名；`ensureBundleMirror` 越过 dsh 的 module-fallback 边界 —— 见 §4.4 |
| 收尾 2 | **环境瘦身**（`scripts/prune-dsh-env.mjs`，挂在 `prepare-dsh-env.sh [6/6]`） | env 253.5MB → **110.7MB**（12,485 文件），HAP 385MB → **238MB**；踩过一次过激规则，见 §4.1 |
| 收尾 3 | **发现运行模式分叉**：`auto` 优先宿主 dsh，两套 `$DSH_HOME` 的会话库互不可见 | 「读取不到会话记录」的真因 —— 见 §5.5 与 §4.4 |
| 收尾 4 | **纯净版**：按用户决定移除「在线环境包」与「Harness 在线更新」两个在线功能 | 菜单只剩 6 个本地项；见 §3 |

### 1.2 升级后的实测状态（真机 `86E0226429000417`，`ENV_VERSION=20260911-107`）

| 指标 | 宿主模式（auto 命中 Harmonybrew dsh） | 内嵌模式（HAP 内置 libnode） |
|---|---|---|
| 启动 → 带 token URL | **9.0s** | **11.4s** |
| `t5.serverReady` | 7.5s | 11.4s |
| 环境版本变化时的一次性解压 | 3.3s（瘦身后） | 同左 |
| 崩溃 | `SIGNAL=0` | `SIGNAL=0`、`ERR_MODULE_NOT_FOUND=0` |

- 端到端：`1+1→2`、`3+4→7`、`7*6→42`、`9+10→19`、`6×7=42`；首屏自动渲染（不再白屏）
- 体积：HAP **238.3MB**（`rawfile` 110.7MB + `libs` 123.7MB，HAP 不压缩存储）；安装耗时 **9.8s**（385MB 时约 60s）
- 包入口自检：`扫描 284 个 package.json，缺失运行时入口 0 个`

---

## 2. 标准升级流程（可复制）

### 步骤 0：前置检查

```powershell
# 设备在线（USB Connected，Offline 时先唤醒/解锁设备）
& $hdc list targets -v
# 构建环境（本机实测路径，见 .local-rules/build-commands.local.md）
$env:JAVA_HOME='C:\Program Files\Huawei\DevEco Studio\jbr'
$env:DEVECO_SDK_HOME='C:\Program Files\Huawei\DevEco Studio\sdk'
$env:PATH='C:\Program Files\Huawei\DevEco Studio\jbr\bin;'+$env:PATH
$env:JAVA_TOOL_OPTIONS='-Xms16m -Xmx384m -XX:MaxMetaspaceSize=192m -XX:ReservedCodeCacheSize=64m'  # 防 SignHap OOM
```

### 步骤 0.5：确认远端仓库地址

本仓库 remote 已迁到 **GitHub `sol5766/dshm`**（2026-09-11）。本机 `github.com:443` **直连不通**，需走本机代理：

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:7897'; $env:HTTP_PROXY='http://127.0.0.1:7897'
git push origin <branch>
```

> - 环境资产（`dist/env/*.zip`）在 `.gitignore` 中，不随仓库分发；发布走 **GitHub Release 附件**（tag `env-<version>`）。
> - 本仓库 `main` 是**「内嵌运行时」实现线**（`bundleName=com.dshm.agentic`，libnode + 完整 dsh 环境打进 HAP）。
> - 历史上 GitHub 上曾有一条**「外部 dsh 接入壳」**线（`bundleName=com.dshm.dshclient`，ArkWeb 加载本机 `dsh web`，提交止于 2026-09-02 v1.1.0）。2026-09-11 按用户决定用内嵌线覆盖 `main`，旧线归档在分支/tag **`archive/external-shell-v1.1.0`**（需要对比或回退时从这里取，勿与当前线混用）。

### 步骤 1：取新版 dsh 产物

- **源**：`npmmirror`（`https://registry.npmmirror.com`）与 **GitCode**（国内可达）。GitHub 直连/gh-proxy 在本机实测不可靠，已从 `scripts/env-asset-sources.json` 里禁用。
- 需要拿到 dsh 的运行时包：`@deepseek-ai/dsh`、`@deepseek-ai/dsh-app-boot`、各 `@deepseek-ai/dsh-*` 插件、以及 `dshm-*` 系 DSHM 自有插件。

### 步骤 2：重建 `rawfile/dsh` 环境树

```bash
bash scripts/prepare-dsh-env.sh 0.1.5-rc.1      # 版本号按需
```

该脚本会（顺序即依赖顺序，**不要手工拆开做**）：

1. 安装/组装新的 `node_modules` 到临时目录；
2. **注入 DSHM 覆盖层**：`dshm-terminal`、`dshm-ohos-settings`、配置编辑器（0.1.5 里叫 `dshm-config-editor`）；
3. **注入 `scripts/_fetch-shim.cjs`** 到 `node_modules/@deepseek-ai/dsh/lib/`；
4. 应用 **`scripts/patch-dsh-env-client-modules.mjs`**（启动期性能补丁，幂等）；
5. 用结构化复制把整棵树落到 `entry/src/main/resources/rawfile/dsh`，并写 `.dshm-env-ready` 标记；
6. **[[6/6] 环境瘦身](scripts/prune-dsh-env.mjs)**：删掉鸿蒙运行时用不到的文件（实测 142.8MB / 56%）：

   | 类别 | 判据 | 实测 |
   |---|---|---|
   | 平台构建产物 | `prebuilds/`；`<os>-<arch>` 完整路径段（`@img/sharp-win32-x64`、`@esbuild/win32-x64`）；`.pdb/.dll/.exe/.lib/.exp` | 48~72MB |
   | 服务端 source map | `*.map`（**保留 `client.js.map`**，客户端合并包要读） | 38.8MB |
   | TypeScript 声明 | `*.d.ts`（只服务编译期；restool 之前还白打包一遍） | 36.5MB |
   | 测试与文档 | `test|tests|__tests__` 目录、`*.md` | 15.7MB |

   瘦身后**自带入口自检**：遍历 `node_modules/<name>`、`node_modules/@scope/<name>` 直下的 `package.json`，逐个校验 `main`/`module`/`exports` 的 js 目标是否还在，缺一个就 `exit 1` —— 这道检查是踩坑后补的，见 §4.1。

> ⚠️ 第 5 步是 `cpSync(force)`：**整棵树会被覆盖**，所以 2/3/4 必须在它**之前**完成；任何只改 rawfile 不改进脚本的手工修补，下一次重建就会丢（本次已经因此丢过一次 shim 修复，见 §4.1）。
> ⚠️ 第 6 步**只删得出「运行时用不到」的文件**。判据必须是「平台构建产物」的形状，**不能**按路径里出现 `win32/darwin` 就删 —— 详见 §4.1 的事故记录。

### 步骤 3：必查的适配面（**本手册的核心**）

| # | 适配面 | 落地位置 | 检查方法 | 失效症状 |
|---|---|---|---|---|
| 1 | **全局 fetch shim** 是否仍覆盖新版所有 undici 用法 | `scripts/_fetch-shim.cjs` | 跑 `scripts/probe-fetch-shim-body.cjs`（含真实 `parseSse` / gzip / `text()/json()` / abort / 真实 HTTPS） | 白屏、RPC 全 400、对话 `TRANSPORT` |
| 2 | **响应体是不是真 ReadableStream** | 同上 | 探针里断言 `body instanceof ReadableStream` 且 `typeof body.pipeThrough === 'function'` | 对话报 `DeepSeek API stream … failed`（code `TRANSPORT`） |
| 3 | **鉴权方式**（token 在 URL？cookie？Header？） | `DshBootstrap.readWebUrl()` / `DshmWebPage.boot()` | 看 node 日志 `dsh web: http://127.0.0.1:3080/?token=…` 以及首次加载是否 401 | 白屏 + `dsh web authentication required` |
| 4 | **插件/客户端 bundle 清单**（`dsh-app-boot` 的 web profile `bundles`） | `rawfile/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js` | grep `PROFILE_TEMPLATES` / `bundles:`，确认 DSHM 的 `dshm-terminal`、`dshm-config-editor`、`dshm-ohos-settings` 仍在 | 设置面板空、`/dshm-admin/*` 全 404、白屏 |
| 5 | **哨兵清单**（启动自检认为「环境完整」的最小文件集） | `DshBootstrap.ets` 的 `verifyDshSentinel()` / `verifyModules()` | 两处清单必须一致，且覆盖 `dshm-*` 与配置编辑器（二者满足其一即可） | 启动即 resetDir 重解压、更新「跑了 2% 就没了」、更新永不生效 |
| 6 | **pnpm 布局**（isolated vs hoisted） | `dshm-terminal` 的 `UPDATE_PNPM_ARGS` | 必须含 `--node-linker=hoisted`，否则顶层没有 `@deepseek-ai/dsh-app-boot` | 同上 |
| 7 | **原生依赖**（koffi / pty / flock 之类） | `entry/libs/arm64-v8a/`、`node-addon-system` | `Harness → 关于版本` 看 koffi 状态；对话里跑一次 bash 工具 | FFI 不可用、`flock is not supported on openharmony-arm64` |
| 8 | **启动期热路径** | `dsh-client-modules`（客户端合并包拼装） | 跑 `scripts/verify-client-modules-patch.mjs` 确认补丁仍能应用 | 冷启动异常慢（本次实测占比 57.8%） |
| 9 | **解压格式** | `EnvAssetClient` / `DshBootstrap` | `@ohos.zlib.decompressFile` **只支持 zip**，资产必须是 zip 而不是 tar.gz | 环境包下载成功但解压失败 |
| 10 | **沙箱约束** | `dsh_host.cpp` / `.rules` | 无 `/tmp`（用 `$TMPDIR`）、无符号链接、seccomp 禁 `io_uring` | 各种 ENOENT / SIGSYS / 启动崩溃 |

### 步骤 4：bump `ENV_VERSION`

`entry/src/main/ets/dshm/bootstrap/DshBootstrap.ets` 的 `const ENV_VERSION`。

**为什么必须**：活环境（沙箱 `filesDir/dsh`）只在「`.dshm-version` ≠ `ENV_VERSION`（且 ≠ 资产版本）」时才从 rawfile 重新解压。不 bump = **rawfile 里换了新 shim / 新环境，设备上跑的还是旧的**（本次踩过两次，表现为「改了没反应」）。

顺带在注释里写清「这一版改了什么、为什么 bump」——这是后续排障最省时间的一行信息。

### 步骤 5：构建 → 安装 → 首启

```powershell
& 'C:\Program Files\Huawei\DevEco Studio\tools\node\node.exe' `
  'C:\Program Files\Huawei\DevEco Studio\tools\hvigor\bin\hvigorw.js' `
  --mode module -p product=default assembleHap --no-daemon
& $hdc -t 86E0226429000417 install -r entry\build\default\outputs\default\entry-default-signed.hap
& $hdc -t 86E0226429000417 shell "aa force-stop com.dshm.agentic"
& $hdc -t 86E0226429000417 shell "aa start -a EntryAbility -b com.dshm.agentic"
```

- **`install -r` 不会清应用数据**（`filesDir/home` 里的 API key / 会话保留）。
- 版本变化后的**首启会多花 6.6–8.8s 解压**（26,572 个文件），属正常，别当成卡死。
- 构建产物：`entry-default-signed.hap ≈ 385MB`（其中 `libnode.so.137` 121MB + `rawfile/dsh` 253MB），安装约 1 分钟。

### 步骤 5.5：确认运行模式（**排查"会话/配置丢失"必看**）

`runtime-mode.txt` 缺省是 `auto`，语义是**优先宿主 dsh**：只要设备上装了 Harmonybrew 版 dsh
（`/storage/Users/currentUser/.harmonybrew/bin/dsh`），App 就会用它，而**不是** HAP 内置的环境。

两套的 `$DSH_HOME` 不同 → **会话库不是同一个**：

| 模式 | dsh | node | $DSH_HOME | 会话库 |
|---|---|---|---|---|
| host | `/storage/Users/currentUser/.harmonybrew/bin/dsh` | 系统 node（有 JIT） | `/storage/Users/currentUser` | `/storage/Users/currentUser/.dsh/` |
| embedded | HAP 内置 `rawfile/dsh`（`--jitless`） | 内置 `libnode.so.137` | `<filesDir>/home` | `<filesDir>/home/.dsh/` |

> ⚠️ 所以在模式之间切换后界面上的会话会"消失"（其实在另一套库里）。排查会话/配置问题时，
> **先 `cat <filesDir>/runtime-mode-active.txt`**；实测宿主模式冷启动约 4.5s，内嵌模式约 11–12s。
### 步骤 6：真机验收清单

```powershell
# 1) 启动耗时：看两个指标
& $hdc -t $T shell "cat <filesDir>/boot-timing.txt"           # t5.serverReady
#    以及「新 pid 的 node 日志里出现 dsh web: http」的时刻（用户实际等的就是它）
# 2) 首屏：截图应为「探索未至之境 / 选择工作区」，不是纯白
& $hdc -t $T shell "snapshot_display -f /data/local/tmp/s.jpeg"
# 3) 对话：新建会话 → 输入 → 发送 → 应给出回答
# 4) 设置面板：Harness→关于版本 与 Web 设置页都应可打开
```

> 用 `uitest dumpLayout` 取坐标时**必须现测现用**：2in1 自由窗口的位置/尺寸会变，沿用上一次的坐标会点空（本次在这上面浪费过多次点击）。

### 步骤 7：回滚

- 代码/环境级：把 `ENV_VERSION` 退回旧值（或重新用旧版本跑一次步骤 2），重装 HAP。
- 运行期：`Harness → 重置运行环境（故障恢复）`（= `forceReinstallEnv`，从 rawfile 重新解压）。
- 环境包级：切到新环境失败时，`boot()` 会自动用 `.dshm-update-backup` / `.dshm-pending-verify` 回滚。

---

## 3. 内置升级链路（App 内到底怎么升）

> ⛔ **2026-09-11 起，App 内不再有任何「在线升级」入口。** 用户决定暂不做在线更新，因此移除了
> 路径 B（在线环境包）与路径 C 的客户端调用（「检查 Harness 更新（自动）」「查看更新进度」
> 「安装在线环境包（开发）」三个菜单项及其全部 ArkTS 实现）。现在**唯一的升级方式 = 装新的 HAP**
> （内置环境随包分发，靠 `ENV_VERSION` 闸门触发重解压）。§3.2 / §3.3 保留为**历史实现记录**，
> 日后恢复在线更新时从这里读回设计；被删代码可在 git 历史中找回（提交标题含「纯净版」）。

菜单入口（`DshmWebPage.harnessMenu()`，**全部为本地功能，无网络请求**）：

| 菜单项 | 作用 |
|---|---|
| 主页 | 回到 DSH web 首页 |
| 关于版本 | App 版本 / DSH 版本 / 运行时 node 版本 / 运行模式 / 内置环境版本 / koffi 状态 |
| 运行模式（宿主 / 内嵌） | `runtime-mode.txt` = `auto`（默认，**优先宿主 dsh**）/ `host`（Harmonybrew 的 dsh）/ `embedded`（内置 libnode） |
| 检查 App 更新 | **只读本机 HAP 版本**，提示「应用更新随安装包发布」（不联网） |
| **重置运行环境（故障恢复）** | 从 rawfile 重新解压整棵环境（本地，无网络） |
| 重启服务 | 触发服务端重启（文件信号，见 §3.4） |

编辑菜单另有：撤销 / 重做 / **刷新**（白屏时的手动兜底）/ **终端 (zsh pty)**。

### 3.1 路径 A（**唯一保留**）：内置环境（rawfile）+ `ENV_VERSION` 闸门

```
HAP(rawfile/dsh, 253MB)
  └─ 启动 boot() → ensureDshDir()
       ├─ 读 <filesDir>/dsh/.dshm-version
       ├─ 与 ENV_VERSION 或资产版本比对
       ├─ 不一致 → resetDir(旧环境)（先 rmdirSync 再建）
       │            └─ @ohos.zlib.decompressFile(zip) 逐文件落盘（26,572 个）
       │            └─ 写 .dshm-version
       └─ 一致 → 跳过（正常启动只花 ~100ms）
```

要点：
- **解压是逐文件 API**，文件数直接决定耗时：26,572 个文件时 6.6–8.8s，瘦身到 12,485 个后降到 **3.3s**；它只在版本变化时发生。
- 判据只剩内置 `ENV_VERSION`（纯净版的有意简化）：原来还要兼容「资产版本」，那是路径 B 留下的兼容负担。
- 自检哨兵（`verifyDshSentinel`）失败 → 同样 resetDir 重解压。

### 3.2 路径 B（**已移除**）：在线环境包（env asset）

```
EnvAssetClient：
  1) 取 manifest（schema: dsh-env-asset/1：engine/size/sha256/entries/sentinels/urls）
  2) 多源 failover 下载（HTTP Range 续传）→ 校验 sha256
  3) 解压到**暂存目录**，逐条校验 sentinels
  4) 原子切换：现役目录 → .dshm-update-backup，暂存目录 → 现役
  5) 写 .dshm-pending-verify，重启服务「验收」
  6) 验收成功 → clearPendingVerify + 丢弃备份
     验收失败 → boot() 检测到 pending → 自动回滚 + restartApp
```

资产由 `scripts/build-env-asset.mjs` 产出（`dist/env/dsh-env-<version>.zip` + `manifest.json` + `SHA256SUMS`），本地联调用 `scripts/dev-env-server.mjs`（默认 18080；设备→主机取包要用 **`hdc rport`**，不是 `fport`）。

> **现状**：客户端侧已整体删除（`EnvAssetClient.ets` + `DshBootstrap` 的备份/暂存/待验收/回滚全套 +
> 两个标记文件 `ASSET_VERSION_FILE`/`PENDING_VERIFY_FILE` + 页面里 8 个相关方法）。构建侧三个脚本
> （`build-env-asset.mjs`/`dev-env-server.mjs`/`env-asset-sources.json`）**保留但已停用**，不再被任何
> 客户端代码消费；`dist/` 本身在 `.gitignore` 里。

### 3.3 路径 C（**客户端调用已移除**）：`dshm-terminal` 的 pnpm 更新任务

服务端端点仍存在于 `dshm-terminal/lib/index.js`（插件保留，因为**终端功能要用**），但**客户端不再调用更新相关的三个**：

| 端点 | 作用 | 现状 |
|---|---|---|
| `POST /dshm-admin/update` | 启动后台更新任务：pnpm 按 `UPDATE_REGISTRIES` 换源安装，`--package-import-method=copy --node-linker=hoisted`，超时 9 分钟，先备份到 `.dshm-update-backup` | ⛔ 无 UI 入口 |
| `GET /dshm-admin/update` | 进度（resolved/downloaded/added/percent/logTail） | ⛔ 无 UI 入口 |
| `POST /dshm-admin/update/apply` | 应用已下载的更新 | ⛔ 无 UI 入口 |
| `POST /dshm-admin/restart` | 重启服务 | ✅ 仍用（菜单「重启服务」） |
| `GET /dshm-admin/version` | 运行时与环境版本 | ✅ 仍用（「关于版本」） |
| `POST /dshm-admin/ui/event` / `GET /dshm-admin/ui/events` | 服务端请求页面刷新/重启（插件安装后常见） | ✅ 仍用（事件轮询） |

> 这些端点都是**本地回环**，留着不会产生任何在线行为。若要做到「连端点都不存在」，需改
> `dshm-terminal` 插件本体（属于环境覆盖层，改完必须同步 `prepare-dsh-env.sh` 的重建流程）。

### 3.4 重启服务的**文件信号**通道（为什么不用端口探测）

在 2in1 上实测发现：
- ArkTS 侧对 loopback 的 http 探测**不可靠**（一会儿通一会儿不通），不能用来判断「旧 node 是否退出」；
- 原地重启会撞 `EADDRINUSE 127.0.0.1:3080`；
- `appRecovery.restartApp()` 在本机是**空操作**（进程 pid 不变，UI 卡在对话框）。

因此改成确定性文件信号：

```
ArkTS 写 <filesDir>/restart-request
   → node 侧监听到 → 优雅退出
   → RunEmbeddedNode 在 node::Start 返回**之后**写 <filesDir>/node-exited
   → ArkTS 轮询到 node-exited → 重新 startNativeChildProcess
```

### 3.5 一次性完整重启时序（含 token）

```
aa start → EntryAbility → DshmWebPage.boot()
  t0 打点
  ArkWeb cookie 接受开关（0.1.5 的 303+Set-Cookie 鉴权需要）
  t1 ensureDshDir（版本变化时解压 6.6–8.8s）
  t2/t3 busybox / pnpm
  t4 工作区信息 / 清 node 日志
  launchDsh() → libdsh_host（native 子进程）→ dlopen libnode → node::Start
       node: -r _fetch-shim.cjs → dsh bin.js web --no-open
  t5 waitForServer：日志出现 "dsh web: http" 或端口可连
  ★ 关键：dsh **先监听 3080、后打印带 token 的 URL**（实测相隔 30–90s）
       → 必须等**带 token 的 URL**再创建 Web，否则裸 URL 401 → 白屏
  ready=true → ArkWeb 加载 <token URL> → 303 → Set-Cookie → /
  首屏按 DOM 内容判断兜底重载（最多 4 次）
```

---

## 4. 坑点清单

> 每条：**现象 → 根因 → 处置**。全部为实测，不是推测。

### 4.1 环境构建期（改 rawfile / 重建环境）

| # | 现象 | 根因 | 处置 |
|---|---|---|---|
| 1 | 改了 shim / 插件，设备上「没反应」 | 只改了 rawfile，没 bump `ENV_VERSION`；活环境不会重解压 | bump 版本号；并确认 `scripts/prepare-dsh-env.sh` 会把该文件重新注入 |
| 2 | 上一次的 shim 修复在重建环境后消失 | `prepare-dsh-env.sh` 的 `cpSync(force)` 整树覆盖；手改 rawfile 不留脚本 | 所有环境侧改动都要有**脚本化补丁**（如 `patch-dsh-env-client-modules.mjs`）并在 prepare 流程里调用 |
| 3 | 环境包解压失败 | `@ohos.zlib.decompressFile` **只支持 zip** | 资产一律打成 zip（曾用 tar.gz 踩过） |
| 4 | `_fetch-shim.cjs` 缺失 → 启动即崩/白屏 | 重建环境未注入 shim（`--jitless` 下 undici 依赖 WebAssembly） | prepare 脚本必须注入并校验；`.dshm-env-ready` 标记里带上适配版本号 |
| 5 | `libnode.so` 补丁脚本报「版本不符」 | `patch-libnode-io-uring.sh` 里的偏移（`0x44e15d8`）与原始字节（`ee36ac94`）**已对不上当前 libnode**（当前文件里该特征 0 次命中）；`fetch-libnode.sh` 落地的还是 `libnode.so`，而运行时通过 `DT_NEEDED` 要的是 `libnode.so.137` | 见 §5 未闭合项 —— 重新下载 libnode 后**必须重新定位 `bl syscall@plt` 补丁点**，不能直接跑旧脚本 |
| 6 | 瘦身后内嵌模式启动即崩：`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-win32-process'` + `SIGNAL 6` | 裁剪规则第一版是「路径含 `win32/darwin/...` 就删」，误伤两类**名字带 win32 但必须存在**的东西：①`@deepseek-ai/dsh-win32-process` —— **dsh 自有包**，`dsh-subprocess-local` 在 `lib/index.js` **顶层** import 它；②`isexe/dist/{mjs,cjs}/win32.js` —— **跨平台分支模块**。裁剪后我只核对了几个关键文件，没做全树入口检查；又因为设备当时跑 **host 模式**，坏掉的内嵌环境一直没被触发 | 规则收紧到「平台构建产物」形状（`prebuilds/`、`<os>-<arch>` 完整路径段、`.pdb/.dll/.exe/.lib/.exp`），**`@deepseek-ai/**` 一律不按平台裁剪**；`prune-dsh-env.mjs` 加**包入口自检**（缺 `main`/`module`/`exports` 的 js 目标即 `exit 1`，只把 `node_modules/<name>`、`node_modules/@scope/<name>` 直下的 json 当包根）；被误删的文件从 npmmirror 逐个补回 |

### 4.2 首启解压期

| # | 现象 | 根因 | 处置 |
|---|---|---|---|
| 7 | 「环境解压不完整」，但 `contentFailed=0 / writeFailed=0` | **哨兵清单**与真实环境对不上（覆盖层被重建冲掉、配置编辑器改名） | 哨兵清单与 `prepare-dsh-env.sh` 的注入清单必须同源；配置编辑器接受 `dshm-config-editor` / `dshm-config-editor` 二者之一 |
| 8 | 备份现役环境失败：`error: file exist` | `removeDirRecursive` 不删目录本身 | 用 `rmdirSync`（`resetDirForStaging`） |
| 9 | 首启很慢（6.6–8.8s） | 26,572 个文件逐个 `decompressFile` | 属机制性成本；只在版本变化时发生。**瘦身到 12,485 个文件后降到 3.3s** —— 文件数就是这里的成本函数 |

### 4.3 运行期（`--jitless` 沙箱）

| # | 现象 | 根因 | 处置 |
|---|---|---|---|
| 10 | node 启动即崩（`WebAssembly is not defined`） | undici 内嵌 llhttp WASM，`--jitless` 下没有 WebAssembly | `_fetch-shim.cjs` 在**任何全局被定义之前**先装 WebAssembly 桩，并替换全部 undici 全局 |
| 11 | 设置页全不可用 / 选不了工作区目录 | shim 的 `ShRequest` 缺 `text()/json()/arrayBuffer()` → 带 body 的 RPC 全 `400 body is not JSON` | shim 必须实现完整 Request/Response body 读取 |
| 12 | 对话永远失败：`DeepSeek API stream … failed`（`TRANSPORT`） | shim 的响应体是自制流，**没有 `pipeThrough`**；而 SSE 链是 `body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream())` | 响应体改为 `node:stream/web` 的真 `ReadableStream`（`pull()` 背压） |
| 13 | 白屏 + `dsh web authentication required` | 0.1.5 鉴权 = `?token=` → 303 + `Set-Cookie(HttpOnly; SameSite=Strict)`；ArkWeb cookie 接受是可关闭的 | Web 组件创建前 `WebCookieManager.putAcceptCookieEnabled(true)` |
| 14 | 白屏（已带 token 仍白） | dsh **先监听端口、后打印带 token 的 URL**，两者相隔 30–90s；壳若在拿到 token 前用裸 URL 创建 Web 就 401 | 等到**带 token 的 URL** 再创建 Web（上限 120s）+ 按 DOM 内容判断的兜底重载 |
| 15 | `flock is not supported on openharmony-arm64` | `@deepseek-ai/node-addon-system` 只为 linux/darwin 提供预编译 `system.node` | 在 `flock.js` 里加纯 JS 等价实现（`O_EXCL` 锁文件 + 轮询 fd 关闭释放） |
| 16 | koffi 崩溃：`Error relocating libkoffi.so: _ZN1K16PrintAssertErrorEPKciS1_` | 预编译 koffi 漏了 `koffi/lib/native/base/base.cc`；且 OHOS/musl 只在**自身 DT_NEEDED 闭包**里解析 dlopen 对象的未定义符号（`RTLD_GLOBAL` 预加载无效） | 用 `scripts/build-koffi-ohos.ps1` 重新构建自包含的 `.so` |
| 17 | 重启服务报 `EADDRINUSE 127.0.0.1:3080` | 原地重启 + loopback 探测不可靠 | 文件信号重启通道（§3.4） |
| 18 | 重启对话框卡住、进程 pid 不变 | `appRecovery.restartApp()` 在本机是空操作 | 不要依赖它；用文件信号 + `startNativeChildProcess` |

### 4.4 升级/更新切换期

| # | 现象 | 根因 | 处置 |
|---|---|---|---|
| 19 | 更新跑到 2% 就没了 / 更新永不生效 | 更新侧 `verifyModules()` 与启动侧 `verifyDshSentinel()` 清单不一致；pnpm 隔离布局下顶层没有 `@deepseek-ai/dsh-app-boot` → 哨兵 false → `resetDir` 重解压把新环境冲掉 | 两处哨兵清单**同源**；pnpm 加 `--node-linker=hoisted`（注：更新链路本身已按用户决定移除，此条留作历史） |
| 20 | 装完在线环境又被覆盖回内置版 | 启动校验只认 `ENV_VERSION`，而资产版本 ≠ `ENV_VERSION` | 当时用 `.dshm-asset-version` 兼容；**现已删除该兼容**（在线路线移除后只认 `ENV_VERSION`） |
| 21 | 新环境起不来但也没回滚 | 待验收标记（`.dshm-pending-verify`）与备份的清理不完整 | 当时在 `boot()` 的 `finally` 里 `resolvePendingEnvSwitch()`；**该机制已随在线路线删除** |
| 22 | **「读取不到会话记录」/ 会话列表突然空了** | **运行模式分叉**：`runtime-mode.txt` 缺省 `auto` → **优先宿主 dsh**。两套 `$DSH_HOME` 不同 → 会话库不是同一个：host = `/storage/Users/currentUser/.dsh/`，embedded = `<filesDir>/home/.dsh/`。模式一换（或先内嵌后宿主），界面上的会话就像"消失" | 排查会话/配置丢失**第一步**看 `cat <filesDir>/runtime-mode-active.txt`；切换模式前先确认自己在哪条线；不要只看 `<filesDir>/home/.dsh` |
| 23 | 装「纯净版」后菜单里找不到在线更新入口 | 2026-09-11 按用户决定移除了「检查 Harness 更新（自动）」「查看更新进度」「安装在线环境包（开发）」 | **这是预期行为**，不是 bug：升级方式 = 换新 HAP；要恢复在线更新见 §3.2/§3.3 与 git 历史 |

### 4.5 启动性能（本次新增，已修）

| # | 现象 | 根因 | 处置 |
|---|---|---|---|
| 24 | 冷启动 26–87s | `dsh-client-modules` 的 `newlineCount` 用 `for (const char of value)` 逐码点遍历 **11MB** 客户端合并包（每次迭代分配单字符字符串）→ 占 57.8%（11.4s/19.6s） | 改原生 `indexOf("\n")` 扫描 + `identitySectionMap` 等价改写；主机 19.6s→6.0s |
| 25 | 仍有 ~1/3 启动时间花在合并包上 | 一轮启动 `buildCombo` 被调用 **469 次但只有 65 个不同产物** —— 约 400 次是同一输入的重复拼装 | 进程内记忆化（键 = `(entry.id, entry.rev)` + revision）；主机 6.0s→4.5s，真机 `t5` 16.4s→10.6s |
| 26 | 启动期仍有大量「看不见」的开销 | 启动成本与**文件数**强相关（模块解析/realpath/stat 各走一遍）。瘦身把 env 从 26,762 砍到 12,485 个文件后：一次性解压 6.6–8.8s → **3.3s**，HAP 385MB → **238MB**，安装 60s → **9.8s** | 见 §4.1 第 6 条的裁剪规则与自检；这是当前性价比最高的一类优化 |

**性能排查方法（可复用）**：
1. `DSHM_BOOT_PROFILE=1` 打开 shim 内置剖析器（`module.registerHooks` 统计模块加载 + 3s 心跳 + `fs.*Sync` 计数与去重率）；
2. `node --jitless --cpu-prof --cpu-prof-dir=<dir> …` + `DSHM_PROF_EXIT=1`（打印 `dsh web:` 后自行退出以便 profile 落盘），再按 self-time 聚合；
3. 判据：**心跳直到结束才输出一次** ⇒ 启动是「一个长同步阻塞」；`--jitless` 与正常 JIT 只差 ~2 倍 ⇒ 瓶颈**不是**解释执行本身。

**已评估但明确不采用**（附数据，避免重复尝试）：`NODE_COMPILE_CACHE`（对真实启动零收益）、合并包**磁盘**缓存（无法证明字节级等价）、同步 fs 记忆化（主机/真机均无收益）。

---

## 5. 未闭合项 / 已知漂移

| 项 | 说明 | 建议 |
|---|---|---|
| `scripts/fetch-libnode.sh` | 落地文件名是 `libnode.so`，而运行时经 `DT_NEEDED` 要的是 **`libnode.so.137`**（见 `entry/src/main/cpp/CMakeLists.txt` 注释）；`build-koffi-ohos.ps1` 也按 `.137` 取 | 把 DEST 改成 `libnode.so.137`，或改名后再跑 patch |
| `scripts/patch-libnode-io-uring.sh` | 硬编码偏移 `0x44e15d8` / 原始字节 `ee36ac94` 与当前 libnode **完全对不上**（0 次命中）；当前 `libnode.so.137` 已在 6 处把 `bl syscall` 改成 `mov w0,#-1` | 重新下载 libnode 后必须**重新定位补丁点**（按 `bl syscall@plt` 站点逐个定位），或改为「校验目标位置已是 `mov w0,#-1` 就跳过」 |
| `entry/libs/arm64-v8a/` 备份副本 | `libnode.so.patched`（中间态）、`libnode.so.v24orig`（未打补丁原件）各 121MB，均**不会被打进 HAP**（实测 HAP 只含 `libnode.so.137`） | 可删；`.v24orig` 建议留作唯一原件（重新下载需要 `DSHM_LIBNODE_URL`） |
| 剩余启动时间 | 宿主模式 9.0s / 内嵌模式 11.4s。已无单一热点：模块加载 0.3–0.7s、同步 fs 0.7–1.9s，其余是 dsh 自身插件图的构建与执行（分散在数十个模块）。**文件数**是唯一被证实有效的杠杆（见 §4.5 第 26 条） | 继续压只能走产品级决策：**减少启动期加载的插件/bundle**、或**服务常驻 + 预热**架构；若接受「纯壳」（不内置运行时）HAP 可降到约 7MB，但必须依赖宿主 dsh |
| `dist/` 与在线资产脚本 | 客户端已移除在线更新，故 `scripts/build-env-asset.mjs`、`dev-env-server.mjs`、`env-asset-sources.json` 变成**无人调用的停用件**；`dist/` 已在 `.gitignore` 中 | 保留（体积很小）供日后恢复；若确定不再做在线更新，可整组删除并在 §3.2 注明 |

---

## 6. 相关文件与脚本索引

**ArkTS / native**
- `entry/src/main/ets/pages/dshm/DshmWebPage.ets` — 启动时序、白屏兜底、菜单（全本地）、重启通道、终端面板
- `entry/src/main/ets/dshm/bootstrap/DshBootstrap.ets` — `ENV_VERSION`、环境解压/哨兵、`waitForServer`、运行模式、品牌迁移
- `entry/src/main/cpp/dsh_host.cpp` — native 子进程入口：环境变量、`dlopen libnode`、`node::Start`、日志重定向
- ~~`entry/src/main/ets/dshm/env/EnvAssetClient.ets`~~ — **已删除**（在线环境包，见 §3.2）

**环境侧（会被 `prepare-dsh-env.sh` 覆盖，改动必须脚本化）**
- `scripts/_fetch-shim.cjs` — 全局 fetch shim（真 ReadableStream 响应体 + 可选启动剖析器）
- `scripts/patch-dsh-env-client-modules.mjs` — 启动性能补丁（幂等）
- `scripts/prune-dsh-env.mjs` — 环境瘦身 + 包入口自检（见 §4.1 第 6 条）

**验证脚本**
- `scripts/verify-client-modules-patch.mjs` — 性能补丁的逐值等价性
- `scripts/probe-fetch-shim-sse.cjs` / `probe-fetch-shim-body.cjs` — fetch shim 回归探针
- `scripts/wait-and-verify-device.ps1` — 守候真机上线后自动安装 + 计时 + 对话验证
- ~~`scripts/build-env-asset.mjs` / `dev-env-server.mjs` / `env-asset-sources.json`~~ — **已停用**（在线环境包，客户端不再调用）

**环境变量开关**
| 变量 | 作用 |
|---|---|
| `DSHM_BOOT_PROFILE=1` | 打开 shim 内置启动剖析器（模块加载 / 心跳 / fs 计数） |
| `DSHM_PROF_EXIT=1` | 打印 `dsh web:` 后自行退出（配合 `--cpu-prof` 落盘） |
| `DSHM_COMBO_VERIFY=1` | 合并包记忆化的运行时自证（每次命中重建并逐字节比对） |
