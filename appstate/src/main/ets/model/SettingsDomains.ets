/**
 * 设置分区的**域判定**（P4-6）：一个 key / 命名空间属于哪个设置分区。
 *
 * ## 为什么单独一个文件（而不是留在 `Settings.ets` 里）
 *
 * 判定必须是**纯逻辑**：它要被 fixture 直接执行（`tools/check-layout-fixtures.mjs`
 * 把纯逻辑 `.ets` 当 TS 编译后在本机跑）。原先这段住在 `model/Settings.ets` 里，
 * 而那个文件 `import { … } from 'connection'`（JSON 取值工具）——fixture 不编 `connection`
 * ⇒ 这份判定**一行断言都拿不到**。搬到这里之后它零依赖，可以逐条钉住。
 *
 * ## 为什么需要"域"这个概念（一个真实的界面缺陷）
 *
 * 写入回执原先是一个**全局字符串**（`Index.settingWriteNote`），而它唯一的读取点
 * 在设置页顶部那条回显里。于是有两种错法：
 *   1. **串段落**：在「通用」改了外观，切到「模型」——那条回执还挂在顶部，
 *      看起来像是模型页刚写出来的结果；
 *   2. **看起来像本页失败**：失败回执（"被拒"）属于别的段落时，同样会挂在当前段落上方。
 * 两条都是"界面在撒谎"这一类问题（本项目 D3 §4 的纪律）。
 *
 * 判据是**命名空间**（Host 的稳定标识），比"看这一项长什么样"可靠。
 * 未列出的命名空间**不猜**：返回空串表示"域未知"，由界面按"宁可显示、不可隐藏"处理
 * ——隐藏一条用户可能正需要的失败回执，比多显示一条更糟。
 *
 * 域取值与服务端**分区 id 同形**（`settings.general` 等），于是界面可以直接与
 * `NavigationState.settingsSection` 比较，不需要再维护第二套映射。
 */

/**
 * 「通用」分区承载的命名空间（E114，对齐官方 web 的层级）。
 *
 * 【依据】官方设置外壳的做法是：**「通用」分区没有内置行**，行由功能包通过
 * `settings.general.item` 注册进来（例如「外观」来自 ui-theme）。也就是说
 * 「通用」= **用户面向的功能包设置**，引擎内部参数不在其中。
 * 真机上 Host 报的 12 个命名空间里，符合这个定义的是下面这几个；
 * 模型相关的（`agent-default-model` / `llm-*` / `subagent-model-selection` /
 * `web-search-*`）归**模型分区**，引擎参数（`agent-loop` / `agent-presets`）不面向用户。
 *
 * 【为什么不是"全部隐藏"】用户**显式改过**的项即使属于引擎命名空间也要留在界面上
 * （否则他改过的东西无处可见、也无处撤回）。所以投影规则是"白名单 ∪ 用户已覆盖"。
 */
export const GENERAL_NAMESPACES: string[] = [
  'ui-theme',
  'locale',
  'ui-conversation',
  'ui-chat',
  'ui-onboarding'
];

/** 该命名空间是否属于「通用」分区（用户面向的功能包设置） */
export function isGeneralNamespace(ns: string): boolean {
  for (let i = 0; i < GENERAL_NAMESPACES.length; i++) {
    if (GENERAL_NAMESPACES[i] === ns) {
      return true;
    }
  }
  return false;
}

/**
 * 默认模型所在命名空间（`setDefaultModel` 写的三个字段都在这里）。
 *
 * 【为什么要一个常量】写默认模型是一条不经过"设置项 key"的写入路径，
 * 但它同样要记回执的归属域；把前缀抄在调用点就等于多一处上游字面量。
 */
export const DEFAULT_MODEL_NS: string = 'agent-default-model';

/** 域未知（判不出来的命名空间）——界面按"宁可显示"处理 */
export const SETTINGS_DOMAIN_UNKNOWN: string = '';

/** 一个命名空间属于哪个设置分区；判不出来返回空串（不猜） */
export function settingsDomainOfNs(ns: string): string {
  if (isGeneralNamespace(ns)) {
    return 'settings.general';
  }
  if (ns.startsWith('llm-') || ns.startsWith('web-search-')) {
    return 'settings.models';
  }
  if (ns === DEFAULT_MODEL_NS || ns === 'subagent-model-selection') {
    return 'settings.models';
  }
  if (ns.startsWith('ui-plugin') || ns === 'plugins') {
    return 'settings.plugins';
  }
  if (ns.startsWith('agent-preset')) {
    return 'settings.presets';
  }
  if (ns.startsWith('skill')) {
    return 'settings.skills';
  }
  return SETTINGS_DOMAIN_UNKNOWN;
}

/**
 * 一个设置项 key 属于哪个设置分区。
 *
 * 与 `settingsDomainOfNs` 分开的理由：key 可能**没有命名空间**
 * （本机偏好 `local.themeMode` 就是），那种情况不猜——由调用方声明它属于哪个分区
 * （见 `Index.noteSettingWrite`）。
 */
export function settingsDomainOfKey(key: string): string {
  const dot: number = key.indexOf('.');
  if (dot <= 0 || dot >= key.length - 1) {
    return SETTINGS_DOMAIN_UNKNOWN;
  }
  return settingsDomainOfNs(key.substring(0, dot));
}
