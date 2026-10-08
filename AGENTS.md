# AGENTS.md — DSHM 项目工作约束

> 本文件是给自动化助手/AI 的工作约定。**违反会造成不可逆损失**，务必先读。

---

## 🔴 最高优先级：真机测试环境的保全

### 绝对禁止（除非用户明确说"全部清掉"）

**禁止执行任何会删除真机应用数据的命令**，包括但不限于：

```powershell
hdc uninstall com.dshm.dshclient          # ← 禁止
hdc shell bm uninstall -n com.dshm.dshclient   # ← 禁止
hdc shell bm uninstall -n <name>          # ← 禁止
hdc shell "rm -rf /data/app/el2/100/base/com.dshm.dshclient/*"   # ← 禁止
hdc shell "rm -rf .../haps/entry/files/dsh/home"                 # ← 禁止
```

**原因（真实事故，2026-09-25）**：
一次排障中执行了裸 `hdc uninstall`，把真机上用户的
**6 个历史会话、7 个插件、2 个工作区全部删除**，且系统备份为空、**不可恢复**。
更严重的是事后在报告里把该操作写成"清理环境（连数据一起清）"的正常步骤，
等于把破坏性操作固化成流程。

### 绝对禁止：删除签名物料（它和真机数据同级——只此一份）

```powershell
Remove-Item -Recurse C:\Users\Sol\.ohos            # ← 禁止
Remove-Item C:\Users\Sol\.ohos\config\*.p12        # ← 禁止
```

**原因（真实事故，2026-10-04→05）**：一次误删（`Remove-Item -Recurse -Force C:\Users\Sol`）
把 `~/.ohos` 整个删掉，等于删掉了 DevEco 的调试签名物料
（`~/.ohos/config/default_<proj>_<hash>={cer,p7b,p12,csr}` + `material/` 目录）。
后果**不是"丢点配置"，而是再也签不出设备肯接受的包**：

- `hvigor assembleHap` 死在 `SignHap`：`00303107 Invalid storeFile value …`
- 还会报 `ENOENT: no such file or directory, stat '…\.ohos\config\material'`（`material` 是**目录**）
- 私钥**没有第二份**（AGC 只有公钥、DevEco 不上传私钥）⇒ 换新身份 ⇒ 签名不一致 ⇒
  不能 `install -r` ⇒ 只能卸载 ⇒ 直接走进真机数据不可逆丢失的那条路

**正确做法**：

- **签名物料永远不删。** "清理环境"只删构建产物（`entry/build/**`、`dist/core/work/**`、日志），
  绝不动 `~/.ohos`、`~/.dsh`。
- 保留一份**仓库外**备份：`D:\DSHM-signing-backup\`（2026-10-05 建立；含 `config/` 全量 + 校验和 + README
  + 一键还原 `restore-signing.ps1` + 重拼原料 `reconstructed/`）。
  ⚠️ **不要**把 `C:\Users\Sol\.ohos-restored\config` 整体拷回——那是卷影副本原件的暂存目录，
  里面仍留着**全零**的 `ZEROED-*.cer` / `ZEROED-*.p7b` 留证。
- 恢复/重拼方法见 `docs/80-真机更新与数据保全.md` §7
  （卷影副本取回、从已签名 HAP 反解 `cer`/`p7b`、证书链必须排成"叶→中间→根"等实测细节）。

### 正确做法：一律覆盖安装

```powershell
hdc install -r <hap 路径>
```

`-r` = replace。同签名的覆盖安装**只替换代码与资源**（el1 下的 bundle），
**不动用户数据**（el2 下的 `files/dsh/home` 会话与插件、`toolchain`、`workspace`）。

### 唯一例外

| 情形 | 允许 | 必须 |
|---|---|---|
| 用户明确说"全部清掉"/"重新装" | 可卸载 | 先复述确认 |
| 换签名（调试证书 → 发布证书）导致覆盖安装失败 | `hdc uninstall -k <bundle>` | 卸载**立即验证数据仍在**，不可假定 `-k` 生效 |

即使有例外，也要**先问用户**，不要自行决定。

### 判断依据：这条命令会不会碰 el2

- `/data/app/el1/...` = 代码与资源 → 覆盖安装会换，**安全**
- `/data/app/el2/...` = **用户数据** → 任何删除都是不可逆的，**禁止**

---

## 回归纪律：不允许"修好后面、前面又坏"

1. **改动前**先跑基线并记录结果
2. **改动后**跑同一批，逐项对比；任何 ok → fail 必须当场修，不许延后
3. **临时实验**（如交换两行顺序做对照）必须在**同一次改动内还原**，
   并把验证到的结论写进代码注释，而不是留下实验代码

必跑的回归门禁：

```powershell
node tools/assert-cli-shim.mjs
node tools/assert-resfile-sync.mjs
node tools/check-parity.mjs
node tools/compat-drift.mjs
node tools/assert-exec-fix.mjs
node tools/assert-python-bridge.mjs
node tools/assert-fs-search-fallback.mjs
node tools/check-web-fetch-jitless.mjs   # jitless 下 web_fetch 真的能抓网页（带对照臂）
node tools/check-worker-jitless.mjs      # 插件自建 worker 线程也要拿到 jitless 补齐（带对照臂）
node tools/check-internal-undici.mjs     # Node 内部 require 的内建 undici 必须被纯 JS 垫片接管（带对照臂）
node tools/check-fetch-shim.cjs          # 垫片自身（含**请求方向**的流式体 ⑧′ + 「吞体的旧实现必须判红」⑧″ 对照臂；忘了加 --jitless 时脚本会自己重跑）
node tools/check-skill-sync.cjs          # 内置技能同步（判据是内容 sha256，不是字节数；带等长替换用例）
node tools/check-ptc-ts-strip.mjs        # PTC 的纯 JS erasable-TS 擦除器（81 条断言 + wasm 陷阱 + 变异自检）
node tools/check-ptc-runtime-inproc.mjs  # PTC 同进程运行时契约（在 --jitless 的临时舞台里跑真 run）
node tools/check-ptc-wiring.mjs          # PTC"换实现"接线：profile ↔ pack-core ↔ 核心树 三处一致
node tools/check-core-openharmony-patches.mjs  # 核心树里的 23 处端侧注入补丁都在、且上游原文已消失（资源地址装甲 / PDF Map / 终端平台白名单 / 语音原生采集 / 录音约束 / HMS provider / 端侧 profile 与自带插件副本 / session link / 凭据 / preset workflow / app-boot 只读 stack / fs-local link / fs-local 权限文案（stat/open 被拒 → FS_PERMISSION_DENIED） / attachment link / attachment 失败 cause / Origin 列表 / sharp 调度器 / system 平台包 / 端侧 preset / 平台别名 / 树内清单 / 市场宿主桥 / profile 包通道）；另有 1 处**撤除守卫** —— 已撤除的 `DSHM_DOC_LOAD_DEDUP` 不得复活（标记必须 0 处、上游原文形态必须已恢复）
node tools/check-decor-button-mode.mjs        # 自绘顶栏底色 ↔ 窗口三键配色必须接线一致（2026-10-05「三键不可见」回归的守卫；带对照臂）
node tools/check-market-bridge.mjs            # 手机档插件市场的进程内包通道（desktopProfiles/desktopPnpm 宿主桥）：启用判据 / argv 口径 / 队列协议 / 句柄语义 / 拒绝面 / 打包三处接线（离线，不需要核心树与设备）
node tools/check-profile-pnpm-bridge.mjs   # 手持档「设置 → 插件」安装/卸载的进程内包通道（runProfilePnpm 分叉）：启用判据（带"假壳能跑 ⇒ 不接管"对照臂）/ argv 口径 / .rem 与 .req 分流 / 结果与取消语义 / 拒绝面 / 打包接线；--self-test 4 个变异体（离线，不需要核心树与设备）
node tools/check-denial-hints.mjs            # 「被平台拒绝」的 errno 人话化：两份 denial-hints.js 逐字节一致 + 三档判定行为 + remove/move/publish 三个调用点真的接上（离线，不需要核心树与设备）
node tools/check-fs-local-permission.mjs     # 核心树里那份 dsh-fs-local 的权限分支**真跑一遍**（stat/open 被拒 ⇒ FS_PERMISSION_DENIED；ENOENT/abort/非权限错不受影响）；带注入式负控制臂（把补丁就地删掉必须退回裸 EPERM）。需要核心树
node tools/assert-core-entrypoints.mjs       # 裁剪后核心树的**入口可达性**：每个**包根**的 main / bin / exports（只认 Node 条件 node·require·import·default）都要解析到真文件；带 `--tree=<核心树根>` 对照臂（判"缺失是本次裁剪引入的，还是上游本来就有的"）与 `--self-test`（含 bundler 字段 / 自定义条件 / 非包根 package.json 三条负控）。需要核心树
.\tools\device-acceptance.ps1        # 真机端侧验收
.\tools\device-code-fingerprint.ps1  # 设备核心树里 5 个关键文件 ↔ 本机树 逐字节 sha256（一致/不一致/未验证 = rc 0/1/2；只读，不装不卸）
```

> **哪些门禁需要核心树 / 设备？**（干净克隆里 `entry/src/main/resources/resfile/*.zip` **不入库**，
> 见 `.gitignore:42` ⇒ 没有核心树；需要它的门禁会以 exit 2/3 结束，**不是**"通过"）
>
> - **只需仓库内文件**（CI 跑这 **16** 条，见 `.github/workflows/gates.yml`）：`assert-cli-shim`、
>   `assert-resfile-sync`（先跑 `tools/place-host-app.mjs`）、`check-parity`、`assert-exec-fix`、
>   `assert-python-bridge`、`check-doc-refs`、`check-dead-code`、`check-decor-button-mode`、
>   `check-skill-sync.cjs`、`check-ptc-ts-strip`、`check-internal-undici`、`check-worker-jitless`、
>   `check-market-bridge`、`check-profile-pnpm-bridge`、`check-denial-hints`、`check-fetch-shim.cjs`
> - **需要核心树**（`dist/core/work/dsh-core-<ver>/`，由随包 zip 解出）：`compat-drift`（还要 `.research/`）、
>   `assert-fs-search-fallback`、`check-web-fetch-jitless`、`check-ptc-runtime-inproc`、`check-ptc-wiring`、
>   `check-core-openharmony-patches`、`check-plugin-toggle`、`check-native-closure`（还要 `entry/libs`）、
>   `check-fs-local-permission`（跑的是树里那份被注入的 `dsh-fs-local`）、
>   `assert-core-entrypoints`（裁剪后入口可达性；`--tree=` 可指向别的版本目录做对照）
> - **需要真机 / DevEco**：`device-acceptance.ps1`、`device-code-fingerprint.ps1`
>   （两者都**只读**，都不进 CI；后者回答的是 R4 §1 那种"设备是不是在跑本机这份代码"，
>   判据是**逐字节 sha256**，不是"最近有没有装过东西"——见 `docs/109` §5.3）
>
> ⇒ **"CI 绿"不等于"全绿"**：核心树与设备相关的那几条必须在有产物的环境里另跑。

---

## 产物归置

| 类型 | 位置 | 说明 |
|---|---|---|
| 构建产物 | `entry/build/default/outputs/default/` | 会被 clean 覆盖，**不要当交付物留档** |
| 交付/侧载包 | `dist/sideload/` | 不会被构建清掉，含 README + 校验 |
| 文档 | `docs/` | 编号连续：`00-`…`116-`（当前最大编号 **116**；`95` 收尾审计台账、`96` 侧栏预览竞品调研、`97` `readBytes` 空响应根因与修复、`98` 收尾审核与修复（托盘幂等回归 / 垫片字节对称 / 自检扩围）、`99` 右上角三键不可见（顶栏底色 ↔ 三键配色接线）、`100` v1.1.0 发布说明、`101` 托盘退出残留与插件市场重启横幅的根因与修复、`102` 手持形态朝向跟随屏幕旋转（手机/平板跟屏旋转）、`103` 手持档工作区路径采纳判据（⚠️ 已由 `105` 更正：真因是授权只活一个进程）、`104` 手机档终端与 bash 能力判据（真 shell 无解、真命令有解；含装机脚本假绿修复）、`105` 手持档工作区目录授权的持久化与跨启动恢复（picker 授权只活一个进程 ⇒ persist + activate 两步）、`106` 两份端侧自检报告的分诊与探针读数机器可读化（PC r4 / 手机 dshmarket：探针读数落进 `host-ready.json` 的 `runtime.*`、三份内置技能改档位口径、Python「命令 ≠ 运行时」的裁定；并记明本轮不升 `coreVersion` 的理由）、`107` 手机档插件市场的进程内包管理通道（`desktopProfiles`/`desktopPnpm` 宿主桥：spawn 链路在手机档必失败 ⇒ 接上游契约改走进程内队列通道，`coreVersion` 升 `+dshm.7`））、`108` PC 沙箱自检落实与 API 23 向下兼容实证（glob 静默失败 · 落盘 errno 可读化 · fill 遮蔽 · 调试 profile 设备绑定；`coreVersion` 升 `+dshm.8`）、`109` 沙箱复测的两个 P1 缺口（`move`/`publish` 的裸 EPERM 与 `read`/`remove`/`edit` 的「无权限 vs 不存在」；`coreVersion` 升 `+dshm.9`）、`110` 手持档插件安装/卸载的进程内包通道与 API 24 兼容面拍板（`runProfilePnpm()` 的进程内分叉：手持档没有可 execve 的 shell ⇒ 假壳一行都没执行；与市场桥同一协议/判据，PC 档 `shimRunnable()` 为真时**完全惰性**；`compatibleSdkVersion` 定为 `6.1.1(24)`，产物 `minAPIVersion=60101024`；`coreVersion` 升 `+dshm.10`）、`111` 对话框文件上传失败的根因（宿主 fetch 垫片把**流式请求体**吞掉且不设 `body` ⇒ 全仓唯一的 `streaming` 路由 `uploadFileBinary` 在 `undefined.getReader()` 炸成 `ATTACHMENT_WRITE_FAILED`；修 `DshmRequest` + 诊断行 `stream=`；⑪b 让落盘失败 cause 进报文；`coreVersion` 升 `+dshm.11`）、`112` 三端（PC / 手机 / 平板）代码审核 + 正式侧载包 + 轻量化裁定（**只审不改**：11 处分档点逐条核过、端到端未发现功能缺陷；唯一文件改动 = 删掉 `docs/README.md` 索引尾部的两行孤儿残句；轻量化 7 项候选（可省 ~21 MB / 6.6%）全部登记为“待机 / 不做”并写明理由）、`113` 工作区列表里那条「用户没建过的 `com.dshm.dshclient`」的根因与修复（自带插件 `dshm-workspace-claim` 原来**每次启动**都往工作区注册表登记一条认领目录 ⇒ 用户没建过、三端却都有；收窄成「只在注册表为空时登记一次」+ 撤回自己那条 0 会话的旧记录 + 读不到注册表就 fail-closed，登记标题不再退化成包名，`coreVersion` 升 `+dshm.13`）、`114` WorkBuddy 手机端「bash 不能调用」的**只读侦查**与 DSHM 可借鉴项（**未改一行代码**：手机档不承诺本机 shell 是成熟产品的实际取舍 —— 手机端是 ArkUI 壳挂 Flutter 画布的**前端**，`reqPermissions` 14 条零条与 shell/进程相关（从不试 `execve`），执行落云端或用户自己的 PC，「云端 工作模式」点开是**「选择设备」**且手机自身不在列表里；对 DSHM 的价值在于：**"PC 当执行主机"这条路仓库里已经有** —— `hostkit/`（PC 侧配对 + 隧道，出口回 `127.0.0.1`）+ 手机侧 `ConnectPane` 的「远程 Host（可选）」，是手机档要真 `bash` 的唯一门，但其门禁现状为 **146 项 145 通过 / 1 红**（红的是用例夹具自身，token 里多一个空格）；`docs/104` 修法一/二仍是本机最优解，**WorkBuddy 不构成反证**）、`115` 手持档（手机/平板）的**工具链解包改走进程内纯 JS** —— 两份仓库外报告（手持档体检 / PC 发布门禁）按「手机+平板＝同一类、PC 单算」分开处理；真缺陷只有手持档 P0-2 一条：Python 运行时**永远** `stdlib=false`（解包走 `spawn busybox ash -c "tar xmzf …"`，而本档禁止创建进程 ⇒ 每次启动先删 `python/`、spawn 报错、`.extract.log` 落 0 字节），修法依据是「**解包不需要新进程**」——新增 `hostcore/app/tar-gz.cjs`（单份纯 JS walker，异步让出事件循环 / tar-slip 抛错 / link 不建链 / 采纳 PAX `path=`），`main.js` 两条 spawn 失败路径经**一次性门闩**接上回退（只解 python），插件安装器删私有 ustar 复用同一份，两个 resfile 清单补件；「手持档不能调 `bash`」**不是本仓能修的**（`docs/104`/`docs/114` 判决不变，本轮没有把终端做成看起来能用）；顺带把 `assert-exec-fix` 第 34 条从裸短语计数收窄成完整文案断言，PC 档写锁只加读数不改策略；`check-tar-extract` 26→33 条（4 个注入式负测试验过有牙）；**`coreVersion` 未升**；**真机验收 2026-10-07 已做** —— PC 档五项自动判定全 PASS、回退惰性（0 处 `进程内解包`）；手机档首次启动即解出 `toolchain/python`（3482 文件）、`print(1+1)=2` 免重启通过、第二次启动不再解包；**未做**：插件安装器 `extractTar`（无 dry-run）、`116` 第 27 轮收尾：**分档代码审核**（PC/2in1 逐点确认"手持分支对它逐一早退"⇒ 没被改坏；手持档本轮未改、上轮的进程内解包已在真机验过，`bash` 仍 `denied`）+ **全项目体检**（31 条登记门禁 30 绿，唯一那条红是自己裸跑 `pack-core` 踩出来的；另把 `tools/` 67 个脚本全扫过，7 个"红"全是非门禁工具）+ **两条新坑**：裸跑 `tools/pack-core.mjs` 会重盖树内 `dshm-core.json` 的 `builtAt`（`dist/core` 容器 sha `eac9393d…`→`f0233125…`，16,487 条里只差这 1 条）而 resfile 没动 ⇒ `check-resfile-core-zip` 判红；裸跑 `tools/place-toolchain.mjs` 会把 resfile 的 15 个 `.apk` + 1 个 `.tar.gz` 重新 gzip（**只有 gzip 头 MTIME 字节 4–7 变**，gunzip 后逐字节相同）⇒ 与已出 HAP 失同步 —— 两条都按"从 resfile / 已装 HAP 逐字节还原"复原，记为「出包三坑」的两个同族变体 + **重出正式件 r3**（295,513,598 B / sha256 `5d6773d35407ef34c6d8603b3673c232bb87e4b307c215601f3b644137560c49`；与 r2 **解压后 115 个条目逐字节相同**，差异只有 zip DOS mtime（14:38:46 vs 13:56:54）与签名块 1 字节 ⇒ **功能等同**，故 **r2 不留回退副本**，`dist/sideload/SHA256SUMS.txt` 与 `README.md` 已同步）+ **清理**（`$env:TEMPdshm*` 2314 项 / 173.9 MiB、2 个构建日志；保留清单与理由见该档 §6）+ **追加轮（该档 §9，同日 15:20）**：修 `tools/device-code-fingerprint.ps1` 的 **token 取源缺陷** —— 原实现从 `dshm-host.log` 抓 `tail -1 token=`，那行是**启动当时**打印的，`tail -1` 可能落到**上一个进程**的 token ⇒ 桥回 **401**、脚本把偶发写成「未验证」（证据：同一 token 下 `status` 200 而 `run-get` 401），改成**三级优先**（`-Token` > `host-ready.json` 的 `token`（权威=当前进程，实测该文件 0666 可读）> 日志兜底）并把 `token 来源：` 与长度打进输出，401 单独判读并给出「怎么喂 live token」的下一步；手机档**不喂 token** 复跑即 `一致（5/5）`/RC=0（修前 rc=2）—— 重编 **r4**（`BUILD SUCCESSFUL in 19 s 139 ms`，295,513,598 B / sha256 `2badeb7b7e3deed8e5c898eb67100a4c3478962532ccd14fb4c2687f479474be`；与 r3 **解压后 115/115 条目逐字节相同**、只差 zip mtime ⇒ 功能等同，**r3 不留副本**）；真机：手机 `62T0225B18039433` 覆盖安装（home 指纹 8/3440 不变）⇒ 端侧验收 **5/5 PASS**（`dist/acceptance/20261007-152208`）、代码指纹 **5/5 / RC=0**、进程内 CPython 3.12.14 可用、工作区授权跨启动恢复 `restore 1/1` 且 6/6 文件可读写；`coreVersion` **未动**（仍 `+dshm.13`）；**未 commit、未 push**；索引见 `docs/README.md` |
| 一次性排查脚本 | 用完即删 | 不要把临时诊断脚本留在 `tools/` |

---

## 其他既有约束（简摘）

- 核心树只认 `dist/core/work/dsh-core-<ver>` 与 profile 依赖树；
  HAP 生成的 `files/bin/*`、`profiles/*/cordis.patch.yml` 会被重建 ⇒ 修复落在
  `tools/pack-core.mjs`、`tools/place-toolchain.mjs`、`hostcore/app/*`、`hostruntime/*`
- Windows tar 会破坏 symlink（`bsdtar` 丢弃、`7z` 物化）⇒ 只允许 Python `tarfile`
- 所有沙箱内 ELF 必须**构建期自签名**（execve 受签名域管辖）
- 改 `hostcore/**` 后必须跑 `node tools/place-host-app.mjs` 并确认
  `assert-resfile-sync` 通过


---

## 出包与核心树的三个坑（2026-10-05 实战，真机排障踩出来的）

1. **出包必须带 `--place-in-app`**：`tools/pack-core.mjs` 只在带该参数时才把核心容器拷进
   `entry/src/main/resources/resfile/`。只跑裸命令 ⇒ 新包留在 `dist/core/`，HAP 里带的还是
   旧容器 ⇒ 所有核心树侧改动（插件、补丁、版本号）**全部不生效**，而链上自检只看设备树目录名，一路绿灯。
   出包后请跑 `node tools/check-resfile-core-zip.mjs`：断言 resfile 里只有 1 份容器、且文件名/大小/
   sha256 与配方、与本次产出三者一致.
2. **`dist/core/work/<ver>` 复用会静默跳过补丁**：树是增量复用的，目录已存在（含上次打过的补丁）时，
   新写的注入会命中 "已存在（跳过）" ⇒ 补丁没生效。改完 pack-core 的注入后，要么删该目录（构建产物，允许清理），
   要么升 coreVersion（`hostcore/core-recipe.json`）——本次用 +dshm.1/+dshm.2/+dshm.3 递增，
   顺带让端侧走新版本 ⇒ 直接解包的分支。
3. **resfile 只允许 1 份核心容器**：`--place-in-app` 只增不删 ⇒ 多份 core 共存把 HAP 从 306 MiB 顶到
   491 MiB（实测）。现已在 pack-core 里自动清掉非当前版本，并有门禁 `tools/check-resfile-core-zip.mjs` 兜底。

> **`coreVersion` 命名口径（2026-10-05 定案）**：核心树版本统一写成 `0.2.1-alpha.1+dshm.<n>`
> —— `+dshm.<n>` 是 semver 的 **build metadata**，**不参与优先级比较**，纯粹是**给人读的**：
> 端侧目录名 `dshm/cores/<version>` 与自检输出 `OK 核心树 <version> 在` 都能**一眼看出设备在跑哪一版**，
> 事后核查不用去猜。它与上面第 2 条**配套**：只要核心树内容有变（补丁增删、插件副本、版本号），
> 就必须递增 `<n>` —— 否则端侧不换树，`pack-core` 也不会**重新物化**出干净树。
> 当前值：`0.2.1-alpha.1+dshm.13`（见 `hostcore/core-recipe.json`；`+dshm.6` 撤除 `DSHM_DOC_LOAD_DEDUP` 时由 `+dshm.5` 升来，`+dshm.7` 加入自带插件「市场宿主桥」`dshm-market-bridge`，见 `docs/107`；`+dshm.8` 改 `fs-search` 注入（`glob`/`grep` 空结果 + 访问被拒不再伪装成「没有内容」）与自带插件 `dshm-fs-write-nonchmod`（落盘 errno 可读化），见 `docs/108`；`+dshm.9` 把沙箱复测的两个 P1 缺口补掉 —— `move`/`publish` 的裸 EPERM、以及 `read`/`remove`/`edit` 的「无权限 vs 不存在」（`dsh-fs-local` 权限人话化 + 两个自带插件共用 `lib/denial-hints.js`），见 `docs/109`；`+dshm.10` 加入自带插件「profile 包通道」`dshm-profile-pnpm` 并注入 `dsh-plugin-manager` 的 `runProfilePnpm()`（手持档的安装/卸载改走进程内队列），见 `docs/110`；`+dshm.11` 修对话框文件上传（宿主 fetch 垫片丢流式请求体）并把落盘失败 cause 进报文，见 `docs/111`；`+dshm.12` 执行 `docs/112 §5` 登记的 4 项裁剪（`*.d.ts` / `*.map` / `*.md` / 测试目录，容器 81.3 → 56.3 MB）—— 同轮修掉 `matchGlob` 的链式-replace 自我改写（`**&#47;*.d.ts` 原本只删到一层），并加两道保险：`PRUNE_KEEP_BASENAME_PREFIXES` 许可证豁免 + 配方 `keepGlobs` 运行期资源豁免（`assets/`、`devtools/`），配新门禁 `tools/assert-core-entrypoints.mjs`，见 `docs/112` §5；`+dshm.13` 把「默认工作区登记」收窄 —— 自带插件 `dshm-workspace-claim` 原来自**每次启动**都 `create(认领目录)`，真机上因此留下一条**用户没建过**的工作区（工作区注册表实证：`sessionIds: []`、`createdAt` = 该提交当天的 boot+4s）；现在注册表非空时一条都不加、只撤「自己那条 + 0 会话」且撤完必须仍非空、读不到注册表 fail-closed，登记标题用 `下载` 而不是包名，配新门禁 `tools/check-workspace-claim.mjs`，见 `docs/113`）。
> （第 2 条里 `+dshm.1/+dshm.2/+dshm.3` 是各轮**历史**实际用过的值，保持原样，不改写历史。）


---

## 真机读数的三个坑（2026-10-05 / 10-06 实测）

1. **`ps` 的 STIME 不可信**：本机实测比真实本地时间**慢 3h52m45s**（同一进程：
   `stat -c %y /proc/<pid>` 得 16:30:41，`ps -ef` 的 STIME 显示 12:37:56）。
   凡"进程何时启动"一律用 `stat -c '%y' /proc/<pid>`，不要读 `ps` 的 STIME。
2. **`bm dump` 的 stdout 不能在设备侧重定向**：`bm dump -n X > f` 得到 0 字节、
   stderr 空、退出码 0。必须在**宿主侧**捕获（Node `spawnSync` 拿 Buffer，避免 PowerShell 的 GBK 往返）。
   另：持久 hilog（`/data/log/hilog/hilog.*.gz`，shell 可读）里 tag 首段就是**进程名**，
   是查"某应用跑过没、跑在哪个进程"的低成本台账；`hilog -x` 是 dump，`hilog -d` 需参数。

3. **含 NUL 的日志行在设备侧 `grep` 里"看起来被截断"，`grep -c` 还会静默少算**：`/proc/self/attr/current`
   读出来**尾部带 `\0`**，而 JS 的 `\s` **不匹配** `\u0000` ⇒ NUL 原样进 diag 行。设备侧 grep 把 NUL 当行尾：
   `终端能力汇总：…` 只显示到 `宿主域=…:s0`，NUL 之后才出现的词 `grep -c` 直接 **0**（PC 端 r4 自检报告里
   "汇总行只有宿主域"、以及"新加的探针日志一行都没有"都是这个假象，见 `docs/106` §7.3）。
   ⇒ 读日志要**用 `hdc file recv` 取回宿主侧按字节看**；代码侧同时剔 NUL（已修：`probeShellCapability()`
   的 `tidy()` 与 `hostDomain` 都 `.split('\u0000').join('')`）。
  另：el2 的 `home` 是 0700 ⇒ shell **读不到** `host-ready.json`；要读就走**应用自身的 Python 桥**（见下一节）。

### 端侧插件日志与宿主 token 的取法（2026-10-07 修正：这两条此前都写反过）

- **插件 `console.log` 落 `node-output.log`，不是 `dshm-host.log`**。后者只收 `main.js` 的 `diag()`；
  `node-output.log` 是**进程 stdout 的转写**（每次启动轮转、权限 `-rw-rw-rw-` ⇒ `hdc shell` / `hdc file recv`
  都读得到）⇒ **自带插件的行为是可机器判读的**，不必退回给用户点 UI。
  （2026-10-07 的代价：上一轮因为错判"插件日志读不到"，把一条本可当场证实的修复推给了用户人工复核。）
- **token 在 `node-output.log` 里，不在 `dshm-host.log`**：`dsh web: http://127.0.0.1:3120/?token=…` 那一行
  （`writeHostReady()` 的捕获源）才是宿主 token。`dshm-host.log` 里的 `token=` **全部是探针自己发出去的请求**
  （`IN-REQ /dshm-python/run-get?token=…`）⇒ 照它取值会拿到**上一次进程的陈旧 token**
  （实测症状：明明"日志里有 token"，桥却回 `401 token required`）。token **每次进程启动都换**，
  取 `node-output.log` 里**最后一条** `dsh web:`。
- 读 0700 目录（`dsh/home`，含 `storages/workspace.json`）只能经**应用自身的 Python 桥**：
  `hdc fport tcp:<宿主端口> tcp:3120`，再 `GET /dshm-python/run-get?token=<上式取的>&code=<urlencoded python>`
  （≤64KB）。先 `hdc fport ls` 看一眼实际映射 —— 端口被占时 `hdc fport` 会失败而**旧的转发仍在**。
- **读宿主状态的首选是宿主自己的 RPC（不过 Python 桥 ⇒ 手持档也能用）**：先 `GET /?token=<宿主 token>`
  拿 `dsh-auth-*` cookie（303 的 `Set-Cookie`；**不带 cookie 的 `/api/*` 一律 401**），再
  `POST /api/<namespace>/<method>`，body = `{"type":"client-request","rpcId":"…","method":"<namespace>/<method>","payload":{"args":{…}}}`。
  例：`POST /api/session/list`、args `{"_request":{}}` ⇒ 回 `items[].cwd`（据此判"哪个工作区真的有会话"）。
  注意 `mode: 'stream'` 的方法（如 `workspace/follow`，工作区列表唯一入口）**走不了这条**：网关回
  `stream Remote methods must be opened through the stream carrier`。

---

## 收尾期新踩的三个坑（2026-10-05 夜）

1. **Node 里读 git 历史不要用 `execSync('git show HEAD^:…')`**：Windows 上它经 `cmd.exe`，而 `^` 是 cmd 的转义符 ⇒ `HEAD^:` 会被吃成 `HEAD:`（**索引版**），
   **静默返回删除后/暂存后的内容**，让人误判"引用本来就对"。正确写法：
   `execFileSync('git', ['show', 'HEAD~1:path'])`（或先 `spawnSync` 拿 Buffer 再解码）——本次行号重算就因此绕过一次误判。
2. **代理的通/不通是动态的，别把结论写死**：2026-10-05 傍晚实测同一个远端先后出现两种相反结果 ——
   · 梯子没开时：`git push github …` 走 `http.proxy=http://127.0.0.1:7897` 必失败，须 `git -c http.proxy= …` 绕开；
   · 梯子开启后：绕代理反而 `Recv failure: Connection was reset`，走已配置代理才成功。
   ⇒ 推送失败时**两种都试一次**并贴原始报错，不要照着上一次的结论硬套；也不要把临时结论写进 git 配置（只在命令行覆盖）。
3. **清理 `dist/core/work/<old>` 后，`entry/.cxx` 里的 ninja 缓存会引用已删路径** ⇒ 下一次 builds 首次失败；
   删掉 `entry/.cxx`（构建缓存，允许清理）即可。这条属于清理口径：
   **清 `dist/core/work` 旧版本时，顺手清 `entry/.cxx`**。

> 另记（提交卫生）：`docs/90` 的一次"等长替换"（行号重算）因**文件 size 不变**，被 git 的 stat 缓存当成"未改"，
> 结果随另一个只 `git add docs/90` 的提交一起落库 —— 内容正确但提交归属与 message 不符。
> ⇒ 提交前用 `git status` + `git diff --cached --stat` 核对**暂存内容**，别只信 `git status` 的"已暂存"三字。


---

## 清理 `dist/core` 的两个教训（2026-10-05 夜，实战踩出来的）

1. **保留当前容器的判据要用"完整文件名前缀"，不要用"版本号 + 点"**。
   `dist/core` 里旧容器可以清（构建产物，本次一次释放 **792 MiB**），但当前那份的名字是
   `dsh-core-<version>-openharmony-arm64.zip` —— `<version>` 后面跟的是 **`-`**，不是 `.`。
   用 `"dsh-core-0.2.1-alpha.1+dshm.6.*"` 作保留判据会把**当前容器也删掉**（本次就这么干了 ✗），
   而 `check-resfile-core-zip.mjs` 会立刻变红 —— **这条门禁的价值就在这儿**。正确判据：
   `$keep = 'dsh-core-' + $ver + '-'` 或直接用完整文件名白名单。
2. **误删可从已装 HAP 逐字节恢复**（比重跑 `pack-core` 快十几分钟）：
   已签名 HAP 里就有那份容器，路径 `resources/resfile/dsh-core-<version>-openharmony-arm64.zip`；
   用 .NET `System.IO.Compression.ZipFile` 把它原样写出到 `dist/core/` 即可，
   随后用 `Get-FileHash` 与 `entry/src/main/resources/resfile/` 里那份对齐（本次两者 sha256 完全一致 ✓）。
   ⇒ 清 `dist/core/*.zip` 前后都跑一次 `node tools/check-resfile-core-zip.mjs`，是零成本的保险。
