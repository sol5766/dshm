# DeepSeek Harness Desktop 工程方法借鉴与 BrewDSH 后续开发规划

> 依据：上游 `deepseek-ai/deepseek-harness` `apps/desktop`（v0.1.5-rc.2，master `c291e7961a`，2026-09-12 通读全部 19 个源文件），
> 结合本机 win-x64 unsigned 打包实测（见 `.local-rules/build-commands.local.md` 2026-09-12 条目）。
> 参照形态：**mac-arm64**（与鸿蒙 PC 同为 arm64 桌面形态 + W^X 内存模型，同构度最高；Harmonybrew 之于鸿蒙 ≈ Homebrew 之于 macOS）。
> 定位：本文是 DSHM 的工程规划文档，不是共享规则；沉淀边界见第 6 节。

## 0. 双模式架构定位（规划的前提）

上游 README 决策表"运行时"一栏的格局，与 DSHM 的 Plan A/B 完全同构：

| 上游 | DSHM 对应 | 特征 |
|---|---|---|
| CLI（用户自装 dsh，系统运行时） | **Plan A 宿主模式**（Harmonybrew dsh） | 原生 V8 完整 JIT、koffi/node-pty 为宿主真编译模块、无需适配补丁；版本绑定最弱 |
| Desktop（捆绑运行时，同一签名更新单元） | **Plan B 内嵌模式**（rawfile/libnode + ENV_VERSION） | 版本完全可控、开箱即用；jitless 探测回退（`jit-capability.txt`）是上游 entitlement 机制的鸿蒙等价物 |
| 两者共享 `$DSH_HOME` 数据、隔离可执行依赖图 | 两模式共享 `filesDir/home`、环境隔离 | 已对齐，方向不变 |

结论：**内嵌是产品默认（版本可控），brew 是进阶路径（能力完整）**。mac-arm64 的借鉴价值主要落在 Plan A（brew 路径）与工程方法层。

## 1. 可借鉴工程方法总清单

每条格式：上游机制（锚点）→ DSHM 现状 → 借鉴动作。优先级：P1=阶段0/1，P2=阶段2/3，P3=机会性。

### A. 启动与生命周期

| # | 上游机制 | DSHM 现状 | 借鉴动作 |
|---|---|---|---|
| A1 | **类型化握手事件**取代日志解析：`{type:'ready', protocolVersion, dshVersion}`（`host-process.ts`） | 轮询 node-*.log 找 `dsh web:`、正则抠 token（`readWebUrl`/`countWebReadyMarkers`），吃过 40-60s token 落盘延迟白屏亏 | **P1**：native 启动完成后写 `<filesDir>/boot-state.json`（mode/url+token/pid/dshVersion/nodeVersion 一次成型），ArkTS 读单文件；删除日志刮削路径（约 150 行）。宿主模式由守候进程写，内嵌模式由 node 预加载脚本或 libdsh_host 写 |
| A2 | **后端控制器状态机**（`backend-controller.ts`，148 行收拢 start/stop/retry/cancel/cleanup） | `boot()`/`restartAndWait()` 内联在 `DshmWebPage`，并发仅靠 `restarting` 布尔；`DshBootstrap` 已 74KB | **P2**：抽 `DshBackendController`（phase: extracting→starting→waitingToken→ready→error），页面只消费状态；`DshBootstrap` 只保留文件/环境职责 |
| A3 | **锁文件带 PID 活性检查**（`project-manager.withLock`：写 PID→`process.kill(owner,0)` 探活→ESRCH 即残留锁删除重建） | `EXTRACT_LOCK_FILE` 时间戳 + 600s 过期 + 最长等 5 分钟 | **P1**：锁内容改 `pid+timestamp`，残留判定查 `/proc/<pid>`；5 分钟等待降为 0 |
| A4 | **确定性退出序列**：先停后端→文件替换→再启动（`DesktopProjectHooks.beforeChange/afterChange`） | 内嵌重启已用 `node-exited` 标记确定性等待（bug-log 教训）；重置路径 `waitPortDown` 仍依赖不可靠的 http 探测 | **P2**：重置路径改用 `node-exited` 同款确定性信号 |

### B. 环境与 profile 事务

| # | 上游机制 | DSHM 现状 | 借鉴动作 |
|---|---|---|---|
| B1 | **fail-forward 事务标记**：改 profile 前写 `desktop-packages-pending`，失败不回滚，下次启动见标记即重建（`project-manager.ts`） | `mergeWebProfileBundles` 直接覆写 `profiles/web/package.json`；写一半崩溃=坏 JSON→dsh-app-boot 解析失败 SIGNAL 6（已实测的崩溃类） | **P1**：改 profile 前写 `.dshm-profile-pending`；启动见标记或 JSON 解析失败→按模板重建（十几行防一类已知崩溃） |
| B2 | **目录级完整性清单**（`runtime-tree.ts` 全树 sha256 清单） | 哨兵 = 5 文件 + lib 目录项数，两次漏掉"解压不完整"事故 | **P2**：`prune-dsh-env.mjs` 产清单时生成**按顶层包聚合的 count+size**（逐文件 sha256 对 2.6 万文件太慢），解压后比对；精确抓截断类损坏 |
| B3 | **arch/platform 绑定断言**（`desktop-runtime.json` 记录 platform/arch，smoke 与启动断言一致） | `.dshm-version` 只有版本号；真机/模拟器环境互窜会报难懂的 dlopen 失败 | **P1**：版本文件加 `arch=arm64` 行，`isEnvVersionOk` 比对；`boot-state.json` 同时记录 arch |
| B4 | **恢复动作页**（`startup-document.ts`：重试/禁用第三方插件/重置三动作，不依赖 preload） | 错误态只有日志回显；"禁用第三方 bundle"（裁回 `dsh-base+dsh-web-app`）无入口 | **P2**：错误页补三个动作；禁用动作=重写 bundles 数组为内置项（上游 `plugins-disable-all` 同款） |
| B5 | **重置保留事务锁**：reset 删 profile 除所持锁外全部条目 | `forceReinstallEnv` 已对齐（会话/工作区/key 在 home 不丢） | 已对齐，无需动作 |

### C. 插件与依赖（brew 路径为主战场）

| # | 上游机制 | DSHM 现状 | 借鉴动作 |
|---|---|---|---|
| C1 | **allowBuilds 编译清单**（`project-manager.ts` workspaceFile：node-pty/koffi/`dsh-subprocess-local`: true 等）= "哪些包必须真编译"的官方答案 | Plan A 依赖 brew formula 编译的原生模块；未核对过清单完备性 | **P2**：对照清单核对 Harmonybrew dsh formula 实际编译的原生包；重点确认 sharp/libvips 是否可用（决定宿主模式图片工具能力面） |
| C2 | **共享包 peer 校验**：插件必须 peer 声明宿主包、拒绝嵌套副本/别名/registry 解析（`profile-packages.ts`） | 壳侧 dshm-* 镜像 + `dsh.moduleFallback` 托管已有（踩坑后收敛）；无系统化校验 | **P2**：镜像逻辑加"源存在且 name+version 一致"之外的校验（patch 声明存在性，对齐 `inspectPlugin`） |
| C3 | **版本组合绑定**：Electron/dsh/node/pnpm 锁成同一已验证组合（`desktop-runtime.json` + `assertProfileRuntime`） | `runtime-mode-active.txt` 已记录 host dsh/node 版本；不做断言 | **P2**：Plan A 生效时与壳要求的 dsh 最低版本比对，不满足→提示回退内嵌（把上游"版本单元"纪律落到 brew 路径） |
| C4 | **pnpm 状态隔离**：每 profile 独占 store/cache/config/userconfig | pnpm wrapper 桥到 brew node，用共享缓存 | **P2**：wrapper 加 `--config.store-dir`/userconfig 指到 `filesDir` 内，插件安装不碰 `~/.harmonybrew` 共享状态 |

### D. 更新

| # | 上游机制 | DSHM 现状 | 借鉴动作 |
|---|---|---|---|
| D1 | **两段式更新协调器**（`update-coordinator.ts`：check 保留版本→install 必等 check 完成、先停后端再换文件、状态机 idle/checking/available/installing/ready/error） | 在线更新已随"纯净版"移除（端点保留，恢复见 `docs/dsh-version-upgrade.md §3.3`） | **P2**（恢复在线更新时）：照抄两段式结构 + install 前强制 `beforeRestart`（停 node）；不重造 |
| D2 | **版本单元纪律**：壳与运行时必须同一发布单元 | HAP 与 ENV_VERSION 绑定已等价 | 已对齐；C3 补上 brew 侧断言即完整 |

### E. 打包与多目标

| # | 上游机制 | DSHM 现状 | 借鉴动作 |
|---|---|---|---|
| E1 | **target 参数化矩阵**：`(platform,arch)` 显式建模，每 target 独立可变准备状态，仅不可变下载缓存共享（文件名带版本+平台+arch，解包前校验） | rawfile/dsh 为 arm64 单形态 | **P3**：出现 x86_64 模拟器需求时，`prepare-dsh-env.sh` 参数化 + 独立准备目录 + 共享 dsh 发行版缓存；不要提前做 |
| E2 | **按目标裁剪其他架构载荷**（`runtime-file-policy.ts`） | v107 环境瘦身已独立收敛出同款规则（`prebuilds/`、`<os>-<arch>` 段、.pdb/.dll/.exe），且带包入口自检 | 已对齐，互相印证；无需动作 |
| E3 | **产物 smoke 按平台参数化**（pty/koffi/sharp/html 四项原生验证 + 运行时清单校验） | brew 模式无验收 smoke | **P2**：给 Plan A 做同形状四项检验（借 brew node 跑），作为 formula/环境验收 |
| E4 | **构建期适配齐备性闸门**（smoke 不过不出包） | v91 已有同类闸门（缺适配 boot 死循环教训） | 已对齐 |

### F. 桌面 UX（鸿蒙 PC 先行）

| # | 上游机制 | DSHM 现状 | 借鉴动作 |
|---|---|---|---|
| F1 | 启动页进度/错误态分离 + 冷启动可感知进度 | bootTicker 计时 + bootPhase 已实现 | 已对齐 |
| F2 | 单实例锁 + 二次启动聚焦宿主窗口 | 默认单例 ability + 托盘保活第二进程；解压跨进程锁已有（A3 补 PID 活性后完整） | A3 覆盖 |
| F3 | locale 化壳文案（en/zh + fallback，i18n gate 检查） | 壳文案硬编码中文 | **P3**：PC 里程碑若需国际化再抽资源 |
| F4 | PC 交互预期（菜单栏、托盘、恢复页） | 顶栏菜单/托盘已有；恢复页见 B4 | B4 覆盖 |

## 2. 明确不借鉴清单

| 项 | 理由 |
|---|---|
| `dsh-app://` 自定义协议 + fd3/fd4 分帧管道 | 鸿蒙 `childProcessManager` 不提供子进程 stdio 管道（已实测）；loopback HTTP + token cookie 是正确等价物 |
| Electron 自动更新 / electron-builder 打包链 / Apple 签名公证 | 鸿蒙走 AGC + HAP；"壳与运行时同一版本单元"语义已由 HAP+ENV_VERSION 等价实现 |
| 目录软链接共享包 | 沙箱禁 symlink（已实测）；复制镜像 + `dsh.moduleFallback` 托管是正确适配 |
| Node IPC 控制通道 | 同 fd 管道条；文件信号 + 守候进程是沙箱内可行等价物 |

## 3. 阶段规划（映射 PR-004 里程碑）

### 阶段 0：启动健壮性（P1，约 0.5–1 天，不动构建）
1. `boot-state.json` 结构化启动状态（A1）——native/libdsh_host + ArkTS 两侧。
2. 解压锁 PID 活性判定（A3）。
3. profile 写入 pending 标记 + 坏 JSON 自愈（B1）。
4. 哨兵加 `arch=arm64`（B3）。
- 验收：真机冷启动不再轮询日志 token；并发/跨进程解压竞争窗口归零；profile 半写状态可自愈；模拟器/真机环境互窜快速失败。

### 阶段 1：M2 收尾（P2）
1. 目录级完整性清单（B2，脚本侧）。
2. `DshBackendController` 状态机抽取（A2）+ 重置路径确定性信号（A4）。
3. 恢复动作页三动作（B4），含"禁用第三方 bundle"。
- 验收：`DshmWebPage` 只消费控制器状态；错误页可一键禁用 dshm-* 外 bundle 并重启成功。

### 阶段 2：M3 插件与 brew 路径（P2）
1. brew formula 原生包清单核对（C1）+ Plan A 四项 smoke（E3）。
2. Plan A 版本组合断言（C3）。
3. pnpm 状态隔离（C4）+ 镜像校验强化（C2）。
- 验收：宿主模式下四项原生检验通过；低版本 brew dsh 触发回退提示；插件安装不污染 brew 缓存。

### 阶段 3：M4 全设备/PC（P2–P3）
1. 两段式更新协调器（D1，恢复在线更新时）。
2. 桌面 UX 补齐（F3）。
3. （可选，需求确认后）多 target 矩阵支持 x86_64 模拟器（E1）。

## 4. 风险与开放决策

- **上游本地补丁维护**：`runtime-payload-smoke.mjs` 的 fs-ext 修复位于上游 checkout 工作区，pull/重 clone 会覆盖；已记录于 `.local-rules/build-commands.local.md`，重打包前需检查。
- **上游缺陷回报**：fs-ext smoke 缺陷与 win-x64 打包链建议可向上游提 issue（未执行，待用户决定）。
- **brew formula 归属**：Harmonybrew dsh formula 是社区/本机资产，上游不背书；其演进时机与 DSHM 壳发布脱钩（C3 断言是唯一防线）。
- **模拟器需求真实性**：E1 是否启动取决于是否真有 x86_64 模拟器交付需求（Open Decisions，未定）。

## 5. 沉淀结论（按 skill-project-rule-governance）

- 本文落 `docs/`（开发规划，非强制规则）。
- 无新增共享 `.rules/` 条目；`.agent-rules/` 无需新增 active 条目（本文各动作在对应阶段实施时自然受 PR-001~004 约束）。
- 本机 win-x64 打包命令与上游缺陷已按边界写入 `.local-rules/build-commands.local.md`。

## 6. 上游锚点速查

| 文件 | 借鉴主题 |
|---|---|
| `src/backend-controller.ts` | A2 状态机 |
| `src/host-process.ts` / `src/host-protocol.ts` | A1 握手、传输（不照搬） |
| `src/project-manager.ts` | A3 锁、B1 事务、C1 allowBuilds、C4 隔离 |
| `src/runtime-tree.ts` | B2 清单、B3 arch 断言 |
| `src/startup-document.ts` | B4 恢复页 |
| `src/update-coordinator.ts` | D1 两段式 |
| `scripts/package-target.ts` / `scripts/runtime-file-policy.ts` | E1/E2 矩阵与裁剪 |
| `tests/fixtures/runtime-payload-smoke.mjs` | E3 smoke 形状（含本地 fs-ext 修复） |
