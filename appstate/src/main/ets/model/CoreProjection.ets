/**
 * 端侧核心页的**投影**：把 Host 侧读出来的插件清单整理成核心页读得懂的事实与行。
 *
 * 分层（D1 §10.1）：hostruntime 只负责"读出来"，页面只负责"画出来"，中间的
 * 「这一堆数字对用户意味着什么」放在这里——纯函数，因此可以在没有设备、没有核心
 * 的情况下被单测钉死。
 *
 * 【为什么参数是平铺的，而不是直接吃宿主的报告对象】ArkTS 明令禁止结构化类型
 * （`arkts-no-structural-typing`）：宿主的 `HostPluginReport` 与这里的接口形状相同也**不能**
 * 互相赋值。可选路只有两条——把 appstate 反向依赖到宿主实现（破坏分层，且方向是反的），
 * 或者让调用点把用到的字段**逐个取出来**。这里选后者：接口只是"参数的分组"，不是"两侧共享的
 * 类型"，于是谁也不必认识谁。
 */

import { classifyPlugin, CoreFact, fact, PluginNative, pluginNativeOf, PluginRow, unknownFact } from './Core';

/** 清单的统计（调用点逐字段填，避免 7 个位置参数写错顺序）。 */
export interface PluginInventoryTotals {
  pluginRows: number;
  pureJs: number;
  native: number;
  unknown: number;
  disabled: number;
}

/**
 * 插件清单的**来源与统计**，作为核心页的一条事实。
 *
 * 【为什么要有这一行】清单是"某个已安装版本"的属性，且它由**打包时**写进树里
 * （端侧不遍历目录现算，见 D6 §6.2.1）。所以用户必须能看出清单来自哪一版；
 * 装的是没有清单的旧包时，也要说清"是这个包没带清单"，而不是让他以为插件为零。
 *
 * @param note 清单为空时的原因（非空即表示"这个包没带清单"）
 */
export function pluginInventoryFact(note: string, version: string,
  totals: PluginInventoryTotals, nativePackageCount: number): CoreFact {
  if (note.length > 0) {
    return unknownFact('插件清单', note);
  }
  return fact('插件清单',
    `${totals.pluginRows} 行 · 纯 JS ${totals.pureJs} · 依赖原生 ${totals.native}`
      + (totals.disabled > 0 ? ` · 默认禁用 ${totals.disabled}` : ''),
    totals.native > 0 ? 'warn' : 'ok',
    `来自核心 ${version}；含原生模块的包 ${nativePackageCount} 个。`
      + '「依赖原生」的插件受签名策略约束，只能随应用发版。');
}

/**
 * 树内清单的一行 → 核心页的行。
 *
 * 端侧的 nativeKind 来自打包时沿**依赖闭包**的判定（D6 §6.2.1），所以这里的分类是
 * **真实取值**，正常情况不会出现「待确认」。
 * `version` 留空：清单描述的是"包内的行"，行本身没有独立版本，编一个版本号比留空更糟。
 */
export function pluginRowOf(id: string, name: string, manifestNativeKind: string,
  disabled: boolean): PluginRow {
  return classifyPlugin(name, '', pluginNativeOf(manifestNativeKind), id, disabled);
}

/**
 * 排序：**先看该看的**。端侧核心实测 152 行里 146 行是"可安装"的普通插件；
 * 按清单原顺序铺开，真正需要用户注意的 6 行（依赖原生、运行时装不了）与
 * 3 行（默认禁用）会被淹掉。
 *
 * **只排序、不隐藏**：插件清单的价值恰恰在于"到底装了什么"能被查全，
 * 藏掉 146 行会让这个问题无法回答。`sort` 是稳定的，同档内保持清单原顺序。
 * 返回新数组：调用点传进来的那一份仍然保持清单原顺序（便于对照与复用）。
 */
export function rankPluginRows(rows: PluginRow[]): PluginRow[] {
  const out: PluginRow[] = rows.slice();
  const rank = (p: PluginRow): number => {
    if (p.nativeKind === PluginNative.NATIVE) {
      return 0;
    }
    return p.disabled ? 1 : 2;
  };
  out.sort((a: PluginRow, b: PluginRow) => rank(a) - rank(b));
  return out;
}
