# DSHM 运行时环境调研报告：内置 vs Harmonybrew 路线

> 日期：2026-09-11
> 背景：插件安装会话重启后无法对话；embedded 模式缺 python/pnpm/node 入口；
> Harmonybrew 的 deepseek-harness 有完整 OHOS 补丁集与原生 node。
> 参考项目：
> - https://gitcode.com/MakeBlackSheepGreat/dsh-OHDSH（本项目旧仓库）
> - https://harmonybrew.atomgit.com/packages/#formula/deepseek-harness
> - https://github.com/social4hyq/homebrew-core（含迁移前的 deepseek-harness formula）

---

## 一、两个参考项目的核心做法

### 1.1 dsh-OHDSH（本项目旧仓库 = 当前仓库的前身）

核心脚本 `scripts/apply-dsh-ohos-adapt.sh`（950 行），在 npm 安装完 dsh 后对
node_modules 树应用 OpenHarmony 适配：

| 补丁类别 | 具体内容 | 解决的问题 |
|---|---|---|
| 原生模块 stub | sharp/node-pty/koffi → JS stub 或重编 | OHOS 无预编译 binding |
| bundle patch | 禁用沙箱链/权限/hmr 插件 | 鸿蒙沙箱不需要这些 |
| app-boot patch | activation 检查降级为 warn | 沙箱内激活服务不可达 |
| bash/fs 注册 | 补注册 dsh-bash-local/dsh-fs-local | 官方 host composition 不在 npm 包内 |
| sandbox-policy | mode 改为 danger-full-access | tool-bash 需要 ctx.sandboxPolicy |
| TMPDIR | 重定向到可写分区 | /tmp 只读 |
| symlink 降级 | EACCES→cpSync 整目录复制 | 沙箱禁 symlink |
| 凭据模式 | 跳过系统 keychain | 沙箱内不可用 |
| ripgrep | 回退 JS 实现 | OHOS 无 ripgrep 二进制 |
| crypto | polyfill | 部分 crypto API 缺失 |

### 1.2 Harmonybrew deepseek-harness

| 特性 | 内容 |
|---|---|
| 运行时 | Harmonybrew node v26.8.1（llvm@22 重编，原生 OHOS，含 JIT） |
| 补丁集 | link 兜底 / 凭据模式 / ripgrep 回退 / crypto polyfill / 无沙箱放行 |
| 安装方式 | `brew install deepseek-harness`（bottle 预编译，秒装） |
| 运行位置 | `/data/service/hnp/`（公有 HNP）或 `~/.harmonybrew/`（用户级） |
| 权限 | HiShell 场景有内核权限（无沙箱限制）；应用沙箱内受限 |
| 更新 | `brew upgrade` 一条命令（bottle 从 CDN 拉取） |

**关键差异**：Harmonybrew 路线**不需要解决 ELF 签名问题**——因为 brew 装的
node/dsh 是通过 HNP（HarmonyOS Native Package）安装的，HNP 安装由 appspawn
处理，会自动授予执行权限。而 HAP 内 libs 的 .so 文件没有执行位。

---

## 二、当前问题诊断

### 2.1 插件安装会话重启后不能对话

**根因链**：
1. 插件安装 = dsh 在会话内跑 pnpm（通过 Worker 桥或 bash 工具）
2. Worker 桥跑 pnpm.cjs 需要进程内 node（**有**，libnode）→ 可行
3. bash 工具跑 pnpm → 需要 PATH 里有 node → **之前没有**（今晚已修）
4. 安装中途重启 → 原子写被打断 → `.credentials.yaml.lock` 残留 → 下次启动
   `atomic-write: timed out` → SIGNAL 6 → **应用起不来 → 会话不可对话**

**解决方案**（已实施部分）：
- ✅ PATH 注入 brew node（dsh_host.cpp 已改，ENV_VERSION=109）
- ✅ pnpm wrapper 自动生成（DshBootstrap.ensurePnpmWrapper）
- ⬜ 启动前清理陈旧 .lock 文件（**待做**：DshBootstrap 里加一步）
- ⬜ 会话恢复健壮性（dsh 侧问题，需上游修复或壳层兜底）

### 2.2 embedded 模式缺 python/pnpm/node

**已解决**：
- ✅ node：Harmonybrew node v26.8.1 通过 PATH 注入（pty 实测 exec OK）
- ✅ pnpm：wrapper 脚本桥接到 brew node（pnpm 10.6.3 实测 OK）

**未解决**：
- ❌ python3：无现成 ohos-arm64 预编译。选项：
  a) Harmonybrew `brew install python`（用户装了 brew 就有）
  b) 自己交叉编译（工作量大，维护成本高）
  c) 引导用户用 uv 装（WorkBuddy 的做法——uv 有 ohos bottle）
- ❌ zstd：busybox 无 zstd applet，系统 toybox 也没有
  → 影响会话轨迹读取（dsh 自己可能内嵌了 zstd 解压，纯 JS 的）
  → 非阻塞问题

### 2.3 签名问题汇总

| 场景 | 签名要求 | 当前状态 |
|---|---|---|
| HAP 安装 | 调试 profile（含 ACL） | ✅ 已解决（21:49 材料，6 条 ACL） |
| 沙箱内 exec ELF | codesign 按页覆盖全文件 + 应用签名身份 | ❌ 需 keystore 明文密码 |
| HNP 安装 | hvigor 需支持 hnpPackages | ❌ 当前 hvigor 版本不支持 |
| JIT（V8） | ACL + XPM 代码页签名 | ❌ debug 签名过不了 XPM |

---

## 三、方案对比与建议

### 方案 A：**embedded + Harmonybrew node 桥接**（当前方向，推荐）

**思路**：不把 node/python 打进 HAP，而是**检测设备上已有的 Harmonybrew 环境**，
有则桥接（PATH 注入 + wrapper），无则降级为纯 jitless 内置。

**已实现**：
- dsh_host.cpp PATH 注入 `.harmonybrew/bin`
- DshBootstrap.ensurePnpmWrapper 生成 pnpm 桥接脚本

**待补**：
- ⬜ 启动前清理 `.credentials.yaml.lock` 残留（防重启死锁）
- ⬜ ensurePnpmWrapper 在 ENV_VERSION 变化时幂等重生成
- ⬜ python：引导用户 `brew install python`（Harmonybrew 有 python formula）
  或 `brew install uv` + `uv python install`（WorkBuddy 同款思路）

**优点**：
- node/python/zstd 由 Harmonybrew 管理，不用打进 HAP（省 100MB+）
- `brew upgrade` 即可更新运行时
- 补丁集由 Harmonybrew 维护（deepseek-harness formula 内置 OHOS 补丁）
- 我们的 HAP 只做壳 + 内置 jitless 兜底环境（无 brew 时可跑核心）

**缺点**：
- 依赖用户装 Harmonybrew（可在 App 内引导一键安装）
- 两套 $DSH_HOME 的会话库不互通（需 UI 提示或统一到 brew 的 home）

**体积**：HAP 可回到 ~130MB（去掉 libnode 121MB 如果纯壳化）
或维持 ~240MB（保留 jitless 兜底）。

### 方案 B：**纯壳 + Harmonybrew 必装**

**思路**：HAP 不带任何运行时（~7MB），必须先装 Harmonybrew。

**优点**：最轻量，环境最完整（python/pnpm/node/zstd 全有）
**缺点**：无 brew = 不可用；安装门槛高；不满足"开箱即用"

### 方案 C：**HNP 路线**（未来）

**思路**：把 node/dsh 打成 HNP 包嵌入 HAP，由安装器解压到私有 hnp 目录并
授予执行权限。

**现状**：hvigor 当前版本不支持 hnpPackages 打包（实测 HAP 内 hnp 条目=0）。
需等 DevEco/hvigor 更新，或用 app_packing_tool --hnp-path 手动打包。

**优点**：环境完全自包含 + 执行权限由系统授予
**缺点**：工具链不支持；HNP 包体积大（node 122MB）；与 Harmonybrew 重复

### 方案 D：**申请正式签名 / 上架**

**思路**：通过 AGC 上架拿到 release 证书 → binary-sign-tool 用应用身份签
node ELF → 可放 libs + executableBinaryPaths 声明 → 安装器自动 +x →
沙箱内可 exec。

**优点**：一劳永逸解决签名问题；JIT 也可能通过 XPM 校验
**缺点**：需要上架审核；证书绑定应用身份；每次更新需重签

---

## 四、推荐实施路径（分阶段）

### 阶段 1（当前，本周内）：修补 embedded 可用性
1. ⬜ 启动前清理 `.credentials.yaml.lock` 等残留锁文件（DshBootstrap 加一步）
2. ⬜ 文档/UI 提示：插件安装建议切 host 模式（embedded 缺 python）
3. ⬜ 确保 PATH 注入 + pnpm wrapper 在 ENV_VERSION 变化时幂等重建

### 阶段 2（1-2 周）：Harmonybrew 深度集成
1. ⬜ 检测 `.harmonybrew` 存在性 → UI 显示「检测到 Harmonybrew 环境，可用完整功能」
2. ⬜ 未安装时显示引导：一键跳转终端执行 `brew install deepseek-harness`
   （或 App 内嵌 Terminal 组件直接跑 brew 命令）
3. ⬜ 统一 $DSH_HOME：embedded 与 host 都用 `~/.dsh`（需要 libdsh_host
   的 HOME 从 filesDir/home 改为 /storage/Users/currentUser）→ 解决会话不互通
4. ⬜ python：提示用户 `brew install python3`（Harmonybrew core 有）

### 阶段 3（上架时）：签名升级
1. ⬜ 用 AGC 正式证书重签 node ELF → executableBinaryPaths 路线
2. ⬜ 或打包 HNP（等 hvigor 支持）
3. ⬜ JIT 权限申请（ACL 审批 + XPM 校验随 release 签名解决）

---

## 五、关于「brew 的 dsh 编译依赖」

**不需要我们解决**：Harmonybrew 的 deepseek-harness formula 已内置全部 OHOS
补丁，用户 `brew install` 一条命令即可，bottle 是预编译的（不需要本地编译）。

**我们从 GitHub 源码更新 dsh 的痛点**（每次要重跑 prepare-dsh-env.sh +
apply-dsh-ohos-adapt.sh + 手动适配新版）在 Harmonybrew 路线下完全消失——
升级 = `brew upgrade deepseek-harness`。

**我们只需要做**：让 App 的 host 模式能正确发现并使用 brew 装的 dsh
（当前 hostDsh 路径检测 `/storage/Users/currentUser/.harmonybrew/bin/dsh`
已实现且工作正常）。

---

## 六、一句话结论

**走 Harmonybrew 路线（方案 A），embedded 只做兜底。** 我们不需要自己解决
编译依赖——Harmonybrew 的 deepseek-harness formula 已经解决了全部 OHOS
适配问题，且 bottle 预编译秒装。我们把精力放在：
1. 修补 embedded 兜底模式的可靠性（清锁文件、防崩溃）
2. 深度集成 Harmonybrew（检测/引导/统一 HOME/PATH 桥接）
3. 上架时再拿正式签名补全 embedded 的执行能力
