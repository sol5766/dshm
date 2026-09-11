# 技能：ArkTS 项目调试工作流

**适用场景**：ArkTS 项目运行时问题调试；涉及崩溃定位、日志插桩、运行时行为验证。

**自动触发条件（满足任意一条即应主动阅读本文件）**：
- ArkTS 项目运行时问题调试、日志插桩、假设验证、运行时行为确认。
- 用户提供复现步骤但缺少明确崩溃堆栈，需要通过日志验证假设。
- 修复运行时问题后需要做前后对比验证。

---

## 1. ArkTS 调试工作流

1. **生成 3-5 个假设**，不要直接改逻辑
2. **插入 3-8 个 ArkTS 安全日志**，每条日志至少映射一个假设
3. **构建**直到构建干净
4. **启动应用**
5. **清理日志**：`hdc_log(action="clear")`
6. **用户复现后收集日志**：`hdc_log(action="collect")`
7. **确认/拒绝每个假设**，用日志证据和引用行号
8. **仅应用运行时证据证明的修复**
9. **后修复验证**：构建 + 启动 + 日志收集，使用 `runId=post-fix` 对比修复前数据
10. 如果所有假设都被拒绝，从不同子系统生成新假设并添加更多仪表代码

## 2. 日志插桩规则

### 安全插入点

- `aboutToAppear`
- `aboutToDisappear`
- `onPageShow`
- `onPageHide`
- 事件处理器
- `.onAppear(() => { ... })` 修饰符
- 非 `@Builder` 装饰的自定义方法

### 禁止插入点

- `build()` UI 声明体
- `@Builder` 函数

### 日志格式

```typescript
console.log(`[DEBUG][H<id>] location=<filePath> | message=<desc> | data=${<var>} | ts=${Date.now()} | runId=<pre-fix|post-fix>`);
```

示例：

```typescript
aboutToAppear() {
  console.log(`[DEBUG][H1] location=MainMenuPage.ets | message=aboutToAppear called | data=${this.tabIndex} | ts=${Date.now()} | runId=pre-fix`);
}
```

## 3. 约束

- **禁止**在没有运行时日志证据的情况下声称修复
- 将源码视为 **ArkTS**，而非通用 TypeScript
- API 行为不确定时，先查阅 ArkTS 文档
- **禁止**使用 `setTimeout`、`sleep` 或人工延迟作为"修复"；使用正确的响应式/事件/生命周期
- **禁止**在后修复验证日志证明成功且用户确认前移除仪表代码
- 每个假设标记为 confirmed/rejected/inconclusive，并引用具体日志行号

## 4. 构建失败时的调试优先级

1. 先聚焦 `ERROR` 行，忽略 `WARN` 除非相关
2. 常见错误分类（参见 `skill-arkts-error-fixes`）
3. 修复错误后增量构建
4. 增量构建意外失败时，清理 `.hvigor` 和 `build` 目录

## 5. 与其他规则的协作

| 调试阶段 | 配套规则 |
|----------|---------|
| 遇到编译错误 | `skill-arkts-error-fixes` |
| 遇到运行时崩溃 | `skill-arkts-runtime-fix` |
| 需要设备连接、启动应用、采集 HiLog 或 bugreport | `skill-device-hdc-debug` |
| 需要修改 UI 组件 | `skill-arkui-knowledge` |
| 语法合规问题 | `skill-arkts-standards` |
