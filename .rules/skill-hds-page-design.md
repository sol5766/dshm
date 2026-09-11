# 技能：HDS 页面设计

**适用场景**：在 `pages/ngf/` 下新建展示页、功能演示页或框架验证页时，确保沉浸式顶栏、安全区、光效/材质等遵循项目已有模式。

**自动触发条件（满足任意一条即应主动阅读本文件）**：
- 任务涉及新建页面文件（`.ets`）到 `pages/ngf/` 目录
- 任务涉及 `HdsNavDestination`、`HdsNavigation` 相关布局
- 任务涉及顶栏配置、沉浸式底板、安全区、顶部 padding 设置
- 任务涉及 `NGFHdsTitleBarOptionsFactory`、`NGFImmersiveTopChromeUnderlay` 等 uiShell 组件
- 任务涉及 `HdsDemoRoutes.ets` 路由常量注册或 `buildNavDestination` 分发

---

## 1. 背景：项目 HDS 页面两种形态

### 形态 A：根导航页（HdsNavigation）

`MainMenuPage` 使用 `HdsNavigation` 作为根容器，特征：
- `@Entry` + `@Component`，注册到 `main_pages.json`
- 使用 `NavPathStack` 管理子路由
- `HdsNavigation` 承载顶栏 + 全局路由容器
- 顶栏通过 `NGFHdsTitleBarOptionsFactory.build(...)` 配置

### 形态 B：子路由目标页（HdsNavDestination）

`HdsNavigationOfficialShowcasePage`、`HdsIntegratedShowcasePage` 等子页面，特征：
- `@Component`（不是 `@Entry`），在 `buildNavDestination` Builder 中 by-name 注册
- 使用 `HdsNavDestination` 作为根容器
- 路由名称在 `HdsDemoRoutes.ets` 的 `NGFHdsDemoRouteName` 中注册为常量

---

## 2. 新增子路由页面标准流程

### 第一步：注册路由常量

在 `HdsDemoRoutes.ets` 中追加：

```typescript
// entry/src/main/ets/pages/ngf/HdsDemoRoutes.ets
export class NGFHdsDemoRouteName {
  // ...现有路由...
  static readonly MY_NEW_PAGE: string = 'ngf_my_new_page'; // 全小写+下划线
}
```

### 第二步：创建页面文件

```typescript
// entry/src/main/ets/pages/ngf/MyNewPage.ets
import { HdsNavDestination } from '@kit.UIDesignKit';
import { hdsMaterial } from '@kit.UIDesignKit';
import { 
  NGFHdsTitleBarOptionsFactory,
  NGFImmersiveTopChromeUnderlay,
  NGFImmersiveTopChromePresetFactory
} from 'ngf_framework';

const TAG: string = 'MyNewPage';
// 顶部底板高度（参考 MainMenuPage 的常量）
const MY_PAGE_UNDERLAY_HEIGHT: number = 168;

@Component
export struct MyNewPage {
  @State private pathStack: NavPathStack = new NavPathStack();
  @State private topInsetVp: number = 108; // 默认避让值，aboutToAppear中动态计算
  private readonly scroller: Scroller = new Scroller();

  aboutToAppear(): void {
    NGFPageWindowSupport.loadDynamicTopInset(this.getUIContext(), 108, 108, (inset) => {
      this.topInsetVp = inset;
    });
  }

  build() {
    HdsNavDestination() {
      Stack({ alignContent: Alignment.TopStart }) {
        // 1. 沉浸式顶部底板（延伸到系统状态栏）
        NGFImmersiveTopChromeUnderlay({
          spec: NGFImmersiveTopChromePresetFactory.build(
            '#07101E',   // gradientStart
            '#0C2341',   // gradientMid
            '#0A1626',   // gradientEnd
            '#2854F0E8', // primaryGlowColor
            '#32A4F2D8', // secondaryGlowColor
            MY_PAGE_UNDERLAY_HEIGHT
          )
        })

        // 2. 页面主内容（顶部 padding 等于 contentTopInset）
        Scroll(this.scroller) {
          Column({ space: 16 }) {
            // 页面实际内容
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: this.topInsetVp, bottom: 32 })
        }
        .width('100%')
        .height('100%')
        .scrollBar(BarState.Off)
        .edgeEffect(EdgeEffect.Spring)
        // 3. 将 Scroller 绑定到 HDS 导航容器（必须，否则顶栏光效无法感知滚动）
        .nestedScroll({ scrollForward: NestedScrollMode.PARENT_FIRST, scrollBackward: NestedScrollMode.SELF_FIRST })
      }
      .width('100%')
      .height('100%')
    }
    // 4. 顶栏配置
    .titleBar(NGFHdsTitleBarOptionsFactory.build(
      '页面标题',                          // mainTitle
      '副标题（可选）',                     // subTitle
      $r('app.color.background_primary'), // backgroundColor
      hdsMaterial.MaterialLevel.EXQUISITE, // materialLevel
      true,   // avoidLayoutSafeArea：顶栏避让系统状态栏
      false   // enableComponentSafeArea
    ))
    .navDestination(this.pathStack)
    .ignoreLayoutSafeArea([LayoutSafeAreaType.SYSTEM], [LayoutSafeAreaEdge.TOP])
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.background_primary'))
  }
}
```

### 第三步：在 MainMenuPage 的 buildNavDestination 中注册

```typescript
// MainMenuPage.ets — buildNavDestination Builder 内部追加
if (name === NGFHdsDemoRouteName.MY_NEW_PAGE) {
  MyNewPage()
}
```

并在文件顶部添加导入：

```typescript
import { MyNewPage } from './MyNewPage';
```

---

## 3. 顶栏参数速查

### NGFHdsTitleBarOptionsFactory.build() 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `mainTitle` | `ResourceStr` | 主标题 |
| `subTitle` | `ResourceStr` | 副标题 |
| `backgroundColor` | `ResourceColor` | 顶栏背景色，通常用 `$r('app.color.background_primary')` |
| `materialLevel` | `hdsMaterial.MaterialLevel` | 材质档位，见下表 |
| `avoidLayoutSafeArea` | `boolean` | 顶栏是否避让系统状态栏，子页默认 `true` |
| `enableComponentSafeArea` | `boolean` | 通常 `false` |

### MaterialLevel 档位

| 枚举值 | 说明 | 适用场景 |
|--------|------|---------|
| `EXQUISITE` | 精美（最高档） | 主入口、重点展示页 |
| `GENTLE` | 轻柔 | 一般功能页 |
| `SMOOTH` | 流畅（最低档） | 低性能设备降级 |
| `ADAPTIVE` | 系统自适应 | 跟随 `ngfVisualEffectsFacade` 的 effectiveMaterialLevel |

---

## 4. 沉浸式底板颜色预设参考

参照 `MainMenuPage` 的深蓝色系：

```typescript
// 深蓝系（默认推荐）
gradientStart: '#07101E'
gradientMid:   '#0C2341'
gradientEnd:   '#0A1626'
primaryGlowColor:   '#2854F0E8'  // 蓝色光晕
secondaryGlowColor: '#32A4F2D8'  // 青色光晕
```

颜色变更只需修改这五个值，光效强度（`effectRadius/Saturation/Brightness`）由 `NGFImmersiveTopChromePresetFactory` 统一管理，默认值已经过调优，非必要不改动。

---

## 5. 安全区处理规范

- **顶部延伸**：`NGFImmersiveTopChromeUnderlay` 内部已有 `.expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP])`，底板会自动延伸到状态栏。
- **HdsNavDestination 根节点**：`.ignoreLayoutSafeArea([LayoutSafeAreaType.SYSTEM], [LayoutSafeAreaEdge.TOP])` 允许内容延伸。
- **顶栏避让**：`avoidLayoutSafeArea = true` 让顶栏自身文字不被状态栏遮挡。
- **内容避让**：页面内容层的 `padding.top` 设为 `MY_PAGE_CONTENT_TOP_INSET`（约 92vp），不要 0。
- **底部安全**：滚动容器的 `padding.bottom` 设置适当值（含 NavBar 高度，通常 76vp）。

---

## 6. 常见错误模式

| 错误 | 原因 | 正确做法 |
|------|------|---------|
| 顶栏标题被状态栏遮挡 | `avoidLayoutSafeArea = false` | 子页设为 `true` |
| 顶栏光效（毛玻璃/光感）不生效 | 未将 Scroller 绑定 HDS 容器 | 加 `.nestedScroll(...)` |
| 页面内容顶部被顶栏遮挡 | content padding.top 为 0 | 设为 `contentTopInset`（≥ 92）|
| 底板不延伸到状态栏 | 未用 `NGFImmersiveTopChromeUnderlay` | 使用该组件替代自定义背景 |
| 路由跳转失败 | 路由名称未注册到 buildNavDestination | 在 `@Builder buildNavDestination` 中追加 `if` 分支 |

---

## 7. 关键框架组件速查（可从 `ngf_framework` 导入）

| 组件/工厂 | 说明 |
|------|------|
| `NGFHdsTitleBarOptionsFactory` | HDS 顶栏参数构建器 |
| `NGFImmersiveTopChromeUnderlay` | 沉浸式顶部底板光效组件 |
| `NGFImmersiveTopChromePresetFactory` | 底板预设光效构建器 |
| `NGFPageWindowSupport` | 窗口策略辅助类（支持动态获取状态栏高度） |

## 8. 关键业务文件路径速查

| 文件 | 说明 |
|------|------|
| `entry/src/main/ets/pages/ngf/HdsDemoRoutes.ets` | `NGFHdsDemoRouteName` 路由常量 |
| `entry/src/main/ets/pages/ngf/MainMenuPage.ets` | `buildNavDestination` Builder，新页面在此注册 |
| `entry/src/main/ets/pages/ngf/HdsIntegratedShowcasePage.ets` | 综合示例页，可参考布局模式 |
| `entry/src/main/ets/pages/ngf/HdsNavigationOfficialShowcasePage.ets` | 官方 HDS 示例，可参考 Material/Effect 用法 |
