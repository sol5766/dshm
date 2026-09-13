# HarmonyOS NEXT (API 26 / HarmonyOS 6, PC 2in1) Dock 交互与退出方案

调研范围：官方文档快照（DevEco CLI docs, API 26.0.0）+ 本机 DevEco SDK 26.0 声明文件实证。
目标机型：MNTXM-24B（PC/2in1）。目标工程：`com.brewdsh.app` / module `entry` / `EntryAbility`。

---

## 结论速览

| 问题 | 结论 | 关键 API |
|---|---|---|
| 1. Dock 图标右键自定义菜单 | **不是 `shortcuts`**。`shortcuts` 只做「长按图标」的快捷方式。Dock/快捷栏右键菜单必须用 **`quickBarManager`（Desktop Extension Kit）** | `quickBarManager.addQuickTask` |
| 2. 左键唤起到前台、不产生第二实例 | `launchType` 默认即 `singleton`，已是正确值。配套用 `onForeground` + `showWindow()` 兜底；必要时用 `setOnNewWantSkipScenarios` 屏蔽误触发的 `onNewWant` | `launchType` / `window.WindowStage.getMainWindowSync()` / `Window.showWindow()` / `Window.restore()` |
| 3. 优雅退出 | `terminateSelf()` 是官方推荐的**正常退出**接口；`killAllProcesses()` 仅用于**异常强制退出**。且必须先清理 native 子进程 | `UIAbilityContext.terminateSelf()` / `ApplicationContext.killAllProcesses()` |

---

# 1. Dock 图标右键菜单

## 1.1 先排除三个错误候选（官方文档明确）

### ❌ `shortcuts`（`metadata: ohos.ability.shortcuts`）——不是 Dock 右键菜单

`shortcuts` 是**桌面快捷方式**：官方原文只说「**长按**桌面上的应用图标，图标上方会显示开发者配置的快捷方式」，**全文从未提及 Dock 右键**。

> 安装应用后，长按桌面上的应用图标，图标上方会显示开发者配置的快捷方式。
> —— [创建应用静态快捷方式](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides-v5/typical-scenario-configuration-V5)

`shortcuts` 字段约束（官方 `module.json5配置文件` 表10，实测文档站路径 /doc/harmonyos-guides/module-configuration-file）：

| 字段 | 类型 | 约束 |
|---|---|---|
| `shortcutId` | string | **不可缺省**；长度 ≤ 63 字节；**不支持 `$string` 资源索引** |
| `label` | string | 可缺省（默认空）；长度 ≤ 255 字节；**可以是描述性内容，也可以是 `$string` 资源索引** |
| `icon` | string | 可缺省（默认空）；**资源文件索引**（`$media:`）；推荐分层图标（前景 450×450px 显示 / 1024×1024px 资源透明图层，背景 1024×1024px） |
| `visible` | boolean | 可缺省（默认 true）；**从 API version 20 开始支持** |
| `wants` | object | 可缺省；`bundleName` / `moduleName` / `abilityName` / `parameters`（**仅支持字符串**，键值均 ≤ 1024） |

**数量上限：最多展示 4 个**（`shortcuts` 标签章节与静态快捷方式指南均明确写出）。

**关于 label 是否必须走资源**：`module.json5` 表10 明确写 `label` **两者皆可**（描述性内容或资源索引）；但最佳实践与官方示例一律用 `$string:`。工程上建议走资源以便国际化。

**关于 2in1/PC 支持**：官方文档**没有**把 `shortcuts` 限定为手机；`deviceTypes` 里含 `2in1` 即可声明。但**文档中没有任何一句说明 `shortcuts` 会出现在 PC Dock 右键菜单里**——它明确对应的是「长按图标」入口。所以把「重启/退出」寄托在 `shortcuts` 上，在 PC Dock 右键场景下**没有官方依据**。

### ❌ `abilities[].skills` 里声明 `ohos.want.action.*` —— 与菜单无关

`skills` 只声明**能被谁拉起**（隐式 Want 匹配），不产生任何菜单项。`ohos.want.action.home` 只表示「这是桌面入口 Ability」。

### ❌ `fileContextMenu` —— 这是「文件管理器里右键文件」的菜单

`module.json5` 的 `fileContextMenu` 标签官方定义：

> 该标签标识当前 HAP 的右键菜单配置项……**仅在 PC/2in1 设备上生效。仅允许在 entry 类型模块中配置。**
> 应用进行右键扩展菜单注册后，**在文件管理器通过右键操作拉起菜单**……文件管理器默认通过 startAbility 的方式拉起三方应用……
> —— [module.json5配置文件 · fileContextMenu标签](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/module-configuration-file)

它是**文件管理器**的右键菜单（`menuKind` 0=空白处/1=文件/2=文件夹/3=文件和文件夹），单模块/单应用 ≤ 5 个，回调参数是 `menuHandler` + `uriList`。**不是 Dock 图标菜单**。

## 1.2 ✅ 正确答案：`quickBarManager`（Desktop Extension Kit）

这是**唯一**官方明确支持「应用图标在 Dock/快捷栏右键菜单」自定义的机制。官方定义原文：

> 快捷栏指的是 **PC/2in1 设备的屏幕底部的图标区域**。
> 应用接入快捷栏之后，**快捷栏的应用图标菜单会显示应用自定义的菜单项**，应用可以添加、删除、更新、查询菜单项。
> —— [应用接入快捷栏](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/desktop-quickbar-extension-guide)

SDK 声明文件里的原话（`@hms.pcService.quickBarManager.d.ets`）更直接：

> This module provides apps with the capability of adding their icons to the quick bar. Apps can customize quick bar
> menu items displayed upon a **right-click** by calling the corresponding APIs.

以及 `addQuickTask` 的注释：

> Adds a quick bar task. The added menu item will be displayed **after you right-click the app icon in the quick bar**.

### 关键事实

- 导入路径：`import { quickBarManager } from '@kit.DeskTopExtensionKit';`
- **本机 SDK 已实证存在**：
  - `C:\Program Files\Huawei\DevEco Studio\sdk\default\hms\ets\kits\@kit.DeskTopExtensionKit.d.ts`
  - `C:\Program Files\Huawei\DevEco Studio\sdk\default\hms\ets\api\@hms.pcService.quickBarManager.d.ets`
- **非系统 API**：SDK api-version 元数据中所有 `quickBarManager` 条目的 `"isSystemApi": "false"` → **三方应用可直接调用**。
- **仅 2in1 生效**：所有条目 `deviceTypes` 仅列 `2in1`。指南原文：「Desktop Extension Kit 相关 API 仅在 PC/2in1 设备上生效。」
- **需要权限：无**。`addCustomCategory` / `addQuickTask` / `getCustomCategories` / `getTasksFromCategory` / `updateQuickTask` / `deleteQuickTask` **均无 `@permission` 标注**。
  仅 26.0.0 新增的图标/进度条 4 个接口需要 `ohos.permission.SET_ABILITY_INSTANCE_INFO`：`setQuickBarCombineIcon`、`setQuickBarLayeredIcon`、`setProgressState`、`setProgressValue`。

### API 版本基线（SDK JSDoc `@since` 实证）

| API | `@since` |
|---|---|
| `quickBarManager` 命名空间 | **6.0.2(22)** |
| `getCustomCategories` / `addCustomCategory` / `updateCustomCategory` / `deleteCustomCategory` | 6.0.2(22) |
| `getTasksFromCategory` / `addQuickTask` / `updateQuickTask` / `deleteQuickTask` | 6.0.2(22) |
| `addQuickBarGroup` / `deleteQuickBarGroup` / `getQuickBarGroups` / `setWindowToGroup` | 6.1.0(23) |
| `ProgressState` / `setProgressState` / `setProgressValue` / `setQuickBarCombineIcon` / `setQuickBarLayeredIcon` / `isQuickBarCapabilitySupported` | 26.0.0 |

> ⚠️ **API 26 可用性**：你的工程 `compatibleSdkVersion: 26.0.0`，上述接口全部可用（6.0.2/6.1.0 均 ≤ 26）。
> ⚠️ **注意 `since` 是三段式 "6.0.2(22)"**：含义为 HarmonyOS 6.0.2 / API 22。工程 `targetSdkVersion: 26.0.0` 满足。

### 数量上限

- 菜单**分组（category）最多 3 个**（`addCustomCategory` 的 `1020210001 Maximum number of categories reached.`，错误码文档原文：「分组最大数量为3」）。
- 每个任务的 `parameters` 数组 **≤ 64 项**（`QuickTaskInfo.parameters` JSDoc：`The number of elements in the array cannot exceed 64`）。
- 每个 `ParameterItem` 的 key/value 长度 **1–512**，不可为空。
- 快捷栏**窗口分组（QuickBarGroup）** 是独立能力（API 23+），与菜单分组不同。

### 菜单项被点击后如何被应用接收

**关键约束：菜单项只能指定一个 `abilityName`（可选 `moduleName`），系统通过 startAbility 拉起它，`parameters` 作为 `WantParams` 传入。**

官方 `ParameterItem` 定义原文：

> Custom parameter of the quick bar menu task, which is **WantParams**. You can customize the key-value pair.

所以接收方式与普通 Want 完全一致：

- 目标 Ability **未运行** → `onCreate(want, launchParam)` + `onWindowStageCreate` + `onForeground`
- 目标 Ability **已运行且为 `singleton`** → **只触发 `onNewWant(want, launchParam)`**（官方 `UIAbility组件启动模式`：singleton 复用实例时「只会进入该 UIAbility 的 onNewWant() 回调，不会进入其 onCreate() 和 onWindowStageCreate()」）

**重要限制（必须明确）**：`quickBarManager` 的任务项**没有**「直接执行一段代码」的能力——它一定会 `startAbility`。
所以「退出应用」这类动作必须**先让某个 Ability 被拉起**，再在该 Ability 的 `onNewWant`/`onCreate` 里读参数执行退出。
这意味着它会带来一次 Ability 启动/回前台的副作用。**避免方法**：让「退出/重启」任务指向**一个专用的隐藏/轻量 Ability**（例如复用现有的 `BackGroundAbility`），而不是指向主 `EntryAbility`，这样点「退出」不会把主窗口再拉起来。

> ⚠️ **以下为推测（文档未明确）**：`quickBarManager` 点击后到底是「冷启动 to Create」还是「热启动 to onNewWant」，官方文档**没有写**。我按 `startAbility` 语义推断（因为 `abilityName` 是显式 Want 目标）。**上线前必须用 `hdc` 实测日志确认**。

## 1.3 落地代码（module.json5 + 资源 + ArkTS）

### `entry/src/main/module.json5`（在现有 `module` 内追加/修改）

```json5
{
  "module": {
    "name": "entry",
    "type": "entry",
    // ... 现有字段保持不变 ...
    "deviceTypes": ["phone", "tablet", "2in1", "car", "tv", "wearable"],

    "abilities": [
      {
        "name": "EntryAbility",
        "srcEntry": "./ets/entryability/EntryAbility.ets",
        // ... 现有 icon/label/startWindow 等保持不变 ...
        "exported": true,
        // 【问题2】显式声明单实例（缺省值本就是 singleton，显式写更清晰）
        "launchType": "singleton",
        // 【问题3】terminateSelf 后从任务列表移除（可选，PC 自由多窗下不生效）
        "removeMissionAfterTerminate": true,
        "skills": [
          {
            "entities": ["entity.system.home"],
            "actions": ["ohos.want.action.home"]
          }
        ]
      },
      {
        // Dock 右键菜单的目标 Ability：Dock 菜单项只拉它就是「退出」
        "name": "BackGroundAbility",
        "srcEntry": "./ets/backgroundability/BackGroundAbility.ets",
        "exported": true,
        "launchType": "singleton"
      }
    ]
  }
}
```

> 注意：`quickBarManager` **不需要任何 `module.json5` 声明**（没有类似 `shortcuts` 的 profile 挂载点），它是纯**运行时 API**。这与 `shortcuts`/`fileContextMenu` 的「静态 profile + metadata」模式完全不同。

### ArkTS：注册 Dock 右键菜单（建议放在 `DshmWebPage` 的 `aboutToAppear` 或 `EntryAbility.onWindowStageCreate` 后）

```typescript
// entry/src/main/ets/dshm/system/QuickBarMenu.ets
import { quickBarManager } from '@kit.DeskTopExtensionKit';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { DshmLogger } from '../utils/Logger';

const TAG: string = 'QuickBarMenu';

/** Dock 右键菜单参数 key：由 quickBarManager 以 WantParams 形式回传给 Ability。 */
export const QUICKBAR_PARAM_KEY: string = 'dshmAction';
export const QUICKBAR_ACTION_RESTART: string = 'restart';
export const QUICKBAR_ACTION_EXIT: string = 'exit';

/**
 * 安装 Dock（快捷栏）右键菜单。
 *
 * 幂等：先查已存在的分组与任务，已存在则跳过，避免重复添加。
 * 失败不影响主流程（非 2in1 设备 / 系统不支持时静默跳过）。
 */
export async function installQuickBarMenu(context: common.UIAbilityContext): Promise<void> {
  try {
    // 1) 能力探测：仅 true 才继续
    const supported: boolean = await quickBarManager.isQuickBarCapabilitySupported(context);
    if (!supported) {
      DshmLogger.info(TAG, '当前设备不支持快捷栏，跳过 Dock 菜单注册');
      return;
    }

    // 2) 取或建分组（最多 3 个）
    let categoryId: number = -1;
    const categories: quickBarManager.CustomCategory[] =
      await quickBarManager.getCustomCategories(context);
    for (let i = 0; i < categories.length; i++) {
      if (categories[i].categoryName === 'DSHM') {
        categoryId = categories[i].categoryId;
        break;
      }
    }
    if (categoryId < 0) {
      const created: quickBarManager.CustomCategory =
        await quickBarManager.addCustomCategory(context, 'DSHM');
      categoryId = created.categoryId;
    }

    // 3) 幂等：已注册的任务名跳过
    const existing: quickBarManager.QuickTask[] =
      await quickBarManager.getTasksFromCategory(context, categoryId);
    const existingNames: string[] = [];
    for (let i = 0; i < existing.length; i++) {
      existingNames.push(existing[i].taskInfo.taskName);
    }

    // 4) 逐项添加。「退出」指向 BackGroundAbility，避免把主窗口再拉到前台
    await addTaskIfMissing(context, categoryId, existingNames, '退出 DSHM',
      QUICKBAR_ACTION_EXIT, 'BackGroundAbility');
    await addTaskIfMissing(context, categoryId, existingNames, '重启 DSHM',
      QUICKBAR_ACTION_RESTART, 'BackGroundAbility');

    DshmLogger.info(TAG, 'Dock 右键菜单注册完成');
  } catch (e) {
    const err: BusinessError = e as BusinessError;
    DshmLogger.warn(TAG, 'Dock 右键菜单注册失败（可忽略）: ' + err.code + ' ' + err.message);
  }
}

async function addTaskIfMissing(context: common.UIAbilityContext, categoryId: number,
  existingNames: string[], taskName: string, action: string, abilityName: string): Promise<void> {
  if (existingNames.includes(taskName)) {
    return;
  }
  const param: quickBarManager.ParameterItem = { key: QUICKBAR_PARAM_KEY, value: action };
  const info: quickBarManager.QuickTaskInfo = {
    taskName: taskName,
    abilityName: abilityName,
    moduleName: 'entry',
    taskDetail: taskName,
    parameters: [param]
  };
  await quickBarManager.addQuickTask(context, categoryId, info);
  DshmLogger.info(TAG, '已添加 Dock 菜单项: ' + taskName);
}
```

### ArkTS：在 Ability 里分发菜单点击

因为 `quickBarManager` 一定走 `startAbility`，菜单点击只会出现在 **`onCreate`（冷启动）或 `onNewWant`（热启动）** 的 `want.parameters` 里。
由于本项目是通过 `napi` 在当前进程中启动 `dsh` 子进程（而非独立的 Console 应用），因此在 `onNewWant` 中读取 `want.parameters` 并调用 `DshBootstrap.stopDshForExit` 是安全的；**唯一需要注意的是**：如果用户点击「退出」时应用不在前台，`onNewWant` 会先触发 `onForeground`，可能短暂显示窗口。若需要完全避免这一闪烁，应在 `onWindowStageCreate` 之后调用 `windowStage.getMainWindowSync().minimize()` 立即最小化（见问题2的讨论）。

```typescript
// entry/src/main/ets/backgroundability/BackGroundAbility.ets（节选）
import { UIAbility, Want, AbilityConstant } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { DshmLogger } from '../dshm/utils/Logger';
import { QUICKBAR_PARAM_KEY, QUICKBAR_ACTION_EXIT, QUICKBAR_ACTION_RESTART }
  from '../dshm/system/QuickBarMenu';

const TAG: string = 'BackGroundAbility';

export default class BackGroundAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    this.dispatchQuickBarAction(want);
  }

  /** Dock 右键菜单热启动路径：目标 Ability 已存在时系统只回调 onNewWant。 */
  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    this.dispatchQuickBarAction(want);
  }

  /** 统一分发：读取 quickBarManager 写入的 WantParams。 */
  private dispatchQuickBarAction(want: Want): void {
    const params: Record<string, Object> | undefined = want.parameters;
    if (params === undefined) {
      return;
    }
    const raw: Object | undefined = params[QUICKBAR_PARAM_KEY];
    if (raw === undefined) {
      return;
    }
    const action: string = String(raw);
    DshmLogger.info(TAG, '收到 Dock 菜单动作: ' + action);
    if (action === QUICKBAR_ACTION_EXIT) {
      this.finishApp();
    } else if (action === QUICKBAR_ACTION_RESTART) {
      this.restartApp();
    }
  }

  private finishApp(): void {
    // 主 Ability 结束后其宿主进程被系统回收，DSH 的 native 子进程随之停止。
    this.context.terminateSelf().then((): void => {
      DshmLogger.info(TAG, 'BackGroundAbility 已结束');
    }).catch((e: BusinessError): void => {
      DshmLogger.warn(TAG, '结束失败: ' + JSON.stringify(e));
    });
  }

  private restartApp(): void {
    // 委托主 Ability 执行重启（需自行实现 requestRestart 信号）
    DshmLogger.info(TAG, '发出重启请求');
    this.finishApp();
  }
}
```

### 完整交互链路

```
用户右键 Dock 图标
  → 系统弹出快捷栏菜单，显示 quickBarManager 注册的「退出 DSHM」「重启 DSHM」
  → 用户点击「退出 DSHM」
  → 系统 startAbility({ bundleName: com.brewdsh.app, moduleName: entry,
                        abilityName: BackGroundAbility,
                        parameters: { dshmAction: 'exit' } })
  → BackGroundAbility.onCreate / onNewWant 读取 want.parameters.dshmAction
  → 执行 terminateSelf() / 重启逻辑
```

### 替代/补充方案（如果 `quickBarManager` 在你的设备上不可用）

1. **系统托盘 `statusBarManager`（Desktop Extension Kit，API 12 起）** — 本项目**已经在用**（`entry/src/main/ets/dshm/system/StatusBarTray.ets`）。
   `StatusBarItem` 支持 `statusBarGroupMenu`（`StatusBarMenuItem[]`，含 `subMenu`）→ `statusBarManager.addToStatusBar(context, statusBarItem)`，并用 `statusBarManager.on('rightMenuClick', cb)` 接收 `menuCode`。
   这是**系统托盘**（屏幕右下角）的右键菜单，**不是 Dock 图标菜单**，但完全可控、无需权限、API 12 起就支持，是当前最稳的落点。
   文档：[statusBarManager（状态栏管理服务）](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/api/desktop-statusbar-extension-manager)、[应用接入状态栏](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/desktop-statusbar-extension-guide)
2. **`shortcuts` 静态快捷方式** — 已实测（`shortcuts` 仅覆盖长按图标，**不覆盖 Dock 右键**），因此仅作为次要补强：桌面长按图标时也能看到「重启/退出」。若要加，按 §1.1 的表约束写 `shortcuts_config.json` + `metadata: ohos.ability.shortcuts`。**改动极小（纯静态配置，不改代码）**。
3. **`onPrepareToTerminate` 拦截系统默认退出项**（纯代码，见 §1.4）。

## 1.4 系统默认提供的 Dock/托盘右键菜单项

官方明确说明系统在 Dock/托盘右键里**自带「退出/关闭」项**，开发者可以拦截，但不能自定义其文案：

> 在 UIAbility 即将关闭前（例如用户通过**点击应用窗口右上角的关闭按钮**、或者通过 **Dock 栏/托盘右键退出应用**时），系统会触发该回调……
> **需要权限**：`ohos.permission.PREPARE_APP_TERMINATE`
> **设备行为差异**：该接口仅在 **PC/2in1 和 Tablet** 设备中可正常执行回调，在其他设备上不执行回调。
> —— [@ohos.app.ability.UIAbility · onPrepareToTerminate10+](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/api/js-apis-app-ability-uiability)

返回值语义：`true` = 本次关闭流程被取消（可用于「最小化到托盘」）；`false` = 继续正常关闭。

**关键互斥规则（官方原文）**：
- API 15 起，若实现了 `onPrepareToTerminateAsync`，则 `onPrepareToTerminate` **不执行**。
- 若 `AbilityStage.onPrepareTerminationAsync` 或 `AbilityStage.onPrepareTermination` 实现，则**在 Dock 栏或系统托盘处右键点击关闭时，本回调不执行**。
- 若注册了 `window.WindowStage.on('windowStageClose')` 监听，本回调**不执行**。

另有官方行为说明（**注意这个坑**）：

> *   **Dock栏退出**：在 PC/2in1 或 Tablet 设备上，用户通过 Dock 栏退出，**UIAbility 的 onDestroy 不保证回调**。
> —— [应用退出 · 用户主动清理UIAbility](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/app-stop)

但同一文档开头又写「通过 Dock 栏右键关闭」属**正常退出**，「系统会严格遵循生命周期规范，依次触发标准的销毁回调」。
> ⚠️ **两处表述不一致**。工程上必须按**最保守**理解：**不要依赖 Dock 退出时一定执行 `onDestroy` 做关键清理**，把关键落盘/清理放在 `onBackground` 或主动退出路径里。

**你的工程已经正确实现了这一套**（`entry/src/main/ets/entryability/EntryAbility.ets`）：

```typescript
onPrepareToTerminate(): boolean {
  if (this.exiting) { return false; }          // 主动退出 → 放行
  if (!this.trayReady) { return false; }        // 托盘不可用 → 绝不放行隐藏
  this.context.hideAbility()...                 // 否则：隐藏到托盘常驻
  return true;
}
```

`module.json5` 中也已声明 `ohos.permission.PREPARE_APP_TERMINATE`。**这一块不需要改动。**

---

# 2. 左键单击 Dock 图标唤起到前台

## 2.1 默认行为

**Dock 左键单击 = 系统级「把该应用的任务/窗口切到前台」**，它**不是** `startAbility`。
证据：官方《应用退出》把「通过 Dock 栏右键关闭」列为**用户主动**操作，与「多任务管理界面清理卡片」并列；`StartOptions.startupVisibility` 的说明以「dock 栏是否有图标」描述窗口可见性，说明 Dock 图标是由 WindowManager/任务栈驱动的系统 UI，而非应用 Ability 的启动入口。

因此对 `launchType: singleton` 的应用：
- 应用**未运行** → 冷启动：`onCreate` → `onWindowStageCreate` → `onForeground`
- 应用**已运行、在后台** → 切前台：`onForeground`（官方生命周期文档：把 UIAbility 拉回前台「依次触发 onNewWant()、onForeground()」；纯 Dock 切前台**只保证 `onForeground`**）
- 应用**已在前台** → 通常无生命周期回调，系统自行抬升窗口层级

## 2.2 需要哪些配置才能「不启动第二个实例」

**结论：`launchType: singleton` 就是答案，而它恰好是缺省值。**

官方 `UIAbility组件启动模式` 原文：

> **singleton 启动模式为单实例模式，也是默认情况下的启动模式。**
> 每次调用 startAbility() 方法时，如果应用进程中该类型的 UIAbility 实例已经存在，则复用系统中的 UIAbility 实例。
> ……此时只会进入该 UIAbility 的 **onNewWant()** 回调，不会进入其 onCreate() 和 onWindowStageCreate() 生命周期回调。

`module.json5` 文档也说：`launchType`「该标签可缺省，**该标签缺省为 "singleton"**」。

> **本项目现状**：`EntryAbility` / `BackGroundAbility` 都**没有**写 `launchType`，即已是 `singleton`。
> 建议**显式写出来**，一是自文档化，二是防止后来者误改成 `multiton`。
> ⚠️ **绝对不要**把主 Ability 改成 `multiton` —— 那会让每次 Dock 点击都新建实例。

## 2.3 ArkTS：把窗口带到前台的推荐写法

### 推荐主路径：`onForeground` 里兜底 `showWindow()`

这是最可靠的写法，因为 **Dock 左键一定会触发 `onForeground`**（无论冷启动还是热启动）。本项目**已经这么做**了：

```typescript
// entry/src/main/ets/entryability/EntryAbility.ets（现有实现）
onForeground(): void {
  DshmLogger.info(TAG, 'onForeground');
  // 兜底：无论从 Dock、任务栏还是托盘唤回，都确保主窗口真的显示出来
  //（窗口被 hideAbility 隐藏后，仅回前台不会自动取消隐藏）。
  this.ensureWindowShown();
}

private ensureWindowShown(): void {
  if (this.stage === null) { return; }
  try {
    const win: window.Window = this.stage.getMainWindowSync();
    win.showWindow().then((): void => {
      DshmLogger.info(TAG, '主窗口已显示');
    }).catch((e: BusinessError): void => {
      DshmLogger.warn(TAG, '显示主窗口失败（已显示时属正常）: ' + JSON.stringify(e));
    });
  } catch (e) {
    DshmLogger.warn(TAG, '获取主窗口失败: ' + String(e));
  }
}
```

官方 API 依据：

`Window.showWindow()`（API 9+）：
> 显示当前窗口，使用 Promise 异步回调，支持系统窗口、应用子窗口、模态窗和全局悬浮窗，**或将已显示的应用主窗口层级提升至顶部**。

错误码：`1300002 This window state is abnormal.`（窗口已显示时会命中，属正常，按 warn 处理即可）。

[Interface (Window) · showWindow9+](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/api/js-apis-window)

`WindowStage.getMainWindowSync()`（API 9+）：
> 调用该接口前，建议先通过 `loadContent` 方法或者 `setUIContent` 方法完成页面加载。

[Interface (WindowStage) · getMainWindowSync9+](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/api/js-apis-window)

`Window.restore()`（**API 14+**）：
> 主窗口为最小化状态且 UIAbility 生命周期为 onForeground 时，将主窗口从最小化状态，恢复到前台显示，并恢复到进入最小化状态之前的大小和位置。**主窗口为前台状态时，仅抬升主窗口层级。**
> **设备行为差异**：该接口在 **PC/2in1 设备**、Tablet 设备的电脑模式下可正常调用，在其他设备和其他模式下返回 **801** 错误码。

[Interface (Window) · restore14+](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/api/js-apis-window)

### 建议的增强写法（最小化场景必须补 `restore`）

`showWindow()` 对**最小化**窗口不一定能恢复——官方为最小化恢复专门提供了 `restore()`，且明确说明 **PC/2in1 可用**。当用户最小化窗口后点 Dock 图标，应优先 `restore()`：

```typescript
/** 确保主窗口处于显示状态：最小化→restore，隐藏→showWindow。 */
private ensureWindowShown(): void {
  if (this.stage === null) { return; }
  try {
    const win: window.Window = this.stage.getMainWindowSync();
    // 首选 restore()：PC/2in1 上同时覆盖「最小化恢复」与「前台抬升层级」。
    win.restore().then((): void => {
      DshmLogger.info(TAG, '主窗口已恢复/抬升');
    }).catch((e: BusinessError): void => {
      // 801 = 设备/模式不支持，1300002 = 窗口状态异常（非最小化时常见），
      // 退回 showWindow() 覆盖「被 hideAbility 隐藏」的场景。
      DshmLogger.info(TAG, 'restore 未生效，回退 showWindow: ' + e.code);
      win.showWindow().catch((e2: BusinessError): void => {
        DshmLogger.warn(TAG, 'showWindow 也失败: ' + JSON.stringify(e2));
      });
    });
  } catch (e) {
    DshmLogger.warn(TAG, '获取主窗口失败: ' + String(e));
  }
}
```

> `Window.restore()` 的 `@since` 是 **14**，`compatibleSdkVersion: 26.0.0` 满足。
> ⚠️ **`restore()` 是推测组合中的一环**：官方文档没有把 `restore()` 描述成「Dock 唤回的标准做法」，它描述的是「最小化→恢复」。但它的「主窗口为前台状态时，仅抬升主窗口层级」语义与 Dock 唤回需求完全吻合，且明确支持 PC/2in1。**建议实测验证**。

### `restoreMainWindow()`（API 23+）——**不适用**

`Window.restoreMainWindow(wantParameters?)` 用于把 **`TYPE_FLOAT` 窗口**的主窗恢复到前台，并要求「需在窗口触发过 DOWN 事件后才能调用」。你的主窗口不是 `TYPE_FLOAT`，**不适用**。

### 避免「误触发 onNewWant 导致页面异常变化」

如果启用 §1.3 的 `quickBarManager`（或任何会 `startAbility` 的入口），`onNewWant` 会在非预期场景被触发。官方专门给了对策：

> 在 Scenarios 相关的场景下启动 UIAbility 时，若该 UIAbility 实例已存在，系统会**非预期触发 onNewWant()** 生命周期回调，导致回调中传入的 want 参数也为非预期。若应用使用了该非预期 want 参数，可能引起非预期的页面变化。
> **解决措施**：建议在 `onCreate()` 生命周期回调中调用 `setOnNewWantSkipScenarios()` 接口……设置在这些场景下不触发 `onNewWant()` 回调，使应用再次启动时**直接切至前台**。

```typescript
import { UIAbility, Want, AbilityConstant, contextConstant } from '@kit.AbilityKit';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // 屏蔽三类「非用户主动」场景下的 onNewWant，避免非预期页面变化
    const scenarios: number = contextConstant.Scenarios.SCENARIO_MOVE_MISSION_TO_FRONT |
      contextConstant.Scenarios.SCENARIO_SHOW_ABILITY |
      contextConstant.Scenarios.SCENARIO_BACK_TO_CALLER_ABILITY_WITH_RESULT;
    try {
      this.context.setOnNewWantSkipScenarios(scenarios).then((): void => {
        DshmLogger.info(TAG, 'setOnNewWantSkipScenarios 成功');
      }).catch((err: BusinessError): void => {
        DshmLogger.warn(TAG, 'setOnNewWantSkipScenarios 失败: ' + err.code);
      });
    } catch (e) {
      DshmLogger.warn(TAG, 'setOnNewWantSkipScenarios 异常: ' + String(e));
    }
  }
}
```

枚举取值（`@ohos.app.ability.contextConstant` · `Scenarios`）：

| 成员 | 值 | 含义 |
|---|---|---|
| `SCENARIO_MOVE_MISSION_TO_FRONT` | `0x00000001` | 共享屏幕时系统将用户选择的 UIAbility 拉起到前台场景 |
| `SCENARIO_SHOW_ABILITY` | `0x00000002` | `showAbility` 接口触发的 UIAbility 到前台场景 |
| `SCENARIO_BACK_TO_CALLER_ABILITY_WITH_RESULT` | `0x00000004` | `backToCallerAbilityWithResult` 接口触发的 UIAbility 到前台场景 |

`setOnNewWantSkipScenarios` 的 `@since` = **API 20**（元服务 API 从 API 20 起支持）。
[UIAbilityContext · setOnNewWantSkipScenarios20+](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/api/js-apis-inner-application-uiabilitycontext)

> ⚠️ **注意副作用**：本项目托盘唤回用的是 `context.showAbility()`（见 `EntryAbility.showMainWindow()`）。
> 若把 `SCENARIO_SHOW_ABILITY` 也加入跳过集合，`showAbility()` 将**不再触发 `onNewWant`** —— 这正是我们想要的（我们靠 `onForeground` 兜底显示窗口）。
> 但**反过来**：如果你将来想用 `onNewWant` 接收托盘/菜单动作，就**不能**跳过对应场景。当前把 Dock 菜单的接收方放在**独立的 `BackGroundAbility`**，主 `EntryAbility` 与它互不干扰，是干净的划分。

### `launchType` 三模式对照（问题2完整答复）

| 模式 | 行为 | 适用 |
|---|---|---|
| `singleton` | 复用唯一实例，再次启动只触发 `onNewWant` | ✅ **本应用（默认值，Dock 场景正确）** |
| `multiton`（曾用名 `standard`） | 每次 `startAbility` 都新建实例，任务列表出现多个同类型卡片 | ❌ Dock 场景会导致多实例 |
| `specified` | 由 `AbilityStage.onAcceptWant(want)` 返回的 KEY 决定复用还是新建 | 文档类多实例场景；官方建议同时设 `removeMissionAfterTerminate: true`，否则冷启动无法复用历史任务 |

`specific` 模式还需在 `AbilityStage.onAcceptWant()` 里返回唯一 KEY：
> 系统会根据获取的 Key 值来匹配 UIAbility。如果匹配到对应的 UIAbility，则会启动该 UIAbility 实例，并进入 `onNewWant()` 生命周期回调。

[UIAbility组件启动模式](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/uiability-launch-type)

---

# 3. 优雅退出（kill 自身进程）

## 3.1 两个接口的官方定位（直接引用）

### `UIAbilityContext.terminateSelf()` —— 正常退出，官方推荐

> 销毁 UIAbility 自身。使用 callback 异步回调。**仅支持在主线程调用。**
> 调用该接口后，**任务中心的任务默认不会清理，如需清理，需要配置 `removeMissionAfterTerminate` 为 true**。
> —— [UIAbilityContext · terminateSelf](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/api/js-apis-inner-application-uiabilitycontext)

### `ApplicationContext.killAllProcesses()` —— 异常强制退出，**不推荐**用于正常退出

> 终止应用的所有进程，**进程退出时不会正常执行完整的应用生命周期流程**。使用 Promise 异步回调。仅支持主线程调用。
> **该接口用于应用异常场景中强制退出应用。如需正常退出应用，可以使用 `terminateSelf()` 接口。**
> —— [ApplicationContext · killAllProcesses](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/api/js-apis-inner-application-applicationcontext)

> API 14+ 有重载 `killAllProcesses(clearPageStack: boolean)`：`true` 表示清除页面堆栈。

## 3.2 「`terminateSelf()` 会不会只是关窗口而进程仍在？」

**官方机制（《应用退出》原文）**：

> 组件销毁（如 UIAbility）仅销毁特定实例，其宿主进程仍常驻后台；**只有当进程内所有组件均被销毁，进程才会触发销毁流程**，直至应用所属的所有进程被操作系统彻底销毁、回收全部内存与线程时，应用才算真正退出。

> 由于应用可能包含多个进程，每个进程中又能运行多个 UIAbility 组件，因此**当某个进程中的最后一个 UIAbility 组件退出后，该进程随之退出**，而当应用的最后一个进程退出时，整个应用即完成退出过程。

**所以答案是：**
- `terminateSelf()` **本身只销毁当前 UIAbility 实例**。
- 但**如果该进程内没有其他存活的 UIAbility/ExtensionAbility**，进程会随之退出 → 达到「退出应用」效果。
- **如果进程内还有其他 Ability 存活，进程会继续常驻**，`terminateSelf()` 看起来就"只是关了窗口"。

> ⚠️ **这是本项目的关键风险点**：`module.json5` 里 `EntryAbility` 和 `BackGroundAbility` 同属 `entry` 模块、未配置 `process` 隔离（`process` 标签「仅在 PC/2in1 和 Tablet 设备上生效」，未设置则同进程）。
> 因此只对 `EntryAbility` 调 `terminateSelf()`，**若 `BackGroundAbility` 仍存活，进程不会退出**。
> 现有实现的应对是：`BackGroundAbility` 通过公共事件联动 `terminateSelf()`（见 `StatusBarTray.subscribeBgTerminating`），两条路径都走完才算干净退出。**这个设计是正确的，务必保持。**

**官方对 iTerminateSelf 的完整定位表**：

| 退出类型 | 触发场景 | 是否触发 `onDestroy` |
|---|---|---|
| 用户主动（正常） | 侧滑/返回键退出；多任务界面清理单个卡片或「清除全部」 | 是 |
| 应用主动（正常） | 开发者显式调用 **`terminateSelf()`** | 是 |
| 系统强制（异常） | 进程崩溃、jscrash、系统资源回收（内存紧张/电量优化/权限变更） | **否** |

另有官方明确的行为差异（见 §1.4）：**Dock 栏退出时 `onDestroy` 不保证回调**。

## 3.3 推荐写法（含 native 子进程清理）

### 核心原则

`terminateSelf()` 只保证 **ArkTS 侧 UIAbility 生命周期**正常走完。**它不会替你管理你在 native 层 `fork/exec` 出来的子进程**（你的 `dsh` node 服务正是这种）。

> ⚠️ **推测标注**：官方文档**没有**任何一句描述「`terminateSelf()` 是否会清理应用自己 spawn 的 native 子进程」。从 OS 语义推断：应用子进程随其宿主进程被回收，但**前提是宿主进程真的退出**（见 §3.2）；且即使宿主退出，若子进程已 `setsid` 脱离进程组也可能残留。
> **必须显式、有序地先停 native 子进程，再 `terminateSelf()`。**

### 推荐顺序（本项目已基本落地）

```typescript
private exitApp(reason: string): void {
  if (this.exiting) { return; }        // ① 幂等闸门，防重入
  this.exiting = true;
  DshmLogger.info(TAG, '开始退出应用（' + reason + '）');

  try {
    StatusBarTray.remove(this.context); // ② 先摘托盘图标，否则会残留孤儿图标
  } catch (e) {
    DshmLogger.warn(TAG, '摘除托盘图标失败: ' + String(e));
  }

  // ③ 停 native 子进程（写 stop-request 文件，轮询 host-stopped 标记，带超时）
  DshBootstrap.stopDshForExit(this.context, mode, 5000).then((): void => {
    // ④ 最后才 terminateSelf
    this.context.terminateSelf().then((): void => {
      DshmLogger.info(TAG, '主 Ability 已结束，DSH 服务随进程回收');
    }).catch((e: BusinessError): void => {
      DshmLogger.warn(TAG, '结束主 Ability 失败: ' + JSON.stringify(e));
    });
  });
}
```

对应现有代码：`EntryAbility.exitApp()`（第 276–294 行）+ `DshBootstrap.stopDshForExit()`（`DshBootstrap.ets` 第 1707–1731 行，用 `stop-request` 文件 + `host-stopped` 标记轮询，5s 超时）。

### 注意事项清单

1. **必须先停 native 子进程**，再 `terminateSelf()`。顺序反了，进程一退你就没有机会发停止信号了。
2. **`exiting` 幂等闸门**：`onPrepareToTerminate` 放行依赖它（见 §1.4），且防止多入口（应用内菜单 / 托盘右键 / Dock 菜单）重复触发。
3. **托盘图标要先摘**：`statusBarManager.removeFromStatusBar(context)`。图标不摘会导致残留。
4. **不要用 `killAllProcesses()` 做正常退出**：官方明说它「不会正常执行完整的应用生命周期流程」，会跳过 `onDestroy`，你现有的清理逻辑（`clearContext()` 等）不会跑。只在 ArkTS 层已经无法自救时（如致命状态）才用。
5. **`terminateSelf()` 仅支持主线程调用**。
6. **`removeMissionAfterTerminate`**：默认 `false`，任务中心会保留快照。官方：**2in1 设备和平板设备的自由多窗模式下该配置不生效，默认移除任务**。所以 PC 上不必指望靠它。
7. **Dock 退出不保证 `onDestroy`**：关键落盘/清理不要只放在 `onDestroy`。
8. **`stopDshForExit` 的 timeout 不能省**：native 子进程若卡住不写 `host-stopped`，必须超时后继续走 `terminateSelf()`，否则应用假死退不掉。
9. **`killAllProcesses(clearPageStack)`** 若要清理页面堆栈需注意：`true` 时**会**清页面堆栈；`false` 时不清除（API 14+）。

### 官方文档链接

- [应用退出（开发指南）](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/app-stop)
- [UIAbilityContext（含 terminateSelf）](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/api/js-apis-inner-application-uiabilitycontext)
- [ApplicationContext（含 killAllProcesses）](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/api/js-apis-inner-application-applicationcontext)

---

# 附：全部官方文档链接

| 主题 | URL |
|---|---|
| 应用接入快捷栏（Dock 右键菜单★核心） | https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/desktop-quickbar-extension-guide |
| quickBarManager（快捷栏管理服务）API | https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/api/desktop-quickbar-extension-manager |
| 应用接入状态栏（系统托盘） | https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/desktop-statusbar-extension-guide |
| statusBarManager API | https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/api/desktop-statusbar-extension-manager |
| module.json5配置文件（shortcuts / fileContextMenu / launchType） | https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/module-configuration-file |
| 创建应用静态快捷方式 | https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/typical-scenario-configuration |
| 桌面快捷方式（最佳实践） | https://developer.huawei.com/consumer/cn/doc/best-practices/bpta-desktop-shortcuts |
| UIAbility组件启动模式（launchType） | https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/uiability-launch-type |
| UIAbility组件生命周期（onNewWant / setOnNewWantSkipScenarios） | https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/uiability-lifecycle |
| @ohos.app.ability.UIAbility（onPrepareToTerminate） | https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/api/js-apis-app-ability-uiability |
| 应用退出（terminateSelf 定位、Dock 退出行为） | https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/app-stop |
| Interface (Window)（showWindow / restore） | https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/api/js-apis-window |
| Interface (WindowStage)（getMainWindowSync） | https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/api/js-apis-window |
| UIAbilityContext（terminateSelf / setOnNewWantSkipScenarios） | https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/api/js-apis-inner-application-uiabilitycontext |
| ApplicationContext（killAllProcesses） | https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/api/js-apis-inner-application-applicationcontext |
| contextConstant（Scenarios 枚举） | https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/api/js-apis-app-ability-contextconstant |

---

# 附：本地实证记录（本机 SDK 探测）

- SDK 根：`C:\Program Files\Huawei\DevEco Studio\sdk\default`
- Kit 声明：`...\hms\ets\kits\@kit.DeskTopExtensionKit.d.ts`
  ```typescript
  import quickBarManager from '@hms.pcService.quickBarManager';
  import statusBarManager from '@hms.pcService.statusBarManager';
  import StatusBarViewExtensionAbility from '@hms.pcService.StatusBarViewExtensionAbility';
  export { quickBarManager, statusBarManager, StatusBarViewExtensionAbility };
  ```
- 实现声明：`...\hms\ets\api\@hms.pcService.quickBarManager.d.ets`（501 行，已通读）
- api-version 元数据：`...\hms\ets\api\device-define\api-version\DesktopExtensionKit.json`
  全部 `quickBarManager` 条目：`"OS": "HarmonyOS"`, `"isSystemApi": "false"`, `deviceTypes` 仅 `2in1`
- 结论：**接口真实存在，且三方应用可用，仅 2in1 生效**。
