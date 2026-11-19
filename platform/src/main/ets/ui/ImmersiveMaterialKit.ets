/**
 * 沉浸光感材质工具（API 26 `uiMaterial`）——**共享单源**。
 *
 * 【为什么独立成文件（2026-10-29，docs/280 步①）】弹窗层/顶栏外壳/
 * 交互控件都要按同一套纪律构造材质，而这套纪律是两条真机血泪换来的：
 *   ① `uiMaterial.ImmersiveStyle` 在未实现该能力的设备上是 `undefined`——真机踩过
 *      `Cannot read property THICK of undefined` ⇒ 组件更新抛错、**闪退循环**（docs/196）；
 *   ② 装饰性能力绝不该让界面起不来 ⇒ **API 判定 + try/catch 双保险**，取不到就
 *      返回 `undefined`（`systemMaterial(undefined)` = 不挂材质，纯色底照常可读）。
 *
 * 【第二个纪律：不整块大面铺】WebApp 曾实测整块铺材质 ⇒ 内容染蓝、文字糊掉
 * （docs/196）；材质只挂弹窗 / 常驻外壳条带 / 小控件。
 *
 * 【第三个纪律：不与 backgroundColor/borderWidth/shadow 同点设置】SDK 原话
 * （`common.d.ts` systemMaterial 注释）：材质会影响这四者，"advised not to use
 * this API together with the aforementioned APIs"；需要底色用 `materialColor`。
 *
 * @module ImmersiveMaterialKit
 */
import { uiMaterial } from '@kit.ArkUI';
import { deviceInfo } from '@kit.BasicServicesKit';

/**
 * 构造沉浸光感材质；**取不到就返回 `undefined`**（调用方把 undefined 传给
 * `systemMaterial` 即"不挂材质"，界面按纯色底渲染——绝不因装饰能力缺席而崩）。
 *
 * @param style 材质档位（THIN/REGULAR/THICK/ULTRA_THIN/ULTRA_THICK）
 * @param interactive 是否带按压触点光感（交互控件用 true；弹窗/外壳用 false）
 *
 * ⚠️ 调用方纪律（2026-11-17 补）：`style` 实参在进入本函数**之前**求值——
 * API<26 设备上 `uiMaterial`/`ImmersiveStyle` 可能是 `undefined`，裸求值
 * `.THIN`/`.THICK` 会当场抛错（本函数内部的 API 判定来不及兜）。
 * 以 `uiMaterial.ImmersiveStyle.X` 作实参的调用点必须先判
 * `deviceInfo.sdkApiVersion >= 26` 再进 try（下方三个包装即此范式）。
 */
export function immersiveMaterialOf(style: uiMaterial.ImmersiveStyle,
  interactive: boolean): uiMaterial.ImmersiveMaterial | undefined {
  if (deviceInfo.sdkApiVersion < 26) {
    return undefined;
  }
  try {
    const opts: uiMaterial.ImmersiveOptions = {
      style: style,
      applyShadow: true,
      interactive: interactive
    };
    return new uiMaterial.ImmersiveMaterial(opts);
  } catch (e) {
    return undefined;
  }
}

/**
 * 弹窗/半模态 options 用的材质（THICK + 非交互）。
 * `AlertDialogParam.systemMaterial` 等字段直接吃这个函数的返回值；
 * undefined 时该字段**省略**（options 里传 undefined 等于不设置）。
 */
export function dialogMaterial(): uiMaterial.ImmersiveMaterial | undefined {
  if (deviceInfo.sdkApiVersion < 26) {
    return undefined;
  }
  try {
    return immersiveMaterialOf(uiMaterial.ImmersiveStyle.THICK, false);
  } catch (e) {
    return undefined;
  }
}

/**
 * 常驻外壳条带（自绘顶栏）用的材质（THIN + 非交互）。
 * ⚠️ 只挂**条带**，不铺大面（染蓝教训，见文件头注 ②）。
 * 【2026-10-29 16:26 回滚 B】真机实测（docs/282）：A+B 组合让顶栏按钮排版异常
 * （按钮落到会话区）且 REGULAR 在真机上仍未形成可见材质 ⇒ 整体退回 THIN，
 * 恢复到 docs/280 步①② 的状态（用户裁决"先恢复上一版"）。
 */
export function shellMaterial(): uiMaterial.ImmersiveMaterial | undefined {
  if (deviceInfo.sdkApiVersion < 26) {
    return undefined;
  }
  try {
    return immersiveMaterialOf(uiMaterial.ImmersiveStyle.THIN, false);
  } catch (e) {
    return undefined;
  }
}

/**
 * 交互控件（按钮/页签）用的材质（REGULAR + 按压触点光感）。
 * 与既有浮层按钮同一套材质参数（先例口径）。
 */
export function controlMaterial(): uiMaterial.ImmersiveMaterial | undefined {
  if (deviceInfo.sdkApiVersion < 26) {
    return undefined;
  }
  try {
    return immersiveMaterialOf(uiMaterial.ImmersiveStyle.REGULAR, true);
  } catch (e) {
    return undefined;
  }
}