# 技能：框架组件与门面复用 (Component Reuse)

**适用场景**：Agent 在接到开发任务，需要往页面上添加通用交互层（如弹窗、提示、标题栏、工具箱等）时，查阅此白名单，以直接复用 `ngf_framework` 包内的高级组件与门面，绝对禁止重复造轮子。

**自动触发条件（满足任意一条即应主动阅读本文件）**：
- 收到“添加提示框”、“增加网络请求”、“处理页面返回逻辑”等功能性指令。
- 试图在业务代码（`entry`）中手写新的基础类（如新的 Dialog、新的 Logger、新的 Hash 函数）。

---

## 1. UI 积木复用速查 (从 `ngf_framework` 导入)

以下 UI 组件已在框架层深度封装了样式体系，在 HAP 业务层中应该**直接导入并使用**：

| 组件名称 | 适用场景 | 说明 |
|---------|---------|------|
| `NGFHdsTitleBarOptionsFactory` | 配置 HDS 顶栏 | 帮你快速生成符合 Material 等级和状态栏避让逻辑的 HdsTitleBarOptions 对象 |
| `NGFImmersiveTopChromeUnderlay` | 页面顶部光效底板 | 用于在纯净页面顶部渲染一层玻璃质感和渐变发光的光效层 |
| `NGFImmersiveTopChromePresetFactory` | 预设光效生成器 | 配合 `NGFImmersiveTopChromeUnderlay` 快速生成深蓝、亮色等光晕参数 |
| `AboutSheetContent` | 弹窗/面板底座 | 标准的关于/信息展示面板壳层（半屏弹窗） |

**如何使用**：
```typescript
import { 
  NGFHdsTitleBarOptionsFactory, 
  NGFImmersiveTopChromeUnderlay, 
  NGFImmersiveTopChromePresetFactory 
} from 'ngf_framework';
```

## 2. 工具与逻辑门面复用速查 (从 `ngf_framework` 导入)

框架暴露了大量单例门面，可以直接跨层调用：

| 门面/对象 | 功能职责 | 如何使用 |
|----------|---------|---------|
| `logger` | 统一日志打印 | `logger.info(TAG, 'message')` |
| `securityToolkit` | 哈希、加解密算法 | `securityToolkit.shaHash(...)` |
| `performanceMonitor` | 性能打点与内存快照 | `performanceMonitor.mark('start')` |
| `FileUtils` | 文本读写与目录遍历 | `FileUtils.readText(path)` |
| `ngfNetworkClient` | HTTP 网络请求 | `ngfNetworkClient.get(url)` |
| `ngfRdbManager` | 关系型数据库操作 | `ngfRdbManager.query(...)` |
| `ngfSystem` | 跨模块派发后台任务 | `ngfSystem.submitTask(...)` |
| `NGFPageWindowSupport`| 窗口高度/安全区探测 | `NGFPageWindowSupport.loadDynamicTopInset(...)` |
| `ngfThemeManagerFacade` | 读写主题/深色模式 | `ngfThemeManagerFacade.getCurrentMode()` |
| `ngfI18nManagerFacade` | 读取相对时间/多语言配置 | `ngfI18nManagerFacade.getCurrentLanguage()` |
| `resolveResourceString` | 强制解析系统Resource为字符串 | `resolveResourceString($r('...'))` |

**强硬约束：**
如果你在 `entry` 层发现你需要一个 `MD5/SHA` 哈希函数，**严禁自己写，必须使用 `securityToolkit`**；如果你需要打日志，**严禁使用原生的 `console.log`，必须使用 `logger`**。
