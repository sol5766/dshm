// HAR 模块：端侧核心运行层（核心版本仓库与激活事务 / 端侧 profile / 插件清单 / 运行时载体接口）。
// 零 UI 依赖、零上游业务知识——上游事实仍只允许出现在 dshcompat（见 D5 §1）。
import { harTasks } from '@ohos/hvigor-ohos-plugin';

export default {
  system: harTasks /* Built-in plugin of Hvigor. It cannot be modified. */,
  plugins: [] /* Custom plugin to extend the functionality of Hvigor. */,
};
