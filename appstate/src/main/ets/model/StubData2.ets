/**
 * 「关于」信息（**本文件是唯一剩下的数据源，且它不是桩数据**）。
 *
 * ───────────────────────── 为什么这份文件被删到只剩一个函数 ─────────────────────────
 * 它原本是一整套「演示数据源」：工作区、文件树、文件预览、设置、凭据、插件、
 * 设备、诊断、模型、斜杠命令、`@` 引用——**全部是编造的**，
 * 用途是「设备到位前也能看到完整界面」。
 *
 * 这个立场被推翻了，原因是它违反本工程自己的文案纪律（D3 §4）：
 *   1. 规范要求的是**空态**（「还没有会话」+ 引导动作），不是假数据；
 *   2. 假数据让**缺陷不可见**——会话列表曾经在真实 Host 上永远解析出 0 条
 *      （`getRecord` 对数组返回 undefined），而界面显示的是桩数据，
 *      所以本地怎么看都正常。桩数据把「功能没接上」伪装成「功能正常」。
 *   3. 「已配置 Host」列表里那条写死的「本机 Host · 已授权」是**安全陈述**。
 *      它会让用户以为设备已配对。编造安全状态比空列表危险得多。
 *
 * 因此这里只保留「关于」：它的每一个数字都是**从 `dshcompat` 实时派生**的
 * （受支持版本矩阵、采集时间、端点上表规模），即使用户没连 Host 也是真的。
 */

import { supportedVersionsText, tableStats, upstreamCapturedAt } from 'dshcompat';
import type { TableStats } from 'dshcompat';
import { AboutInfo } from './Settings';

/**
 * 关于信息。
 *
 * 【为什么必须派生而不能写死】这些数字是「兼容面到底覆盖了什么」的唯一用户可见凭据。
 * 曾经硬编码过——上游基线从 0.1.2-rc.1（74 端点 / 3 流式 / 12 能力）升到
 * 0.1.5-rc.1（84 / 4 / 15）之后，页面仍在显示旧数字。
 * 那是**界面在说谎**：用户看到「74 个端点」而实际可用 84 个，排查问题会被这条假信息带偏。
 */
export function aboutInfo(): AboutInfo {
  const stats: TableStats = tableStats();
  return {
    appVersion: '1.0.0 (1000000)',
    supportedUpstream: supportedVersionsText(),
    compatCapturedAt: upstreamCapturedAt(),
    endpointStats: `${stats.endpoints} 个端点 / ${stats.streamEndpoints} 个流式 / ${stats.capabilities} 个能力`
  };
}
