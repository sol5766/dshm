# 技能：UI 图标与 Symbol 规范

**适用场景**：在 UI 界面中需要使用图标、状态指示或装饰性符号时，或者需要为文本添加指示性标识时。

**自动触发条件（满足任意一条即应主动阅读本文件）**：
- UI 中需要添加图标、状态提示、按钮图标、字符串带图或装饰性符号。
- 发现现有代码或资源中使用 Emoji 作为状态/按钮/提示标识。
- LLM 准备主动生成 Emoji、符号字符或不确定系统 Symbol 名称。

---

## 1. 背景

在开发 NGF 框架的页面或组件时，经常需要通过视觉元素（如成功、警告、错误、信息等指示）来增强可读性。
HarmonyOS 提供了强大的 `sys.symbol` 系统级图标库。如果不加规范，开发者或 LLM 容易在代码或配置文件（如 `string.json`）中直接硬编码使用 Emoji 表情符号（如 ✅、📴、✕、✏ 等）作为替代，这会导致：
1. 与系统的沉浸式设计（HDS）和原生控件风格不协调。
2. 无法响应系统的主题色和多层颜色（多色/单色）配置。
3. 文本与图标混合时对齐和尺寸难以精确控制。

因此，**全面禁止在 UI 层与配置层主动使用 Emoji**，必须统一使用 HarmonyOS 的系统 Symbol。

## 2. 标准模式

**禁止行为**：
- **禁止** LLM 主动在代码和 `string.json` 中添加 Emoji 表情作为图标指示。
- 除非用户在自己的代码中明确使用了 Emoji 或是特别要求保留，否则凡是需要“打勾”、“叉号”、“提示”、“警告”等图标的地方，均不能用 Emoji。

**正确做法**：
- 在需要图标的地方，使用 `SymbolGlyph($r('sys.symbol.xxxx'))` 组件配合 `Text` 实现。
- 对于字符串拼接的场景，分离图标和文本，用 `Row` 容器包裹 `SymbolGlyph` 和 `Text`，或者在 `Text` 内部使用 `SymbolSpan` 和 `Span` 的组合。
- 在选择具体图标时，如果不确定图标名称，请主动在项目中搜索现有的 Symbol 列表，例如参考 `SystemSymbolCatalog.ets`。

```typescript
// ✅ 正确做法：使用 Row 分离 SymbolGlyph 和 Text
Row({ space: 6 }) {
  SymbolGlyph($r('sys.symbol.checkmark_circle'))
    .fontSize(14)
    .fontColor([$r('app.color.tag_green')])
  Text($r('app.string.sync_result_success'))
    .fontSize(13)
    .fontColor($r('app.color.tag_green'))
}

// ✅ 正确做法：在按钮中使用
Button() {
  Row({ space: 4 }) {
    SymbolGlyph($r('sys.symbol.square_and_pencil'))
      .fontSize(14)
      .fontColor(['#FFFFFF'])
    Text($r('app.string.sync_enqueue_update'))
      .fontSize(12)
      .fontColor('#FFFFFF')
  }
}

// ✅ 正确做法：在 Text 内部使用 SymbolSpan
Text() {
  SymbolSpan($r('sys.symbol.info_circle'))
    .fontSize(12)
    .fontColor([$r('app.color.text_muted')])
  Span(' ')
  Span(this.statusMessage)
}
```

## 3. 常见错误与对比

| 场景 | ❌ 错误（使用 Emoji） | ✅ 正确（使用 Symbol） |
|------|--------------------|--------------------|
| 状态信息 | `Text("✅ 同步成功")` | `Row() { SymbolGlyph($r('sys.symbol.checkmark')); Text("同步成功") }` |
| 按钮文字 | `Button("✏ 更新")` | `Button() { Row() { SymbolGlyph($r('sys.symbol.square_and_pencil')); Text("更新") } }` |
| 配置文件 | `"value": "⚠️ 网络断开"` | `"value": "网络断开"` (UI层通过代码外挂警告图标) |

## 4. 常用图标索引建议

如果在编写代码时需要寻找合适的图标，可以通过全局搜索（grep） `ngf_framework/src/main/ets/resources/SystemSymbolCatalog.ets` 来查找系统原生的全量图标名称，常见的高频基础图标包括：
- `sys.symbol.checkmark` / `sys.symbol.checkmark_circle` (成功/确认)
- `sys.symbol.xmark` / `sys.symbol.xmark_circle` (失败/关闭)
- `sys.symbol.info_circle` (信息提示)
- `sys.symbol.exclamationmark_triangle` (警告)
- `sys.symbol.plus` (添加/创建)
- `sys.symbol.square_and_pencil` (编辑/更新)
- `sys.symbol.trash` (删除)

## 5. 关键文件路径速查

| 文件 | 说明 |
|------|------|
| `SystemSymbolCatalog.ets` | 包含了系统中可用系统 Symbol 名称的完整列表，不知道名字时可查阅此文件。 |
