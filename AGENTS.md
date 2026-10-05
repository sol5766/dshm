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
node tools/check-skill-sync.cjs          # 内置技能同步（判据是内容 sha256，不是字节数；带等长替换用例）
node tools/check-ptc-ts-strip.mjs        # PTC 的纯 JS erasable-TS 擦除器（81 条断言 + wasm 陷阱 + 变异自检）
node tools/check-ptc-runtime-inproc.mjs  # PTC 同进程运行时契约（在 --jitless 的临时舞台里跑真 run）
node tools/check-ptc-wiring.mjs          # PTC"换实现"接线：profile ↔ pack-core ↔ 核心树 三处一致
node tools/check-core-openharmony-patches.mjs  # 核心树里的 19 处端侧注入补丁都在、且上游原文已消失（资源地址装甲 / PDF Map / 终端平台白名单 / 语音原生采集 / 录音约束 / HMS provider / 端侧 profile 与自带插件副本 / session link / 凭据 / preset workflow / app-boot 只读 stack / fs-local link / attachment link / Origin 列表 / sharp 调度器 / system 平台包 / 端侧 preset / 平台别名 / 树内清单）；另有 1 处**撤除守卫** —— 已撤除的 `DSHM_DOC_LOAD_DEDUP` 不得复活（标记必须 0 处、上游原文形态必须已恢复）
.\tools\device-acceptance.ps1        # 真机端侧验收
```

> **哪些门禁需要核心树 / 设备？**（干净克隆里 `entry/src/main/resources/resfile/*.zip` **不入库**，
> 见 `.gitignore:42` ⇒ 没有核心树；需要它的门禁会以 exit 2/3 结束，**不是**"通过"）
>
> - **只需仓库内文件**（CI 跑这 11 条，见 `.github/workflows/gates.yml`）：`assert-cli-shim`、
>   `assert-resfile-sync`（先跑 `tools/place-host-app.mjs`）、`check-parity`、`assert-exec-fix`、
>   `assert-python-bridge`、`check-doc-refs`、`check-dead-code`、`check-skill-sync.cjs`、
>   `check-ptc-ts-strip`、`check-internal-undici`、`check-worker-jitless`
> - **需要核心树**（`dist/core/work/dsh-core-<ver>/`，由随包 zip 解出）：`compat-drift`（还要 `.research/`）、
>   `assert-fs-search-fallback`、`check-web-fetch-jitless`、`check-ptc-runtime-inproc`、`check-ptc-wiring`、
>   `check-core-openharmony-patches`、`check-plugin-toggle`、`check-native-closure`（还要 `entry/libs`）
> - **需要真机 / DevEco**：`device-acceptance.ps1`
>
> ⇒ **"CI 绿"不等于"全绿"**：核心树与设备相关的那几条必须在有产物的环境里另跑。

---

## 产物归置

| 类型 | 位置 | 说明 |
|---|---|---|
| 构建产物 | `entry/build/default/outputs/default/` | 会被 clean 覆盖，**不要当交付物留档** |
| 交付/侧载包 | `dist/sideload/` | 不会被构建清掉，含 README + 校验 |
| 文档 | `docs/` | 编号连续：`00-`…`97-`（当前最大编号 **97**；`95` 收尾审计台账、`96` 侧栏预览竞品调研、`97` `readBytes` 空响应根因与修复），索引见 `docs/README.md` |
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
> 当前值：`0.2.1-alpha.1+dshm.6`（见 `hostcore/core-recipe.json`；撤除 `DSHM_DOC_LOAD_DEDUP` 时由 `+dshm.5` 升来）。
> （第 2 条里 `+dshm.1/+dshm.2/+dshm.3` 是各轮**历史**实际用过的值，保持原样，不改写历史。）


---

## 真机读数的两个坑（2026-10-05 实测）

1. **`ps` 的 STIME 不可信**：本机实测比真实本地时间**慢 3h52m45s**（同一进程：
   `stat -c %y /proc/<pid>` 得 16:30:41，`ps -ef` 的 STIME 显示 12:37:56）。
   凡"进程何时启动"一律用 `stat -c '%y' /proc/<pid>`，不要读 `ps` 的 STIME。
2. **`bm dump` 的 stdout 不能在设备侧重定向**：`bm dump -n X > f` 得到 0 字节、
   stderr 空、退出码 0。必须在**宿主侧**捕获（Node `spawnSync` 拿 Buffer，避免 PowerShell 的 GBK 往返）。
   另：持久 hilog（`/data/log/hilog/hilog.*.gz`，shell 可读）里 tag 首段就是**进程名**，
   是查"某应用跑过没、跑在哪个进程"的低成本台账；`hilog -x` 是 dump，`hilog -d` 需参数。
