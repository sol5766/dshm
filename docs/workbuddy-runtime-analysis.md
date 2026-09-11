# WorkBuddy（Electron）在鸿蒙 PC 上的运行时结构分析

> 目的：WorkBuddy（`com.tencent.workbuddy` 5.4.9）能在鸿蒙 PC 上跑 **Electron 37.2（Chromium 138 / Node 22.17，带 V8 JIT）**，
> 而我们此前认定"沙箱 W^X 硬约束 → 内嵌 node 必须 `--jitless`"。本文记录 2026-09-11 的设备实测证据，
> 修正这个结论，并给出 DSHM 可选的三条路线。
>
> 结论先行：**不是"鸿蒙沙箱一律禁 JIT"，而是"没有 ACL 权限的 app 沙箱禁 JIT"。**
> WorkBuddy 的 Electron 能跑 JIT，靠的是签名 profile 里的受限权限
> **`ohos.permission.ALLOW_EXTERNAL_NATIVE_CODE`**（app_gallery 分发 + AGC 审批）。

---

## 1. 设备实测证据（2in1 `86E0226429000417`，OpenHarmony 7.0 / API 26）

### 1.1 WorkBuddy 的进程结构

```
com.tencent.workbuddy                    # ArkTS 主进程（EntryAbility）
com.tencent.workbuddy:GPU                # 渲染加速
com.tencent.workbuddy:NetworkService
com.tencent.workbuddy:Renderer
electron …/app.asar/main/daemon-app-server-entry.js --stdio     # electron 主进程
electron …/app.asar.unpacked/cli/dist/codebuddy-headless.js …   # sidecar（dsh 式 headless 服务）
electron …/app.asar.unpacked/resources/extensions/edge-sync/server/index.cjs
```

关键点（来自 `ps -ef` 与 `bm dump`）：

- **Electron 运行时整体打进 HAP**：可执行文件在 `/data/storage/el1/bundle/libs/arm64/electron`
  （独立 ELF，`cat /proc/<pid>/cmdline` 证实 argv[0] 就是它）；资源在 bundle 的 `electron/` 目录；
  且 Electron 是**独立 feature HAP 模块**（`hapPath = …/com.tencent.workbuddy/electron.hap`，
  `entryModuleName: electron`）。
- **命令行里没有任何 `--jitless`**，node 22.17 + V8 正常跑 JIT。
- `bm dump -n com.tencent.workbuddy`：`"hnpPackages": {}` —— **没用 HNP**，运行时走
  "libs/arm64 ELF + 独立 HAP 模块"的路线。

### 1.2 决定性差异：权限清单对比

```
WorkBuddy 有、我们没有的权限（关键）：
  ohos.permission.ALLOW_EXTERNAL_NATIVE_CODE      ← 允许加载/执行外部原生代码（JIT 的门）

WorkBuddy 的分发属性：
  appDistributionType = app_gallery（应用市场）
  appProvisionType   = release
```

即：**WorkBuddy 通过 AGC 上架拿到了这条受限 ACL 权限**，其 app 沙箱内因此允许创建
可执行内存 → Electron 的 V8 JIT（以及 Chromium 的 JIT）正常工作。

### 1.3 社区侧证（与我们的实测互洽）

- [dsh-ohos-patch 的沙箱笔记](https://github.com/shenjackyuanjie/dsh-ohos-patch/blob/main/docs/ohos-sandbox-notes.md)：
  受限通道里任何初始化 V8 堆的 node 进程都会因 `mmap(PROT_EXEC)`/`mprotect(PROT_EXEC)`
  被拦而 CHECK 失败（返回的 errno 不是 V8 期望的 ENOMEM(12) → `Signal 5`）；
  `--jitless` 不崩但禁 WASM（undici fetch 全挂）。与我们 2026-09-08 的观察一致。
- [自签名 ELF 与 JIT 权限（简书）](https://www.jianshu.com/p/624f4a901655)：
  JIT 属内核级高危权限（`ohos.permission.kernel.ALLOW_EXECUTABLE_FORT_MEMORY`，
  system_grant + ACL 白名单）；自签名 ELF 无 JIT；正规路径 =
  **AGC 申请受限权限 → 带权限 profile → HAP（可含 public HNP）正式签名 → 安装后继承 JIT 权限**。
- [华为官方《应用程序包集成 bin 文件（PC/2in1）》](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/hap-bin)：
  PC/2in1 上官方允许把 bin 类可执行文件集成进 HAP（WorkBuddy 的 `libs/arm64/electron` 即此形态）。
- [Harmonybrew 第三方 tap README](https://github.com/social4hyq/homebrew-core/blob/main/README.md)：
  鸿蒙 PC 终端（HiShell）强制代码签名；Harmonybrew 官方 core 已原生提供
  `deepseek-harness`（含 OHOS 补丁集：link 兜底/凭据模式/ripgrep 回退/crypto polyfill/无沙箱放行）
  与原生重编的 `node` 26.8.1 —— **我们宿主模式用的正是这条线**；`bun` 1.4.2（JavaScriptCore）也在鸿蒙 PC 可用。

## 2. 对我们项目结论的修正

| 原结论（2026-09-08） | 修正后（2026-09-11） |
|---|---|
| "沙箱 W^X 禁止 app 创建可执行内存 → 内嵌 node 必须 `--jitless`" | "**未持有 JIT 类 ACL 权限的 app 沙箱**禁止 W+X 匿名内存 → 无权限时才必须 `--jitless`；权限可经 AGC 审批获得（WorkBuddy 即例证）" |
| 当年的 V8 Fatal 全部归因于 W^X | Fatal 混有两类问题：①加载期 TLS/链接问题（已由 libnode DT_NEEDED 修复）②真正的 JIT 内存拦截（权限，未验证过现在是否仍拦——我们从未在持有权限的签名下试过裸 JIT） |

## 3. DSHM 可选路线与建议

### 路线 A：申请 JIT 类 ACL 权限，内嵌 node 开 JIT（中期最优）

1. AGC 创建应用 → 申请受限权限（`ohos.permission.ALLOW_EXTERNAL_NATIVE_CODE`
   或 `ohos.permission.kernel.ALLOW_EXECUTABLE_FORT_MEMORY`，以 AGC 审批口径为准）；
2. 审批通过后用带权限的 profile/证书重新签名 HAP；
3. `dsh_host.cpp` 把 `--jitless` 改成**运行时探测**：先起裸 node 探针（现有
   `node_probe_naked` 机制，改成写一个 JIT 探测脚本），成功即走 JIT，失败自动回退 jitless
   —— 两种签名装同一份代码都能跑。
4. 预期收益：内嵌模式启动 13.6s → **约 6–8s**（jitless 与 JIT 实测约 2×差距）；
   且 WASM 可用，`_fetch-shim.cjs` 的 WebAssembly 桩可简化，undici 原生 fetch 回归。
5. 代价：需要 AGC 账号/上架流程/审核周期；签名体系变更（现有本机 p7b 不含该权限）。

### 路线 B：维持现状（短期最优，已验证）

- `auto` 缺省已优先**宿主 dsh**（Harmonybrew 线，系统 node 26.8.1 带 JIT）→ 启动 **4.7s**，
  这是当前最快的用户路径；社区还在持续维护（deepseek-harness 的 OHOS 补丁集随官方 core 分发）。
- 内嵌模式（jitless 13.6s）作为"设备上没有 Harmonybrew"时的兜底，纯自包含。
- 零额外工作。缺点：依赖用户自备宿主环境；两套 `$DSH_HOME` 的会话库不互通（已知限制，文档已记）。

### 路线 C：参考 WorkBuddy 把运行时拆成独立 feature HAP（长期可选）

- WorkBuddy 的 `electron.hap` 是独立 HAP 模块（`entryModuleName: electron`），主 HAP 只留壳。
- 对 DSHM 的意义：`libnode.so.137`（121MB）+ `rawfile/dsh`（110MB）可拆成独立 feature HAP，
  主 entry HAP 变小、运行时可独立升级（不用重发整个应用）；与"恢复在线更新"天然配合。
- 代价：打包/签名/版本匹配复杂度显著上升；且**它本身不解决 JIT 权限**（权限在签名 profile，
  不在拆不拆模块）。建议只在决定上架/恢复在线更新时一并考虑。

### 建议

- **现在**：维持路线 B（auto 优先宿主，已是最快路径），不做代码改动；
- **决定上架/去 Harmonybrew 依赖时**：启动路线 A 的 AGC 权限申请（周期长，先提交），
  同时在 `dsh_host.cpp` 预置"JIT 探测 + 自动回退"（一次性改动，两种签名通吃）；
- **决定恢复在线更新/上应用市场时**：把路线 C 纳入设计（运行时独立 feature HAP）。

## 4. 相关引用

- 华为官方：[应用程序包集成 bin 文件（PC/2in1）](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/hap-bin)
- 社区：[dsh-ohos-patch 沙箱笔记](https://github.com/shenjackyuanjie/dsh-ohos-patch/blob/main/docs/ohos-sandbox-notes.md)、
  [自签名 ELF 与 JIT 权限](https://www.jianshu.com/p/624f4a901655)、
  [HNP 全解析](https://juejin.cn/post/7658290915857727498)、
  [Harmonybrew 第三方 tap](https://github.com/social4hyq/homebrew-core/blob/main/README.md)
- 本仓库关联：`docs/device-runtime-fixes.md`（jitless WASM 崩溃）、`dsh_host.cpp`（探针机制）、
  `docs/dsh-version-upgrade.md` §5.5（运行模式）
