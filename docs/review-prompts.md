# 最终审核提示词（7 路，各自对抗性，判据 = 对齐官方 dsh）

> 本文件是「最后审核」用的校验提示词。目的**不是复述实现说明**，而是**证伪**：
> 每一路都必须拿出 `文件:行号` 或命令输出，报告"与官方 dsh 不一致 / 站不住"的地方。
> 审核对象：本仓库（HarmonyOS 包装层，核心是官方 `@deepseek-ai/dsh@0.2.0-rc.2`）。
> 基准纪律见 `AGENTS.md`。

## 共同约束（每一路都要遵守）

1. **只报能证明的**。没有证据的怀疑写进「无法验证」而非「问题清单」。
2. **不许把"看起来不同"当"不一致"**：包装层必须适配平台（ArkTS 无进程 env、沙箱禁 symlink 等），
   这类差异若**有注释说明理由且有验证记录**，属于合理适配，不算问题；**无理由的偏离**才算。
3. 严重度只允许：`阻断`（会导致功能不可用/数据错误）/ `高`（用户可见缺陷或契约违背）/
   `中`（维护陷阱、静默失败路径）/ `低`（一致性、可读性）。
4. 输出必须含「无法验证的项」，如实列出没能确认的，不要用推断填空。

---

## 路 1：协议契约对齐（`dshcompat` ↔ 官方 140 endpoint）

**判据**：`dshcompat/src/main/ets/Endpoints.ets` 必须与
`.research/protocol/contracts.json`（`corePackage=0.2.0-rc.2`，140 endpoint）**逐条一致**。

核验：

| # | 项 | 判据 |
|---|---|---|
| 1.1 | endpoint 集合相等 | 名字集合与 contracts.json 完全相同（无多、无少） |
| 1.2 | 每条的 `shape`/`stream`/`cancellable` 与契约同 | 抽查至少 15 条，含全部 13 条流式 |
| 1.3 | `shapeOf` 用的是 **wire 名** | 官方 30 个端点的 `name ≠ wire`；用错会 `gateway/arguments-invalid` |
| 1.4 | 能力映射（`CAPABILITIES` 15 项）指向的 endpoint 真实存在 | 无悬空引用 |
| 1.5 | 调用点不绕过 `dshcompat` | 全仓搜裸 endpoint 字符串（如 `'session/list'`）出现在 dshcompat 之外的地方 |
| 1.6 | `SUPPORTED_VERSIONS` 与 `UPSTREAM_IDENTITY` 自洽 | 与 `hostcore/core-recipe.json` 的 `coreVersion` 一致 |

**重点攻**：`capability: ''` 的 86 个端点里，有没有**官方 UI 已经在用、我们却没接**的（= 能力缺口被藏起来）？

---

## 路 2：Host 侧与官方语义的偏离（`hostcore/app/main.js` + `profile/ondevice/cordis.patch.yml`）

**判据**：端侧 Host 是官方 dsh 的**宿主包装**；对上游行为的每一处修改都必须**能说出为什么**。

核验：

| # | 项 | 判据 |
|---|---|---|
| 2.1 | 每处 `patch`/`override` 有理由注释 | 无注释的 monkey-patch / 配置覆盖 = 问题 |
| 2.2 | 没有**静默**吞错 | 空 `catch {}`、`.catch(() => {})` 而不记日志 |
| 2.3 | 退出/重启链自洽 | `requestStop` / `requestAppRestart` / `host-stop-request` 无竞态、无"停了不停" |
| 2.4 | `cordis.patch.yml` 的插件行与 `dsh.bundle` 语义一致 | 禁用项有理由；无孤儿行 |
| 2.5 | 已知未落盘项 | 连接抖动（gateway 心跳 `websocketHeartbeatIntervalMs`）是否仍为官方默认 2000ms，端侧是否有对应处置 |

**重点攻**：`main.js` 里有没有**只为绕过一个具体现象**而加的特判（样例如 `isRestartHelper`）——这些是否可能误伤正常调用？

---

## 路 3：插件安装/卸载生命周期（`dshm-installer.js` + `dshm-user-rows.js`）

**判据**：必须满足官方 plugin manager 的**可观测契约**，否则官方 UI 会报错。

核验：

| # | 项 | 判据 |
|---|---|---|
| 3.1 | 装完 `dependencies` 新增 key **恰好 1 个** | 否则官方 `ambiguous-install`（`lib/install.js`） |
| 3.2 | `node_modules/<name>` 目录名 **== dependencies key** | 官方注释明确依赖这条 |
| 3.3 | `dsh.bundle` 才登记 `dsh.profile.bundles`；plain 不登记 | 无孤儿登记 |
| 3.4 | **不写**用户行（`.dshm-plugin-rows.yml`） | 该文件只由端侧插件页维护 |
| 3.5 | **卸载对称** | `removeSpec` 是否清干净：`node_modules`、`dependencies`、`bundles` 三处 |
| 3.6 | 失败不留半残包 | 落位校验失败必须回滚（删目录 + 删 tmp） |
| 3.7 | GitHub 回退守卫 | `repositoryMatchesRequest` 同一性判断是否可被绕过；只回退一次是否真的成立 |

**重点攻**：`removeSpec` 的**对称性**——安装有严格的回滚，卸载有没有同样的清理？漏一处就是下次启动报错。

---

## 路 4：连接层与官方 gateway 语义（`connection/**` + `hostruntime/**`）

核验：

| # | 项 | 判据 |
|---|---|---|
| 4.1 | 重连退避与官方 `dsh-client-connection` 一致或有理由 | base/factor/max 是否自造 |
| 4.2 | 上行溢出（`uplink-overflow`）处置正确 | 丢弃 vs 阻塞，是否与官方同 |
| 4.3 | 心跳语义 | 是否有"Pong 超时即掐连接"的误杀路径；端侧是否可配置 |
| 4.4 | 无静默断连 | 断连必须对用户可见（banner）且日志可查 |

**重点攻**：用户反复报的「正在连接 ↔ 连接成功」抖动，**代码里能否找到成因**？

---

## 路 5：端侧桥与环境注入（`hostruntime/src/main/ets/runtime/**`、`entry/.../NodeRuntime.ets`）

核验：

| # | 项 | 判据 |
|---|---|---|
| 5.1 | env 注入 5 项（`DSHM_CORE_DIR/HOME/SANDBOX_HOME/PORT/PROFILE`）全覆盖 | 少传会静默用默认目录 |
| 5.2 | 端口/目录不硬编码两次 | 端侧与 `main.js` 默认值不得冲突 |
| 5.3 | 停止路径干净 | `host-stop-request` 写入 → `port.stop()` → 超时兜底 |
| 5.4 | 不写预期外的路径 | 全仓搜 `filesDir` 拼接，确认都落在 `dsh/` 下 |

---

## 路 6：工程纪律与残留（全仓，判据 `AGENTS.md`）

核验：

| # | 项 | 判据 |
|---|---|---|
| 6.1 | 无一次性排查脚本留在 `tools/` | 逐个 `tools/` 文件说明是否长期门禁 |
| 6.2 | 无 `.bak`/实验残留/被注释掉的实验代码 | 全仓搜 |
| 6.3 | 注释与代码**相符** | 注释说 A 代码做 B = 问题（最难查最坑） |
| 6.4 | 无重复定义的同一常量 | 一处改了另一处没改 |
| 6.5 | **任何脚本都不含删 el2 的命令** | 全仓搜 `uninstall`/`rm -rf` |
| 6.6 | 文档描述的"当前形态"与代码一致 | 抽查 `README.md`、`docs/50`、`docs/70` 的关键论断 |

---

## 路 7：端侧 UI 对官方能力的遮挡（`entry/src/main/ets/pages/WebApp.ets`、`view/**`）

核验：

| # | 项 | 判据 |
|---|---|---|
| 7.1 | ArkTS 壳没有**隐藏官方功能** | 菜单/设置项是否为官方原有的子集 |
| 7.2 | 原生新增项**都是必要**的（平台必需），且不放进官方菜单造成误导 | 例如"退出应用"不应在顶栏菜单 |
| 7.3 | `docs/parity-matrix.md` 的声明与代码一致 | 声明 DONE 的行在代码里真有实现 |
| 7.4 | 无 App 内测试菜单 | 用户明确要求 |

**重点攻**：`WebApp.ets` 里有没有**残留的自检/探针入口**（语音自检、重放自检等）留在正式菜单里？

---

## 输出格式（七路统一）

```
## 结论
（一句话：通过 / 有 N 个问题）

## 问题清单
| 严重度 | 位置 | 问题 | 证据 | 建议 |
|---|---|---|---|---|

## 无法验证的项
```/n