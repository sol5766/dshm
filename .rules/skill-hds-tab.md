# 技能：HDS TabBar 与 HdsTabs 布局

**适用场景**：使用 `HdsTabs` (或 `Tabs`) 构建页面底部导航栏或标签页，且涉及浮动样式（`barFloatingStyle`）、毛玻璃/材质效果与底部系统安全区避让时。

**自动触发条件（满足任意一条即应主动阅读本文件）**：
- 任务涉及修改或添加 `HdsTabs` / `HdsTabsController` / `Tabs` 组件
- 任务涉及底部标签栏（Tab）遮挡内容、贴边显示或安全区重叠问题
- 任务涉及 `barFloatingStyle` 浮动样式、圆角、光晕或毛玻璃效果调优

---

## 1. 背景：HdsTabs 浮动样式的避让机制

在 NGF 框架中，为了实现精致的系统级光效与毛玻璃质感，我们常在 `HdsTabs` 上启用 `barFloatingStyle`（浮动标签栏样式）。

### 核心痛点与避让机制

- **自动避让失效**：当 `barFloatingStyle` 开启且 `barPosition` 设为 `BarPosition.End` 时，系统**不会**自动将浮动的 TabBar 往上移来避让底部的系统导航条（例如 Navigation Indicator 避让线）。如果不对其进行处理，TabBar 将紧贴屏幕底部，造成视觉拥挤与触控冲突。
- **正确的避让方案**：
  1. 动态获取底部系统导航条避让区高度（单位为 px，需要转换为 vp）。
  2. 将转换后的值动态赋给 `HdsTabs` 属性 `barFloatingStyle` 中的 `barBottomMargin`。
  3. 保持 `barOverlap(true)`，使 `TabContent` 内部的内容能延伸到 TabBar 下方，以展示完美的毛玻璃半透明融合效果。
  4. 为 `TabContent` 的内容容器设置足够的底部 padding（如 `76vp` 或更多），确保滚动到最底部时内容不会被浮动 TabBar 遮挡。

---

## 2. 标准实现模式与代码范式

### 第一步：声明状态变量与控制器

在组件内声明 `bottomInsetVp` 状态变量，以及选中的索引与 HDS 专属 Tabs 控制器：

```typescript
@State private bottomInsetVp: number = 0;
@State private selectedTabIndex: number = 0;
private readonly tabsController: HdsTabsController = new HdsTabsController();
```

### 第二步：生命周期读取底部避让高度

在 `aboutToAppear()` 中动态读取底部安全区避让高度：

```typescript
aboutToAppear(): void {
  // ... 其他初始化 ...
  this.readBottomInset();
}

private readBottomInset(): void {
  const uiCtx = this.getUIContext();
  if (!uiCtx) {
    return;
  }
  const hostCtx = uiCtx.getHostContext();
  if (!hostCtx) {
    return;
  }
  // 强类型安全调用，获取底部导航指示条高度并转换为 vp
  window.getLastWindow(hostCtx).then((lastWindow: window.Window): void => {
    const avoidArea: window.AvoidArea = lastWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);
    this.bottomInsetVp = uiCtx.px2vp(avoidArea.bottomRect.height);
  }).catch((_err: Error): void => {
    this.bottomInsetVp = 0;
  });
}
```

### 第三步：布局配置与属性应用

```typescript
HdsTabs({ barPosition: BarPosition.End, controller: this.tabsController }) {
  TabContent() {
    Scroll() {
      Column() {
        // 页面实际内容组件
      }
      .width('100%')
      .padding({
        left: 16,
        right: 16,
        top: NGF_MAIN_MENU_CONTENT_TOP_INSET,
        bottom: 76 // 必须：底部留白，保证内容滚出浮动 TabBar
      })
    }
    .width('100%')
    .height('100%')
    .scrollBar(BarState.Off)
    .edgeEffect(EdgeEffect.Spring)
    .backgroundColor($r('app.color.background_transparent'))
  }
  .tabBar(this.buildTabItem($r('app.string.tab_framework'), 'sys.symbol.house', 0))

  // ... 其它 TabContent 节点 ...
}
.width('100%')
.height('100%')
.barMode(BarMode.Fixed)
.barOverlap(true) // 必须：内容延伸到底部，支撑毛玻璃融合
.barFloatingStyle({
  adaptToHandedness: true, // 握持感自适应
  systemMaterialEffect: {
    materialType: hdsMaterial.MaterialType.IMMERSIVE,
    materialLevel: hdsMaterial.MaterialLevel.EXQUISITE // 精美材质
  },
  thermoCtrl: true,
  barOpacity: 0.95,
  barBottomMargin: this.bottomInsetVp // 关键：动态底部避让边距
})
.scrollable(true)
.onChange((index: number): void => {
  this.selectedTabIndex = index;
})
```

---

## 3. HdsTabs 特效与关键属性速查

| 属性 | 类型 | 推荐配置 / 作用 |
|------|------|----------------|
| `barOverlap` | `boolean` | `true`。必须开启，否则 TabContent 无法沉浸到 TabBar 下方，毛玻璃效果会变成实色背景。 |
| `barMode` | `BarMode` | `BarMode.Fixed`。均分底部导航栏宽度。 |
| `barFloatingStyle.systemMaterialEffect.materialType` | `hdsMaterial.MaterialType` | `hdsMaterial.MaterialType.IMMERSIVE` 沉浸材质。 |
| `barFloatingStyle.systemMaterialEffect.materialLevel` | `hdsMaterial.MaterialLevel` | `EXQUISITE` (精美，主入口页推荐) / `ADAPTIVE` (自适应，常规页推荐)。 |
| `barFloatingStyle.barOpacity` | `number` | `0.92 ~ 0.95`。过低会导致底部内容字迹重叠影响阅读，过高失去透明质感。 |
| `barFloatingStyle.barBottomMargin` | `number` | 绑定 `bottomInsetVp`。避免 TabBar 贴在最底端。 |

---

## 4. 常见错误模式与避坑指南

### ❌ 错误做法：直接在页面容器或 Tab 容器上设置安全区忽略
- **现象**：在 `HdsTabs` 上加 `.expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])`。
- **问题**：这会导致 `HdsTabs` 内部布局定位混乱，甚至导致滚动容器内的手势在安全区失效，或 TabBar 被强行拉伸变形。
- **正确做法**：不使用根节点安全区强制拉伸，仅通过 `barBottomMargin` 来移动浮动的 TabBar，内容沉浸通过 `barOverlap(true)` 解决。

### ❌ 错误做法：动态读取底部避让高度时使用 dynamic any 或 dynamic index
- **现象**：`window.getLastWindow(ctx as any)` 或通过 `globalThis` 取 window 实例。
- **问题**：违反 ArkTS 类型安全规范，导致编译报错或运行时崩溃。
- **正确做法**：使用 `this.getUIContext().getHostContext()`，显式进行 `null` 校验。

### ❌ 错误做法：未在 TabContent 容器底部预留 padding
- **现象**：内容底部的按钮、说明文本滚到最下方时，依然叠在 TabBar 底下点不到。
- **问题**：`padding.bottom` 为 0 或数值小于 TabBar 自身高度（约 56vp）。
- **正确做法**：设置内容容器的 `padding.bottom` 至少为 `76vp`（TabBar 自身高度约 `56vp` + 浮动间距/底边距）。

---

## 5. 关键文件路径速查

| 文件 | 说明 |
|------|------|
| `entry/src/main/ets/pages/ngf/MainMenuPage.ets` | 根导航主页，已配置标准的 `bottomInsetVp` 避让与 `barBottomMargin` 样式。 |
| `entry/src/main/ets/pages/ngf/HdsIntegratedShowcasePage.ets` | 综合示例页，内含多处 `HdsTabs` 布局。 |
| `ngf_framework/src/main/ets/uiShell/components/NGFHdsTabsFactory.ets` | HdsTabs 通用封装工厂类。 |
