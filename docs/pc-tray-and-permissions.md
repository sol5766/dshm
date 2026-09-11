# DSHM PC 端：系统托盘常驻、全盘授权弹窗与插件预装

本文记录 2026-09-10 一轮针对鸿蒙 PC（HUAWEI MateBook 14，API 26 / 2in1）的联调反馈处理：
**四条问题**的定位与实现，以及插件预装、包名变更两项议题的当前状态与待办。

> 本章为**功能与结论记录**；具体 Bug 的「现象/根因/修复/验证」另见 `.agent-rules/bug-log.md`。
> **本轮所有改动均未编译**（遵循 `.agent-rules/project-rules.md` PR-003：默认不自动构建），
> 交付形态为源码级实现 + 静态校验，设备端行为待用户手动编译验证。

---

## 0. 问题清单与结论速览

| # | 用户反馈 | 定位结论 | 实现状态 |
|---|---------|---------|---------|
| 1 | 首次安装未弹出「访问全盘文件」授权提示 | `ACCESS_USER_FULL_DISK` 是 `manual_settings` 受限权限，**没有弹窗形态**；原代码对它调 `requestPermissionsFromUser` 必然抛错被吞 | ✅ 已改为申请可弹窗权限 + 去设置的手动引导；见 §1 |
| 2 | 顶栏白色区域空太多 / 右上角 X 应「退出并停服务」/ 菜单「最小化」无效 / PC 系统托盘无图标常驻 | 顶栏高度 40→38；X 与最小化此前都走无效的 `win.minimize()`；托盘常驻需按官方「系统托盘保活」实现 | ✅ 已实现 `StatusBarTray` + `BackGroundAbility`；见 §2 |
| 3 | 注入 dshmarket（插件市场）与皮肤市场两个插件 | 两包在 npm 均存在，隔离安装已验证成功；但**尚未注入** `rawfile/dsh` | 🟡 半成品，见 §3 |
| 4 | 终端只显示 `用户@localhost`，不显示当前路径 | 提示符函数拼接了 host+path | ✅ 已改为 `用户名@localhost$`；见 §4 |
| — | 包名彻底改为 `dshm` | 鸿蒙要求 bundleName ≥3 段、7–128 字节，字面 `dshm` 非法；需用户选定三段式并**重签证书** | ❌ 未执行（用户叫停），见 §5 |

---

## 1. 「访问全盘文件」授权弹窗（问题 1）

### 1.1 权限模型事实（权威来源已核实）

| 权限 | grantMode | availableLevel | deviceTypes | 是否有系统弹窗 |
|------|-----------|----------------|-------------|---------------|
| `ohos.permission.ACCESS_USER_FULL_DISK` | **manual_settings** | system_basic | `["2in1"]` | ❌ **无弹窗**，只能由用户在「系统设置」里手动开启 |
| `ohos.permission.READ_WRITE_USER_FILE` | system_grant | system_basic | — | ❌ 无用户弹窗 |
| `ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY` | user_grant | normal | 2in1 | ✅ 声明即弹窗 |
| `ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY` | user_grant | normal | 2in1 | ✅ 声明即弹窗 |

**根因**：原 `WorkspaceAccess.ensureInitialSelection()` 对 `ACCESS_USER_FULL_DISK` 调用
`atManager.requestPermissionsFromUser(...)`。该权限是 `manual_settings` 受限权限，**不存在弹窗形态**，
调用必然抛错；错误被 `catch` 吞掉后表现为「首次安装什么都没弹」。

### 1.2 `openPermissionOnSetting` —— demo 项目的正确姿势

参照 `D:\desktop\demo` 工程 + 本地 SDK 声明（`@ohos.abilityAccessCtrl.d.ts`）确认：

- `atManager.openPermissionOnSetting(context, permissions)` **专用于 `manual_settings` 权限**：
  对非该模式权限调用会抛 `401` 参数错误（错误码 `12100014`）。
- 语义：弹出一个系统对话框说明用途，用户确认后**跳转到系统设置页**由用户手动开启。
- 返回 `SelectedResult` 枚举：
  - `REJECTED = -1`（用户拒绝）
  - `OPENED = 0`（已跳转设置页）
  - `GRANTED = 1`（已授权）
- 有效期 10 秒：超时未选择返回 `REJECTED`，需重新调用。
- demo 的完整组合：`READ_WRITE_USER_FILE`（可读写用户文件） + `FILE_ACCESS_PERSIST`（持久化授权）
  + `ACCESS_USER_FULL_DISK`（全盘），前两者走 `requestPermissionsFromUser`、全盘走 `openPermissionOnSetting`。

### 1.3 当前实现与**未闭合项**

`entry/src/main/ets/dshm/access/WorkspaceAccess.ets` 现状：

- 新增常量 `PERM_PUBLIC_DIRS = ['READ_WRITE_DOWNLOAD_DIRECTORY','READ_WRITE_DOCUMENTS_DIRECTORY']`，
  `ensureInitialSelection()` 改为对这两个权限调 `requestPermissionsFromUser`，带 30s 超时兜底
  （`PERM_DIALOG_TIMEOUT_MS`），避免用户长时间不操作时卡住启动。
- 新增 `isFullDiskGranted(context)`（`checkAccessToken` 探测）与 `shouldNotifyFullDisk(context)`
  （每次安装只提示一次的引导标记，key `full_disk_notified`）。

> ⚠️ **未闭合项（编译前必须处理）**：`module.json5` 目前**并未声明**
> `READ_WRITE_DOWNLOAD_DIRECTORY` / `READ_WRITE_DOCUMENTS_DIRECTORY`。对未在 manifest 声明的权限
> 调 `requestPermissionsFromUser` 会失败，弹窗不会出现。
> 需要在「按 demo 走 `READ_WRITE_USER_FILE` + `openPermissionOnSetting`」与
> 「补声明这两个公共目录权限」之间二选一（详见 §6 待办 T1）。

`DshmWebPage.ets` 侧：DSH 运行时就绪后，若 `shouldNotifyFullDisk()` 为真则弹一次
「全盘访问需在系统设置中手动开启」的引导提示。

---

## 2. PC 系统托盘常驻与窗口按钮语义（问题 2）

### 2.1 官方方案

HarmonyOS PC **不允许应用在后台私自常驻**。官方《PC应用通过系统托盘后台保活》给出的路子是：

1. 用 `statusBarManager`（`@kit.DeskTopExtensionKit`，HMS SDK）在系统托盘挂一枚应用图标；
2. 另起一个**绑定该图标**的后台 Ability 进程维持保活；
3. 用户左键点图标 → 把主窗口唤回前台；右键菜单提供「打开 / 退出」。

关键 API：`addToStatusBar` / `removeFromStatusBar`、`StatusBarItem` / `StatusBarIcon`（黑白双
PixelMap）/ `QuickOperation` / `StatusBarGroupMenu` / `StatusBarMenuItem` / `StatusBarMenuAction`，
事件 `statusBarIconClick` / `rightMenuClick`。

后台 Ability 的拉起靠 `StartOptions`：
- `processMode = contextConstant.ProcessMode.NEW_PROCESS_ATTACH_TO_STATUS_BAR_ITEM`
  —— 新建独立进程并把该进程绑到托盘图标；
- `startupVisibility = contextConstant.StartupVisibility.STARTUP_HIDE`
  —— 启动后不显示窗口、不进 Dock、不触发 `onForeground`。
- **前置条件**：应用必须**已有**托盘图标，否则绑定失败 —— 因此先 `install()` 挂图标，再延时 `hold()`。

### 2.2 实现结构

| 文件 | 职责 |
|------|------|
| `entry/src/main/ets/dshm/system/StatusBarTray.ets`（新建） | 托盘模块：`install()` 挂图标（含右键「打开/退出」菜单组）、`hold()` 拉起后台 Ability、`remove()` 幂等摘除、`onIconClick()` / `onMenuClick()` 事件注册、`publishExitRequest()` / `notifyBgTerminating()` 跨 Ability 公共事件、`delayBeforeTerminate()` 摘图标缓冲 |
| `entry/src/main/ets/backgroundability/BackGroundAbility.ets`（新建） | 后台保活 Ability。`onCreate` 订阅整体退出事件 → `terminateSelf()`；`onPrepareToTerminate()` 广播 `EVENT_BG_TERMINATING` 并返回 `false`。**不承载任何业务**，DSH 运行时仍由 EntryAbility 进程的 native 子进程承担 |
| `entry/src/main/ets/entryability/EntryAbility.ets`（重写） | `onCreate` 调 `setupStatusBar()`；`onPrepareToTerminate()` 拦截系统关闭 → `hideAbility()`；`exitApp()` 摘托盘 + 延时 + `terminateSelf()` |
| `entry/src/main/resources/rawfile/tray_white.png` / `tray_black.png`（新建） | 托盘图标：官方鲸鱼矢量派生的纯白 / 纯黑两版，72px（透明底，鲸鱼占比约 86%） |
| `entry/src/main/module.json5` | 新增 `BackGroundAbility`（`exported: true`） |

### 2.3 窗口按钮语义（用户确认）

| 触发点 | 行为 |
|--------|------|
| **系统窗口右上角 X** | **隐藏到托盘常驻**（官方范式）：`onPrepareToTerminate()` 返回 `true` + `hideAbility()`，应用继续在托盘运行 |
| 应用内「窗口 → 关闭窗口 (Ctrl+W)」 | **真正退出 + 停服务**：`StatusBarTray.publishExitRequest()` |
| 应用内「窗口 → 最小化（后台运行）」 | `hostCtx.hideAbility()`（原 `win.minimize()` 无效） |
| 托盘右键「退出」 | 真正退出：`exitApp('托盘右键退出')` |

### 2.4 退出链路（两条，均收敛到 `EntryAbility.exitApp()`）

1. **应用内退出**：`DshmWebPage.closeWindow()` → `StatusBarTray.publishExitRequest()`
   → EntryAbility 与 BackGroundAbility 各自收到事件 → 各自 `terminateSelf()`；
   `DshmWebPage` 另有 600ms 兜底 `terminateSelf()`。
2. **系统侧退出**：系统先结束 BackGroundAbility → 其 `onPrepareToTerminate()` 发
   `EVENT_BG_TERMINATING` → EntryAbility 摘托盘图标并 `terminateSelf()`。

> `exitApp()` 在摘除托盘图标后延时 `REMOVE_DELAY_MS = 120ms` 再结束 Ability，避免图标残留。

### 2.5 顶栏高度

`DshmWebPage.ets` 的 `TOP_BAR_HEIGHT` 由 `40` 调为 **`38`**（用户反馈白色区域偏高，要求「再小 5%」）。
对应上一轮记录：顶栏此前已由 `28` → `40`（因为要容纳右上角系统窗口按钮）。

> ⚠️ **未闭合项**：`EntryAbility.onPrepareToTerminate()` 需要
> `ohos.permission.PREPARE_APP_TERMINATE`，但 `module.json5` **尚未声明**，拦截行为可能不生效。
> 见 §6 待办 T2。

---

## 3. 插件预装：dshmarket + dsh-skin-market（问题 3）

### 3.1 目标

用户要求「软件注入两个插件：一个 dshmarket 插件市场，一个是皮肤市场」，方案为
**预装进应用、开箱可用**（非运行时安装）。

### 3.2 两个包的事实（npm 已核实）

| 包 | 版本 | 形态 | 依赖 / 备注 |
|----|------|------|------------|
| `dshmarket` | 1.45.1 | bundle + web client + `cordis.patch.yml`；含 `lib/dsh-cli.js` | 依赖 `undici ^7.29.0`、`js-yaml`；与 `@deepseek-ai/dsh` 的 peer 依赖存在已知冲突 |
| `dsh-skin-market` | 0.1.51 | 同上；含 `lib/`、`client/`、`data/`、`registry/` | 依赖 `@phosphor-icons/react`、`@primer/octicons-react`、`ajv`、`yaml`；install/restart 路径会 **spawn pnpm 子进程** |

### 3.3 已完成：隔离安装验证

在工程根临时目录 `tmpplugins/`（合法 npm 包名目录，此前用 `.tmp-plugins` 因目录名非法导致
`npm init` 失败）执行：

```bash
npm install --no-audit --no-fund --ignore-scripts --legacy-peer-deps \
  dshmarket@latest dsh-skin-market@latest
```

**结果：成功**。依赖闭包完整落盘，`tmpplugins/node_modules/` 含
`dshmarket`、`dsh-skin-market`、`@phosphor-icons`、`@primer`、`ajv`、`yaml`、`js-yaml`、
`undici`、`fast-uri`、`argparse`、`require-from-string`、`json-schema-traverse`、`fast-deep-equal` 等。

> **注意**：`tmpplugins/` **未被 `.gitignore` 忽略**，提交前必须清理或加入忽略，勿入库。

### 3.4 尚未完成：注入成 HAP 内置插件

注入基础设施**已存在**（`scripts/apply-dsh-ohos-adapt.sh` 的 `dsh-app-boot` profile 迁移逻辑
已实现 dshmarket 的 bundle + 依赖闭包复制、profile v2/v3 迁移、Worker-bridge 补丁），
**缺的只是包本体**：当前 `entry/src/main/resources/rawfile/dsh/node_modules/` 中
`dshmarket` 与 `dsh-skin-market` **均不存在**。

待办见 §6 待办 T3。

### 3.5 已知风险

- **peer 依赖冲突**：`dshmarket` 需要 `undici ^7.29.0`，而现有树中是 `undici 8.x`。
  需按现有 dshmarket 迁移块的模式**成对复制闭包**、避免顶层覆盖。
- **皮肤市场的子进程调用**：`dsh-skin-market` 在 install / restart 时 spawn pnpm。
  鸿蒙应用沙箱**禁止创建子进程**（且 `--jitless` 下 Worker 继承 `execArgv` 会崩），
  需套用现有 `dshmarket/lib/dsh-cli.js` 的 Worker-bridge 适配方式。
- **环境重构成本**：改动涉及 `scripts/prepare-dsh-env.sh` 重跑（npm 网络下载，耗时较长）。

---

## 4. 终端提示符（问题 4）

`DshmWebPage.ets` 的 `termPrompt()` 由「用户名 + host + 当前路径」改为
**`用户名@localhost$`**（不再拼接 host 与 path）。见 `DshmWebPage.ets:769-778`。

---

## 5. 包名（bundleName）议题 —— 未执行

- 当前值：`com.dshm.agentic`（`AppScope/app.json5:3`）。
- 官方约束（app.json5 文档）：`bundleName` **必须 ≥3 段、以点分隔、7–128 字节**，
  因此字面的 `dshm` **非法、无法编译**。
- 用户目标「彻底去掉 agentic、以 dshm 为核心」，候选：`com.dshm.app` / `com.dshm.desktop`
  / `com.dshm.dshm` / `cn.dshm.app`。
- **风险**：签名证书绑定 bundleName，改名后必须**重新签名**（p7b 的 `acls.allowed-acls`
  亦随之重签，正好覆盖 2026-09-09 bug-log 中「受限权限安装被拒」问题）。
- **状态**：用户本轮叫停（「算了别动了」），**未做任何改动**。

---

## 6. 待办清单

| ID | 事项 | 阻塞点 |
|----|------|--------|
| T1 | 全盘授权弹窗落地：二选一 —— ①按 demo 补 `READ_WRITE_USER_FILE` 声明 + 用 `openPermissionOnSetting` 走全盘；②或补声明 `READ_WRITE_DOWNLOAD/DOCUMENTS_DIRECTORY` | 现在 `WorkspaceAccess` 请求的两个公共目录权限**未在 module.json5 声明**，弹窗不会出现 |
| T2 | 补声明 `ohos.permission.PREPARE_APP_TERMINATE` | `onPrepareToTerminate` 拦截关闭依赖它，当前缺失 |
| T3 | 注入 dshmarket + dsh-skin-market 到 `rawfile/dsh` 并写入 profile bundles / 依赖闭包 | 需改 `prepare-dsh-env.sh` + `apply-dsh-ohos-adapt.sh`，并重跑环境 |
| T4 | 清理 `tmpplugins/`（或加入 `.gitignore`） | 未忽略，存在误入库风险 |
| T5 | 重新签名以使 `ACCESS_USER_FULL_DISK` 等受限 acls 生效 | 需 DevEco 重签 p7b（承接 2026-09-09 bug-log） |
| T6 | 编译 + 设备端验证本轮全部改动 | 未编译（PR-003）；`scripts/ui-test-phone.sh` 补托盘/权限/提示符回归断言 |

## 7. 验证状态

- 全部为**源码级实现 + 静态校验**：文件 `{}`/`()`/`[]` 括号平衡、关键 API 逐个对照本地 SDK
  声明（`@ohos.web.webview.d.ts`、`@ohos.abilityAccessCtrl.d.ts`）、托盘图标逐像素校验。
- **未执行** `assembleHap`（PR-003 默认不自动构建；且沙箱 fs 钩子会导致假失败，
  见 `.local-rules/build-commands.local.md`）。
- 设备端行为（托盘常驻 / X 拦截 / 权限弹窗 / 顶栏高度 / 终端提示符）**均待用户手动编译验证**。
