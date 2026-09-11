# 技能：极速页面脚手架 (Page Scaffolding)

**适用场景**：用户发出“新建一个页面”、“生成一个带标题栏的页面”、“创建一个关于XXX的界面”等页面搭建指令时，Agent 应直接套用本规则中的模版生成，无需再拼凑旧代码或查阅多个规则文件。

**自动触发条件（满足任意一条即应主动阅读本文件）**：
- 收到明确的“生成页面”、“新建路由”、“脚手架页面”等指令。
- 任务涉及从零开始创建一个新的完整的、符合 HDS 标准的页面。

---

## 1. 自动注册路由常量
在新建页面前，首先打开并修改 `entry/src/main/ets/pages/ngf/HdsDemoRoutes.ets`：
```typescript
export class NGFHdsDemoRouteName {
  // 追加全小写带下划线的路由常量
  static readonly YOUR_FEATURE_PAGE: string = 'ngf_your_feature_page';
}
```

## 2. 极速生成页面文件模板

在 `entry/src/main/ets/pages/ngf/` 目录下创建对应的页面文件（如 `YourFeaturePage.ets`），直接使用以下完整代码骨架替换：

```typescript
import { HdsNavDestination, hdsMaterial } from '@kit.UIDesignKit';
import { 
  NGFHdsTitleBarOptionsFactory,
  NGFImmersiveTopChromeUnderlay,
  NGFImmersiveTopChromePresetFactory,
  NGFPageWindowSupport
} from 'ngf_framework';

const TAG: string = 'YourFeaturePage';
const PAGE_UNDERLAY_HEIGHT: number = 168;

@Component
export struct YourFeaturePage {
  @State private pathStack: NavPathStack = new NavPathStack();
  @State private topInsetVp: number = 108; // 默认顶部安全区高度
  private readonly scroller: Scroller = new Scroller();

  aboutToAppear(): void {
    // 动态获取状态栏高度，保证全面屏自适应
    NGFPageWindowSupport.loadDynamicTopInset(this.getUIContext(), 108, 108, (inset) => {
      this.topInsetVp = inset;
    });
  }

  build() {
    HdsNavDestination() {
      Stack({ alignContent: Alignment.TopStart }) {
        // 1. 沉浸式顶部底板（光效引擎）
        NGFImmersiveTopChromeUnderlay({
          spec: NGFImmersiveTopChromePresetFactory.build(
            '#07101E', '#0C2341', '#0A1626', '#2854F0E8', '#32A4F2D8', PAGE_UNDERLAY_HEIGHT
          )
        })

        // 2. 页面主内容区
        Scroll(this.scroller) {
          Column({ space: 16 }) {
            
            // ================== TODO: 在此处填入你的具体业务组件 ==================
            Text('Hello, Feature Page!')
              .fontColor($r('app.color.font_primary'))
              .fontSize(16)
            // ======================================================================

          }
          .width('100%')
          // 必须预留 top padding 避开状态栏和标题栏遮挡
          .padding({ left: 16, right: 16, top: this.topInsetVp, bottom: 32 })
        }
        .width('100%')
        .height('100%')
        .scrollBar(BarState.Off)
        .edgeEffect(EdgeEffect.Spring)
        // 必须绑定滚动，激活标题栏材质的光晕联动
        .nestedScroll({ scrollForward: NestedScrollMode.PARENT_FIRST, scrollBackward: NestedScrollMode.SELF_FIRST })
      }
      .width('100%')
      .height('100%')
    }
    // 3. 配置 HDS 顶栏参数
    .titleBar(NGFHdsTitleBarOptionsFactory.build(
      '主标题',                          // mainTitle
      '副标题（可选）',                   // subTitle
      $r('app.color.background_primary'), // backgroundColor
      hdsMaterial.MaterialLevel.EXQUISITE, // materialLevel
      true,   // avoidLayoutSafeArea
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

## 3. 自动注入路由分发器

最后，自动打开 `entry/src/main/ets/pages/ngf/MainMenuPage.ets`：
1. 在文件顶部引入你刚刚建好的页面 `import { YourFeaturePage } from './YourFeaturePage';`
2. 找到 `@Builder buildNavDestination(name: string, param: Object)` 方法。
3. 在里面追加 `if (name === NGFHdsDemoRouteName.YOUR_FEATURE_PAGE) { YourFeaturePage() }`。

## 4. 验证检查点

生成完成后，请自我检查：
- [ ] 页面是否基于 `HdsNavDestination` 包裹？
- [ ] 是否正确通过 `'ngf_framework'` 导入了组件工厂？
- [ ] 是否在内容容器的 `padding.top` 中使用了 `this.topInsetVp` 动态避让变量？
- [ ] 是否已经在 `MainMenuPage` 完成了路由分发？
