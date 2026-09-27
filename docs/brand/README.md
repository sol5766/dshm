# DSHM 品牌资源

本目录的图片**全部由脚本生成**，不要手工替换。

## 生成方式

```bash
node tools/gen-fish-logo.mjs    # ① 从核心树取官方鲸鱼 path → fish_logo.svg
python tools/make-icon.py       # ② 生成全部尺寸的图标/标记
```

① 必须先跑：②依赖 ① 产出的 `entry/src/main/resources/base/media/fish_logo.svg`。
（① 会自检"鲸鱼真实紧包围盒 == 官方 viewBox"，不符则拒绝生成。）

## 本目录文件

| 文件 | 用途 | 尺寸 |
|---|---|---|
| `dshm-icon.png` | README / 商店之外的展示图（白底，看起来就是一个应用图标） | 512 |
| `dshm-mark.png` | 纯标记、**透明底**、**不含右下角角标**（做浅色背景物料时用） | 256 |

应用图标本体不在这里，而是直接写进 HarmonyOS 的资源目录：

| 路径 | 说明 |
|---|---|
| `AppScope/resources/base/media/{background,foreground}.png` | 分层图标的两层（系统自己加遮罩） |
| `entry/src/main/resources/base/media/{background,foreground}.png` | 同上；**必须与 AppScope 完全一致**，否则不同入口显示不同图标 |
| `entry/src/main/resources/base/media/startIcon.png` | 启动窗口图标（512） |
| `entry/src/main/resources/base/media/logo_dark.png` | 启动页大标识（512，**透明底黑鲸**，不带白底方块） |

## 设计

**采用 dsh 官方白底黑鲸 logo，右下角加 `HM` / `OS` 四字母角标**。

1. **主体**：dsh 官方鲸鱼路径（`tools/gen-fish-logo.mjs` 从核心树
   `dsh-client-ui-primitives` 的 `FISH_LOGO_PATH` 取出，与官方**逐字节一致**，
   viewBox `0 0 23.16 17.04`），填官方墨色 `#151517`；
2. **背景**：纯白（分层图标的 background 层）；
3. **右下角**：`HM` / `OS` 四字母 **2×2 排布**，加粗黑体，**单个 `O` 下加一条
   短横线**（长度 = O 的墨迹宽度，不超出；紧贴 O 下缘），整体**逆时针旋转 45°**。
   字号取画布 **10.5%**（`FONT_RATIO = 0.105`）；
4. **为什么四字母用等宽单元**：直接整串绘制时 `S` 比 `M` 窄，右列会"缺一块"；
   改成"每字母一个等宽单元 + 单元内居中"后，两行外框等宽、两列中心对齐
   （实测列中心偏差 ≤1px）；
5. **为什么是 HM/OS 而非 HarmonyOS 全称**：图标内文字面积极小
   （缩到 48px 时每个字母仅约 5px 高），全称必然糊成一团。

## 实现要点（踩过的坑）

1. **鲸鱼是"带洞"图形 ⇒ 必须按 even-odd 合成。**
   path 有 4 个子路径，绕向 **CW/CCW 混合**（外轮廓 CW、三个内腔 CCW）。
   逐个子路径 `fill` 会把内腔**填黑**（第一版即如此）。
   `make-icon.py` 用扫描线 + even-odd 实现，并带**自检**：内腔采样点若为 0
   就判定失败退出，不产出一个"实心鲸鱼"。
2. **`logo_dark` 不能带白底。** 它用在**浅色启动页**（`#F3F7FB`）上；
   带白底方块会呈"小图带黑边"（项目在 `WebApp.ets` 里记过这条验收反馈）。
   故它取**透明底黑鲸、且不带右下角文字**。
3. **超采样 3× 后缩放**，避免小尺寸锯齿。
4. **`dshm-mark.png` 必须从"未合成角标"的底图出。** `whale.alpha_composite(blk_r, …)`
   是**就地**修改，若接着用 `whale.resize()` 出 mark，mark 会**带上角标**
   （真实 bug，已修：改从 `whale_base` 出图，并加了自检）。
5. **自检在写盘前跑完。** 旧版先落盘再自检 ⇒ 自检失败时坏图**已写进资源目录**。
   现在全部通过才写。
6. **`tools/make-brand-assets.mjs` 已废弃**（它画的是自研的字母 H 字形标记）。
   它与 `make-icon.py` 产出**同一批文件** ⇒ 两者都能跑会导致"图标莫名变回去"。
   故该脚本现在**直接拒绝执行**并指向新脚本；保留文件是为了存档那套
   H 字形标记的设计推导（carabiner 语义、同心波纹、配色理由）。
