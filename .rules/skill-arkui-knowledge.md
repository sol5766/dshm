# skill: ArkUI / 声明式 UI

适用：页面、组件、布局、导航、对话框、状态渲染。

## 要点

- `build()` 内只写声明式 UI，不写命令式副作用；事件回调在 `onClick` 等里调用方法。
- 页面尺寸/断点处理参考 `pages/Index.ets` 与 `pages/Settings.ets` 现有的安全区与滚动策略。
- 导航优先用 `Navigation` / `NavDestination`；路由常量集中注册，避免字符串散落。
- 列表用 `ForEach`，依赖 `keyGenerator` 稳定生成 key；大数据用 `LazyForEach`。
- 深色模式/主题以 `@kit.ArkUI` + `AppStorage` 或目标管理器为准，不在各页面重复硬编码颜色。
- 新增公共能力（Dialog、Toast、日志、Http）应先看是否可在 `hdsh/` 复用，再决定是否新写。
