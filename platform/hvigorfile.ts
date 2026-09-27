// HAR 模块：设备能力层（通知 / 长时任务 / 剪贴板 / 分享 / 窗口与形态 / 快捷键机制）。
// 零 UI 依赖、零上游知识——只把系统能力包装成可注入的机制，策略由 appstate 决定。
import { harTasks } from '@ohos/hvigor-ohos-plugin';

export default {
  system: harTasks /* Built-in plugin of Hvigor. It cannot be modified. */,
  plugins: [] /* Custom plugin to extend the functionality of Hvigor. */,
};
