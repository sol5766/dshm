/**
 * Dock（快捷栏）右键菜单：在 PC/2in1 的应用图标右键菜单里加入「重启 DSH」「退出 DSH」。
 *
 * ## 为什么用 quickBarManager，而不是 shortcuts
 *
 * 官方对 `shortcuts`（`metadata: ohos.ability.shortcuts`）的表述只覆盖「**长按**桌面上的
 * 应用图标」，全文未提 Dock 右键；`abilities[].skills` 只声明"能被谁拉起"，不产生菜单项；
 * `fileContextMenu` 是文件管理器里右键**文件**的菜单。三者都不适用于 Dock 图标。
 *
 * 真正对应的能力是 Desktop Extension Kit 的 `quickBarManager`：官方定义「快捷栏指的是
 * PC/2in1 设备屏幕底部的图标区域」，SDK 里 `QuickTaskInfo` 的注释即
 * "menu items displayed upon a right-click"。本机 SDK 实测该模块元数据为三方可用
 * （`isSystemApi: false`）、`deviceTypes: 2in1`、增删改查接口**无需任何权限**。
 *
 * ## 关键约束
 *
 * 菜单项**只能指定 `abilityName`**，系统必定以 `startAbility` 拉起该 Ability，并把
 * `parameters` 作为 **WantParams** 传给它的 `onCreate`/`onNewWant`。因此：
 *   - 这里统一指向 `BackGroundAbility`（无窗口、不触发 onForeground），这样点「退出」
 *     不会把主窗口又闪到前台；
 *   - 动作分发在 `BackGroundAbility.onCreate/onNewWant`（见该类注释）。
 *
 * 全流程失败都只记日志，不影响启动（非 2in1 设备 / 系统不支持时静默跳过）。
 */
import { quickBarManager } from '@kit.DeskTopExtensionKit';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { fileIo } from '@kit.CoreFileKit';
import { DshmLogger } from '../utils/Logger';

const TAG: string = 'QuickBarMenu';

/** 菜单分组名（同一分组的项会显示在一起）。 */
const CATEGORY_NAME: string = 'BrewDSH';
/** Dock 菜单动作的 WantParams key（系统原样回传）。 */
export const QUICKBAR_PARAM_KEY: string = 'dshmAction';
export const QUICKBAR_ACTION_RESTART: string = 'restart';
export const QUICKBAR_ACTION_EXIT: string = 'exit';
/**
 * 我们希望在 Dock 菜单里出现的项（**只留「重启」**）。
 *
 * 「退出」不自己加：系统的快捷栏菜单自带退出项，再放一个只是重复噪音。
 * 这里同时作为"清理白名单"——分组是我们独占的（名字 BrewDSH），凡是名字不在
 * 这份清单里的历史项一律删掉，避免升级后新旧菜单项并存。
 */
const RESTART_TASK_NAME: string = '重启';
const RESTART_TASK_LABEL: string = '重启';
/** 菜单动作的目标 Ability：无窗口的后台保活 Ability。 */
const TARGET_ABILITY: string = 'BackGroundAbility';
const TARGET_MODULE: string = 'entry';

/**
 * 安装 Dock 右键菜单（幂等：已存在的分组/菜单项不重复创建）。
 *
 * 建议在 `EntryAbility.onWindowStageCreate` 之后调用：早于页面加载，用户即使从不
 * 打开页面也能用 Dock 菜单重启/退出。
 */
export async function installQuickBarMenu(context: common.UIAbilityContext): Promise<void> {
  const diag: string[] = [];
  try {
    const supported: boolean = await quickBarManager.isQuickBarCapabilitySupported(context);
    diag.push('capabilitySupported=' + String(supported));
    if (!supported) {
      DshmLogger.info(TAG, '当前设备不支持快捷栏（非 2in1），跳过 Dock 菜单注册');
      writeDiag(context, diag);
      return;
    }

    // 分组：先找同名分组，找不到再建（系统限制最多 3 个分组）。
    //
    // 注意：鸿蒙在"一个分组都没有"时，getCustomCategories 会**抛错**而不是返回空数组
    // （设备实测 code=1020210003 "Category not found"），因此这里必须把查询失败当作
    // "无分组"处理，否则首次安装永远不会创建分组。
    let categoryId: number = -1;
    let categories: quickBarManager.CustomCategory[] = [];
    try {
      categories = await quickBarManager.getCustomCategories(context);
    } catch (e) {
      diag.push('getCustomCategories 失败（视为无分组）: ' + errText(e));
    }
    diag.push('existingCategories=' + String(categories.length));
    for (let i = 0; i < categories.length; i++) {
      if (categories[i].categoryName === CATEGORY_NAME) {
        categoryId = categories[i].categoryId;
        break;
      }
    }
    if (categoryId < 0) {
      const created: quickBarManager.CustomCategory =
        await quickBarManager.addCustomCategory(context, CATEGORY_NAME);
      categoryId = created.categoryId;
      DshmLogger.info(TAG, '已创建快捷栏分组 ' + CATEGORY_NAME + '（id=' + categoryId + '）');
    }
    diag.push('categoryId=' + String(categoryId));

    // 幂等 + 清理：分组是我们独占的，把不想要的历史项删掉（含旧版本注册的
    // 「重启 DSH」「退出 DSH」），只保留「重启」。
    const existingNames: string[] = [];
    try {
      const existing: quickBarManager.QuickTask[] =
        await quickBarManager.getTasksFromCategory(context, categoryId);
      for (let i = 0; i < existing.length; i++) {
        const name: string = existing[i].taskInfo.taskName;
        if (name === RESTART_TASK_NAME) {
          existingNames.push(name);
          continue;
        }
        // 非白名单项：删掉（系统自带退出项不在本分组里，不会被误删）。
        try {
          await quickBarManager.deleteQuickTask(context, existing[i].taskId);
          diag.push('已删除历史菜单项: ' + name);
        } catch (e) {
          diag.push('删除菜单项失败 ' + name + ': ' + errText(e));
        }
      }
    } catch (e) {
      diag.push('getTasksFromCategory 失败（视为无任务）: ' + errText(e));
    }
    diag.push('existingTasks=' + existingNames.join(','));

    await addTaskIfMissing(context, categoryId, existingNames,
      RESTART_TASK_NAME, RESTART_TASK_LABEL, QUICKBAR_ACTION_RESTART);

    // 复核：把注册后的菜单项列出来（这是"菜单真的生效了吗"的唯一可靠证据）。
    try {
      const after: quickBarManager.QuickTask[] =
        await quickBarManager.getTasksFromCategory(context, categoryId);
      const names: string[] = [];
      for (let i = 0; i < after.length; i++) {
        names.push(after[i].taskInfo.taskName + '->' + after[i].taskInfo.abilityName);
      }
      diag.push('tasksAfter=' + names.join(' | '));
      DshmLogger.info(TAG, 'Dock 右键菜单已就绪: ' + names.join(' | '));
    } catch (e) {
      diag.push('复核任务列表失败: ' + errText(e));
    }
    diag.push('OK');
  } catch (e) {
    const err: BusinessError = e as BusinessError;
    diag.push('FAILED code=' + err.code + ' message=' + err.message);
    DshmLogger.warn(TAG, 'Dock 菜单注册失败（可忽略）: ' + err.code + ' ' + err.message);
  }
  writeDiag(context, diag);
}

/** 错误摘要（ArkTS 不允许把 any/unknown 往日志里塞，统一转字符串）。 */
function errText(e: Object): string {
  const err: BusinessError = e as BusinessError;
  return String(err.code) + ' ' + String(err.message);
}

/** 写诊断文件：hilog 在部分设备上读不到应用日志，用文件留证据（与 host-plugin-diag 同思路）。 */
function writeDiag(context: common.UIAbilityContext, lines: string[]): void {  try {
    const f = fileIo.openSync(context.filesDir + '/quickbar-diag.txt',
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    fileIo.writeSync(f.fd, lines.join('\n') + '\n');
    fileIo.closeSync(f);
  } catch (e) {
    DshmLogger.warn(TAG, '写 Dock 菜单诊断失败: ' + String(e));
  }
}

/** 追加一个菜单项（同名已存在则跳过）。 */
async function addTaskIfMissing(context: common.UIAbilityContext, categoryId: number,
  existingNames: string[], taskName: string, label: string, action: string): Promise<void> {
  if (existingNames.indexOf(taskName) >= 0) {
    return;
  }
  const param: quickBarManager.ParameterItem = { key: QUICKBAR_PARAM_KEY, value: action };
  const parameters: quickBarManager.ParameterItem[] = [param];
  const info: quickBarManager.QuickTaskInfo = {
    taskName: taskName,
    abilityName: TARGET_ABILITY,
    moduleName: TARGET_MODULE,
    taskDetail: label,
    parameters: parameters
  };
  await quickBarManager.addQuickTask(context, categoryId, info);
  DshmLogger.info(TAG, '已添加 Dock 菜单项: ' + taskName);
}
