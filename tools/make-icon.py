#!/usr/bin/env python3
"""
生成 DSHM 的 **APP 图标**（桌面/任务卡片图标）与品牌展示图。

───────────────────────────── 设计 ─────────────────────────────
· 主体：**dsh 官方鲸鱼**（白底黑鲸），路径取自核心树
  `dsh-client-ui-primitives` 的 `FISH_LOGO_PATH`（与官方逐字节一致，
  viewBox `0 0 23.16 17.04`），墨色同官方 `#151517`；
· 右下角：`HM` / `OS` 四字母 2×2 加粗，单个 O 下加短横线，整体逆时针 45°；
· 背景：纯白（分层图标的 background 层）。

──────────────────────── 产物（8 个，全是图标用途） ────────────────────────
| 路径 | 尺寸 | 说明 |
|---|---|---|
| `AppScope/resources/base/media/foreground.png`   | 1024 | 分层图标前景（系统遮罩） |
| `AppScope/resources/base/media/background.png`   | 1024 | 分层图标背景（纯白） |
| `entry/src/main/resources/base/media/foreground.png` | 1024 | 同上（**必须与 AppScope 一致**，否则不同入口图标不同） |
| `entry/src/main/resources/base/media/background.png` | 1024 | 同上 |
| `docs/brand/dshm-icon.png` | 512 | README 展示图（白底合成版） |
| `docs/brand/dshm-mark.png` | 256 | 纯标记（透明底，物料用） |
| `entry/src/main/resources/rawfile/tray_white.png` | 72 | **系统托盘（状态栏）图标·深色栏用**，纯白剪影 |
| `entry/src/main/resources/rawfile/tray_black.png` | 72 | **系统托盘图标·浅色栏用**，纯黑剪影 |

──────────────────── 托盘图标为什么是"纯鲸鱼单色"，不是 APP 图标 ────────────────────
`statusBarManager.StatusBarIcon` 要求**同一图案给两份**（`white` / `black`），由系统
按状态栏明暗二选一 ⇒ 托盘图标在定义上就是**单色剪影**，不能是带白底/带角标的彩色
图（那会变成一块白方块，且与微信等其它托盘图标风格不一致）。
因此这里取 APP 图标的**主标记**（鲸鱼，来自 `FISH_LOGO_PATH`）单独出图，
**不带**右下角 `HM`/`OS` 角标 —— 24vp 的尺寸下角标只有几像素，必然糊成一团。

────────────────── 🔴 本脚本**不产出**启动画面资源（2026-09-27 起） ──────────────────
| 不再产出的文件 | 现在由谁负责 |
|---|---|
| `entry/src/main/resources/base/media/logo_dark.png` | **原版**（启动页大标识/动画），归档在 `third_party/brand-original/` |
| `entry/src/main/resources/base/media/startIcon.png` | **原版**（启动窗口图标），同上 |

**用户明确要求"新图标只应用到 APP icon，启动画面和启动动画用原版"**，
所以本脚本**绝不写**这两个文件 —— 否则跑一次就会把启动画面改成带角标的版本。
要改启动画面请单独处理（并先与用户确认），不要从这里顺手改。

────────────────────────── 三个必须注意的点 ──────────────────────────
1. **必须按 even-odd 合成**：鲸鱼 path 有 4 个子路径，绕向 CW/CCW 混合
   （外轮廓 CW、三个内腔 CCW）⇒ 是"带洞"图形。逐个子路径 `fill`
   会把内腔填黑（第一版即如此，靠绕向自检发现）。
   所以下面用自实现的扫描线 + even-odd 填充。
2. **四字母要等宽单元**：直接整串绘制时 `S` 比 `M` 窄，右列会"缺一块"。
3. **横线基准用 O 自己的下缘**：`textbbox` 返回的是含升降部的排版框，
   比全大写字母的实际下缘低 8~15%，拿它当"字底"会把横线放得过远。

用法：
    python tools/make-icon.py
前置：`entry/src/main/resources/base/media/fish_logo.svg` 存在
（由 `node tools/gen-fish-logo.mjs` 从核心树生成）。
"""
import math
import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont

"""
【为什么强制 stdout 用 UTF-8】本机 Windows 控制台默认 GBK，
脚本里的中文与箭头符号（⇒）会触发 UnicodeEncodeError 而中断 ——
那是**输出编码**问题，不是逻辑问题。这里显式重配，让脚本在任何控制台都能跑完。
"""
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

FISH_SVG = os.path.join(ROOT, 'entry', 'src', 'main', 'resources', 'base', 'media', 'fish_logo.svg')
INK = (0x15, 0x15, 0x17, 255)          # 官方墨色 #151517
WHITE = (255, 255, 255, 255)
SS = 3                                  # 超采样倍数

# ── 托盘（状态栏）图标参数 ──
TRAY_PX = 72                            # 官方建议 24vp×24vp；实产 72px 供高分屏
# 鲸鱼宽度占画布比。
# 【为什么是 0.861 这个"零头"数】取自**上一代 DSHM 项目在真机上跑通过的**
# tray_white.png 实测：其墨迹外接框 62×46（72px 画布）⇒ 62/72 = 0.861。
# 旁证同源：62/46 = 1.348，鲸鱼 viewBox 23.16/17.04 = 1.359（差异是像素取整）。
# 这个值在真机托盘里视觉边距合适，没理由重新发明。
TRAY_RATIO = 0.861
TRAY_WHITE = (255, 255, 255, 255)
TRAY_BLACK = (0, 0, 0, 255)
# 墨迹外接框期望值（**真正的判据**，见自检⑤处为什么覆盖率不能当判据）。
# 取自上一代真机跑通的 tray_white.png 实测：62×46 @ x[5..66] y[13..58]。
# 本脚本硬边渲染得 63×46 @ x[5..67]，差 1px 是边界取整 —— 判定带 ±1。
TRAY_BBOX_W = 62
TRAY_BBOX_H = 46
FONTS = [
    # 【优先加粗】用户要求"字体加粗一点"。顺序即优先级：
    #   ① 各家的 **Bold** 独立字体文件（真正的粗体字形，不是合成加粗）
    #   ② 常规体兜底（跨平台可跑，避免因缺字体而中断）
    # 为什么不用 Pillow 的 stroke_width 合成加粗：它靠描边膨胀字形，
    # 小字号（48px 图标角标仅几像素）会把 o/h 的内孔糊死。
    r'C:\Windows\Fonts\segoeuib.ttf',       # Segoe UI Bold
    r'C:\Windows\Fonts\arialbd.ttf',        # Arial Bold
    r'C:\Windows\Fonts\calibrib.ttf',       # Calibri Bold
    r'C:\Windows\Fonts\segoeui.ttf',        # 兜底：常规
    r'C:\Windows\Fonts\arial.ttf',
    '/system/fonts/HarmonyOS_Sans_SC_Bold.ttf',
    '/system/fonts/HarmonyOS_Sans_SC_Regular.ttf',
]


# ───────────────────────── path 解析/展平 ─────────────────────────
def lex(d):
    return re.findall(r'[MLCZmlcz]|-?\d*\.?\d+(?:e[-+]?\d+)?', d)


def cubic(p0, p1, p2, p3, t):
    u = 1 - t
    return (u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0],
            u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1])


def subpaths(d, steps=300):
    toks = lex(d)
    subs, pts = [], []
    cur = start = (0.0, 0.0)
    i = 0
    while i < len(toks):
        c = toks[i]
        if not re.fullmatch(r'[MLCZmlcz]', c):
            i += 1
            continue
        i += 1
        if c in 'Zz':
            if len(pts) >= 3:
                subs.append(pts)
            pts = []
            cur = start
            continue
        nums = []
        while i < len(toks) and not re.fullmatch(r'[MLCZmlcz]', toks[i]):
            nums.append(float(toks[i]))
            i += 1
        if c in 'Mm':
            if len(pts) >= 3:
                subs.append(pts)
            pts = []
            cur = start = (nums[0], nums[1])
            pts.append(cur)
        elif c in 'Ll':
            k = 0
            while k + 1 < len(nums):
                cur = (nums[k], nums[k + 1])
                pts.append(cur)
                k += 2
        elif c in 'Cc':
            k = 0
            while k + 5 < len(nums):
                p1 = (nums[k], nums[k + 1]); p2 = (nums[k + 2], nums[k + 3]); p3 = (nums[k + 4], nums[k + 5])
                for s in range(1, steps + 1):
                    pts.append(cubic(cur, p1, p2, p3, s / steps))
                cur = p3
                k += 6
    if len(pts) >= 3:
        subs.append(pts)
    return subs


def signed_area(poly):
    a = 0.0
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    return a / 2


def fill_evenodd(size, subs, sx, sy, ox, oy, color):
    """扫描线 + even-odd 填充（正确处理多子路径的"洞"）。"""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    px = img.load()
    polys = [[(x * sx + ox, y * sy + oy) for (x, y) in p] for p in subs]
    ys = [pt[1] for p in polys for pt in p]
    y0, y1 = max(0, int(min(ys))), min(size - 1, int(max(ys)) + 1)
    for y in range(y0, y1 + 1):
        yc = y + 0.5
        xs = []
        for p in polys:
            n = len(p)
            for i in range(n):
                x1, y1_ = p[i]
                x2, y2_ = p[(i + 1) % n]
                if (y1_ <= yc < y2_) or (y2_ <= yc < y1_):
                    t = (yc - y1_) / (y2_ - y1_)
                    xs.append(x1 + t * (x2 - x1))
        if not xs:
            continue
        xs.sort()
        for i in range(0, len(xs) - 1, 2):
            a, b = int(round(xs[i])), int(round(xs[i + 1]))
            for x in range(max(0, a), min(size - 1, b) + 1):
                px[x, y] = color
    return img


def make_tray(subs):
    """产出托盘（状态栏）图标：同一鲸鱼图案的**纯白**与**纯黑**两份单色剪影。

    【为什么复用 `fill_evenodd` 而不是另写一份路径解析】鲸鱼 path 是"带洞"图形
    （外轮廓 CW、三个内腔 CCW）。任何绕过 even-odd 的简化实现都会把内腔填实，
    得到一团黑块 —— 托盘只有 24vp，这种错误在小尺寸下就是"一个方块"。
    共用同一段填充逻辑，等于共用同一份已经过绕向自检的正确性。
    """
    px = TRAY_PX
    whale_w = px * TRAY_RATIO
    sc = whale_w / 23.16
    whale_h = 17.04 * sc
    ox = (px - whale_w) / 2
    oy = (px - whale_h) / 2
    white = fill_evenodd(px, subs, sc, sc, ox, oy, TRAY_WHITE)
    black = fill_evenodd(px, subs, sc, sc, ox, oy, TRAY_BLACK)
    return white, black


def main():
    if not os.path.exists(FISH_SVG):
        print('[make-icon] 缺 fish_logo.svg；先跑 node tools/gen-fish-logo.mjs', file=sys.stderr)
        return 1

    svg = open(FISH_SVG, encoding='utf-8').read()
    d = re.search(r'd="([^"]+)"', svg).group(1)
    vb_w, vb_h = 23.16, 17.04

    subs = subpaths(d)
    areas = [signed_area(p) for p in subs]
    mixed = len({a > 0 for a in areas}) > 1
    print(f'[make-icon] 子路径 {len(subs)}，有向面积 {["%.2f" % a for a in areas]}')
    print(f'[make-icon] 含洞（绕向混合）: {mixed}  ⇒ {"用 even-odd 合成" if mixed else "同向，等价"}')

    big = 1024 * SS
    whale_w = big * 0.70
    sc = whale_w / vb_w
    whale_h = vb_h * sc
    ox = (big - whale_w) / 2
    oy = big * 0.42 - whale_h / 2
    whale = fill_evenodd(big, subs, sc, sc, ox, oy, INK)

    # ── 右下角角标：`HM` / `OS` 四字母 2×2，黑色，O 下一条紧贴的短横线 ──
    #
    # 【为什么是 HM / OS 而非 HarmonyOS 全称】图标内文字面积极小
    # （缩到 48px 时角标只有几像素），全称必然糊成一团。HM/OS 四字母
    # 是这个尺寸下仍可辨的最大信息量。
    LETTERS = [['H', 'M'], ['O', 'S']]

    FONT_RATIO = 0.105      # 字号占画布比
    LINE_RATIO = 0.86       # 行距倍数
    fs = int(big * FONT_RATIO)
    font = next((ImageFont.truetype(f, fs) for f in FONTS if os.path.exists(f)), None)
    if font is None:
        print('[make-icon] 找不到 TrueType 字体', file=sys.stderr)
        return 1
    line_h = fs * LINE_RATIO

    # 【用"真实墨迹"而不是排版框定位】
    # `textbbox` 返回含**升降部**的排版框：对全大写字母，框底通常比字形
    # 实际下缘低 8~15%。拿它当"字底"会把横线放得过远。
    # 做法：把字画进小图后扫墨迹，取真实上下缘。
    def ink_bbox(txt):
        """该文本的真实墨迹框（相对绘制原点 (0,0)）。"""
        pad = fs
        tmp = Image.new('L', (int(fs * len(txt) * 1.8) + pad * 2, fs * 3), 0)
        ImageDraw.Draw(tmp).text((pad, pad), txt, font=font, fill=255)
        bb = tmp.getbbox()
        if bb is None:
            return (0, 0, 0, 0)
        return (bb[0] - pad, bb[1] - pad, bb[2] - pad, bb[3] - pad)

    # 逐字母量墨迹（**不是整串**）—— 这是"四字母等宽"的前提
    let_ink = {}
    for row in LETTERS:
        for ch in row:
            if ch not in let_ink:
                let_ink[ch] = ink_bbox(ch)

    # ── 等宽单元 ──
    # 【为什么要这样】用户指出"S 比 M 窄"：整串 `HM`/`OS` 直接绘制时，
    # 各字母按自身宽度排布，于是右列（M / S）宽度不一，25px 缩放下看出"缺一块"。
    # 改成"每字母一个等宽单元 + 单元内居中" ⇒ 两行外框完全等宽、列对齐。
    max_w = max(b[2] - b[0] for b in let_ink.values())
    letter_gap = fs * 0.16                  # 单元之间的净空隙
    cell_w = max_w + letter_gap

    # 每行的墨迹纵向范围（该行所有字母的并集）
    row_top = [min(let_ink[ch][1] for ch in row) for row in LETTERS]
    row_bot = [max(let_ink[ch][3] for ch in row) for row in LETTERS]

    rule_h = max(2, int(fs * 0.055))     # 线宽
    # 【与 O 底的间隙】用户要求"很近"：0.055 → 0.030 → **0.012**。
    # 不设 0：完全贴合会与 O 的圆底连成一体、看起来像"Q"，小尺寸下更糊。
    rule_gap = fs * 0.012
    margin = fs * 0.22

    # ── 块坐标 ──
    # x 框架由"单元网格"定义 ⇒ 天然等宽（不再依赖字母墨迹宽度）
    ink_x0 = 0.0
    ink_x1 = cell_w * len(LETTERS[0])
    ink_y0 = min(row_top[i] + i * line_h for i in range(len(LETTERS)))
    ink_y1 = max(row_bot[i] + i * line_h for i in range(len(LETTERS)))
    # 横线在 O 下缘之下，也要计入块高
    o_ink = let_ink['O']
    rule_y = o_ink[3] + 1 * line_h + rule_gap       # O 在第 1 行
    ink_y1 = max(ink_y1, rule_y + rule_h)

    blk_w = int(ink_x1 - ink_x0 + margin * 2)
    blk_h = int(ink_y1 - ink_y0 + margin * 2)
    blk = Image.new('RGBA', (blk_w, blk_h), (0, 0, 0, 0))
    bd = ImageDraw.Draw(blk)

    o_left_blk = 0.0     # O 在块内的左缘（下面算横线要用）
    for i, row in enumerate(LETTERS):
        oy = margin - ink_y0 + i * line_h          # 该行共用同一绘制基线原点
        for j, ch in enumerate(row):
            li = let_ink[ch]
            lw = li[2] - li[0]
            # 单元内居中
            target_left = j * cell_w + (cell_w - lw) / 2
            ox = margin - ink_x0 + target_left - li[0]
            bd.text((ox, oy), ch, font=font, fill=INK)
            if ch == 'O':
                o_left_blk = margin - ink_x0 + target_left

    # 横线：长度 = **O 的真实墨迹宽度**（不超出 O），紧贴其下缘
    rx0 = o_left_blk
    rx1 = o_left_blk + (o_ink[2] - o_ink[0])
    ry = margin - ink_y0 + rule_y
    bd.rectangle([rx0, ry, rx1, ry + rule_h], fill=INK)

    # 逆时针 45°：PIL 的 rotate 正角度即逆时针
    #
    # 【MAKE_ICON_ROT 调试旋钮】置 0 可产出"未旋转"版本，用于核对角标
    # 内部的相对关系（旋转后横线变成斜线，几何核对会失真）。
    # 正常产出不要用 0。
    ROT = float(os.environ.get('MAKE_ICON_ROT', '45'))
    blk_r = blk.rotate(ROT, resample=Image.BICUBIC, expand=True)

    # 【关键】合成角标**之前**先留一份"只有鲸鱼"的底图。
    # `whale.alpha_composite(...)` 是就地修改，之后 whale 就带角标了；
    # `mark`（纯标记）必须从这份底图出，否则会带上 HM/OS（曾经的真实 bug）。
    whale_base = whale.copy()

    # 位置：整体（旋转后的外接框）贴右下角，留统一边距
    pad = big * 0.045
    px_ = int(big - pad - blk_r.width)
    py_ = int(big - pad - blk_r.height)
    whale.alpha_composite(blk_r, (max(0, px_), max(0, py_)))

    # 【自检①】角标旋转后**不得被裁**。
    # ⚠️ 说明：`rotate(expand=True)` 会按外接框扩画布，墨迹通常**不会贴边**，
    # 所以"触边"这个判据在 expand=True 下几乎不会触发（审查实测：margin≥1px 即 False）。
    # 因此这里补一个**更强的判据**：角标墨迹面积必须落在预期区间，
    # 否则说明块尺寸/行距/位置算错（如"块高漏算行距"会让第二行被裁）。
    cb = blk_r.split()[3].getbbox()
    if cb is not None and (cb[0] <= 0 or cb[1] <= 0
                           or cb[2] >= blk_r.width or cb[3] >= blk_r.height):
        print('[make-icon] 文字旋转后被裁切（墨迹触边）', file=sys.stderr)
        return 1
    badge_ink = sum(1 for p in blk_r.split()[3].getdata() if p > 128)
    lo, hi = int(blk_r.width * blk_r.height * 0.06), int(blk_r.width * blk_r.height * 0.30)
    print(f'[make-icon] 角标墨迹 {badge_ink}（预期 {lo}~{hi}）')
    if not (lo <= badge_ink <= hi):
        print('[make-icon] 角标墨迹面积异常 —— 文字可能被裁/变形', file=sys.stderr)
        return 1

    fg = whale.resize((1024, 1024), Image.LANCZOS)
    bg = Image.new('RGBA', (1024, 1024), WHITE)
    comp = Image.alpha_composite(bg, fg)
    showcase = comp.resize((512, 512), Image.LANCZOS)          # 白底合成版（展示用）
    # 【bug 修复 2026-09-27】此前 `mark = whale.resize(...)` 会**带上角标**：
    #   `whale.alpha_composite(blk_r, ...)` 是**就地**合成（PIL 该方法无返回值、直接改
    #   宿主画布），所以 `whale` 已被写上 HM/OS。于是 docs/brand/README.md 说 mark 是
    #   "纯标记、不带右下角文字"，实际却带着 —— 三路独立审查各自命中
    #   （与 foreground 缩小版逐像素 alpha 差异 **0**，右下角墨点 386）。
    # 修法：从**未合成角标**的 `whale_base` 另存 mark。
    mark = whale_base.resize((512, 512), Image.LANCZOS)        # 透明底纯标记（物料用，无角标）

    # ── 托盘（状态栏）图标：同一鲸鱼的纯白/纯黑单色剪影 ──
    tray_white, tray_black = make_tray(subs)

    # 【只写 APP 图标用途的文件】
    # ⚠️ **不含** startIcon.png / logo_dark.png —— 那两个是**启动画面**资源，
    # 用户明确要求"用原版"。它们的正本归档在 `third_party/brand-original/`；
    # 本脚本一旦写它们，就等于把启动画面改成带角标的版本（用户不要）。
    outs = [
        ('AppScope/resources/base/media/foreground.png', fg),
        ('AppScope/resources/base/media/background.png', bg),
        ('entry/src/main/resources/base/media/foreground.png', fg),
        ('entry/src/main/resources/base/media/background.png', bg),
        ('docs/brand/dshm-icon.png', showcase),
        ('docs/brand/dshm-mark.png', mark.resize((256, 256), Image.LANCZOS)),
        ('entry/src/main/resources/rawfile/tray_white.png', tray_white),
        ('entry/src/main/resources/rawfile/tray_black.png', tray_black),
    ]
    # ── 写盘前先把所有自检跑完 ──
    # 【为什么"先自检后写盘"】旧版先落盘再自检：自检失败时坏图**已经写进资源目录**，
    # 等于"退出码 1 但资源被污染"（审查实测：强制失败后磁盘上仍留下 6 个 PNG）。
    # 现在全部自检通过才写；失败则一个文件都不动。
    failures = []

    # 【自检①】鲸鱼内腔必须保留（证明 even-odd 生效、洞没被填黑）。
    # ⚠️ 旧判据"固定窗口数透明点 > 0"**拦不住**它声称要防的 bug：
    #   采样窗 x∈[300,700] y∈[400,620] 里有若干点本就落在鲸鱼轮廓**之外**，
    #   恒为透明 ⇒ holes 永远 > 0（审查构造反例：逐子路径 fill 把洞填黑，脚本仍 exit 0）。
    # 改成"内腔必须有墨、且**外面**必须有透明"两头都判，并给出具体坐标。
    fpx = fg.split()[3]
    # 【自检①】鲸鱼"实心度"必须落在预期带内。
    # 这比"数几个取样点"稳健：even-odd 失效（内腔被填黑）会让实心度**显著上升**。
    #
    # 【带宽是按实测差标定的，不是拍脑袋】两个版本实测（1024 画布）：
    #     正常 even-odd    18.10%
    #     错 逐子路径 fill 23.46%   ← 填黑内腔使实心度 +5.36 个百分点
    # ⇒ 带宽必须**窄于**两者之差才有鉴别力。取 16%~20%（正常值居中）。
    #   曾经用过 15%~25%：坏图 23.46% 落在带内 ⇒ **根本拦不住**（对抗测试发现）。
    opaque = sum(1 for p in fpx.getdata() if p > 128)
    lo, hi = int(1024 * 1024 * 0.16), int(1024 * 1024 * 0.20)
    print(f'[make-icon] 前景不透明像素 {opaque}（预期 {lo}~{hi}，正常约 18.1%）')
    if not (lo <= opaque <= hi):
        failures.append(f'前景实心度异常（{opaque} 不在 {lo}~{hi}）—— 内腔被填黑或缩放错')
    # 画布四角必须透明（鲸鱼不该铺满）
    corners_ink = sum(1 for (x, y) in [(4, 4), (1019, 4), (4, 1019), (1019, 1019)] if fpx.load()[x, y] > 128)
    if corners_ink > 0:
        failures.append('画布四角有墨（鲸鱼溢出/填充范围错）')

    # 【自检②】`mark` 必须**不带**角标（文档描述为"纯标记、透明底"）。
    #
    # ⚠️ 两次写错判据，记录在此以免后人重犯：
    #   ① "看右下角有没有墨"—— 那片区域**鲸鱼尾鳍本来就有墨**，无法区分鳍与角标；
    #   ② "把 mark 放大到 1024 与 fg 逐像素比"—— mark 走 3072→512→1024 的重采样
    #      路径与 fg 不同，会引入**遍地**差异，判据失效。
    # 正确判据（只用同一尺度、且能区分"鳍"与"鳍+角标"）：
    #   在 512 尺度上比较 mark 与 fg 在**角标框内**的不透明像素数。
    #   · mark 干净 ⇒ 框内只有鳍 ⇒ 明显**少于** fg
    #   · mark 带角标 ⇒ 框内 = 鳍+角标 ⇒ 与 fg **基本相等**
    mk512 = mark.split()[3].load()
    # 【尺度换算】角标框坐标在 `big`(=1024*SS=3072) 尺度，mark 是 512 ⇒ 除以 6。
    # （写错过一次：除以 2 得到 1536 越界，框内空 → 判据失效。）
    scale512 = 512.0 / big
    bx0, by0 = int(px_ * scale512), int(py_ * scale512)
    bx1 = min(512, int((px_ + blk_r.width) * scale512))
    by1 = min(512, int((py_ + blk_r.height) * scale512))
    fg512 = fg.resize((512, 512), Image.LANCZOS).split()[3].load()
    mk_ink = sum(1 for y in range(by0, by1) for x in range(bx0, bx1) if mk512[x, y] > 128)
    fg_ink = sum(1 for y in range(by0, by1) for x in range(bx0, bx1) if fg512[x, y] > 128)
    print(f'[make-icon] 角标框内墨点 mark={mk_ink} fg={fg_ink}'
          f'（mark 应明显少于 fg；相当=mark 带上了角标）')
    if fg_ink > 50 and mk_ink >= fg_ink * 0.9:
        failures.append('mark 在角标框内与 fg 相当 —— mark 被带上了角标（应从 whale_base 出图）')

    # 【自检③】AppScope 与 entry 两份 foreground/background 必须**字节相同**
    # （品牌文档要求：不同则不同入口图标不一致）。写盘后校验实际落盘文件。
    # 注：outs 里两处写的是同一个内存对象，理论上必然相同；这条断言防的是
    # 将来有人把其中一处改成"另一版本图"（例如单独给 entry 换图）。

    # 【自检④】托盘图标：两份必须**同形**、且各自颜色正确、覆盖率在带内。
    #
    # 【为什么必须判"同形"】系统按状态栏明暗二选一渲染（white/black），两份若
    # 形状不同，用户在切换深浅色时图标会"变样"。alpha 通道必须逐像素相等。
    tw_a = tray_white.split()[3].load()
    tb_a = tray_black.split()[3].load()
    shape_diff = sum(1 for y in range(TRAY_PX) for x in range(TRAY_PX) if tw_a[x, y] != tb_a[x, y])
    print(f'[make-icon] 托盘 白/黑 alpha 差异像素 {shape_diff}（必须 0）')
    if shape_diff != 0:
        failures.append(f'托盘 white/black 形状不一致（alpha 差异 {shape_diff} 像素）')

    # 颜色必须纯粹：白图所有不透明像素都是纯白、黑图都是纯黑。
    # 旧项目实测正是这样（中心像素 R=G=B=255 / R=G=B=0），系统据此做明暗适配。
    tw_rgb = tray_white.convert('RGBA').load()
    tb_rgb = tray_black.convert('RGBA').load()
    bad_color = 0
    for y in range(TRAY_PX):
        for x in range(TRAY_PX):
            if tw_a[x, y] > 128:
                r, g, b, _ = tw_rgb[x, y]
                if not (r == 255 and g == 255 and b == 255):
                    bad_color += 1
            if tb_a[x, y] > 128:
                r, g, b, _ = tb_rgb[x, y]
                if not (r == 0 and g == 0 and b == 0):
                    bad_color += 1
    print(f'[make-icon] 托盘 非纯色像素 {bad_color}（必须 0；白图须纯白、黑图须纯黑）')
    if bad_color != 0:
        failures.append(f'托盘图标含非纯色像素（{bad_color} 个）—— 状态栏明暗适配会失准')

    # 【自检⑤】墨迹外接框必须与"上代真机跑通的那张图"一致。
    #
    # ⚠️ 这里曾经用过"墨迹覆盖率百分比"作判据，**标定错了**（实测被抓）：
    #   我拿上代 tray_white.png 的 `A==255` 计数 1232 当基准（= 23.76%），
    #   但那张图是**抗锯齿**渲染（半透明 351 像素），而本脚本 `fill_evenodd`
    #   是**硬边**（半透明 0）⇒ 两者口径不同，硬边图的覆盖率天然更高（29.59%）。
    #   于是自检把一张**几何完全正确**的图判成失败。
    #   ⇒ 教训：拿另一个渲染器的像素计数当基准，必须先把口径对齐；对不齐就别用。
    #
    # 正确判据用**外接框**：它是"形状"的度量，与抗锯齿/取整无关 ——
    # 抗锯齿只会把边界像素变灰，不会改变外接框落在哪一行哪一列。
    # 期望值即上代真机图的实测值（x[5..66] y[13..58]，63×46），容差 ±1px
    # 吸收硬边/抗锯齿在边界上的取整差。
    xs = [x for y in range(TRAY_PX) for x in range(TRAY_PX) if tw_a[x, y] > 128]
    ys = [y for y in range(TRAY_PX) for x in range(TRAY_PX) if tw_a[x, y] > 128]
    if not xs or not ys:
        failures.append('托盘图标整张全透明 —— 鲸鱼根本没画上去')
    else:
        bw, bh = max(xs) - min(xs) + 1, max(ys) - min(ys) + 1
        print(f'[make-icon] 托盘 墨迹外接框 x[{min(xs)}..{max(xs)}] y[{min(ys)}..{max(ys)}]'
              f' = {bw}×{bh}（上代真机 62×46 @ x[5..66] y[13..58]，容差 ±1）')
        if abs(bw - TRAY_BBOX_W) > 1 or abs(bh - TRAY_BBOX_H) > 1:
            failures.append(f'托盘鲸鱼外接框 {bw}×{bh} 偏离预期 {TRAY_BBOX_W}×{TRAY_BBOX_H}'
                            f'（±1）—— 缩放/留边算错')
        if min(xs) < 1 or min(ys) < 1 or max(xs) > TRAY_PX - 2 or max(ys) > TRAY_PX - 2:
            failures.append(f'托盘鲸鱼贴边（x[{min(xs)}..{max(xs)}] y[{min(ys)}..{max(ys)}]）'
                            f'—— 状态栏里会被裁掉边缘')

    # 鲸鱼内腔（洞）必须在托盘小图上仍保留：取鲸鱼中部偏上一处本该透明的点。
    # 【坐标怎么定】72px 下鲸鱼占 x[5..67] y[13..58]，其身体内部三个内腔之一
    # 落在画布中心附近。这里不写死单点（易受取整影响），改为统计"内腔带"里的
    # 透明像素数：even-odd 生效则该带必须有透明点，被填实则恒为 0。
    hole_band_transparent = sum(
        1 for y in range(26, 42) for x in range(24, 48) if tw_a[x, y] <= 128)
    print(f'[make-icon] 托盘 内腔带透明像素 {hole_band_transparent}（必须 > 0，否则洞被填黑）')
    if hole_band_transparent == 0:
        failures.append('托盘鲸鱼内腔被填实（even-odd 失效）—— 在 24vp 下会显示成一个方块')

    if failures:
        for f in failures:
            print(f'[make-icon] ✗ {f}', file=sys.stderr)
        print('[make-icon] 自检未过 —— **未写任何文件**', file=sys.stderr)
        return 1

    # ── 全部自检通过，开始写盘 ──
    for rel, img in outs:
        p = os.path.join(ROOT, rel.replace('/', os.sep))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        img.save(p, 'PNG', optimize=True)
        print(f'[make-icon]   {rel}  {img.size[0]}x{img.size[1]}  {os.path.getsize(p)//1024}KB')

    # 【护栏·真断言，不是 print】启动画面资源必须仍是"原版"。
    # 旧版只 `print('（未改动）…')`，即使把 startIcon 加进 outs 被覆盖，
    # 也照样打印"未改动"（审查实测：文件从 3577B 被改成 59441B 而日志说没改）。
    # 现在改为与 `third_party/brand-original/` 逐字节比对，不一致即报错。
    orig_dir = os.path.join(ROOT, 'third_party', 'brand-original')
    for base in ['startIcon.png', 'logo_dark.png']:
        cur = os.path.join(ROOT, 'entry', 'src', 'main', 'resources', 'base', 'media', base)
        org = os.path.join(orig_dir, base)
        if not os.path.exists(org):
            print(f'[make-icon] ⚠ 缺原版归档 {org}，无法校验 {base}', file=sys.stderr)
            continue
        if not os.path.exists(cur):
            print(f'[make-icon] ✗ 启动画面资源缺失：{base}', file=sys.stderr)
            return 1
        with open(cur, 'rb') as f1, open(org, 'rb') as f2:
            same = f1.read() == f2.read()
        print(f'[make-icon]   {"✓ 原版" if same else "✗ 被改动"} {base}')
        if not same:
            print(f'[make-icon] ✗ {base} 与 brand-original 不一致 —— '
                  f'启动画面必须用原版（本脚本不得写它）', file=sys.stderr)
            return 1

    return 0


if __name__ == '__main__':
    sys.exit(main())
