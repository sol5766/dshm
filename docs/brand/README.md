# 鲸鸿 品牌资源

> 本目录的图片**全部由脚本生成**，不要手工替换。
> **2026-10-30 换标 + 换名**：品牌标由「虎鲸抱环」换成 **蓝鲸 + 光环 + 星芒**，应用名 DSHM → **鲸鸿**
> （英文层 `Jinghong`）。详见 `docs/320`。

## 生成方式

```bash
python3 tools/make-brand-master.py   # 从用户源件生成母版（白底→透明底、按 73.9% 口径归一化）
python3 tools/make-icon.py           # 从母版生成全部品牌物料（图标 / 启动画面 / 托盘 / 展示图 / Agent 图标）
```

- 源件留档：`third_party/brand-source/jinghong-1254-source.png`（用户给的 `Desktop/logo.png`，1254²，**白底**）。
- 母版：`third_party/brand-source/foreground-1024.png`（1024²，**透明底**，墨迹 757×444）。
- 母版与背景层都是**本地素材**，`/third_party/` 不入库；母版缺失时脚本**直接退出**，不猜、不退化。
- **零第三方依赖**：位图运算在 `tools/lib/tinypng.py`（纯标准库）。原因见该文件头注与 `docs/320` §3
  —— 本机没有 Pillow / numpy，也没有 openharmony-arm64 的轮子。

> ⚠️ 白底源件抠白有两条硬约束（`make-brand-master.py` 已实现，别改成"一刀切"）：
> ① 只从画布四边泛洪抠**连通的背景白**（鲸身内侧的浅蓝面是原画，不能被挖空）；
> ② 环内 / 鲸身与环之间的**封闭白**是原画留白，必须保持不透明。

## 本目录文件

| 文件 | 用途 | 尺寸 |
|---|---|---|
| `jinghong-icon.png` | README / 商店之外的展示图（白底合成版，看起来就是一个应用图标） | 512 |
| `jinghong-mark.png` | 纯标记、**透明底**（做物料时用） | 256 |
| `jinghong-icon-1024.png` | **AGC 商店图标上传件**（白底合成、正方形、RGB 无 alpha、**不烘圆角**） | 1024 |
| `jinghong-icon-216.png` | 同上（AGC 允许的另一档尺寸） | 216 |

> 上一代 `dshm-icon*.png` / `dshm-mark.png` **保留未删**（可能被历史文档引用），但已不是当前品牌；
> AGC 上架请用 `jinghong-icon-1024.png` / `jinghong-icon-216.png`。

> **AGC 商店图标口径**（素材规范，2026-10-16）：应用图标 1 张、**正方形**、**216×216 或 1024×1024**、
> PNG ≤ 3MB（或 WEBP ≤ 100KB）；圆角由平台加，**不要自己烘**。两档都由 `tools/make-icon.py`
> 从母版白底合成产出（与 APP 图标同构图：墨迹占画布 73.9%），实测 1024 → 305KB、216 → 24KB。

应用图标本体不在这里，而是直接写进 HarmonyOS 的资源目录：

| 路径 | 说明 |
|---|---|
| `AppScope/resources/base/media/{background,foreground}.png` | 分层图标的两层（系统自己加遮罩） |
| `entry/src/main/resources/base/media/{background,foreground}.png` | 同上；**必须与 AppScope 逐字节一致**，否则不同入口显示不同图标 |
| `entry/src/main/resources/base/media/startIcon.png` | 启动窗口图标（512，透明底品牌标） |
| `entry/src/main/resources/base/media/logo_dark.png` | 启动页大标识（512，透明底品牌标，**与 startIcon 同图**） |
| `phone/src/main/resources/...` 同上一整组 | 手机 HAP 是**另一套资源目录**；`check-brand-surface` 要求与 entry 逐字节一致 |
| `entry|phone/src/main/resources/rawfile/common/dshm_agent_icon.png` | A2A 智能体图标（512 透明底品牌标） |
| `entry/src/main/resources/rawfile/{tray_white,tray_black}.png` | 系统托盘（状态栏）图标，72px **单色剪影**（白 / 黑） |

## 设计

**品牌标 = 蓝鲸 + 光环 + 星芒**（2026-10-30 用户换标，源件 `Desktop/logo.png` 1254²，白底）：

1. **主体**：蓝色鲸鱼剪影（鲸身高光是**浅蓝**面，不是白色），被一道**渐变光环**自右向左环绕，
   环上叠一颗四角**星芒**；整体横长（757×444，≈1.71:1）；
2. **背景**：纯白（分层图标的 background 层，也是启动窗口 `startWindowBackground`）；
3. **母版**：`third_party/brand-source/foreground-1024.png`（1024²、**RGBA 透明底**，
   墨迹紧包围盒 **757×444**）+ `background-1024.png`（纯白）。

### 各形态的口径

- **APP 图标前景**（`foreground.png`）：母版做 **256 色分域量化**
  （实心体 `CORE_COLOURS=192` + 抗锯齿边缘 `RIM_COLOURS=63` + 全透明 1 色）。
- **启动画面**（`startIcon` / `logo_dark`）：方画布居中缩放，**墨迹最长边占画布 `SPLASH_RATIO=0.90`**
  （横长的标按长边算，上下自然留白；两侧取同一个 `place_centred()`，故两者逐字节相同）。
- **托盘**（`tray_white` / `tray_black`）：取品牌标的 **alpha 剪影**（鲸 + 环 + 星芒，只去颜色）。
  原因：`statusBarManager.StatusBarIcon` 要求**同一图案给两份**（white / black），
  由系统按状态栏明暗二选一 ⇒ 托盘在定义上就是**单色剪影**，不能是彩色图。
  实测外接框 **62×36**（72px 画布），框内留白 40.2%。

## 换名的两侧

应用名不只是图标：**用户可见的品牌名**在 `docs/320` §4 有逐处清单 ——
`AppScope`/`entry`/`phone` 的 `string.json`（应用名、托盘提示、会话卡片、A2A 描述）、
`AboutPanel`（关于页）、`Index.APP_NAME`（诊断报告抬头）、`StatusBarTray`（托盘菜单）、
以及 Web UI 品牌垫片 `dshcompat/WebBrand.ets`（侧栏名称与文档标题替换）。
门禁 `tools/check-brand-surface.mjs` 用常量 `BRAND_NAME` 判"垫片确实显示了我们的名字"。

## 实现要点（踩过的坑）

1. **数字量化要分域。** 对 (R,G,B,A) 做**单次联合八叉树**会把大部分调色板条目花在
   抗锯齿边缘上，使实心体渐变变块状。故**实心体与边缘簇分开量化**：实心体保
   `alpha=255`；边缘簇在**白底合成空间**聚类，每个条目再反解回 (颜色, alpha) 对。
   实测白底合成误差约为联合八叉树的一半，体积还略小。
2. **`logo_dark` 不能带白底。** 它用在**浅色启动页**（`#F3F7FB`）上；
   带白底方块会呈"小图带黑边"（项目验收记录里有这条）。故取透明底品牌标。
3. **托盘不用"墨迹覆盖率"当判据。** 本脚本是**抗锯齿**渲染（边缘半透明），覆盖率
   与"硬边渲染"口径不同，拿另一个渲染器的像素计数当基准会把几何完全正确的图判红。
   改判**外接框尺寸**（虎鲸标实测 `62×52` @ `x[5..66] y[10..61]`，与抗锯齿无关）
   + **框内透明像素占比 > 30%**（防"糊成一坨"；鲸身 + 鳍之间实测留白 46.5%，
   被填满外接框会掉到接近 0）。
4. **自检在写盘前跑完。** 旧版先落盘再自检 ⇒ 自检失败时坏图**已写进资源目录**
   （"退出码 1 但资源被污染"）。现在全部通过才写；失败则**一个文件都不动**。
5. **落盘后再断言两处一致。** `AppScope ↔ entry` 的 `foreground/background`、
   以及 `startIcon ↔ logo_dark`，必须**逐字节相同**。
6. **防回退断言。** `third_party/brand-original/`（旧鲸鱼启动画面，2026-09-25 归档）
   现在是**历史留档**；脚本断言 `startIcon` / `logo_dark` **不得**等于它
   （2026-10-11 用户要求把品牌标"一并改掉"，旧约束"启动画面用原版"作废）。
7. **`tools/make-brand-assets.mjs` 已废弃**（它画的是自研的字母 H 字形标记）。
   它与 `make-icon.py` 产出**同一批文件** ⇒ 两者都能跑会导致"图标莫名变回去"。
   故该脚本现在**直接拒绝执行**并指向新脚本；保留文件是为了存档那套
   H 字形标记的设计推导（carabiner 语义、同心波纹、配色理由）。
8. **`tools/gen-fish-logo.mjs` 只管顶栏功能资源，不参与品牌图标生成。** 它从核心树
   官方 primitives 逐字节复制鲸鱼 path 出 `fish_logo.svg`（`Image.fillColor` 按主题着色）。
   顶栏左上角已于 2026-10-10 由鲸鱼换成**侧栏按钮**（`sidebar_toggle.svg`），
   `fish_logo.svg` 随之不再被运行时代码引用，但**保留**（不删）。
9. **换标 = 重标定**（2026-10-16 虎鲸标换掉气泡标时的教训）：`make-icon.py` 里有三处
   **针对上一代图案写死的数**——前景"实心度"带（旧 18~24%，新标实测 24.05% ⇒ 现 22~26%）、
   托盘外接框（旧 `62×61` ⇒ 新 `62×52`）、托盘"框内留白"判据的说明文字。换标必须**先跑一次
   "只测量不落盘"**（自检失败时不写盘，正是为这个留的），把新实测值填回去再出图；
   改完记得同步 `tools/check-icon-assets.mjs` 的注释口径与本节数字。
