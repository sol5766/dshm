# 114 · WorkBuddy 手机端"bash 不能调用"是怎么处理的：执行外移，以及 DSHM 可借鉴的四条

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-07 |
| 真机 | HUAWEI Mate 80 / `VYG-AL00` / OH 7.0.0.105 / API 26 / `deviceType=phone`（`62T0225B18039433`，全程在线） |
| 用户原话 | 「读取一下手机端 WorkBuddy 是怎么处理 bash 不能调用的问题，深度分析一下 WorkBuddy 手机端的运行环境和工具调用的处理，看看我们 dshm 有哪些可以借鉴来解决问题的方案」 |
| 本轮性质 | **只读侦查**：未改一行代码、未装机、未动用户数据。对 WorkBuddy 的全部操作 = 启动到前台 + 点开「工作模式」面板 + 切底部 tab（无数据写入、无任务发起） |
| 被分析对象 | `com.tencent.workbuddyohos`（腾讯，AppGallery 分发的**已发布**应用，版本 2.6.0 / versionCode 844） |

---

## 1. 结论

**WorkBuddy 没有"解决"手机端调不了 bash 的问题——它把"在手机上执行"这件事从产品里取消了。**

三条互相独立的证据链（§4）：

1. **权限面为零**：`bm dump` 的 `reqPermissions` 共 14 条，**没有任何一条与 shell / 进程 / 可执行文件相关**（§3）。
   ⇒ 它**从不尝试** `execve`，因此也就不会撞上 `docs/104` 记录的那道 MAC 墙。
2. **"在哪儿执行"是用户可见的选择**：顶栏「云端 工作模式」点开是**「选择设备」**，选项只有
   `☁️ 云端` 与 `🖥️ Sol的MateBook 14（离线）`——**手机自己不在这个列表里**（§4.2）。
3. **连定时任务都绑定执行主机**：定时任务卡片的头部标注主机为 `Sol的MateBook 14`，
   任务正文要求读 `~/.workbuddy/skills/ppt-master/`（§4.3）——那是**执行主机的本地路径**，不是手机的。

进而一句话：**手机是前端，执行在云端或用户自己的 PC 上。**

对 DSHM 的意义有两层，且**第二层是本轮最重要的发现**：

- WorkBuddy 不是"手机端 bash 的解法"，而是**"不承诺手机端 bash"的产品样板**（与 `docs/104` 的判决一致）；
- 它赖以成立的"**PC 当执行主机**"架构，**DSHM 仓库里已经有一份实现**并带端到端隧道测试
  —— `hostkit/`（PC 侧桥）+ 手机侧 `ConnectPane` 的「远程 Host（可选）」，只是被降级为可选路径（§6.1）。
  ⇒ **要"手机端有真 shell"，DSHM 不必发明新东西，只需要把这条既有路径扶正**（含先让它那 1 条红测试变绿，§6.1）。

---

## 2. 取证方法与本轮的边界

用什么取的（全部宿主侧捕获，遵守 `AGENTS.md` 真机读数的坑：`bm dump` 不在设备侧重定向）：

| 手段 | 用途 |
|---|---|
| `hdc shell bm dump -n com.tencent.workbuddyohos` → 宿主侧 `Out-File` | 包清单：版本 / 签名 / SDK / 形态 / ability / 权限面（55,983 B） |
| `hdc shell uitest dumpLayout -b <bundle> -p <dev路径>` + `hdc file recv` | 界面树（含 `XComponent` 与全部文本节点） |
| `hdc shell uitest screenCap` + `hdc file recv` | 截图（面板形态与选中态） |
| `hdc shell uitest uiInput click <x> <y>` | 点按（坐标取自 dumpLayout 的 `bounds`） |
| `hdc shell ps -ef` / `cat /proc/<pid>/status` | 进程与身份 |
| 上一轮的 12 份 `hilog.*.gz`（宿主侧 gunzip） | 判"它写不写日志" |

**拿不到的（不是没试，是权限上做不到）**：

- `bm dump` 与 `ls` 对 **el1 bundle 目录 / el2 数据目录**一律 `Permission denied`
  （对照组：我们自己的 `com.dshm.dshclient` 同样被拒 ⇒ 是**用户 shell 的身份问题**，不是 WorkBuddy 特别设防）。
  本轮 shell 身份实测：`uid=2000(shell) … context=u:r:sh:s0`。
- `/proc/9605/maps` → `Operation not permitted`（同 pid 的 `status` 可读）⇒ 拿不到它加载了哪些 `.so`。
- **它自己的运行时日志：没有**。698 条含 `workbuddy` 的 hilog 命中**全部来自系统侧**
  （AMS/WMS/sceneboard 的 `launchApp`、`SceneSession`、`setLabel`），说明该应用不往 hilog 写业务日志。

⇒ 本轮的结论**建立在包清单 + 界面事实**这两类硬读数上，不建立在它的日志或反编译上（做不到）。

---

## 3. WorkBuddy 手机端的运行环境（逐条带出处）

| 项 | 读数 | 出处 |
|---|---|---|
| 包名 / 版本 | `com.tencent.workbuddyohos` / `2.6.0`（versionCode 844，`minCompatibleVersionCode` 844） | `bm dump` |
| 发行方 / 分发渠道 | `vendor: tencent` / `appDistributionType: app_gallery` | `bm dump` |
| 签名 | `appProvisionType: release`（**非调试签名**） | `bm dump` |
| **编译 SDK** | `compileSdkVersion: 6.1.0.105`、`compileSdkType: HarmonyOS`、`apiReleaseType: Release` | `bm dump` |
| **目标形态** | `deviceTypes: ["phone","tablet","2in1"]` | `bm dump` |
| Ability | `EntryAbility` + `TIMPushClickActionAbility`（推送点开）；**没有** Service / 后台任务类 Extension | `bm dump` |
| 权限面（14 条） | `ACCELEROMETER` · `APP_TRACKING_CONSENT` · `FILE_ACCESS_PERSIST` · `GET_NETWORK_INFO` · `GET_WIFI_INFO` · `INTERNET` · `KEEP_BACKGROUND_RUNNING` · `MICROPHONE` · `PUBLISH_AGENT_REMINDER` · `READ_CALENDAR` · `READ_PASTEBOARD` · `SET_NETWORK_INFO` · `STORE_PERSISTENT_DATA` · `WRITE_CALENDAR` | `bm dump` |
| UI 形态 | ArkUI 根节点下挂 `XComponent`（`oh_flutter_1`）⇒ 界面是 **Flutter 画布**；dumpLayout 里 Flutter 侧节点一律 `clickable:"false"`（语义树投影），但坐标点按**仍然生效**（实测点开了面板） | `uitest dumpLayout` |
| 进程 | `20020410 9605 567 com.tencent.workbuddyohos`（uid 20020410，PPid 567） | `ps -ef` |
| 商业形态（线索） | 「我的」页：`体验版` · `我的积分 980.64` · `升级套餐` | `uitest dumpLayout` |

两个值得本项目留意的点：

- **权限面里"没有 shell 权限"这件事，在鸿蒙上本来就没有对应权限可申请**——这一点与 `docs/104` §3 的
  机制解释完全吻合（`execve` 由 MAC 域判决，不是靠 `reqPermissions` 放行的）。
  所以"权限面干净"更准确的读法是：**该应用根本没把本机执行当成一条能力路径来设计**。
- **`compileSdkVersion: 6.1.0.105`**：这是一个**大厂在 AppGallery 正式分发**、面向 `phone/tablet/2in1`
  三形态出货的 6.1 SDK 应用，而它在 API 26 设备上正常运行
  ⇒ 这是 `docs/110` 把 `compatibleSdkVersion` 定为 `6.1.1(24)` 的**旁证**（不是证据，是同行实践）。

---

## 4. "bash 不能调用"在 WorkBuddy 里为什么不是问题

### 4.1 它不试

`reqPermissions` 零条相关权限（§3），`EntryAbility` 没有后台执行类 Extension
⇒ 没有"在手机里跑命令"的代码路径。它不需要面对 `docs/104` 的六条读数。

### 4.2 执行位置是一个用户可见的开关

顶栏是 `☁️ 云端 工作模式 >`；点开后是一个底部弹层：

```
Text   | 选择设备              | [70,1677][1126,1761]
Button | 云端                  | [126,1873][1154,1957]   selected:true（绿勾）
Button | Sol的MateBook 14/离线 | [126,2069][1154,2153]
Button | 关闭                  | [1126,1677][1210,1761]
```

**列表里只有"云端"和"一台 PC"，没有这台手机。**

实测点选那台离线 PC：**三次点按均未生效**——第一次点按后面板仍在（未选中）；
另两次点按后面板关闭但顶栏模式**仍是 `云端`**。
⇒ 能确定的只有"未观察到选中离线主机"；**它是被禁用了、还是点选后静默回退，本轮未定论**（§9）。

### 4.3 定时任务也绑定执行主机——而且这里的"本地"是执行主机的本地

定时任务 tab 里唯一一条任务，卡片头部标着 **`Sol的MateBook 14`**，正文是：

> 每周三空闲时段，自动检测**本地** ppt-master 技能（位于 `~/.workbuddy/skills/ppt-master/`）是否有 GitHub 更新。
> 步骤：1）读取**本地** SKILL.md 中的 metadata.version（当前 v4.2.0）；2）通过 GitHub API …；
> 3）若远程版本高于本地，简要列出版本差异并提示用户是否更新，不要自动执行下载或覆盖本地文件；4）若已是最新，简单回报一下。

**这段话里的"本地"指的是执行主机的本地文件系统**（PC 上的 `~/.workbuddy/skills/`），
而不是用户手里这台手机——手机沙箱里连这个路径前缀都不存在。
⇒ 这正是"执行外移"在**文案层面**的痕迹：同一个任务描述，手机端渲染、PC 端执行。

---

## 5. 它的"工具调用"长什么样（形态对照）

| 维度 | WorkBuddy 手机端 | DSHM 手持档（现状） |
|---|---|---|
| 用户看到的能力入口 | **任务型**：`文档处理` / `幻灯片` / `工作台` / `数据分析` / `换一换`；底部 `任务` / `定时任务` / `发现` / `我的` | **开发者型**：会话 + 工作区 + 侧栏文件预览 +（终端受限） |
| 执行位置 | 云端（积分计量）/ 用户的 PC | 本机沙箱（手机档 `execve` 被系统拒，`docs/104`） |
| 手机侧承担的工作 | UI + 附件上传 + 语音输入（`MICROPHONE`）+ 通知（`PUBLISH_AGENT_REMINDER`）+ 保活连接（`KEEP_BACKGROUND_RUNNING`） | 全部：Host、核心树、模型调用、工具执行 |
| "工具名"是什么 | 对用户不可见（聊天/任务式） | 对模型可见（`read`/`write`/`edit`/`glob`/`grep` + 自带插件的 `remove`/`move`/`publish` 等） |
| 跨设备 | **是核心概念**（"选择设备"） | 有实现但降级为可选（`ConnectPane` 的「远程 Host」+ `hostkit`） |

一句话：**WorkBuddy 面向"交付物"，DSHM 面向"开发过程"。** 这个差异决定了它对 bash 的态度
（它不需要 bash），也决定了我们**不能照搬它的形态**——但可以照搬它的**位置取舍**。

---

## 6. DSHM 可借鉴的四条（按性价比排序）

### 6.1 【首选 · 零新代码】"执行外移"这条路，仓库里已经有了：`hostkit` + 「远程 Host」

- **PC 侧**：`hostkit/`（`@dsh-harmony/hostkit`，私包，Node ≥20）——
  配对（`pair` 打印 120 s 窗口的 `dshkit://` URI + 二维码）、LAN 发现、**端到端加密隧道，
  隧道出口仍在 `127.0.0.1`**、并以受管方式拉起/守护本机 `dsh web` 子进程。
  命令面：`start | pair | devices | revoke | audit | status | discover`。
- **手机侧**：`ConnectPane`（「远程 Host（可选）」）已支持三种接入
  ① 粘贴启动 URL（含 `?token=`，同时完成授权）② 手输 `host:port` + token ③ 局域网自动发现（P1，当前为入口 + 说明）。
- **安全口径天然满足本项目的红线**：`docs/10` §136 定的是"永不依赖 `0.0.0.0` 绑定、永不改写 `Host`/`Origin`；
  跨设备必须让请求在 Host 看来仍来自 loopback"——hostkit 的隧道设计**正是**这个形状。
- **现状（本轮实测，未改动）**：`node --test hostkit/test/index.mjs` = **146 项，145 通过 / 1 红**。
  红的那条是 `hostproc.test.mjs:90` 的 `parseAnnounce reads the upstream dsh web: line…`：
  用例夹具里的 token 写成了 `<示例 token>`（**含一个空格**），而 `parseAnnounce` 的正则是
  `(http:\/\/\S+?)…\s*$` ⇒ 含空格的 URL 必然不匹配、函数返回 `undefined`、断言炸在 `plain.host`。
  真实启动行里的 token 不含空格（`dsh web: http://127.0.0.1:3120/?token=QMHMWOSL…`）
  ⇒ **不影响真实链路，但它让这条可选路径的门禁不能叫"全绿"**。
- **为什么值得扶正**：这是**唯一**能让手机档拥有真 `bash`/真终端/真 `execve` 的路径
  （`docs/104` 已判决本机无解，且平台不会给我们放行）。而 WorkBuddy 的行为表明，
  "PC 当执行主机"是这个品类**成熟产品实际采用的答案**。
- **代价 / 待办**：① 先把上面那 1 条红测试变绿（并判断它是**夹具写错**还是**上游输出格式已变**）；
  ② `docs/60` 把 hostkit 从主流程降到「高级」，需要一份**用户能照着做**的文档才有意义；
  ③ 桌面载体（dsh desktop）本轮不在线，**端到端未复测**（§9）。

### 6.2 【低成本】把"本档能力"做成用户可见的事实（照抄它把执行位置放到顶栏的做法）

WorkBuddy 把"在哪儿执行"**直接摆在顶栏**（`☁️ 工作模式`）。我们手上已经有**同款事实、但没有展示面**：

- **事实在哪**：`host-ready.json` 的 `runtime` 段里已经有两批探针读数（入口脚本用 `PENDING_RUNTIME_PROBES`
  增量补写）：`exec 探测`（`python3/git/rg/ash/bash/system-sh/toybox…`）与 `终端能力`
  （`toybox域` / `toybox-stat-sh` / `toybox-exec-sh` / `toybox-exec-ash` / `libs-exec` + 汇总行）；
  同一批读数还压成**一行**写进 `dshm-host.log`（`docs/106` 做的可读副本，为的是"任何档位一条 grep 就能拿到结论"）。
- **展示面缺在哪**：`hostruntime` 的 `mergeRuntimeFacts()` 只把 `nodeVersion / platform / zstd / jitless /
  natives / listenAddress` 六个字段并进 `RuntimeProbe`（`hostruntime/src/main/ets/runtime/DshHost.ets:228`），**shell / 终端能力的结论不在其中**；
  诊断页 (`DiagnosticsPane`) 的能力条目目前只有「输入模态（键鼠 / 指针）」（`entry/src/main/ets/pages/Index.ets:1644`）。

⇒ 手持档的诊断页可以如实多一行：**"本档无 shell 进程；命令能力 = 系统 toybox 的 149 个 applet 子集"**。
价值：用户不必再靠读日志判断"为什么终端打不开"，也不必反复重试（`docs/104` §3 明确说"不要反复重试"）。
代价：读一个已有字段 + 加一条 `DiagEntry`，不触碰任何执行路径。
### 6.3 【沿用既定判决】本机唯一出路仍是 `docs/104` 的修法一 / 修法二

`toybox <applet>` 在手机档**能真跑**（149 applet，`ls/cat/grep/sed/find/xargs/sort/uniq/cut/head/tail/wc/cp/mv/rm/mkdir/chmod/tar/gzip/…`），
只是**不带 `sh`/`bash`/`ash`**。⇒ "真 userland 命令 + 纯 JS 命令翻译层"仍是本机的最优解。
**WorkBuddy 不构成反证**（它压根没在本机试过），所以 `docs/104` 的判决**不需要因为本轮而修改**。

### 6.4 【产品形态】把"终端"换成"任务型入口"（`docs/104` 修法三的成熟样本）

WorkBuddy 首页给用户的是 `文档处理` / `幻灯片` / `工作台` / `数据分析`，**不是** `bash`。
DSHM 手持档若最终决定"不暴露终端"（`docs/104` 修法三），那么**入口应该换成能力/任务**，
而不是留一个点开必然失败的终端图标——WorkBuddy 是这个取舍的现成样板。

---

## 7. 不该抄的三条

| 不抄 | 为什么 |
|---|---|
| **Flutter / `XComponent` 客户端架构** | 我们的界面是 ArkUI + 官方 Web 前端（`WebApp.ets` + 兼容内核）。换渲染引擎等于重做界面层，且与本项目的移植目标无关。 |
| **云端 agent** | 我们没有云端，也不打算有（`docs/00` 的核心取舍就是"端侧自足，不依赖另一台机器"）。它的"选择设备"里那个选项我们没有对应物。 |
| **把"设备列表"做成首屏模式开关** | 我们只有"本机 Host + 可选远程 Host"两级语义，没有"多台执行主机"的模型。照搬会造出一个语义上不成立的控件。 |

---

## 8. 与本项目既有判决的关系

| 既有判决 | 本轮的关系 |
|---|---|
| `docs/104`（手机/平板无真 shell 是系统级硬约束） | **一致**。WorkBuddy 的行为是这条判决的正面印证：成熟产品也不在本机试。 |
| `docs/110`（`compatibleSdkVersion = 6.1.1(24)`） | **旁证**。WorkBuddy 以 `compileSdkVersion 6.1.0.105` 在 AppGallery 正式分发、覆盖 `phone/tablet/2in1`，在 API 26 设备上正常运行。 |
| `docs/107` / `docs/110`（手持档"不能 spawn"⇒ 改进程内通道） | **同源不同解**。那两轮是**内联**（把 spawn 换成宿主进程内队列），本轮讨论的是**外移**（把执行搬到另一台机器）。两者不冲突：内联覆盖"必须在本机完成"的功能，外移覆盖"本机根本做不到"的功能（真 `bash`）。 |
| `docs/60`（hostkit 降级为「高级」） | 本轮**不改**该定位，只在 §6.1 指出：它是"手机端要真 shell"时的唯一门。是否扶正由用户拍板。 |

---

## 9. 未做 / 待决

- **未反编译 / 未解包 WorkBuddy**：release 签名 + el1 0700，权限上做不到（§2）。
- **未拿到它自己的运行时/工具调用日志**：它不写 hilog（§2）。
- **未验证 hostkit 隧道端到端**：桌面档设备本轮 Offline，且本轮性质是只读分析（§6.1 的 ③）。
- **未定论"离线主机是否可选中"**：三次点按均未生效（§4.2）；"禁用"与"静默回退"两种解释都无法证伪。
- **未验证"选择设备"里那台 PC 的形态**：只能确定它是一台与用户账号关联的设备（推断为 PC 侧配套执行体）；
  从手机侧无法证实它的实现（§4.2 的描述均限于 UI 事实）。
- **本轮未改任何代码、未装机、未 commit**：`hostkit` 那条红测试、`docs/60` 的 hostkit 定位、
  `docs/104` 修法一/二/三的取舍，**全部保持原样**等用户拍板。

---

## 10. 复现命令（可核查）

```powershell
$hdc = "C:\Users\Sol\AppData\Local\OpenHarmony\Sdk\26.0.0\toolchains\hdc.exe"

# 包清单（宿主侧捕获；不要在设备侧重定向，见 AGENTS.md）
& $hdc shell bm dump -n com.tencent.workbuddyohos | Out-File "$env:TEMP\wb\bmdump.txt" -Encoding utf8

# 界面树 + 截图
& $hdc shell uitest dumpLayout -b com.tencent.workbuddyohos -p /data/local/tmp/wb.json
& $hdc file recv /data/local/tmp/wb.json "$env:TEMP\wb\wb.json"
& $hdc shell uitest screenCap -p /data/local/tmp/wb.jpeg
& $hdc file recv /data/local/tmp/wb.jpeg "$env:TEMP\wb\wb.jpeg"

# 打开「工作模式」面板（坐标取自 dumpLayout 的 bounds）
& $hdc shell uitest uiInput click 424 282

# 它不写 hilog（698 条命中全来自系统侧 AMS/WMS/sceneboard）
& $hdc shell "ls -l /data/log/hilog | tail -5"

# 拿不到的（预期 Permission denied / Operation not permitted）
& $hdc shell "ls -la /data/app/el1/bundle/public/com.tencent.workbuddyohos"
& $hdc shell "head -5 /proc/<pid>/maps"

# 反证：hostkit（PC 侧桥）自身的门禁
node --test hostkit/test/index.mjs
```