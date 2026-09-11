# 技能：ArkTS 编译错误修复

**适用场景**：编译失败或修复 ArkTS 类型错误时；涉及 ArkTS 编译报错、类型不匹配、构建错误。

**自动触发条件（满足任意一条即应主动阅读本文件）**：
- 编译失败、ArkTS 类型错误、Hvigor/构建报错。
- 报错涉及 Notification、Window、AppStorage、IDataSource、Resource、对象字面量、catch、null 安全等常见类型问题。
- 用户要求解释或修复构建日志、编译日志、IDE 报错。

---

## 1. 错误快速参考表

| 错误类型 | 解决方案 |
|----------|---------|
| Notification 类型错误 | 将 ContentType 转换为 `number` 类型 |
| Window 类型错误 | 对 `getLastWindow` 使用回调模式 |
| AppStorage 类型错误 | 使用 `@StorageLink` + `LocalStorage` 或 `AppStorage.setAndLink`（避免 `setOrCreate`） |
| 对象展开类型错误 | 显式类型化对象 |
| @StorageLink 默认值错误 | 添加 `= undefined` 或具体默认值 |
| 对象字面量接口错误 | 在使用对象字面量前定义 interface |
| 对象字面量类型错误 | 定义 interface 并用作返回类型 |
| 函数返回类型错误 | 添加显式返回类型注解 |
| 箭头函数转换错误 | 将 `function` 转换为箭头函数 `=>` |
| Color 属性错误 | 使用十六进制颜色值代替不存在的 Color 属性 |
| 接口方法签名错误 | 使用属性语法 `method: () => {}` 代替方法语法 |
| AvoidArea 类型错误 | 添加 `visible: false` 属性 |
| 独立函数 `this` 错误 | 将 context 作为参数传递 |
| TitleButtonRect 类型错误 | 使用 `window.TitleButtonRect`；仅 `width` 和 `height` 属性可用 |
| Catch 子句类型错误 | 移除类型注解或使用 `any`/`unknown` |
| ESObject 类型错误 | 使用 `ESModule` 或具体类型 |
| Resource 转换错误 | 在 UI 组件中直接使用 Resource 或使用 ResourceManager |
| 未使用变量警告 | 使用 console.info/hilog 或删除未使用变量 |
| IDataSource 类型错误 | 为 LazyForEach 实现 IDataSource 接口 |
| 重复 Entry 错误 | 移除多余的 @Entry，子组件使用 @Component |
| 可能为 null 错误 | 使用 `!== null` 检查或可选链 |

## 2. 高频错误详细修复

### 2.1 Notification API 类型错误

**错误**：`notificationManager.ContentType` 类型不兼容

**修复**：将 ContentType 值转换为 `number` 类型

```typescript
let notificationRequest: notificationManager.NotificationRequest = {
  id: 1,
  content: {
    contentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT as number,
    normal: { title: '标题', text: '内容' }
  }
}
```

### 2.2 Window API 类型错误

**错误**：`window.getLastWindow` 类型推断问题

**修复**：使用回调模式代替 async/await

```typescript
window.getLastWindow(context, (err, win) => {
  if (err.code !== 0) {
    console.error('Failed to get window:', err)
    return
  }
  // 使用 window 实例
})
```

### 2.3 AppStorage 类型错误

**修复**：使用 `@StorageLink` 装饰器

```typescript
@Entry
@Component
struct MyComponent {
  @StorageLink('myKey') myValue: number = 0

  aboutToAppear() {
    AppStorage.setOrCreate('myKey', 0)
  }
}
```

### 2.4 对象字面量接口错误

**错误**：`Object literal must correspond to some explicitly declared class or interface`

**修复**：先定义 interface

```typescript
interface Article {
  title: string
  desc: string
  image: Resource
}

private articles: Article[] = [
  { title: '文章1', desc: '描述', image: $r('app.media.icon') }
]
```

### 2.5 Catch 子句类型错误

**错误**：`Catch clause variable type annotation must be 'any' or 'unknown'`

**修复**：移除类型注解

```typescript
// 错误
catch (error: Error) { ... }

// 正确
catch (error) { ... }
```

### 2.6 IDataSource 类型错误

**错误**：`Argument of type 'string[]' is not assignable to parameter of type 'IDataSource'`

**修复**：实现 `IDataSource` 接口

```typescript
class MyDataSource {
  data: string[] = []
  private listeners: DataChangeListener[] = []

  totalCount(): number { return this.data.length }
  getData(index: number): string { return this.data[index] }

  registerDataChangeListener(listener: DataChangeListener): void {
    this.listeners.push(listener)
  }
  unregisterDataChangeListener(listener: DataChangeListener): void {
    const index = this.listeners.indexOf(listener)
    if (index > -1) { this.listeners.splice(index, 1) }
  }

  pushData(data: string): void {
    this.data.push(data)
    this.listeners.forEach((listener: DataChangeListener) => {
      listener.onDataAdd(this.data.length - 1)
    })
  }
}
```

### 2.7 Resource 类型转换错误

**错误**：不能将 `Resource` 类型直接转换为 `string` 或 `number`

**修复**：在 UI 组件中直接使用 Resource，或使用 ResourceManager 获取值

```typescript
// 直接在 UI 组件中使用（推荐）
Text($r('app.string.hello'))
  .fontSize($r('app.float.title_font_size'))

// 需要字符串值时
const manager = context.resourceManager
const text: string = await manager.getString($r('app.string.hello').id)
```

### 2.8 可能为 null 错误

**修复**：使用 `!== null` 检查

```typescript
// 正确
let display = display.getDefaultDisplaySync()
if (display !== null) {
  console.log(display.width)
}
```

## 3. ArkTS 项目构建失败诊断规则

- 聚焦包含 `ERROR` 的行，忽略 `WARN` 除非相关
- 常见错误分类：
  - **类型错误**：ArkTS 严格类型检查失败，添加显式类型或移除不安全转换
  - **导入错误**：缺少模块或导入路径错误，检查 `oh-package.json5` 依赖
  - **资源错误**：`resources/` 目录中缺失或命名错误的资源
  - **权限错误**：`module.json5` 中未声明的权限
  - **SDK 版本错误**：API level 不匹配，检查 `build-profile.json5` 中的 `compileSdkVersion`
- 修复错误后，再次运行 `build_project`
- 如果增量构建意外失败，建议删除 `.hvigor` 和 `build` 目录进行干净构建
