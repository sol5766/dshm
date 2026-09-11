# 技能：多实例与子窗口管理规范

## 1. 自动触发条件
当任务涉及以下情况时，必须遵守本规则：
- 涉及应用内悬浮窗、子窗口、弹层面板开发。
- 涉及任务多卡片、`launchType: "multiton"` 模式。
- 调用了 `ngfPlatformWindowManagerFacade.createSubWindow`。
- 调用了 `MultitonEntryAbility` 进行动态页面挂载。

## 2. 核心架构认知
NGF 框架通过巧妙的方法绕过了 `SYSTEM_FLOAT_WINDOW` 悬浮窗系统权限的要求，允许在纯应用级上下文中提供多窗口和浮窗体验：
- **多实例 (Multiton)**：这是一种由系统托管的宏观多任务方式。每次启动都是一个独立的 ArkUI 虚拟机实例，并能在系统“最近任务列表”形成单独的快照卡片。多实例不仅可以在应用内唤起，还支持从**桌面快捷方式 (Shortcuts)** 和 **桌面元服务卡片 (Widgets)** 直接独立唤起。
- **子窗口 (SubWindow)**：这是一种基于当前 Ability 窗口舞台的微观多窗口方式。子窗口附着在主窗口之上，生命周期随主窗口终结。适合用作应用内的全局媒体控制器、快捷工具条、悬浮设置面板等。

## 3. 多实例 (Multiton) 开发规范

### 3.1 启动方式
NGF 提供了一个通用的 `MultitonEntryAbility` 与 `NGFDemoMultitonPage` 壳层容器。任何组件都可以被挂载到这个独立卡片上，无需为其单独创建新的 UIAbility 或在 main_pages 注册。
- **启动 API**：必须使用 `context.startAbility`。
- **参数传递**：通过 `want.parameters['targetRouteName']` 告知通用宿主需要拉起哪个路由。还可通过 `targetTitle` 设置系统任务栏名称。

**示例：**
```typescript
const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
context.startAbility({
  bundleName: 'com.dlzz.ngf',
  abilityName: 'MultitonEntryAbility',
  parameters: {
    'targetRouteName': 'NGFSettings', // 这里填要拉起的路由标识（配合 NGFDemoMultitonPage 内部渲染逻辑）
    'targetTitle': '独立设置'       // 最近任务卡片的名称
  }
});
```

### 3.2 桌面系统集成与独立启动 (Standalone Launch)
NGF 框架完美支持将 Multiton 与鸿蒙桌面的快捷方式及卡片功能集成。
- **参数传递**：在 `shortcuts_config.json` 或卡片的 `postCardAction` 中拉起 `MultitonEntryAbility` 时，必须传递 `targetRouteName` 和 `instanceId`。否则会导致路由无法匹配而出现白屏。
- **智能初始化接管**：当通过桌面卡片或快捷方式触发多实例时，可能会遇到主应用 (`EntryAbility`) 完全未启动（杀后台）的冷启动情况。此时，`MultitonEntryAbility` 的 `onCreate` 生命周期会通过 `isInitialized()` 智能识别全局状态，并**自动接管全套的框架初始化流程**（包括 `ngfStarterKernel`、`ThemeManager`、`I18nManager` 等），同时也会正确绑定 `WindowStage`，确保无论如何启动，框架的沉浸式安全区和全局配置等核心能力绝不缺失。

### 3.3 Multiton 页面的限制
- Multiton 页面由于处于完全隔离的 Ability 实例中，它**不能**通过 `AppStorage`、`LocalStorage`、单例对象等直接与主界面的内存进行同步通信。如果需要通信，必须依赖持久化沙箱 (SettingsManager/Preferences) 或者跨 Ability 事件 (EventHub / Emitter)。

## 4. 应用内子窗口 (SubWindow) 开发规范

### 4.1 启动方式
**严禁**直接调用原生的 `window.createSubWindow`，因为这会导致应用失去对悬浮窗生命周期的管控能力。
必须使用统一的门面方法：`ngfPlatformWindowManagerFacade.createSubWindow(name: string)`。该门面会自动注册销毁监听器，避免内存泄漏。

**示例：**
```typescript
import { ngfPlatformWindowManagerFacade } from 'ngf_framework';
import { window } from '@kit.ArkUI';

// 1. 使用 AppStorage 安全地向通用子窗口容器 (NGFDemoSubWindowPage) 传参
AppStorage.setOrCreate('CurrentSubWindowRoute', 'NGFSettings');

// 2. 调用门面创建子窗口
ngfPlatformWindowManagerFacade.createSubWindow('unique_sub_window_name').then((subWindow: window.Window) => {
  // 注意：必须使用 setUIContent，不可使用废弃的 loadContent
  subWindow.setUIContent('pages/ngf/NGFDemoSubWindowPage', () => {
    subWindow.showWindow();
  });
}).catch((err: Error) => {
  // 错误处理
});
```

### 4.2 容器页面支持
无论是 `MultitonEntryAbility` 还是 `NGFDemoSubWindowPage`，它们已经在其 `aboutToAppear` 生命周期中完成了相关的路由出栈拦截（当页面退回根时自动终结自己），并实现了优雅的退场和进场动画（通过 `getUIContext().animateTo`），请不要破坏这部分逻辑。

### 4.3 错误类型捕获 (ArkTS 特有规则)
在调用框架 facade 方法遇到 `catch` 时，**务必遵循 ArkTS 的严格限制**：
- `throw` 语句只能抛出派生自 `Error` 的对象。
- Facade 方法中如捕获到未知类型错误，在向外继续抛出前，必须先将其 `as Error` 进行类型断言或重新包装为 `new Error(...)`。

### 4.4 悬浮窗样式与 UI
- **透明背景**：如果子窗口需要表现为半透明或浮层，请在它的根布局元素上设置透明或半透明的 `backgroundColor`。
- **系统栏穿透**：子窗口默认可能不在沉浸式下。如果需要穿透状态栏，需在其对应的 page 组件里调用 `window` API 或者框架沉浸式组件。
