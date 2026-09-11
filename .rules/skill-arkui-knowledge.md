# 技能：ArkUI 知识与组件规范

**适用场景**：回答 ArkUI UI 问题；编写/修改 ArkUI 组件、布局、状态驱动 UI、渲染控制、导航、对话框、交互、组件 API、`.ets` 文件中的声明式 UI。

**自动触发条件（满足任意一条即应主动阅读本文件）**：
- 编写或修改 ArkUI 声明式 UI、组件、布局、状态装饰器、渲染控制、导航、对话框、Toast 或交互。
- 修改 `.ets` 文件中的 `build()`、`@Builder`、`ForEach`、`Tabs`、`List`、`Grid`、`Button`、`Text` 等 UI 节点。
- 用户询问 ArkUI 组件 API、布局错位、状态不刷新、UI 不可见、点击无响应等问题。

---

## 1. 组件构造器防护

- `Tabs(options?)` 接受 `barPosition`、`index`、`controller` 等选项
- `TabContent()` 不接受对象参数；通过 `.tabBar(...)` 设置标签
- `List({ space })` 和 `Grid()` 包含所需的子组件
- `Row({ space })` 和 `Column({ space })` 在构造器中设置间距
- `Flex()` 不接受 `space` 选项；子组件使用 margin
- `Stack({ alignContent })` 控制堆叠对齐；不在其上使用 row/column 对齐方法

## 2. 修饰符名称

**必须使用完整 ArkUI 修饰符名称**：

| 正确 | 禁止（其他 UI 框架简写） |
|------|--------------------------|
| `.backgroundColor(...)` | bg, background-color |
| `.borderRadius(...)` | radius, br |
| `.fontSize(...)` | size, font-size |
| `.fontColor(...)` | color, font-color |
| `.fontWeight(...)` | weight |
| `.textAlign(...)` | align |
| `.objectFit(...)` | fit |
| `.textOverflow(...)` | overflow |

**禁止使用 CSS、Android 或其他 UI 框架的简写修饰符。**

## 3. 修饰符归属

- `Text` 拥有文本修饰符：`.fontSize()`、`.fontColor()`、`.fontWeight()`、`.textAlign()`、`.maxLines()`、`.textOverflow()`
- `Image` 拥有图片修饰符：`.objectFit()`
- `Column` 和 `Row` 拥有布局对齐，但枚举类型不同
- `Button` 标签样式通常在 `Button` 内放置样式化 `Text` 更清晰
- `List` 拥有列表级方向、边缘、分隔线和滚动行为；`ListItem` 拥有逐行内容

## 4. 参数和回调

- `margin` 和 `padding` 使用 number、string 或带边缘名称的对象；**禁止**多参数 CSS 样式简写
- `AlertDialog` 按钮条目使用 `{ value: '确定', action: () => {} }`，**禁止** `text` 字段
- `ActionSheet` 条目使用 `sheets`
- 弹窗状态变更回调接收可见性事件对象
- 事件回调参数类型应在推断不清晰时显式声明

## 5. 枚举和资源

- 使用精确大小写的 ArkUI 枚举名：`TextAlign.Center`、`FontWeight.Bold`、`BarPosition.End`
- 枚举预期位置**禁止**传递字符串值
- **禁止**猜测系统符号或系统颜色名称；使用已验证的名称

## 6. UIContext 敏感 API

当项目已使用 UIContext 时，遵循以下模式：

- Toast：`this.getUIContext().getPromptAction()`
- 对话框：`this.getUIContext().showAlertDialog(...)`
- 路由：`this.getUIContext().getRouter()`
- 动画：`this.getUIContext().animateTo(...)`

如果项目有路由/对话框/Toast/日志的封装，使用封装而非引入新模式。

## 7. 常见错误防护

### Tabs 和 TabContent

**禁止**：向 `TabContent` 传递带 builder 回调的对象参数

```typescript
// 正确
TabContent() {
  Column() {
    Text('首页')
  }
}
.tabBar('首页')
```

### ForEach 和 LazyForEach

- 键生成器必须返回**稳定的字符串**
- 业务数据**禁止**使用索引键（顺序可能变化）
- `LazyForEach` 需要真正的懒数据源，放在支持的滚动容器中

```typescript
// 正确
ForEach(this.items, (item: ItemInfo) => {
  Text(item.title)
}, (item: ItemInfo) => item.id)
```

### 状态装饰器

- `@State` 用于组件本地 V1 状态
- `@Prop` 用于父到子输入
- `@Link` 用于 V1 组件双向绑定
- `@Local` 和 `@Param` 属于 V2 组件
- **禁止**在同一个组件中混用 V1 和 V2 装饰器家族
- **禁止**将 `@State` 放在顶层变量、局部变量、普通类或组件输入上

### 对话框按钮

- Alert dialog 按钮标签字段是 `value`，**禁止**使用 `text`
- 取消行为仅关闭对话框，除非需求另有说明

## 8. 组件代码手册

### Tabs

```typescript
Tabs({ barPosition: BarPosition.End }) {
  TabContent() {
    Column() { Text('首页') }
  }.tabBar('首页')

  TabContent() {
    Column() { Text('发现') }
  }.tabBar('发现')
}
```

### List + ForEach

```typescript
interface CardItem {
  id: string
  title: string
}

@State cards: CardItem[] = [
  { id: 'card-1', title: '卡片 1' },
  { id: 'card-2', title: '卡片 2' }
]

Grid() {
  ForEach(this.cards, (item: CardItem) => {
    GridItem() { Text(item.title) }
  }, (item: CardItem) => item.id)
}
```

### TextInput + Button + 状态刷新

```typescript
@State userName: string = ''
@State errorText: string = ''

Column({ space: 12 }) {
  TextInput({ placeholder: '请输入用户名', text: this.userName })
    .onChange((value: string) => { this.userName = value })

  Button('注册')
    .onClick(() => {
      this.errorText = this.userName.length === 0 ? '请填写完整信息' : '注册成功'
    })

  Text(this.errorText)
    .fontColor(this.errorText === '注册成功' ? Color.Green : Color.Red)
}
```

### Dialog 和 Toast

```typescript
this.getUIContext().showAlertDialog({
  title: '确认操作？',
  message: '确认执行此操作？',
  primaryButton: {
    value: '确定',
    action: () => {
      this.getUIContext().getPromptAction().showToast({ message: '操作成功' })
    }
  },
  secondaryButton: { value: '取消', action: () => {} }
})
```

### Navigation + NavDestination

- 保持现有导航架构
- 已用 `Navigation` 时，通过现有 `NavPathStack` 或项目路由封装注册/路由到 `NavDestination`
- 使用自定义路由器时，遵循该封装和现有页面注册模式

## 9. UI 质量检查清单

修改 UI 后必须验证：

### 需求可见性

- [ ] 必需的标签、按钮文本、Tab 标签、卡片标题、对话框文本在目标屏幕上可见
- [ ] 文本未被遮罩、零尺寸容器、屏幕外放置或低对比度隐藏
- [ ] 首屏仍可从应用启动路径到达

### 交互

- [ ] 需求要求 `Button` 时使用 `Button` 组件
- [ ] 点击处理器更新可见状态、切换 Tab、打开对话框、导航或显示响应
- [ ] 取消和关闭操作不执行额外业务动作
- [ ] 点击目标足够大且视觉清晰

### 布局质量

- [ ] 新 UI 遵循附近间距、颜色、排版、密度和组件风格
- [ ] 布局嵌套仅足以表达 UI
- [ ] 动态文本、列表和 Tab 内容有稳定的宽度/高度约束
- [ ] 新元素不与现有 banner、卡片、底栏或系统安全区重叠

### 状态和渲染

- [ ] 驱动 UI 的状态使用当前组件的装饰器家族
- [ ] 列表和网格渲染稳定键
- [ ] 条件 UI 仍保持必需内容可达
- [ ] 对话框、Toast 和导航代码遵循现有项目模式

### 变更范围

- [ ] 仅修改 UI 任务所需的文件
- [ ] 保留现有业务流程、页面注册、资源命名和导航架构
- [ ] 未经明确要求，不进行状态管理迁移、导航重写或广泛重构

## 10. 与其他规则的边界

| 场景 | 使用规则 |
|------|---------|
| ArkTS 语言规则、模板字面量、动态属性访问 | `skill-arkts-standards` |
| 编译报错、类型错误、构建失败 | `skill-arkts-error-fixes` |
| 运行时崩溃、白屏、jscrash 日志 | `skill-arkts-runtime-fix` |
