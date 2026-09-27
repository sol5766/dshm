/**
 * HarmonyTheme —— **Web 语义 → HarmonyOS 视觉**的映射层（P1.5）。
 *
 * ## 为什么要有这一层（而不是继续加 Parity* 令牌）
 *
 * 本项目的对等原则是「**功能与交互语义对齐官方 Web；布局、输入与系统能力按设备适配**」。
 * 落到视觉上有两种做法：
 *   A. 把 Web 的 CSS 像素级翻译成 ArkUI —— 追不上（官方主题一改就重做），且丢掉鸿蒙的原生质感；
 *   B. **产品语义保持 Web，视觉/交互用 HarmonyOS 原生表达** —— 本层就是 B 的落点。
 *
 * 因此这里分成两半：
 *   · **上半：Harmony* 视觉令牌**（Color/Typography/Spacing/Radius/Border/Elevation/Motion/Touch）——
 *     尽量指向**系统语义资源**（`sys.color.*`），于是深浅色、品牌色、无障碍对比由系统保证；
 *   · **下半：`WEB_TOKEN_MAP`** —— 把官方 Web 的语义 token 名映射到上面的视觉令牌，
 *     **一一写在数据里**。官方 Web 更新时，先改这张表，而不是满仓找 `fontSize`。
 *
 * ## 与既有 Tokens.ets 的关系（不重复实现）
 *
 * `Tokens.ets` 是**尺度原语**（Sp/Radius/Border/Fs/Sz/Dur——"有哪些档位"）；
 * 本文件是**语义角色**（"这个位置该用哪一档"）。角色的值**引用原语**，不另立数字。
 *
 * ## 一条硬约束（实测，决定了 Material 层的写法）
 *
 * `$r('sys.color.*')` 的名字**由编译器校验**（注入假名字会 `Unknown resource name` 并 BUILD FAILED）⇒
 * 本文件里出现的每个系统资源名都是**编译期验证过存在**的，不是"看起来像"。
 */

import { Border, Dur, Fs, Lh, Radius, Sp, Sz } from './Tokens';

// ───────────────────────── ① 语义颜色 ─────────────────────────

/**
 * 语义颜色：**角色 → 系统资源**。
 *
 * 只增角色，不增色值。凡是系统已有的语义（正文字阶、表面、描边、状态色、品牌色之上的一层）
 * 一律用 `sys.color.*`，让深浅色/品牌色/对比度**由系统保证**——
 * 手工色值在深色模式下必然有一处看不清，而那是真机上才发现的缺陷。
 */
export class HarmonyColor {
  // 文字阶（三级，够用且不过度分档）
  static readonly TEXT_PRIMARY: Resource = $r('sys.color.font_primary');
  static readonly TEXT_SECONDARY: Resource = $r('sys.color.font_secondary');
  static readonly TEXT_TERTIARY: Resource = $r('sys.color.font_tertiary');
  /** 需要跳出来的文字（标题/强调数字）；比 PRIMARY 更强 */
  static readonly TEXT_EMPHASIZE: Resource = $r('sys.color.font_emphasize');

  // 表面阶（页面底 / 卡片与栏底 / 更高一层）
  static readonly SURFACE: Resource = $r('sys.color.background_primary');
  static readonly SURFACE_RAISED: Resource = $r('sys.color.background_secondary');
  static readonly SURFACE_TERTIARY: Resource = $r('sys.color.comp_background_tertiary');

  // 描边 / 分隔
  static readonly DIVIDER: Resource = $r('sys.color.comp_divider');


  // 状态色（语义，不写死红绿）
  static readonly BRAND: Resource = $r('sys.color.brand');
  static readonly WARNING: Resource = $r('sys.color.warning');
  static readonly ALERT: Resource = $r('sys.color.alert');
  static readonly CONFIRM: Resource = $r('sys.color.confirm');

  /**
   * 「品牌/状态色**之上**」的前景（文字与图标）。
   *
   * 【为什么单独列出来】此前 badge 里直接写 `Color.White`——那在浅色品牌底上或许对，
   * 但换成系统品牌色、深色模式或高对比模式就不一定。系统提供了对应的**前景色**语义，
   * 交给它比手工挑白色更稳（且编译器已校验这两个名字存在）。
   */
  static readonly ON_BRAND_TEXT: Resource = $r('sys.color.font_on_primary');
  static readonly ON_BRAND_ICON: Resource = $r('sys.color.icon_on_primary');
}

// ───────────────────────── ② 排版角色 ─────────────────────────

/**
 * 排版角色（一组"字号 + 行高 + 字重"）。
 *
 * 【为什么不是三个独立令牌】三者一起才构成"一种文字"。分开写必然出现
 * "标题的字号配了正文的行高"这类只在真机上才看得出的错位。
 *
 * `weight` 用**数值**（400/500/600）而不是 `FontWeight` 枚举：数值是 ArkUI 的合法入参，
 * 也让本文件保持**不依赖 ArkUI 枚举**（HAR 里的纯数据更可测）。
 */
export interface TypeRole {
  size: number;
  lineHeight: number;
  weight: number;
}

export class HarmonyType {
  /** 页面级标题 */
  static readonly TITLE: TypeRole = { size: Fs.TITLE_L, lineHeight: Fs.TITLE_L * Lh.TIGHT, weight: 600 };
  /** 区块标题 */
  static readonly SUBTITLE: TypeRole = { size: Fs.TITLE_M, lineHeight: Fs.TITLE_M * Lh.TIGHT, weight: 500 };
  /** 正文（会话内容的主字号） */
  static readonly BODY: TypeRole = { size: Fs.BODY, lineHeight: Fs.BODY * Lh.BODY, weight: 400 };
  /** 次要信息（时间、模型名、路径） */
  static readonly CAPTION: TypeRole = { size: Fs.SECONDARY, lineHeight: Fs.SECONDARY * Lh.BODY, weight: 400 };
  /** 标签/徽标文字 */
  static readonly LABEL: TypeRole = { size: Fs.CAPTION, lineHeight: Fs.CAPTION * Lh.TIGHT, weight: 500 };
  /** 最小可读档（徽标计数、等宽日志行） */
  static readonly OVERLINE: TypeRole = { size: Fs.CAPTION_XS, lineHeight: Fs.CAPTION_XS * Lh.TIGHT, weight: 400 };
}

// ───────────────────────── ③ 空间 / 圆角 / 描边 ─────────────────────────

/**
 * 空间角色：把 `Sp` 的档位**按用途**命名。
 *
 * 【为什么要再包一层】`Sp.M` 只说明"12"，不说明"哪儿该用 12"。工具栏内距、卡片内距、
 * 区块间距是三种不同的用途，混用会让界面节奏散掉；命名后 review 时能一眼看出用错。
 */
export class HarmonySpacing {
  /** 紧邻元素之间（图标与文字） */
  static readonly INLINE: number = Sp.XS;
  /** 控件内距（chip/按钮） */
  static readonly CONTROL_INNER: number = Sp.S;
  /** 容器内距（卡片/面板） */
  static readonly CONTAINER: number = Sp.M;
  /** 区块之间 */
  static readonly SECTION: number = Sp.L;
  /** 页面级留白 */
  static readonly PAGE: number = Sp.XL;
}

/**
 * 图标档位（**只给原语需要的角色**命名）。
 *
 * 【为什么只给一个】现网图标尺寸有 **10 档**裸值（12/14/16/18/20/22/28/32/36/40），
 * 它们的收敛**会改变视觉、需要真机验收**，属待决策项（见矩阵缺口登记）。
 * 若现在就把这 10 档照抄成"令牌"，只是给魔数换个名字，反而把问题藏起来。
 * 因此这里只命名**新原语真正需要的角色**（行内图标），并且取值与现网一致（14 ⇒ 视觉不变）；
 * 其余档位继续留在棘轮基线里，等设计收敛时一次处理。
 */
export class HarmonyIconSize {
  /** 卡片/列表行内的图标（与现网工具卡的 14 一致） */
  static readonly INLINE: number = 14;
  /**
   * 导航面板里的图标（侧栏完整面板）。
   *
   * 【为什么要单列】导航图标比行内图标大一号才站得住（原实现写死 20），
   * 而"写死 20"正是设计令牌棘轮要挡的裸值——搬到 shell 后不再有祖父条款，
   * 故在这里给它一个名字。
   */
  static readonly NAV: number = 20;
  /** 导航 rail / 底部标签栏里的图标（比面板里再大一号：没有文字陪伴，图标要更醒目） */
  static readonly NAV_RAIL: number = 22;
  /** 状态提示图标（横幅里的警示符号等；原实现写死 16） */
  static readonly STATUS: number = 16;
}

/** 圆角角色（值引用原语，不另立数字） */
export class HarmonyRadius {
  /** 药丸/小徽标 */
  static readonly CHIP: number = Radius.XS;
  /** 控件（输入框、按钮） */
  static readonly CONTROL: number = Radius.S;
  /** 卡片 / 浮层 */
  static readonly SURFACE: number = Radius.M;
  /** 大面板 / Sheet */
  static readonly PANEL: number = Radius.L;
}

/** 描边角色 */
export class HarmonyBorder {
  /** 分隔线 / 常规描边 */
  static readonly HAIRLINE: number = Border.HAIRLINE;
}

/**
 * 阴影层级。
 *
 * 【为什么用数据而不是直接 `.shadow(…)`】层级是**设计决定**（哪一层更"高"），
 * 具体阴影参数是实现细节。集中成数据后，改成系统材质或统一调参只动一处。
 */
export interface ShadowLevel {
  radius: number;
  offsetY: number;
  /** 透明度（0–1）；越高的层级越明显 */
  alpha: number;
}

export class HarmonyElevation {
  /** 贴地（列表项、内联卡片）：几乎只有一层分隔感 */
  static readonly FLAT: ShadowLevel = { radius: 4, offsetY: 1, alpha: 0.04 };
  /** 抬起（Composer、浮动操作区） */
  static readonly RAISED: ShadowLevel = { radius: 12, offsetY: 4, alpha: 0.10 };
  /** 悬浮（Popup / 菜单 / Sheet） */
  static readonly OVERLAY: ShadowLevel = { radius: 24, offsetY: 8, alpha: 0.16 };
}

// ───────────────────────── ③b 材质（Material） ─────────────────────────

/**
 * 材质层：**当前不启用系统沉浸光感**，用系统阴影 + 半透明表面表达层次。
 *
 * 【这是一个已决策项，不是待办】（2026-09-14，项目负责人决定）
 * 官方「沉浸光感」（空间化材质：内容相关毛玻璃、按压弹性光效、滑动透明度渐变，
 * 覆盖 Popup/Menu/BindSheet/Dialog 等浮层）明确要求 **`targetAPIVersion >= 26`**，
 * 而本仓 `build-profile.json5` 固定在 `compatibleSdkVersion: 6.1.1(24)`。
 * 决定是：**API 暂定保持 24，后期再考虑升级** ⇒ 现在**不**引入需要 26 的 API。
 *
 * 【为什么把这条写进代码而不是只写进文档】否则半年后总有人问"为什么不用沉浸光感"，
 * 或者更糟——有人以为可以顺手开一下，写出一个在目标设备上不生效的材质。
 * 这里用常量把事实固定下来，视图层可以据此分支，且**升级时只改这一处**。
 *
 * 升级后要动的地方（一次性列清楚）：① 本常量置 true；② `build-profile.json5` 提 target；
 * ③ 按官方《沉浸光感功耗优化》克制地只用在常驻外壳（Composer / Toolbar / 面板头 / 命令面板 /
 * 模型选择 / 浮动操作区 / 底部导航），**不要全页滥用**（官方明确它耗大量 GPU）。
 */
export class HarmonyMaterial {
  /** 是否可用系统沉浸光感（受 targetAPIVersion 限制） */
  static readonly IMMERSIVE_ENABLED: boolean = false;
  /** 不可用时的替代：层次由阴影层级表达（见 `HarmonyElevation`） */
  static readonly FALLBACK_IS_SHADOW: boolean = true;
}

// ───────────────────────── ④ 动效 ─────────────────────────

/**
 * 动效时长角色（毫秒）与**意图**。
 *
 * 曲线不在这里定：`Curve` 是 ArkUI 的枚举，放在视图层选择（保持本文件不依赖 ArkUI 枚举）。
 * 这里只固定"多快"——时长不统一时，界面会显得同一个动作时快时慢。
 */
export class HarmonyMotion {
  /** 状态切换（按压、选中）：要"立刻" */
  static readonly STATE: number = Dur.FAST;
  /** 常规过渡（展开/折叠、淡入淡出） */
  static readonly TRANSITION: number = Dur.NORMAL;
  /** 层级切换（页面/面板进出） */
  static readonly ENTER: number = Dur.PAGE;
}

// ───────────────────────── ⑤ 触控 ─────────────────────────

/**
 * 触控目标与指针目标的尺寸角色（计划 §7 无障碍 + P3 输入模态）。
 *
 * 【为什么要区分】**手指与鼠标不是一回事**：手指需要 ≥44vp（`Sz.TOUCH_MIN`，系统无障碍底线），
 * 而鼠标指针可以接受更小的目标。把两者写成两个名字，P3 接输入模态时才有地方可改，
 * 而不是到处找魔数。
 */
export class HarmonyTouch {
  /** 手指可及的最小目标（无障碍底线） */
  static readonly MIN_TARGET: number = Sz.TOUCH_MIN;
  /** 图标按钮的目标尺寸（比图标本身大一圈，保证可点） */
  static readonly ICON_TARGET: number = Sz.TOUCH_MIN;
  /** 指针（鼠标/触控笔）可接受的最小目标 */
  static readonly MIN_TARGET_POINTER: number = Sz.POINTER_MIN;
}

// ───────────────────────── ⑥ Web 语义 → Harmony 视觉（映射表） ─────────────────────────

/**
 * 一行映射：官方 Web 的语义 token → 本层的视觉令牌。
 *
 * 【为什么做成数据而不是注释】官方 Web 的主题**会变**。把映射写成可枚举的数据，
 * 升级时"改了哪几处"是可核对、可测试的（fixture 会检查每条映射都填齐）；
 * 写在注释里则一定会随代码漂移。
 *
 * `web` 用官方 `--dsw-*` 的语义名（`ui-theme` 包的令牌族），`harmony` 写本文件的令牌路径。
 */
export interface WebTokenMapping {
  /** 官方 Web 语义 token（`--dsw-*` 族） */
  web: string;
  /** 本层对应的 HarmonyOS 视觉令牌（写成路径便于核对） */
  harmony: string;
  /** 一句话说明"为什么这样对应"（尤其是不 1:1 的地方） */
  note: string;
}

export const WEB_TOKEN_MAP: WebTokenMapping[] = [
  { web: '--dsw-color-bg', harmony: 'HarmonyColor.SURFACE', note: '页面底色 → 系统 background_primary（深浅色自动）' },
  { web: '--dsw-color-bg-elevated', harmony: 'HarmonyColor.SURFACE_RAISED', note: '抬起的栏/卡片 → background_secondary' },
  { web: '--dsw-color-text', harmony: 'HarmonyColor.TEXT_PRIMARY', note: '正文主色 → font_primary' },
  { web: '--dsw-color-text-weak', harmony: 'HarmonyColor.TEXT_SECONDARY', note: '次要信息 → font_secondary' },
  { web: '--dsw-color-text-faint', harmony: 'HarmonyColor.TEXT_TERTIARY', note: '最弱信息（提示/占位）→ font_tertiary' },
  { web: '--dsw-color-border', harmony: 'HarmonyColor.DIVIDER', note: '分隔线 → comp_divider（鸿蒙的分隔语义只有一档）' },
  { web: '--dsw-color-brand', harmony: 'HarmonyColor.BRAND', note: '品牌色 → sys.color.brand（跟随系统主题）' },
  { web: '--dsw-color-danger', harmony: 'HarmonyColor.ALERT', note: '危险 → alert' },
  { web: '--dsw-color-warning', harmony: 'HarmonyColor.WARNING', note: '警告 → warning' },
  { web: '--dsw-color-success', harmony: 'HarmonyColor.CONFIRM', note: '成功 → confirm' },
  { web: '--dsw-font-body', harmony: 'HarmonyType.BODY', note: '正文字号+行高+字重**成套**映射（Web 是三属性，鸿蒙这里是一个角色）' },
  { web: '--dsw-font-title', harmony: 'HarmonyType.TITLE', note: '标题' },
  { web: '--dsw-font-label', harmony: 'HarmonyType.LABEL', note: '标签/徽标；鸿蒙侧字重更高（小字号下更清晰）' },
  { web: '--dsw-radius-md', harmony: 'HarmonyRadius.SURFACE', note: 'Web 的中圆角 → 鸿蒙卡片圆角' },
  { web: '--dsw-radius-pill', harmony: 'HarmonyRadius.CHIP', note: '药丸 → chip 圆角' },
  { web: '--dsw-space-2', harmony: 'HarmonySpacing.INLINE', note: '行内间隙' },
  { web: '--dsw-space-3', harmony: 'HarmonySpacing.CONTROL_INNER', note: '控件内距' },
  { web: '--dsw-space-4', harmony: 'HarmonySpacing.CONTAINER', note: '容器内距' },
  { web: '--dsw-shadow-1', harmony: 'HarmonyElevation.RAISED', note: 'Web 的 box-shadow 层级 → 鸿蒙阴影层级（更克制）' },
  { web: '--dsw-duration-fast', harmony: 'HarmonyMotion.STATE', note: '状态切换时长' },
  { web: '--dsw-duration-normal', harmony: 'HarmonyMotion.TRANSITION', note: '常规过渡时长' }
];

/** 查一条 Web token 映射（界面与 fixture 都用它，避免各处字符串比较） */
export function harmonyTokenFor(webToken: string): string {
  for (let i = 0; i < WEB_TOKEN_MAP.length; i++) {
    if (WEB_TOKEN_MAP[i].web === webToken) {
      return WEB_TOKEN_MAP[i].harmony;
    }
  }
  return '';
}
