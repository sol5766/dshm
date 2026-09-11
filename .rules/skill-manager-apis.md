# 技能：框架管理器 API

**适用场景**：需要在页面中读取或响应以下能力时，按本技能的标准模式接入，不要自行实现：
- **主题**（深色/浅色/自动）
- **语言/国际化**（多语言切换、相对时间格式化）
- **视效等级**（材质档位、沉浸式支持检测）
- **握持感知**（左手/右手/双手握持侧推断）

**自动触发条件（满足任意一条即应主动阅读本文件）**：
- 任务涉及主题切换、深色模式响应、`ngf_is_dark_mode` / `ngf_current_theme` 相关逻辑
- 任务涉及语言切换、`ngf_current_locale`、`resolveResourceString`、`ngfI18nManagerFacade`
- 任务涉及视效/材质档位读取或设置、`ngfVisualEffectsFacade`、`hdsMaterial.MaterialLevel`
- 任务涉及握持感知、`ngf_holding_awareness_*` 相关 Key、`ngfHoldingAwarenessFacade`
- 任务需要在 `aboutToAppear`/`aboutToDisappear` 中订阅或取消管理器回调
- 任务需要向页面组件传递 `@StorageProp` 绑定的框架状态

---

## 1. 总体原则

- **读取实时状态**：优先用 `@StorageProp(key)` 响应式绑定 AppStorage，不要在 `aboutToAppear` 里读一次快照就不再更新。
- **订阅变更通知**：需要在状态变化时执行逻辑（而不只是刷新 UI）时，用各管理器的 `addListener/onThemeChanged` 系列接口，并在 `aboutToDisappear` 中对称取消。
- **写操作**：通过 Facade 单例的方法发起，不要直接操作 AppStorage 写入管理器的 key。
- **导入路径**：应用层统一从 `ngf_framework` 包导入公开 Facade、契约与工具，不要从业务层重新封装一层，也不要再使用历史 `Framework/NGF/` 路径。

---

## 2. 主题管理（ThemeManagerFacade）

### 2.1 AppStorage Keys（用于 @StorageProp 响应式绑定）

| Key | 类型 | 说明 |
|-----|------|------|
| `'ngf_current_theme'` | `string` | 当前主题覆盖：`'auto'` / `'light'` / `'dark'` |
| `'ngf_is_dark_mode'` | `boolean` | 当前是否为深色模式（已综合系统状态） |
| `'ngf_system_color_mode'` | `number` | 系统颜色模式原始值 |

### 2.2 导入

```typescript
import { NGFThemeMode, ngfThemeManagerFacade } from 'ngf_framework';
```

### 2.3 标准读取模式（响应式）

```typescript
@Component
struct MyPage {
  // UI 层响应式绑定，主题变化时自动重绘
  @StorageProp('ngf_current_theme') private currentTheme: string = 'auto';
  @StorageProp('ngf_is_dark_mode')  private isDarkMode: boolean = false;

  build() {
    Text('当前主题')
      .fontColor(this.isDarkMode ? '#FFFFFF' : '#000000')
  }
}
```

### 2.4 标准写操作（切换主题）

```typescript
import { ConfigurationConstant } from '@kit.AbilityKit';
import { uiContextManager } from 'ngf_framework';

// 切换主题（同时更新系统颜色模式）
private applyTheme(mode: NGFThemeMode): void {
  ngfThemeManagerFacade.setThemeOverride(mode);
  const context = uiContextManager.getFullAbilityContext();
  if (context) {
    if (mode === NGFThemeMode.DARK) {
      context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_DARK);
    } else if (mode === NGFThemeMode.LIGHT) {
      context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT);
    } else {
      context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
    }
  }
}
```

### 2.5 订阅主题变更回调

```typescript
private readonly onThemeChanged = (mode: NGFThemeMode): void => {
  // 执行主题变化后的逻辑（非 UI 重绘，UI 用 @StorageProp 即可）
  logger.info(TAG, `主题已变更为: ${mode}`);
};

aboutToAppear(): void {
  ngfThemeManagerFacade.onThemeChanged(this.onThemeChanged);
}

aboutToDisappear(): void {
  ngfThemeManagerFacade.offThemeChanged(this.onThemeChanged);
}
```

### 2.6 可用方法速查

| 方法 | 说明 |
|------|------|
| `getCurrentTheme(): NGFThemeMode` | 读取当前主题设置 |
| `setThemeOverride(mode)` | 写入主题覆盖（同步到 AppStorage） |
| `clearThemeOverride()` | 清除覆盖，恢复 AUTO |
| `isDarkMode(): boolean` | 判断当前是否深色模式 |
| `onThemeChanged(cb)` / `offThemeChanged(cb)` | 订阅/取消主题变更回调 |

---

## 3. 语言与国际化管理（I18nManagerFacade）

### 3.1 AppStorage Keys

| Key | 类型 | 说明 |
|-----|------|------|
| `'ngf_current_locale'` | `string` | 当前语言覆盖：`''`（系统）/ `'zh-Hans'` / `'en'` / `'ja'` |

### 3.2 导入

```typescript
import { ngfI18nManagerFacade, resolveResourceString } from 'ngf_framework';
```

### 3.3 标准读取模式

```typescript
@Component
struct MyPage {
  @StorageProp('ngf_current_locale') private currentLocale: string = '';

  build() {
    Text(this.currentLocale === 'zh-Hans' ? '中文模式' : 'Other locale')
  }
}
```

### 3.4 标准写操作（切换语言）

```typescript
private applyLanguage(locale: string): void {
  if (locale.length > 0) {
    ngfI18nManagerFacade.setLocaleOverride(locale);  // 设置特定语言
  } else {
    ngfI18nManagerFacade.clearLocaleOverride();       // 恢复系统语言
  }
}
```

### 3.5 相对时间格式化（RelativeTimeFormatterFacade）

```typescript
import { ngfRelativeTimeFormatterFacade } from 'ngf_framework';

// 格式化时间差（毫秒）为可读字符串，自动跟随当前语言
const label = ngfRelativeTimeFormatterFacade.format(Date.now() - targetTimestamp);
// 输出示例（中文）："3分钟前"
// 输出示例（英文）："3 minutes ago"
```

### 3.6 ResourceStr 转字符串（需要 context 的场景）

```typescript
// 当需要把 $r('app.string.xxx') 传给非 UI 的 API（如日志）时
const str = resolveResourceString(this.getUIContext().getHostContext(), $r('app.string.my_key'));
```

---

## 4. 视觉效果管理（VisualEffectsFacade）

### 4.1 AppStorage Keys

| Key | 类型 | 说明 |
|-----|------|------|
| `'ngf_visual_effects_material_mode'` | `string` | 当前模式：`'adaptive'` / `'manual'` |
| `'ngf_visual_effects_effective_material_level'` | `number` | 生效的材质档位（hdsMaterial.MaterialLevel 枚举值） |
| `'ngf_visual_effects_supports_immersive'` | `boolean` | 当前设备是否支持沉浸式材质 |
| `'ngf_visual_effects_recommended_manual_level'` | `number` | 系统推荐的手动档位 |

### 4.2 导入

```typescript
import { NGFVisualEffectsMaterialMode, ngfVisualEffectsFacade } from 'ngf_framework';
import { hdsMaterial } from '@kit.UIDesignKit';
```

### 4.3 标准读取模式（响应式）

```typescript
@Component
struct MyPage {
  @StorageProp('ngf_visual_effects_effective_material_level')
  private effectiveMaterialLevel: number = hdsMaterial.MaterialLevel.ADAPTIVE;

  @StorageProp('ngf_visual_effects_supports_immersive')
  private supportsImmersive: boolean = false;

  build() {
    // 动态传入顶栏材质档位
    // NGFHdsTitleBarOptionsFactory.build(..., this.effectiveMaterialLevel as hdsMaterial.MaterialLevel, ...)
  }
}
```

### 4.4 标准写操作

```typescript
// 切换为自适应模式（推荐默认）
await ngfVisualEffectsFacade.setMaterialMode(NGFVisualEffectsMaterialMode.ADAPTIVE);

// 切换为手动固定档位
await ngfVisualEffectsFacade.setMaterialMode(NGFVisualEffectsMaterialMode.MANUAL);
await ngfVisualEffectsFacade.setManualMaterialLevel(hdsMaterial.MaterialLevel.EXQUISITE);

// 重置为推荐默认
await ngfVisualEffectsFacade.resetToRecommended();
```

### 4.5 订阅视效状态变化

```typescript
import { NGFVisualEffectsState } from 'ngf_framework';

private readonly onVisualEffectsChanged = (state: NGFVisualEffectsState): void => {
  // state.effectiveMaterialLevel、state.capability.supportsImmersiveMaterial 等
  logger.info(TAG, `视效状态变化：level=${state.effectiveMaterialLevel}`);
};

aboutToAppear(): void {
  ngfVisualEffectsFacade.addListener(this.onVisualEffectsChanged);
}

aboutToDisappear(): void {
  ngfVisualEffectsFacade.removeListener(this.onVisualEffectsChanged);
}
```

### 4.6 MaterialLevel 枚举值对照

| 枚举成员 | 数值 | 含义 |
|---------|------|------|
| `hdsMaterial.MaterialLevel.EXQUISITE` | 3 | 精美（最高档，需设备支持沉浸式） |
| `hdsMaterial.MaterialLevel.GENTLE`   | 2 | 轻柔 |
| `hdsMaterial.MaterialLevel.SMOOTH`   | 1 | 流畅（最低档，所有设备可用） |
| `hdsMaterial.MaterialLevel.ADAPTIVE` | 0 | 系统自适应（推荐） |

---

## 5. 握持感知管理（HoldingAwarenessFacade）

### 5.1 AppStorage Keys

| Key | 类型 | 说明 |
|-----|------|------|
| `'ngf_holding_awareness_preferred_anchor'` | `string` | 推荐 UI 停靠侧：`'left'` / `'right'` |
| `'ngf_holding_awareness_side'` | `string` | 握持侧：`'left'` / `'right'` / `'both'` / `'none'` / `'unknown'` |
| `'ngf_holding_awareness_available'` | `boolean` | 握持感知功能是否可用 |
| `'ngf_holding_awareness_confidence'` | `string` | 置信度：`'exact'` / `'inferred'` / `'fallback'` |
| `'ngf_holding_awareness_detect_gesture_granted'` | `boolean` | DETECT_GESTURE 权限是否授予 |
| `'ngf_holding_awareness_activity_motion_granted'` | `boolean` | ACTIVITY_MOTION 权限是否授予 |

### 5.2 导入

```typescript
import { 
  NGFHoldingUiAnchor, 
  NGFHoldingAwarenessSide, 
  NGFHoldingAwarenessSnapshot, 
  NGFHoldingAwarenessListener
} from 'ngf_framework';
import { ngfHoldingAwarenessFacade } from 'ngf_framework';
```

### 5.3 标准读取模式（响应式）

```typescript
@Component
struct MyPage {
  @StorageProp('ngf_holding_awareness_preferred_anchor')
  private preferredAnchor: string = NGFHoldingUiAnchor.RIGHT;

  @StorageProp('ngf_holding_awareness_available')
  private holdingAvailable: boolean = false;

  build() {
    // 根据推荐停靠侧调整布局
    Row() {
      if (this.preferredAnchor === NGFHoldingUiAnchor.LEFT) {
        // 左手友好布局：主操作区靠左
        this.buildActionArea()
        this.buildInfoArea()
      } else {
        // 右手友好布局（默认）
        this.buildInfoArea()
        this.buildActionArea()
      }
    }
  }
}
```

### 5.4 订阅握持状态变更（需要执行逻辑时）

```typescript
private readonly holdingListener: NGFHoldingAwarenessListener =
  (snapshot: NGFHoldingAwarenessSnapshot): void => {
    // snapshot.preferredAnchor / .side / .confidence 等
    // 注意：UI 重绘用 @StorageProp 即可，此回调适合做动画、音效、自动布局切换等副作用
    logger.info(TAG, `握持侧变更：${snapshot.side}，推荐停靠：${snapshot.preferredAnchor}`);
  };

aboutToAppear(): void {
  // 初始化（需已在 EntryAbility 中完成，此处仅备用 resume）
  // void ngfHoldingAwarenessFacade.initialize();
  ngfHoldingAwarenessFacade.addListener(this.holdingListener);
}

aboutToDisappear(): void {
  ngfHoldingAwarenessFacade.removeListener(this.holdingListener);
}
```

### 5.5 权限申请（ACTIVITY_MOTION，增强操作手感知）

```typescript
// 通常在设置页或引导页中调用，需要 UIAbilityContext
private async requestOperatingHandPermission(): Promise<void> {
  const granted = await ngfHoldingAwarenessFacade.requestActivityMotionPermission(
    this.getUIContext().getHostContext()
  );
  logger.info(TAG, `ACTIVITY_MOTION 权限申请结果: ${granted}`);
}
```

> **注意**：`DETECT_GESTURE` 权限为预授权权限，随应用安装自动获得，无需弹窗申请。只有 `ACTIVITY_MOTION` 需要弹窗。

---

## 6. 组合使用示例

在同一页面同时响应主题 + 握持侧：

```typescript
@Component
struct MyAdaptivePage {
  // 主题
  @StorageProp('ngf_is_dark_mode') private isDarkMode: boolean = false;
  // 握持
  @StorageProp('ngf_holding_awareness_preferred_anchor') private preferredAnchor: string = 'right';
  // 视效
  @StorageProp('ngf_visual_effects_effective_material_level') private materialLevel: number = 0;

  build() {
    Stack() {
      // 背景随主题
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(this.isDarkMode ? '#1A1A1A' : '#F5F5F5')

      // 操作按钮随握持侧停靠
      Button('主操作')
        .position({
          x: this.preferredAnchor === 'left' ? 16 : undefined,
          right: this.preferredAnchor === 'right' ? 16 : undefined,
          bottom: 40
        })
        .animation({ duration: 300, curve: Curve.EaseOut })
    }
  }
}
```

---

## 7. 关键文件路径速查

| 文件 | 说明 |
|------|------|
| `ngf_framework/src/main/ets/uiTheme/facades/ThemeManagerFacade.ets` | `ngfThemeManagerFacade` |
| `ngf_framework/src/main/ets/uiTheme/contracts/IThemeManager.ets` | `NGFThemeMode` 枚举 |
| `ngf_framework/src/main/ets/i18n/facades/I18nManagerFacade.ets` | `ngfI18nManagerFacade` |
| `ngf_framework/src/main/ets/i18n/facades/RelativeTimeFormatterFacade.ets` | `ngfRelativeTimeFormatterFacade` |
| `ngf_framework/src/main/ets/i18n/index.ets` | `resolveResourceString` |
| `ngf_framework/src/main/ets/deviceAwareness/facades/VisualEffectsFacade.ets` | `ngfVisualEffectsFacade` |
| `ngf_framework/src/main/ets/deviceAwareness/contracts/IVisualEffectsManager.ets` | `NGFVisualEffectsMaterialMode`、`NGFVisualEffectsState` |
| `ngf_framework/src/main/ets/deviceAwareness/facades/HoldingAwarenessFacade.ets` | `ngfHoldingAwarenessFacade` |
| `ngf_framework/src/main/ets/deviceAwareness/contracts/IHoldingAwarenessManager.ets` | `NGFHoldingUiAnchor`、`NGFHoldingAwarenessSide`、`NGFHoldingAwarenessSnapshot` |
| `pages/ngf/NGFSettingsPage.ets` | 综合使用示例参考 |
| `pages/ngf/NGFDeviceAwarenessPage.ets` | 握持感知详细演示参考 |
