/**
 * 会话头部的**上下文行**（P2-7）：把"这场会话在哪、用哪个模型、多久没动"压成一行。
 *
 * ## 为什么需要它（对齐官方的会话头）
 *
 * 官方 Web 的会话头带一串**上下文事实**（`conversation.header`）：Session title、
 * Workspace context、Agent preset、Model、Jobs、Goal、Schedule、Open in App。
 * 本仓此前只有"标题"（在页头 `MainHeaderShell` 里）与"任务条"，**工作区与模型在会话页看不到**
 * ——用户得回工作区列表才知道这场会话在哪个目录里跑。
 *
 * 本模块只做**能确证的那几项**：工作区路径、模型名、最近活动时间。
 * Agent preset / Schedule / Open in App 分别缺"当前会话的预设名"与协议面（见 `docs/parity-matrix.md`
 * 的缺口登记）——**不猜、不摆假入口**是本项目一贯的纪律。
 *
 * ## 为什么单独一个文件（零依赖）
 *
 * 与 `SettingsDomains.ets` 同一条理由：这段判定要被 fixture **直接执行**，
 * 而 `model/SessionList.ets` 依赖 `connection` 与 `dshcompat`（fixture 不编它们）。
 * 放在这里之后它是零依赖的，可以逐条钉住。
 */

/**
 * 工作区路径的**可读形式**。
 *
 * 【为什么不是原样显示整条路径】会话头是一行，长路径会把模型名与时间挤掉；
 * 官方在这一格显示的是**工作区名**（它的实体是"哪个项目"），完整路径在悬停/详情里看。
 * 故这里只给**目录名**，而 `~` 开头的路径按 `~` 处理（家目录下的项目最常见）。
 *
 * 【为什么保留父目录前缀】同名目录会撞（`~/a/app` 与 `~/b/app`）⇒ 取**末两段**
 * （`a/app`）。只有一段时不加前缀——`app` 比 `/app` 干净。
 */
export function workspaceNameOf(cwd: string): string {
  const trimmed: string = cwd.trim();
  if (trimmed.length === 0) {
    return '';
  }
  // 尾斜杠不影响"哪一段"，统一去掉后再切
  const norm: string = trimmed.endsWith('/') ? trimmed.substring(0, trimmed.length - 1) : trimmed;
  // 根目录：切完没有段
  const parts: string[] = norm.split('/').filter((s: string) => s.length > 0);
  if (parts.length === 0) {
    return '/';
  }
  if (parts.length === 1) {
    return parts[0];
  }
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/**
 * 会话头的上下文行（工作区 · 模型 · 最近活动）。
 *
 * 【三条纪律】① 每段**拿不到就不出现**（不写"未知"，也不留空的分隔符）；
 * ② 一段都没有时返回空串 ⇒ 界面**整行不画**（不占位置）；
 * ③ 时间用 `relativeTime` 的文案（与本仓别处同一套），不在这里造第二套措辞。
 *
 * 参数全是拼好的文案（工作区名、模型名、相对时间），因为本模块要零依赖——
 * "怎么拼出模型名"是模型层别处的判定（`modelSelectionLabel`）。
 */
export function sessionContextLine(workspace: string, model: string, updatedLabel: string): string {
  const parts: string[] = [];
  if (workspace.length > 0) {
    parts.push(`工作区 ${workspace}`);
  }
  if (model.length > 0) {
    parts.push(`模型 ${model}`);
  }
  if (updatedLabel.length > 0) {
    parts.push(updatedLabel);
  }
  return parts.join(' · ');
}
