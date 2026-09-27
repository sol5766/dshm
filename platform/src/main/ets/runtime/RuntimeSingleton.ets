/**
 * 进程内唯一运行时身份与窗口台账。
 *
 * 存在理由（D1 §7.7.5b「多窗口状态归属」，P0）：
 *   规范要求「全应用**单一**连接池 + 单一会话状态机 + 单一待发队列；窗口只是视图，
 *   不得各自开连接或各自维护会话状态」。
 *
 *   实现前提是一条**系统事实**：HarmonyOS 的 multiton 启动模式「每次调用 startAbility()
 *   都会在**应用进程**中创建一个新的该类型 UIAbility 实例」（见官方《UIAbility 组件启动模式》）。
 *   既然多窗口实例共享同一应用进程，模块级单例就天然被所有窗口共享——
 *   这正是我们把连接池放在模块级单例（appstate 的 SessionHub）的**依据**。
 *
 *   但「依据」不等于「已验证」。本文件因此提供可核查的证据面：
 *   每次进程启动分配一个随机 runtimeId，并登记本进程内的窗口。
 *   诊断页展示它们——若两个窗口显示出**不同**的 runtimeId，说明它们落在了不同进程，
 *   单例假设被推翻，必须改用跨进程方案。这是把架构假设变成可观测事实的最小成本做法。
 */

import { FormFactor } from '../system/DeviceFacts';

/** 一次窗口登记的记录 */
export interface WindowLedgerEntry {
  /** 系统窗口 id（字符串化，避免各 API 的 number/string 差异） */
  windowId: string;
  /** 人类可读标签（主窗 / 会话窗：<标题>） */
  label: string;
  /** 该窗口的形态（登记时的设备形态） */
  form: FormFactor;
  /** 登记时间戳 */
  at: number;
}

/** 运行时事实快照（诊断页展示） */
export interface RuntimeFacts {
  /** 进程内唯一运行时 id；跨窗口比对它即可判定是否同一运行时而共享单例 */
  runtimeId: string;
  /** 本进程内已登记的窗口数 */
  windowCount: number;
  /** 窗口标签列表 */
  labels: string[];
  /** 进程启动后的毫秒数（用于判断是否曾被系统回收重启） */
  uptimeMs: number;
}

let runtimeIdValue: string = '';
const startedAt: number = Date.now();
const ledger: Map<string, WindowLedgerEntry> = new Map();

/**
 * 取本进程的运行时 id（惰性生成）。
 *
 * 用「时间戳 + 随机」而不是递增计数：系统回收进程后重启会得到新 id，
 * 这正是我们想观察到的（重启会丢掉连接，必须能看出来）。
 */
export function runtimeId(): string {
  if (runtimeIdValue.length === 0) {
    const rand: number = Math.floor(Math.random() * 0x7fffffff);
    runtimeIdValue = `rt-${startedAt.toString(36)}-${rand.toString(36)}`;
  }
  return runtimeIdValue;
}

/** 登记一个窗口（UIAbility 实例创建时调用）。 */
export function registerWindow(windowId: string, label: string, form: FormFactor): void {
  ledger.set(windowId, { windowId: windowId, label: label, form: form, at: Date.now() });
}

/** 注销一个窗口（UIAbility 实例销毁时调用）。关任一窗口不得影响其他窗口。 */
export function unregisterWindow(windowId: string): void {
  ledger.delete(windowId);
}

/** 更新窗口标签（例如会话标题变化后）。 */
export function relabelWindow(windowId: string, label: string): void {
  const entry: WindowLedgerEntry | undefined = ledger.get(windowId);
  if (entry !== undefined) {
    entry.label = label;
  }
}

/** 本进程窗口数。>1 且只存在一条连接，即为 D1 §7.7.5b 的达标证据。 */
export function windowCount(): number {
  return ledger.size;
}

/** 运行时事实快照。 */
export function runtimeFacts(): RuntimeFacts {
  const labels: string[] = [];
  ledger.forEach((v: WindowLedgerEntry) => {
    labels.push(v.label);
  });
  return {
    runtimeId: runtimeId(),
    windowCount: ledger.size,
    labels: labels,
    uptimeMs: Date.now() - startedAt
  };
}
