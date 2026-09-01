/**
 * DSHM 事件总线。
 *
 * 语义对齐 DSH/Cordis 事件系统的最小子集（参考 HDSH）：
 * - 订阅返回回卷函数（disposer），便于卸载/取消订阅；
 * - 按 kind 分发；emit 用副本遍历，允许监听器在回调内再次订阅。
 */

/** 事件类型。 */
export enum AppEventKind {
  SERVER_DISCOVERED = 0,
  DSH_LAUNCHING = 1,
  DSH_READY = 2,
  CONNECTION_STATE = 3,
  INSTALL_PROGRESS = 4,
  INSTALL_DONE = 5,
  INSTALL_ERROR = 6,
  WORKSPACE_CHANGED = 7
}

/** 事件负载（payload 为消息或 JSON 字符串）。 */
export interface AppEvent {
  kind: AppEventKind;
  payload: string;
}

/** 事件处理函数。 */
export type AppEventHandler = (event: AppEvent) => void;

/** 回卷函数：取消订阅。 */
export type Disposer = () => void;

export class EventBus {
  private handlers: Map<AppEventKind, AppEventHandler[]> = new Map<AppEventKind, AppEventHandler[]>();

  /** 订阅某类事件，返回取消订阅函数。 */
  on(kind: AppEventKind, handler: AppEventHandler): Disposer {
    let list: AppEventHandler[] | undefined = this.handlers.get(kind);
    if (list === undefined) {
      list = [];
      this.handlers.set(kind, list);
    }
    list.push(handler);
    return (): void => {
      const current: AppEventHandler[] | undefined = this.handlers.get(kind);
      if (current === undefined) {
        return;
      }
      const index: number = current.indexOf(handler);
      if (index >= 0) {
        current.splice(index, 1);
      }
    };
  }

  /** 广播事件（副本遍历，允许回调内再次订阅/取消）。 */
  emit(event: AppEvent): void {
    const list: AppEventHandler[] | undefined = this.handlers.get(event.kind);
    if (list === undefined) {
      return;
    }
    const snapshot: AppEventHandler[] = list.slice();
    for (let i = 0; i < snapshot.length; i++) {
      snapshot[i](event);
    }
  }

  /** 清空所有订阅。 */
  clear(): void {
    this.handlers.clear();
  }
}
