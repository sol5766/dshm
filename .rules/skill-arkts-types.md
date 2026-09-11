# 技能：ArkTS 类型安全与集合操作

**适用场景**：在编写 ArkUI 组件状态（@State, @StorageProp）、使用 `Map` 或 `Array` 集合，以及配合 `ForEach` 渲染时，确保严格符合 ArkTS 的强类型规范。

**自动触发条件（满足任意一条即应主动阅读本文件）**：
- ArkUI 组件状态、`@State`、`@StorageProp`、`Map`、`Array`、`ForEach`、`LazyForEach`、`IDataSource` 相关修改。
- 异常捕获、Promise 回调、事件监听或集合遍历中需要显式类型。
- 需要处理 `any`/`unknown`、隐式类型、对象字面量或泛型推断相关编译错误。

---

## 1. 背景

ArkTS 强制要求强类型，全面禁止 `any` 和 `unknown`。这在处理动态结构（如 `Map`、`Array`）以及 UI 列表循环（如 `ForEach`）时尤为重要。如果使用了隐式类型或者直接将参数声明为 `any`，会引发硬性编译错误（如 `10605008 ArkTS Compiler Error: Use explicit types instead of "any", "unknown"`）。

## 2. 常见错误与正确写法

### 2.1 AppStorage 与 Map 的强类型声明

**错误做法**：

```typescript
// 缺少明确的泛型值类型，或者使用了 any，将导致编译失败
@StorageProp('ngf_tasks_map') tasksMap: Map<string, any> = new Map();
```

**正确做法**：

```typescript
import { NGFTaskInfo } from 'ngf_framework';

// 必须显式声明 Key 和 Value 的确切类/接口类型
@StorageProp('ngf_tasks_map') tasksMap: Map<string, NGFTaskInfo> = new Map();
```

### 2.2 ForEach 迭代 Map 的正确姿势

**背景**：ArkUI 的 `ForEach` 只能迭代 `Array` 类型。当你需要迭代 `Map` 的 `values()` 时，除了将其转换为 Array 之外，**回调函数中的 item 参数必须显式指定类型**，否则编译器极易将其推断为 `any` 从而打断编译。

**错误做法**：

```typescript
List() {
  ForEach(Array.from(this.tasksMap.values()), (task: any) => {
    ListItem() {
      Text(task.name)
    }
  }, (task: any) => task.taskId)
}
```

**正确做法**：

```typescript
List() {
  ForEach(Array.from(this.tasksMap.values()), (task: NGFTaskInfo) => {
    ListItem() {
      Text(task.name)
    }
  }, (task: NGFTaskInfo) => task.taskId) // 键值生成器的参数也必须显式提供类型
}
```

### 2.3 异常捕获 (Catch) 中的类型安全

**错误做法**：

```typescript
.catch((e: any) => {
  console.error(e);
});
```

**正确做法**：

```typescript
.catch((e: Error) => {
  console.error(e.message);
});
```

## 3. 关键验证文件

| 文件 | 说明 |
|------|------|
| `pages/ngf/NGFTaskManagerPage.ets` | 已在此文件中验证并清除了所有与 `Map`、`ForEach`、`any` 相关的 ArkTS 编译警告 |
