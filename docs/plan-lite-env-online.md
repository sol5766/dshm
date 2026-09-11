# DSHM 轻量化改造规划：容器（壳）+ 在线环境预设

> ## ⛔ 本文档状态：**方案已停用（2026-09-11）**
>
> **客户端侧的在线环境包能力已按用户决定整体移除**，因此本文描述的路线**当前不在产品里**：
> - 已删除：菜单「安装在线环境包（开发）」、`entry/src/main/ets/dshm/env/EnvAssetClient.ets`、
>   `DshBootstrap` 的备份/暂存/待验收/回滚全套机制、`.dshm-asset-version` 与 `.dshm-pending-verify` 两个标记。
> - 已停用（保留脚本但不被调用）：`scripts/build-env-asset.mjs`、`scripts/dev-env-server.mjs`、`scripts/env-asset-sources.json`。
> - 现状：**升级方式 = 装新的 HAP**；包体问题改由「环境瘦身」解决（253.5MB → 110.7MB，HAP 385MB → 238MB，见 `dsh-version-upgrade.md` §4.1 第 6 条）。
> - 本文**保留全文**作为日后恢复在线更新 / 纯壳路线的设计参考；被删代码可在 git 历史中找回（提交标题含「纯净版」）。
>
> 若日后要恢复，请先读 `docs/dsh-version-upgrade.md` §3.2 的操作要点，以及 §5.5「确认运行模式」——
> 纯壳路线与「宿主 dsh」路线的边界必须先想清楚（两者都依赖设备上存在外部 dsh）。

> 状态：规划稿 v2（2026-09-09）。用户已确认 D1=纯在线（无网不启动，用离线导入兜底）、下载源=内置 5 加速源 + 失败自动切换。已加入 busybox 实测结论与 brew/zsh 宿主通道讨论。
> 关联：`docs/device-runtime-fixes.md`（现有沙箱运行机制）、`docs/CHANGELOG.md`、`.agent-rules/bug-log.md`。
> 背景确认：`ACCESS_USER_FULL_DISK` 等权限经重签后已生效（用户已实测可用）。

---

## 1. 目标与动机

1. **初次启动太慢**：当前 `DshBootstrap` 首启要把 rawfile 里 **441MB** 的 dsh 环境（6万+ 文件）从 HAP 解包进沙箱，加上 ENV 校验与 profiles 复制，冷启动秒级不可接受。
2. **包体过大**：`entry-default-signed.hap` 实测 **670,633,909 B ≈ 640MiB**，远超"轻应用"预期，也是安装/分发痛点。
3. **运行时可切换性**：对标用户描述的 workbuddy（只内嵌 nodejs/V8 做服务端 JS 运行时，另有 Python）。要求：运行栈瘦身到「Node 内核即可」，废除非必要外壳（busybox/pnpm/大依赖），Python 作为可选项。
4. **交付形态**：**容器（小 HAP）随安装即时可用下载页；环境本体首次在线下载 → 校验 → 解压部署 → 部署完成后启动应用**。二次启动直接走已部署环境。

---

## 2. 现状量化（2026-09-09 实测，规划依据）

### 2.1 HAP 构成（`python zipfile` 实测 signed HAP）

| 组成部分 | 体积 | 说明 |
|---|---|---|
| `resources/rawfile/dsh`（node_modules 整树） | **308 MB** | DSH 本体 + 197 个依赖包 |
| `resources/rawfile/pnpm` | **132 MB** | pnpm 分发包（app-boot 二次安装 fallback） |
| `resources/rawfile/busybox` | 1 MB | sh/bash 等 applet |
| `libs/arm64-v8a/libnode.so` | 127 MB | **重复了两份**（`libnode.so` + `libnode.so.137`） |
| `libs/arm64-v8a/libc++_shared.so` | 1.3 MB | |
| `libs/arm64-v8a/libdsh_host.so` | 0.1 MB | native host（node 启动+日志） |
| 其它（ets 字节码、resources.index 等） | ~1 MB | |

`libnode.so` 重复 = 至少白扔 ~127MB。核对 native 引用后只保留一份。

### 2.2 dsh node_modules 中可剥离大头（预期可砍 ~100-250MB）

| 包 | 体积 | 理由/去留 |
|---|---|---|
| `node-pty` | 26M | 终端能力；鸿蒙无 PTY 支撑 → **去**（运行时校验按需） |
| `typescript` | 21M | DSH 内部 code-gen 用；若预设需要则保留（在线包内不占壳） |
| `pnpm` | 19M | 与 rawfile/pnpm 132M 重复 → 壳内**去**（在线预设含**无 pnpm** 的闭包） |
| `@opentelemetry` * | 31M | 遥测 → 默认去，留开关 |
| `@deepseek-ai` | 39M | DSH 全家桶（本体+client+host…）→ 在线包必含 |
| `@google`/`openai`/`@anthropic-ai`/`@aws-sdk` | ~45M | LLM SDK 各有用，进在线包；`@google` 超大（protobuf）按使用情况裁剪 |
| 其余（zod/web-streams 等） | ~100M | 依赖闭包，保留 |

**结论**：在线包 = dsh 运行必需闭包（去 pty/otel/冗余 SDK 后 ~250M 源码 + 压缩 ≈ **在线传输 ~120-200MB**）。壳内 node 必需引擎 libnode 保留 **127M（单份）** → **HAP 目标 ≤ 160-180MB**（后续可再降到 30M 内，见 §4.2 可选项）。

### 2.3 现状首启耗时组成部分（待测基线）

计划在 M0 加 `DshLogger` 打点（现有 `DshmLogger`），对四段分别计时：
1. rawfile 解包（dsh 308M/busybox/pnpm 132M）
2. `ENV_VERSION` 校验 + profiles 组装
3. libnode 冷启动（node -e / -D shim）
4. dsh web 就绪（3080 LISTEN + `dsh web:`）

---

## 3. 目标架构

### 3.1 拆成两层

```
┌─────────────────────────── DSHM 壳 (HAP, ~150-200MB) ──────────────────────────┐
│ ArkTS UI  下载/部署/启动页 + 主功能 ArkWeb 页（可复用现有 DshmWebPage）          │
│ libdsh_host.so + libnode.so（1 份,V8/Node24, 沙箱内已适配 W^X --jitless）      │
│ 环境工厂（EnvProvider）：检查本地预设 → 下载（断点/校验） → 校验 → 解压 → 就绪挑    │
│ 出厂 fallback：tiny core 兜底（可选）                                          │
└───────────────────────────────────────────────────────────────────────────────┘
      ▲ 下载/校验/部署（后台，UI 进度）
      │  HTTPS GET（中断重试 + sha256 校验）
┌──────────────── 在线环境预设（asset, ~120-200MB 压缩传输） ──────────────────────┐
│ manifest.json       版本 / 引擎 / 依赖 / 大小 / sha256 / 发布者签名             │
│ hardware-independent payload: dsh node_modules 闭包(压缩)                       │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 启动流程（目标时序）

**首次安装（在线）**：
1. 首启读 `filesDir/env/<version>/.dshmenv-version` 不存在 → 进入「部署中」页
2. 下载 manifest → 校验；下载 payload（断点续传，进度条）→ 校验 sha256+签名
3. 本地解压（node/zlib 内建，不需要 busybox；hvigor 包内 `/vtools` 可后续用 txz）
4. 落 `filesDir/env/<rev>/`，写 `.dshmenv` 标记当前 rev
5. 拉起 libnode → `dsh web` → 3080 就绪 → 换入 ArkWeb 主界面

**二次启动**：命中标记 → 直接复用已部署环境（跳过下载/解压，毫秒级启动到 ArkWeb）。

**版本升级**：manifest rev 变化 → 后台预下载新 rev，下次启动原子切换（旧 rev 可回退）。

### 4.3 与原有机制的兼容

- 保留 `ENV_VERSION` 校验机制，只是「环境」由「HAP 内 rawfile」改为「在线预设」，版本号升级到 `20260910-60+` 一代。
- 保留 `profile` 复制/覆盖模式（沙箱无 node 符号链接、不重写 workspace，`dsh-app-boot` 不动）。
- `rawfile/dsh` 仍是义拯救；改为 `rawfile/env-downloader`（下载/校验/部署逻辑本身进 HAP）。

---

## 4. 运行时瘦身（对标 workbuddy：Node/V8 仅 + Python 可选）

### 4.1 原则：Node 就是 V8，无需换引擎，只需砍外壳

- 现状：`libnode.so`（Node24/V8，HAP 内）已经是「Chrome V8 引擎的 JS 运行时，用于服务端开发」（= workbuddy 方案）。**不用换引擎**，要做的是**只保留 Node**：
  - pnpm（132M + 19M 两处）→ 鸿蒙沙箱无 symlink，插件安装本来就是「目录复制 fallback」（`app-boot` 的 cpSync），**pnpm 可去**，替换为内置 `node` 复制脚本
  - 其余大包按 §2.2 裁剪
- busybox 结论见 §4.1.1（实测：**必须留**）
- `--jitless`、`_fetch-shim`、W^4 沙箱约束**不变**（不属本规划范围）

### 4.1.1 busybox 能不能不要？（实测修订 v3）

- **审计结果**：`dsh/node_modules/@deepseek-ai` 全部 19 个匹配文件里，**没有直接引用 `busybox` 字符串**；但**大量 Agent 工具 spawn `sh`/`bash`**：`dsh-tool-bash`、`dsh-tool-bash-persist`、`dsh-bash-sandbox`、`dsh-terminal-bash`、`dsh-tool-fs`、`dsh-tools`、`dsh-client-connection`、`dsh` 主体、`dsh-web-frontend`。
- **关键新证据（2026-09-09）**：`D:\desktop\demo`（鸿蒙 PC 2in1 移植项目）证明 **app 沙箱能 exec 宿主 shell + 开 pty**（`forkpty`/`posix_openpt`/`execl("/bin/sh")` 全部可跑，见 `entry/src/main/cpp/pty_diagnostic.h` + `napi_init.cpp`）。即鸿蒙 PC 设备上不再依赖「busybox 提供 bash」——宿主自带的 zsh/bash（Harmonybrew 安装的）可以被直接 exec。
- **修正结论**：busybox **不必内置**——在 2in1/PC 形态下由「宿主 shell 桥」替代（见 §4.3）；但作为**兜底**（平板/手机形态 + 没有宿主工具时）保留一个最小副本成本极低（1MB，且可随在线包发，不占 HAP）。
- 交付默认：**HAP 不再内置 busybox；由 native 桥优先探测宿主 zsh/bash，找不到则回退到在线包附带的 busybox**。

### 4.2 宿主工具链方案（Harmonybrew + zsh + Python —— 采纳，作为 v1 目标）

- **前置确认（2026-09-09）**：
  - 用户确认：鸿蒙 PC **本地可调用 zsh**。
  - brew 移植项目：**https://atomgit.com/Harmonybrew**（Homebrew 的 OpenHarmony 移植，安装命令即 `zsh -c "curl … install.sh"`，提供 `brew install python` 等）。
  - 用户其他鸿蒙 PC 移植项目（参考 `D:\desktop\demo`）已验证 **pty 在 app 沙箱可用**。
- **结论**（推翻此前 v1/v2 的「宿主不可达」）：在**鸿蒙 PC（2in1）形态**下，**「宿主通道」可行且应作为主路径**。实现方式参照 demo：
  1. **native 桥（NAPI）**：DSHM 已有 `libdsh_host`（启动 node 的 NAPI 模块），在此之上**新增 `host_pty.c`/`host_exec.c` 两组原生方法**（复刻 `demo/cpp/pty_diagnostic.h` 模式）：
     - `execHost(cmd: string, argv: string[], opts): Promise<{code,stdout,stderr,shell}>` → 内部 `fork + execv`（宿主 zsh/bash）
     - `forkPty(cmd, argv, term)` → `forkpty` 语义返回 master fd + 流式 IO（node-pty 能力）
     - `probeShell(): string[]` → 依次探测 `/bin/zsh /system/bin/zsh /bin/bash /system/bin/bash /system/toys/sh` 等是否存在可执行
  2. ArkTS 侧启动时 `probeShell()` → 把宿主 shell 路径写入 `DSHM_HOST_SHELL` 配置；DSH 的 `bash` 工具走它。
  3. Python：宿主 `brew install python3` 后，桥提供 `execHost('python3', …)`；DSH Python 工具默认找宿主 python，找不到则提示/回退 v2 内置。
- **安全边界**：native 桥只暴露「exec 绝对路径」接口 + PATH 白名单（zsh/bash/python3/brew/pnpm/node）；禁用相对路径/通配；默认超时；禁止无参 exec。
- **回退链**：宿主 shell → busybox 兜底（在线包）→ 报错指引安装 Harmonybrew。

### 4.3 与 demo 的具体对照（怎么搬过来）

- demo native 面（`entry/src/main/cpp/napi_init.cpp` + `types/libentry/Index.d.ts`）给了完成的实践样板：
  - `runForkptyTest`：`forkpty()` 全流程——**已验证鸿蒙 PC 可跑**
  - `runShellControlTest`：`fork()`+`execl("/bin/sh","-c",…)`+`waitpid`+pipe 回读 —— **已验证宿主 shell 可执行**
  - `runElfExecTest`：`chmod(755)`+`execv` 且校验档（对在沙箱内运行自带的第三方 ELF 很关键）
  - `runToyboxTest`：toybox 命令输出回读
- 迁移动作：把 demo 的 `pty_diagnostic.(h|cpp)` 裁剪为 `host_exec.cpp`（去掉诊断自毁 options），挂到 DSHM `entry/src/main/cpp/CMakeLists.txt`，导出 `HostBridge` 供 ArkTS/DSH 两侧使用；node 侧用 `child_process.spawn` 直接复用宿主（无需新建 pty 桥时）。

## 5. 多源下载与 5 源自动切换（在线预设拉取）

### 5.0 源选择（2026-09-09 实测本机可达性）

| # | 源 | URL 模板 | 实测 | 说明 |
|---|---|---|---|---|
| 1 | GitHub Releases 直连 | `https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>` | ✅ 200 | 官方源 |
| 2 | gh-proxy.com | `https://gh-proxy.com/<完整GitHub URL>` | ✅ 200 | GitHub 加速代理 |
| 3 | ghproxy.net | `https://ghproxy.net/<完整GitHub URL>` | ✅ 200 | GitHub 加速代理 |
| 4 | 华为云镜像 | `https://mirrors.huaweicloud.com/...` | ✅ 200 | 可托管镜像/OBS |
| 5 | 用户自定义 | 配置项 `source[4]` | - | 内网/OBS/自建，默认空 |

> 用户要求：内置 5 源「一个不行换一个」→ 下载器按序探测，超时/HTTP 4xx/5xx/连接失败即换下一源；全 5 源失败 → 明确报错 + 「导入离线包」入口。

### 5.1 下载器协议

- manifest（`meta.json`，随包）声明：`version`、`engine`（node 版本复用）、`asset.url[]`（5 源全列）、`asset.sha256`、`asset.size`；内置公钥验签。
- 失败策略：逐源 failover（含断点续传 range）+ 每源超时 10s + 重试 3 次 → 5 源失败置「离线导入」态。
- 校验：sha256 必验 + 签名必验（防源劫持换包）；全部通过才解压。

### 5.2 解压与部署

- 解压用 node zlib/tar 内建（不依赖 busybox）；落盘 `filesDir/env/<rev>/`；写`.dshm-env` 标记。
- 部署中：后台线程 + UI 进度（N%）。

### 5.3 兼容原机制

- 保留 `ENV_VERSION` 校验机制，只是「环境」由「HAP 内 rawfile」改为「在线预设」，版本升级到 `20260910-60+`。
- 保留 `profile` 复制模式（沙箱无 symlink）；`dsh-app-boot` 不动。
- `rawfile/dsh` 不再内置；`rawfile/env-downloader`（下载/校验/部署逻辑本身进 HAP）。

---

## 5A. 里程碑（v2）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M0 基线测量**（0.5d） | 在线设备上采样四段时序；`probeShell()` 实测鸿蒙 PC 各 shell 路径；确认 zsh/brew 可用集 | 精确耗时表 + 宿主 shell 探测结果 |
| **M0.5 宿主桥**（0.5-1d） | 按 demo 裁剪出 `host_exec.cpp`（execHost/forkPty/probeShell）+ CMake 挂接 + ArkTS 调用 + `DSHM_HOST_SHELL` 写入 | demo 模式跑通：host 调用 zsh→bash→python 逐项输出 |
| **M1 壳瘦身**（0.5-1d） | libnode 去重（省 127MB）；去掉 HAP 内 busybox/rawfile 直接依赖；在线包接管 | HAP ≤ 基线 mv，构建通过 |
| **M2 预设打包 + 5 源下载器**（2d） | `build-env-asset.mjs` 出 tar.gz（含 busybox 兜底）+ manifest（5 源表+sha256+签名）；failover 下载器 | mock 源手测：换源→OK；bad sha256→拒装 |
| **M3 启动时序改造**（1d） | 首启「部署中」页；二次启动直接秒开；升级原子切换+回退 | 首启（在线）<60s；二次 <10s |
| **M4 回归**（0.5d） | §4.5 RPC 全过程 + ArkWeb 闭环回归 + 宿主 Python 链路回测 + 文档同步 | 全绿 + 数据落地 |


## 6. 风险与决策点

| 风险/决策 | 对策 |
|---|---|
| 在线下载依赖网络（弱网/内网） | 断点续传 + 重试 + 源多镜像可配；可选「离线导入」入口（把 asset 文件拷贝进 app 沙箱由 IVF` 提供） |
| 首建解压仍耗时（440M 文件级 IO） | 压缩单文件传输会显著降体积（tar.gz 传输 ~120-200M）；解压并行/逐包；M3 打点确认 |
| `on save on libnode 重复 127M` | M1 直接删一即可 |
| 下载源被篡改 | manifest 内 sha256 + 内置公钥签名验签 |
| `node-pty` 等被 DSH 某些插件动态引用 | 运行时做好「缺失模块探针」→ 提示安装 optional（不进主预设） |
| 沙箱限制解压到自定义路径 | 全部落 `filesDir/env/…`，沿用现有 profiles 复制模型 |

**决策点（已确认 2026-09-09，v3 修订）**：
- D1 ✅ 纯在线：无网不连，配「导入离线包」入口兜底
- D2 ✅ 下载源：内置 **5 源**（GitHub 直连 / gh-proxy.com / ghproxy.net / 华为云镜像 / 用户自定义），一个失败自动换下一个
- D3 ✅ busybox：**不再必须内置**（v3 修订）——鸿蒙 PC 下宿主 shell 经 native 桥可执行，busybox 降级为在线包兜底（平板/无宿主时）
- D4 ✅ Python：**宿主通道采纳**（鸿蒙 PC 形态经桥 exec Harmonybrew python3；电话/平板回退内置 CPython 或远程执行器）
- D5 (新) 宿主桥白名单：仅 exec 绝对路径（bin/bash / system/zsh / bash / python3 / brew / pnpm / node），禁通配/相对/无参

---

## 附：实施顺序建议（第一刀）

1. M0：挂 4 段计时器（先量出「解包占多少、node 冷启占多少」）— 数字不劣化就继续做，不猜。
2. M2 顺序：先本地「伪下载」（从 dev PC 拷 asset 到 `/sdcard` 模拟源）验证整条链（校验/解压/启动），再接真网络。
3. 每一步都有 `test-*.mjs` 单测 + `ui-test-phone.sh` 回归兜底，与既有文档体系同步。

---

## 实施进展与修订（2026-09-11）

> 本节记录落地过程中的事实修订与已完成项；与上文冲突时以本节为准。

### 修订 R1：资产格式 tar.gz → **zip**（已由 SDK 证实）

- **原定**（§5.2 / M2）：tar.gz，解压「用 node zlib/tar 内建」。
- **事实**：**解压发生在 ArkTS 侧**——此时设备上还没有 node，因为环境本身就是待部署物。原假设「有 node 可用」不成立。
- **依据**：`sdk/default/openharmony/ets/api/@ohos.zlib.d.ts` 明确 `@ohos.zlib` 是 Zip 模块，`decompressFile(inFile, outFile, options)` 支持把 zip 解压到目录，且注明中文名需 UTF-8；tar 无任何系统支持，需在 ArkTS 里手写 tar 解析。
- **结论**：资产改为 **zip**。打包侧 `scripts/build-env-asset.mjs` 用纯 Node 实现（deflateRaw + 自算 CRC32，不依赖 bsdtar / Compress-Archive，规避 Windows 侧长路径与非 ASCII 行为差异）。

### 修订 R2：下载源不能照抄「GitHub Releases」

- 本仓库 remote 已迁到 **GitHub**（`github.com/sol5766/dshm`，2026-09-11）。
- 5 源模板独立成 `scripts/env-asset-sources.json`，GitHub Releases 附件为**主通道**（发布前须实测 `HTTP 200` 且 `content-length` 与 `manifest.asset.size` 一致）；`gh-proxy.com` / `ghproxy.net` 仅在同时建立 GitHub 镜像时才有意义；另留用户自建镜像槽。
- 另设**本地联调通道**（`_devMock`）：开发机起静态服务器托管 `dist/env`，用 `hdc fport` 映射到设备 loopback，即可走完整条 `下载 → sha256 → 解压 → 哨兵 → 启动` 链路，无需先完成外网发布（即上文「附：实施顺序建议」第 2 条）。

### 已完成：M2 打包器

`scripts/build-env-asset.mjs`（新增，版本号自动读 `DshBootstrap.ENV_VERSION`）：

- 输入 `entry/src/main/resources/rawfile/{dsh,busybox,ohos-skills}`（构建期已由 `prepare-dsh-env.sh` + `apply-dsh-ohos-adapt.sh` 适配好）。
- 产出 `dist/env/dsh-env-<version>.zip` + `manifest.json` + `SHA256SUMS`。
- manifest 含：`schema`、`version`、`engine{node,platform,arch}`、`asset{name,format,size,sha256,entries,extractTo,sentinels,urls[]}`。**`sentinels` 与 `DshBootstrap.verifyDshSentinel()` 对齐**，避免重演 2026-09-11 那次「更新侧与启动侧校验清单不一致 → 更新被静默抹掉」。
- 首次实测：**12,499 文件 / 113.5 MB → zip 30.5 MB（8.5s）**，`sha256=825f2e4e…8deab`；用 .NET `ZipFile` 回解校验：**文件数/总字节与原树完全一致、抽样文件逐字节一致**。

### 里程碑状态

| 阶段 | 状态 |
|---|---|
| M0 基线测量 | 🟡 部分完成：`boot-timing.txt` 已有四段打点（`t1.dshEnv`≈3.2s，`t5.serverReady`≈11-25s，后者才是大头，与上文「解包是大头」的假设相反） |
| M0.5 宿主桥 | ❌ 未开工；且实测设备 `/data/service/hnp/bin` 下 **bash/zsh/brew/python3 全部缺失**，D3「busybox 不必内置、宿主 shell 为主路径」的前提在当前设备**不成立**，busybox 兜底仍必需 |
| M1 壳瘦身 | 🟡 部分完成：HAP 已从 ~640MB 降到 251MB（移除 `rawfile/pnpm` 132MB、libnode 去重）；把 `rawfile/dsh`（112MB）移出 HAP 是本路线 M3 的前置 |
| M2 预设打包 + 5 源下载器 | 🟢 打包器 ✅；**failover 下载器 + sha256 + zip 解压 + 哨兵校验已在真机跑通**（见下） |
| M3 启动时序改造 | 🟢 **原子切换与回退已实现并真机验证**；首启「部署中」页、二次启动秒开 ❌ 未开工 |
| M4 回归 | ❌ 未开工 |

### 已完成并真机验证：原子切换（2026-09-11）

`DshBootstrap.installStagedEnv()`：备份现役 `node_modules` → 换 `node_modules`/`busybox`/`ohos-skills`
→ 写 `.dshm-version` 与 `.dshm-asset-version` → 对活环境复校哨兵；任一步失败即 `rollbackEnv()`。

配套必须改的一处（否则前功尽弃）：`isEnvVersionOk()` 原来只认壳内 `ENV_VERSION`，而在线环境的
`.dshm-version` = **资产版本**（通常 ≠ ENV_VERSION）→ 会被启动逻辑当成"坏拷贝"，`resetDir` 后
从 rawfile 覆盖回内置版本（与 2026-09-11 那次「pnpm 更新被静默抹掉」同一类陷阱）。现改为：
**版本号等于 ENV_VERSION，或等于 `.dshm-asset-version` 标记，且哨兵校验通过**即认可。

**真机验证（用同内容、版本号为 20260911-99 的资产，便于证伪）**：

| 断言 | 结果 |
|---|---|
| 切换写入版本标记 | `.dshm-version` = `.dshm-asset-version` = `20260911-99` ✅ |
| 启动不从 rawfile 覆盖 | `dsh-extract-diag.txt` mtime 保持 01:42 **未被重写** ✅ |
| 在线环境能跑起来 | `dsh web:` 出现、3080 有 11 个连接、node 进程在 ✅ |

即：**活环境确实来自在线资产，且不会被内置环境抢回去**。

**已知缺陷（下一步修）**：切换后的"就地重启服务"会抢 3080（EADDRINUSE）导致崩溃——
`restartAndWait()` 依赖 ArkTS 侧 http 探测 loopback，而该探测不可靠。本次用「重启整个应用进程」
完成验收（有效）。修复方向见 `.agent-rules/bug-log.md` 的 `[2026-09-11] EADDRINUSE` 条目。

### 已完成并真机验证：下载 → 解压 → 哨兵（2026-09-11）

入口：Harness 菜单 →「安装在线环境包（开发）」（`DshmWebPage.installEnvAsset()`）。
本步**只下载/解压/校验，不切换活环境**，用于在真机上验证整条链路。

| 环节 | 实测证据 |
|---|---|
| manifest failover 拉取 | 开发机 mock 服务器记录 `200 /manifest.json`；`@ohos.net.http` 拉取并校验 schema 通过 |
| 资产下载 + sha256 | 设备 `filesDir/env-download/dsh-env-20260911-91.zip` = **32,018,909 字节**（= manifest 的 30.5 MiB），sha256 用 `@ohos.file.hash` 校验一致 |
| zip 解压 | `@ohos.zlib.decompressFile` 解压到 `filesDir/env-staging`，**12,499 个文件**（与源树逐个一致） |
| 哨兵验收 | `manifest.sentinels` 5 项**全部 OK**（含此前让 pnpm 路线翻车的 `@deepseek-ai/dsh-app-boot/package.json`） |

配套工具（新增）：

- `scripts/dev-env-server.mjs`：开发用「伪下载源」静态服务器（支持 Range），托管 `dist/env`；配合 `hdc rport tcp:18080 tcp:18080`（**注意是 rport：设备→开发机**）即可在真机上走完整链路，无需先完成外网发布。
- `entry/src/main/ets/dshm/env/EnvAssetClient.ets`：manifest 拉取 + 多源 failover 下载（HTTP Range 断点续传，服务端返回 200 时截断重写）+ sha256 校验 + zip 解压 + 哨兵校验。

**存储提醒**：12499 个小文件在设备上实占约 215MB（各占 4KB 块），比 host 侧 113.5MB 明显膨胀；环境目录规划与「在线包体积」评估都要按设备实占算。

### 外部参考（2026-09-11 核实，用于收敛适配清单）

社区已有两条把 dsh 装到鸿蒙 PC 的成熟路线，恰好是「在线环境预设」要替代的那种**设备端原地安装/打补丁**：

- [shizhonggang/dsh-harmonyos](https://github.com/shizhonggang/dsh-harmonyos)：设备上装 npm 版 dsh + **4 个幂等补丁**（`dsh-subprocess-local` 加 openharmony 平台分支、`dsh-terminal-bash` 的 shellPath、`link`→`rename`、koffi stub）+ 现场 clang 编 node-pty + sharp 换 wasm32；升级脚本升级后**重打全部补丁**。
- [QinpanWan/dsh-harmonyos-pc](https://github.com/QinpanWan/dsh-harmonyos-pc)：更完整——`harmony.patch.yml`（profile 层禁用依赖原生二进制的插件行）+ 一组 node_modules 补丁（credentials 跳过 `chmod 600`、session/attachment/fs-local 的 `link`→`rename`/`copy`、permission-presets 改读 fs 沙箱）+ `--expose-internals`。

两条结论直接影响本路线：

1. **设备端原地升级/打补丁本身很脆**：该仓库记录「npm arborist 在鸿蒙本机依赖解析阶段会静默卡死」，只能自写 tarball 直装器；且每次升级都要按**内容锚点**重打补丁、上游一改锚点就失败。这从旁证了本路线（分发**预适配**环境包、设备端只做下载+解压+切换）的判断。
2. **适配清单可直接借用**：上面那份补丁/适配枚举，正好是构建期 `apply-dsh-ohos-adapt.sh` 应当覆盖的集合。可据此逐项对照本仓库现状，补上缺口（如 `sharp` 走 `@img/sharp-wasm32`、`--expose-internals` 启动参数、credentials/session/attachment 的 `link` 兜底）。