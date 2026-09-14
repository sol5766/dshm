/**
 * Dock（快捷栏）自定义菜单的**清理**。
 *
 * ## 为什么只剩清理
 *
 * 2026-09-13 曾用 `quickBarManager` 在鸿蒙 PC 的任务栏图标右键菜单里加过「重启」，
 * 但实测与评估后**决定不做这个入口**，原因：
 *   1. 系统对菜单项只支持指定 `abilityName`，一律用普通 `startAbility` 拉起，
 *      **不带** `startupVisibility: STARTUP_HIDE` —— 目标 Ability 会被建出一个正常窗口；
 *   2. 实测系统送回的 `want.parameters` 里**没有**我们在 `QuickBarMenuInfo.parameters`
 *      里登记的键值（只有系统参数），动作分发拿不到动作标识；
 *   3. 该能力仅 2in1 可用，且系统自带退出项，收益与复杂度不成比例。
 *
 * 「重启」的入口保留在**系统托盘右键菜单**（`statusBarManager`，见 `StatusBarTray`），
 * 那是另一套 API 且本来就在用。
 *
 * ## 本模块的作用
 *
 * 删除旧版本注册进系统的分组（连带其下所有菜单项），避免用户的任务栏右键里残留
 * 一个「重启」死项。**幂等**：分组不存在（或已删过）时按"已清理"处理，不报错。
 */
import { quickBarManager } from '@kit.DeskTopExtensionKit';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { fileIo } from '@kit.CoreFileKit';
import { DshmLogger } from '../utils/Logger';

const TAG: string = 'QuickBarMenuCleanup';

/** 曾经使用的分组名（清理时按名字匹配）。 */
const LEGACY_CATEGORY_NAME: string = 'BrewDSH';

/**
 * 清掉旧版本在 Dock 右键里留下的自定义分组。
 *
 * 全流程 best-effort：非 2in1 设备、能力不支持、分组不存在都直接返回。
 */
export async function removeQuickBarMenu(context: common.UIAbilityContext): Promise<void> {
  const diag: string[] = [];
  try {
    const supported: boolean = await quickBarManager.isQuickBarCapabilitySupported(context);
    diag.push('capabilitySupported=' + String(supported));
    if (!supported) {
      writeDiag(context, diag);
      return;
    }
    let categories: quickBarManager.CustomCategory[] = [];
    try {
      categories = await quickBarManager.getCustomCategories(context);
    } catch (e) {
      // 一个分组都没有时系统会抛 1020210003 "Category not found"，属正常。
      diag.push('无自定义分组（已清理干净）');
      writeDiag(context, diag);
      return;
    }
    diag.push('existingCategories=' + String(categories.length));
    let removed: number = 0;
    for (let i = 0; i < categories.length; i++) {
      if (categories[i].categoryName !== LEGACY_CATEGORY_NAME) {
        continue;
      }
      const id: number = categories[i].categoryId;
      try {
        await quickBarManager.deleteCustomCategory(context, id);
        removed++;
        DshmLogger.info(TAG, '已删除遗留的 Dock 菜单分组（id=' + id + '）');
      } catch (e) {
        const err: BusinessError = e as BusinessError;
        diag.push('删除分组失败 id=' + id + ' code=' + err.code + ' ' + err.message);
        DshmLogger.warn(TAG, '删除 Dock 菜单分组失败: ' + err.code + ' ' + err.message);
      }
    }
    diag.push('removedCategories=' + String(removed));
    // 复核：再查一次，确认分组真的没了。
    try {
      const after: quickBarManager.CustomCategory[] =
        await quickBarManager.getCustomCategories(context);
      const names: string[] = [];
      for (let i = 0; i < after.length; i++) {
        names.push(after[i].categoryName);
      }
      diag.push('categoriesAfter=' + names.join(','));
    } catch (e) {
      diag.push('categoriesAfter=(none)');
    }
    diag.push('OK');
  } catch (e) {
    const err: BusinessError = e as BusinessError;
    diag.push('FAILED code=' + err.code + ' ' + err.message);
    DshmLogger.warn(TAG, 'Dock 菜单清理异常（可忽略）: ' + err.code + ' ' + err.message);
  }
  writeDiag(context, diag);
}

/** 写诊断文件（hilog 在本机 2in1 上读不到应用日志，用文件留证）。 */
function writeDiag(context: common.UIAbilityContext, lines: string[]): void {
  try {
    const f = fileIo.openSync(context.filesDir + '/quickbar-diag.txt',
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    fileIo.writeSync(f.fd, lines.join('\n') + '\n');
    fileIo.closeSync(f);
  } catch (e) {
    DshmLogger.warn(TAG, '写 Dock 清理诊断失败: ' + String(e));
  }
}
