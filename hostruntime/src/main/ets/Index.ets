/**
 * 端侧核心运行层对外出口。
 *
 * 已实现（可单测的纯逻辑 + 文件系统实现 + 载体抽象）：
 *   - Types      ：核心仓库的状态与**激活/回滚/清理判据**（纯函数）
 *   - Naming     ：容器名与版本目录名的规则与安全校验（纯函数）
 *   - CoreStore  ：解包落位、状态读写、激活事务、回滚、清理
 *   - BundledCore：把 resfile 里内置的核心容器落地（首启安装；幂等）
 *   - RuntimePort：运行时载体接口 + 「未接线」实现（如实报告未接线，不伪装）
 *   - DshHost    ：运行状态机（未接线/未安装/待启动/就绪/失败…），起停核心
 *   - Plugins    ：插件清单与「纯 JS / 依赖原生」分类——**清单来自树内元数据**
 *                  （打包器写入，端侧只读一个小 JSON，不遍历 27000 余文件）。
 *                  已能如实回答"这一版装了什么、哪些装不了"。
 *   - PluginRows ：**插件启停**（E91）——写 `<profile>/.dshm-plugin-rows.yml`，由入口脚本在
 *                  下次启动时拼进 profile 的 `cordis.patch.yml`（后写覆盖先写）。
 *                  **安装/卸载插件在端侧永远做不到**（上游经 pnpm 创建进程，鸿蒙不允许），
 *                  启停随包发版的行则是纯文件操作；两者在界面文案里严格区分。
 *
 * 尚未实现（下一步）：
 *   - 核心版本的**切换/回滚动作接线**：`CoreStore.activate/rollback` 与判据已就位
 *     （且"健康检查不过绝不切换"），但界面动作还没接上，目前只给如实提示。
 */

export * from './core/Types';
export * from './core/Naming';
export * from './core/CoreStore';
export * from './core/BundledCore';
export * from './core/PluginRows';
export * from './runtime/RuntimePort';
export * from './runtime/DshHost';
