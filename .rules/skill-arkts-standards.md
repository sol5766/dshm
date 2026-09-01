# skill: ArkTS 标准

适用：编写或修改任意 `.ets` 文件，特别是 `entry/src/main/ets/**`。

## 硬性要求

- 用 `import { X } from '@kit.ArkUI'` / `@kit.AbilityKit` 等新的 kit 引入，优先于旧 `@ohos.*`。
- 禁用非 ArkTS 特性：`any`/`unknown`（除非确实无类型）、结构化的 `object` 类型、mapped/conditional type、`with`、非受限泛型访问。
- 变量/返回类型显式标注；`Map`/`Set`/数组遍历注意类型；`catch` 需显式处理异常类型。
- 状态装饰器：`@State`/`@Prop`/`@Link`/`@Provide`/`@Consume`/`@Observed`/`@ObjectLink` 用对；不在 `build()` 里做副作用。
- 空行、命名风格与现有文件一致（4 空格缩进，`camelCase` 函数 / `PascalCase` 类）。

## 检查点

- 写完自查：无 `@ts-ignore` 滥用、无隐式 `any`、无运行时类型断言 `as any`。
- 组件数据刷新用 `ForEach`/`LazyForEach` 时，`keyGenerator` 稳定且基于内容。
