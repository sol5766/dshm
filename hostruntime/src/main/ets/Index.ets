/**
 * 端侧核心运行层对外出口。
 *
 * 已实现（可单测的纯逻辑 + 文件系统实现 + 载体抽象）：
 *   - Types      ：核心仓库的状态与**激活/回滚/清理判据**（纯函数）
 *   - Naming     ：容器名与版本目录名的规则与安全校验（纯函数）
 *   - CoreStore  ：解包落位、状态读写、激活事务、回滚、清理
 *   - BundledCore：把 resfile 里内置的核心容器落地（首启安装；幂等）
 *   - RuntimePort：运行时载体接口与启动契约
 *   - DshHost    ：运行状态机（未接线/未安装/待启动/就绪/失败…），起停核心
 *   - Plugins    ：插件清单与「纯 JS / 依赖原生」分类——**清单来自树内元数据**
 *                  （打包器写入，端侧只读一个小 JSON，不遍历 27000 余文件）。
 *                  已能如实回答"这一版装了什么、哪些装不了"。
 *   - PluginRows ：**插件启停**（E91）——写 `<profile>/.dshm-plugin-rows.yml`，由入口脚本在
 *                  下次启动时拼进 profile 的 `cordis.patch.yml`（后写覆盖先写）。
 *                  **安装/卸载插件在端侧永远做不到**（上游经 pnpm 创建进程，鸿蒙不允许），
 *                  启停随包发版的行则是纯文件操作；两者在界面文案里严格区分。
 *
 * 已接线（界面动作在核心页）：
 *   - 核心版本**切换**：`DshHost.switchTo`（宿主正在跑时只写状态、由重启生效，E151）
 *   - 核心版本**回滚**：`DshHost.rollbackTo`
 *   - 旧核心树**清理**：`CoreStore.evict`（2026-10-08 起由 `installBundledCores` 在装入
 *     内置核心之后调用；判据在 `Types.evictionCandidates` —— 永不删 current / previous /
 *     **会真正启动的那棵**。此前只有定义、没有调用点，真机上因此攒了 15 棵 ≈5 GB）
 */

export * from './core/Types';
export * from './core/Naming';
export * from './core/CoreStore';
export * from './core/BundledCore';
export * from './core/PluginRows';
export * from './runtime/RuntimePort';
export * from './runtime/DshHost';
export * from './runtime/NodeRuntime';
export * from './runtime/HostModules';
