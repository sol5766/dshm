/**
 * 设备与形态事实（只读）。
 *
 * 用途：
 *   1. 顶层断点（D3 §2.2「以窗口宽度为主断点」）之外，还需要**特征断点**：
 *      设备类型、折叠态、是否外接键盘/鼠标。这些事实由系统提供，UI 据此决定
 *      是否启用「快捷键提示」「拖拽投喂」等 2in1 专属能力。
 *   2. 诊断页展示「你以为我在什么设备上跑」——排查一多适配问题时的第一手信息。
 *
 * 只读、无副作用、不缓存策略判断。
 */

import { deviceInfo } from '@kit.BasicServicesKit';
import { display } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'platform/device';

/** 形态族：把系统给出的 deviceType 归一成三种产品形态 */
export enum FormFactor {
  PHONE = 'phone',
  TABLET = 'tablet',
  DESKTOP = 'desktop',
  UNKNOWN = 'unknown'
}

/** 设备事实快照 */
export interface DeviceFacts {
  /** 系统原始 deviceType（phone / tablet / 2in1 / default / …） */
  rawType: string;
  /** 归一后的形态族 */
  form: FormFactor;
  brand: string;
  /** 系统市场名（如 MatePad Edge） */
  model: string;
  /** 系统产品型号（如 QXS-W20） */
  productModel: string;
  /** 强制走 PC 形态的本机系列（MateBook / MatePad Edge / Pro Max / QXS-*） */
  desktopForced: boolean;
  /** 终端只走宿主原生实现，不再交给 guest VM */
  nativeTerminalOnly: boolean;
  osFullName: string;
  /** 屏幕密度（px per vp） */
  density: number;
  /** 屏幕宽（vp，取默认显示设备） */
  screenWidthVp: number;
  screenHeightVp: number;
  /** 是否具备键鼠形态（2in1 / 桌面模式） */
  keyboardLikely: boolean;
}

const EDGE_PRODUCT_PREFIX: string = 'QXS-';
const EDGE_MARKET_NAME: string = 'MatePad Edge';
const PRO_MAX_MARKET_NAMES: string[] = ['MatePad Pro Max', 'MatePad ProMax'];
const MATEBOOK_MARKET_PREFIX: string = 'matebook';

/**
 * Edge / Pro Max 的型号族前缀（`deviceInfo.productSeries` 大写后比较）。
 * marketName / productModel 在多语言 SKU 上可能为空或变体，型号族是最后兜底。
 *
 * 【2026-11-12 用户口径（第三次拍板，最终）】只有 **PC / 2in1 / MateBook /
 * MatePad Edge / MatePad Pro Max** 接原生终端（可用 sh / zsh / bash 三种模式）；
 * **其余所有普通平板与手机一律没有原生终端，只能走 guest VM**。
 *
 * 因此型号族白名单只保留 `QXS`（MatePad Edge）。Pro Max 不再靠型号族，统一由
 * 上面的 `PROMAX` + `MATEPAD` 市场名联合判定识别 —— 普通 MatePad Pro（如 `MRO-W00`）
 * 不在其中，必须回到 tablet 档走 VM。
 *
 * 【为什么必须收窄（真机事故，2026-11-12）】`MRO-W00`（MatePad Pro，非 Pro Max）
 * 曾被这份名单判成 desktop ⇒ `nativeTerminalOnly=true` ⇒ `DSHM_VM_BASH=off`
 * ⇒ 该机既没有原生 shell（`realShell=no`、`forkpty` 被拒）也没有 VM 兜底，
 * 终端直接报 `command "/bin/sh" is not an executable file`。
 * 同口径见 `docs/379` §3、`docs/386` 三端矩阵。
 */
const EDGE_FAMILY_TOKENS: string[] = ['QXS'];
/** Pro Max 的市场名分词（归一化后比较）。 */
const PRO_MAX_MARKET_TOKEN: string = 'PROMAX';
/** 平板产品线分词：与 Pro Max 分词联合判定，避免误收普通 MatePad。 */
const TABLET_MARKET_TOKEN: string = 'MATEPAD';

/**
 * MatePad Edge 系列在平板全屏模式下仍按 PC 产品处理。
 *
 * 用户裁决（2026-10-19）：该系列在 PC 模式有系统原生终端，平板模式没有；
 * 为了不让同一台设备在两条终端/形态路线之间切换，整系列永久识别为 desktop。
 * 判据同时覆盖产品型号前缀与市场名：不同 SKU 的 productModel 可能不同，
 * 但只要属于 QXS-* 或 MatePad Edge 系列，就必须得到同一结论。
 */
export function isDesktopPcSeries(productModel: string, marketName: string): boolean {
  return isDesktopPcSeriesFull(productModel, marketName, '');
}

/**
 * 完整判据：产品型号 / 市场名 / 型号族三路并联。
 *
 * MatePad Edge 与 MatePad Pro Max 的系统原始 deviceType 仍是 tablet，必须靠
 * 产品事实识别。三个字符串字段任一稳定命中都强制 desktop；Pro Max 同时要求
 * MATEPAD 与 PROMAX 分词，避免把普通 MatePad Pro 误判成 PC。
 */
export function isDesktopPcSeriesFull(productModel: string, marketName: string,
  familyModel: string): boolean {
  const model: string = productModel.trim().toUpperCase();
  const family: string = familyModel.trim().toUpperCase();
  const market: string = marketName.trim().toUpperCase().replace(/[\s\-_\u3000]+/g, '');
  if (model.startsWith(EDGE_PRODUCT_PREFIX)
    || market.startsWith(EDGE_PRODUCT_PREFIX)
    || market.indexOf('MATEPADEDGE') >= 0
    || market.indexOf(MATEBOOK_MARKET_PREFIX.toUpperCase()) >= 0) {
    return true;
  }
  const name: string = model.replace(/[\s\-_\u3000]+/g, '') + '|' + market;
  if (name.indexOf(PRO_MAX_MARKET_TOKEN) >= 0
    && (name.indexOf(TABLET_MARKET_TOKEN) >= 0 || name.indexOf('MATEBOOK') >= 0)) {
    return true;
  }
  const familyHead: string = family.replace(/-/g, '').slice(0, 3);
  for (let i = 0; i < EDGE_FAMILY_TOKENS.length; i++) {
    if (familyHead === EDGE_FAMILY_TOKENS[i] || family.startsWith(EDGE_FAMILY_TOKENS[i] + '-')) {
      return true;
    }
  }
  return false;
}

/** 兼容旧调用名；语义已扩为 MateBook / Edge / Pro Max / QXS-* 的 PC 形态系列。 */
export function isEdgePcSeries(productModel: string, marketName: string): boolean {
  return isDesktopPcSeries(productModel, marketName);
}

/**
 * 取型号族：`productSeries` 优先，`productModelAlias` 兜底，都空就是空串。
 */
export function readFamilyModel(): string {
  const series: string = safeString(() => deviceInfo.productSeries, '').trim().toUpperCase();
  if (series.length > 0) {
    return series;
  }
  return safeString(() => deviceInfo.productModelAlias, '').trim().toUpperCase();
}

/** 归一化：平板与 2in1 在 D3 中都属于「完整工作台」，但断点不同，故分开保留。 */
function formOf(raw: string): FormFactor {
  if (raw === 'phone') {
    return FormFactor.PHONE;
  }
  if (raw === 'tablet') {
    return FormFactor.TABLET;
  }
  if (raw === '2in1' || raw === '2in1_foldable' || raw === 'desktop') {
    return FormFactor.DESKTOP;
  }
  return FormFactor.UNKNOWN;
}

/** 采集设备事实。任何一项读取失败都降级为安全默认值，绝不抛异常。 */
export function readDeviceFacts(): DeviceFacts {
  const rawType: string = safeString(() => deviceInfo.deviceType, 'default');
  const brand: string = safeString(() => deviceInfo.brand, '');
  const marketName: string = safeString(() => deviceInfo.marketName, '');
  const productModel: string = safeString(() => deviceInfo.productModel, '');
  const familyModel: string = readFamilyModel();
  const desktopForced: boolean = isDesktopPcSeriesFull(productModel, marketName, familyModel);
  const form: FormFactor = desktopForced ? FormFactor.DESKTOP : formOf(rawType);

  let density: number = 1;
  let widthVp: number = 0;
  let heightVp: number = 0;
  try {
    const d: display.Display = display.getDefaultDisplaySync();
    density = d.densityPixels > 0 ? d.densityPixels : 1;
    widthVp = Math.round(d.width / density);
    heightVp = Math.round(d.height / density);
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, 'display read failed: %{public}s', e.message);
  }

  return {
    rawType: rawType,
    form: form,
    brand: brand,
    model: marketName,
    productModel: productModel,
    desktopForced: desktopForced,
    // 普通 PC / 2in1 也是 desktop；它们和 Edge 系列一样必须走系统原生 PTY。
    nativeTerminalOnly: form === FormFactor.DESKTOP,
    osFullName: safeString(() => deviceInfo.osFullName, ''),
    density: density,
    screenWidthVp: widthVp,
    screenHeightVp: heightVp,
    keyboardLikely: form === FormFactor.DESKTOP
  };
}

/**
 * 本机是否为**折叠屏**（横折 / 竖折都算）。
 *
 * ── 为什么需要它（2026-10-13 用户裁决）────────────────────────────────────
 * 用户原话："设置的 UI 手机只是直板机是横着的，折叠机也是 PC 竖着的 UI。"
 * 即手机档那套「设置面板铺满 + 导航改顶部横条」只对**直板机**成立；折叠屏展开后
 * 宽度与平板相当，官方「左导航 + 右内容」本来就放得下 ⇒ 与平板走同一条路（官方形态）。
 *
 * ── 判据与降级 ───────────────────────────────────────────────────────────
 * `isFoldable()` 是**设备级**能力（不是当前折叠态），系统口径见 `@ohos.display.d.ts`：
 * 小折叠的外屏只作辅助显示时恒回 false（那一类本来就跟直板机一样窄，按直板机处理正确）。
 * 读不到（1400003 等）⇒ false ⇒ `isPhoneForm()` 仍按手机处理（保守方向：只缩小适配面，
 * 绝不因为读失败把手机误判成平板 / 桌面）。
 */
export function isFoldableDevice(): boolean {
  try {
    return display.isFoldable();
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, 'display.isFoldable failed（按非折叠处理）：%{public}s', e.message);
    return false;
  }
}

/* ── 折叠屏适配（2026-10-28，用户口径：单屏显示时设置 UI 要竖屏）──────────────────
 *
 * 判定分三层，且**纯判据只吃数字**（便于门禁静态核对，也便于将来加单测）：
 *   ① 断点：`foldLayoutTierOf(widthVp)` —— `<600` 单列 / `600–900` 双列 / `>900` 多列；
 *   ② 单屏判定：`isSingleScreenFoldState(foldStatus, widthVp)`；
 *   ③ 现场快照：`readFoldSnapshot()` —— 设备级折叠能力 + FoldStatus + FoldDisplayMode + 宽度。
 *
 * 【为什么判定**不**只看 `FoldDisplayMode`】本机 SDK（`@ohos.display.d.ts`）的枚举是
 * `UNKNOWN/FULL/MAIN/SUB`，而 SDK 自己的注释写明"内外屏对应哪个值**随机型不同**"
 * （一种机型：内屏 `FULL` / 外屏 `MAIN`；另一种：内屏 `MAIN` / 外屏 `SUB`）⇒ 单看 mode
 * 无法通用。所以 mode 只当**读数与变化触发**，判定落在与机型无关的两条量上：
 * **物理折叠态** + **窗口宽度断点**。
 */

/** 单列断点（vp）：窄于它按"单屏 / 手机形态"处理（直板机与折叠屏外屏都落在这一档）。 */
export const FOLD_BREAKPOINT_COMPACT_VP: number = 600;
/** 双列断点（vp）：600–900 双列；`>900` 多列（阔折叠 / 三折展开都落在后者）。 */
export const FOLD_BREAKPOINT_MEDIUM_VP: number = 900;
/** `display.FoldStatus.FOLD_STATUS_FOLDED` 的数值镜像（纯判据只吃数字，不依赖枚举对象）。 */
const FOLD_STATUS_FOLDED_VALUE: number = 2;

/** 宽度档：单列 / 双列 / 多列。 */
export type FoldLayoutTier = 'compact' | 'medium' | 'expanded';

/**
 * 宽度 → 布局档（纯函数）。
 * 读不到宽度（`<= 0`）时按 **medium**：宁可给双列，也不要把"读失败"误判成"单屏"。
 */
export function foldLayoutTierOf(widthVp: number): FoldLayoutTier {
  if (!(widthVp > 0)) {
    return 'medium';
  }
  if (widthVp < FOLD_BREAKPOINT_COMPACT_VP) {
    return 'compact';
  }
  if (widthVp < FOLD_BREAKPOINT_MEDIUM_VP) {
    return 'medium';
  }
  return 'expanded';
}

/**
 * 折叠屏此刻是否按"单屏（手机形态）"处理（纯函数）。
 *
 * 为真 ⇒ 设置面板走手机化布局、朝向锁竖屏；为假 ⇒ 与平板同路（官方竖排 + 跟屏旋转）。
 */
export function isSingleScreenFoldState(foldStatus: number, widthVp: number): boolean {
  /*
   * 【2026-11-07 修正：宽度优先，foldStatus 不能单独定案】
   *
   * 旧实现只要 `foldStatus === FOLDED(2)` 就判"单屏"。三折叠的**双屏/三屏**仍会上报
   * `FOLDED` 或 `HALF_FOLDED`，于是被误判成单屏 ⇒ phone 壳挂 `dshm-compact` 走抽屉
   * （有遮罩、点右侧空白不收回、必须再点一次按钮）—— 与"折叠展开=平板"口径直接冲突。
   *
   * 现在以**渲染宽度**为准：宽视口（≥600vp）一律按多屏/展开处理，只有窄视口才可能
   * 是单屏（外屏 / 分屏窄窗）。`foldStatus` 保留在签名里是为了不打断既有调用点与桥。
   */
  void foldStatus;
  return foldLayoutTierOf(widthVp) === 'compact';
}

/** 折叠现场快照（诊断页与桥都用它，避免同一次判定读两遍系统）。 */
export interface FoldSnapshot {
  /** 设备级折叠能力（`display.isFoldable()`） */
  foldable: boolean;
  /** `display.FoldStatus` 原始值（0 unknown / 1 expanded / 2 folded） */
  foldStatus: number;
  /** `display.FoldDisplayMode` 原始值（0 unknown / 1 FULL / 2 MAIN / 3 SUB）——**只作读数** */
  displayMode: number;
  /** 当前窗口宽度（vp）；读不到为 0 */
  widthVp: number;
  /** 宽度档 */
  tier: FoldLayoutTier;
  /** 是否按"单屏形态"处理 */
  singleScreen: boolean;
}

/** 读一次折叠现场；任何一项失败都降级为安全默认（非折叠 / 中档），绝不抛。 */
export function readFoldSnapshot(): FoldSnapshot {
  let foldable = false;
  let foldStatus = 0;
  let displayMode = 0;
  let widthVp = 0;
  try {
    foldable = display.isFoldable();
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, '折叠能力读取失败（按非折叠处理）：%{public}s', e.message);
  }
  if (foldable) {
    try {
      foldStatus = display.getFoldStatus();
    } catch (err) {
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, 'FoldStatus 读取失败（按展开处理）：%{public}s', e.message);
    }
    try {
      displayMode = display.getFoldDisplayMode();
    } catch (err) {
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, 'FoldDisplayMode 读取失败（按未知处理）：%{public}s', e.message);
    }
  }
  try {
    const d: display.Display = display.getDefaultDisplaySync();
    /*
     * 【px → vp 必须用 densityPixels，不能用 densityDPI（2026-10-29 审核修）】
     * SDK 原文（`@ohos.display.d.ts`）：
     *   · `densityDPI` = "**Physical** pixel density … the number of pixels per **inch**"
     *     —— 每英寸物理像素，**不是**缩放系数；
     *   · `densityPixels` = "**Logical** pixel density … the scaling coefficient between
     *     px and vp"，取值区间 [0.5, 4.0]，一般 1.0 / 3.0。
     * 旧实现写 `width * 160 / densityDPI`，把"每英寸像素数"当成缩放系数：
     * 3120px / 440 = 7.09 的伪系数会算出 ~1134vp（实际 1080 档 ≈ 1040vp），
     * 断点判定整体偏大 ⇒ 折叠屏"单屏"可能被误判成展开。⇒ 改用官方缩放系数。
     */
    const scale: number = d.densityPixels > 0 ? d.densityPixels : 1;
    widthVp = d.width / scale;
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, '默认显示宽度读取失败（按中档处理）：%{public}s', e.message);
  }
  const tier: FoldLayoutTier = foldLayoutTierOf(widthVp);
  return {
    foldable: foldable,
    foldStatus: foldStatus,
    displayMode: displayMode,
    widthVp: widthVp,
    tier: tier,
    singleScreen: foldable && isSingleScreenFoldState(foldStatus, widthVp)
  };
}

/** 便利判据：**此刻**是不是"折叠屏 + 单屏形态"（设置面板手机化与朝向锁竖屏都用它）。 */
export function isFoldableSingleScreenNow(): boolean {
  return readFoldSnapshot().singleScreen;
}

/**
 * 折叠屏此刻是否按"单屏"处理（**兼容入口**，手机模块的 `platformSingleScreen` 在用）。
 *
 * 2026-10-28 口径升级：旧实现只看 `FOLD_STATUS_FOLDED`，漏掉"折叠态读不到、但窗口已经很窄"
 * （外屏 / 单屏渲染）这一半情形 ⇒ 现在**委托** `isFoldableSingleScreenNow()`，
 * 判据 = 物理折叠态 ∪ compact 宽度档。函数名保留是为了不破坏既有调用点与桥方法。
 */
export function isFoldableSingleScreen(): boolean {
  return isFoldableSingleScreenNow();
}

/**
 * 读取一个可能抛错的字符串属性。
 *
 * 抽出来的理由：`deviceInfo` 的多个属性在不同设备/权限下可能抛错，
 * 逐个 try-catch 会把采集函数写成一堆重复样板。
 */
function safeString(read: () => string, fallback: string): string {
  try {
    const v: string = read();
    return v === undefined || v === null ? fallback : v;
  } catch (err) {
    return fallback;
  }
}
