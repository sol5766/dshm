/**
 * 桌面卡片状态（2026-10-17，docs/178）—— FormExtensionAbility 与主应用共用的一份解析。
 *
 * 数据源：宿主 Node 进程写出的 `$DSH_HOME/card-state.json`（真机 = `<filesDir>/dsh/home/card-state.json`）：
 *   { updatedAt, session:{ title,state,turn,step }, balance:{ available,display },
 *     usage:{ today,last5h,last7d,last30d } }
 *
 * 【显示规则（用户口径）】**有余额显示余额；余额取不到才显示 token 用量**（今天 / 近5h / 近7天 / 近30天）。
 * 卡片首帧与定时刷新由 FormExtensionAbility 读本文件；进度类更新由主应用 `CardStateWatcher`
 * 轮询本文件后 `formProvider.updateForm` 推向已添加的卡片（FormExtension 自身没有宿主事件通道）。
 */

import { fileIo as fs } from '@kit.CoreFileKit';

export interface CardSession {
  sessionId: string;
  title: string;
  state: string;   // idle | running | done
  turn: number;
  step: number;
}

export interface CardBalance {
  available: boolean;
  display: string;
}

export interface CardUsage {
  today: number;
  last5h: number;
  last7d: number;
  last30d: number;
}

export interface CardState {
  updatedAt: number;
  session: CardSession;
  balance: CardBalance;
  usage: CardUsage;
}

/** 空状态：宿主还没写出文件时卡片也能渲染。 */
export function emptyCardState(): CardState {
  return {
    updatedAt: 0,
    session: { sessionId: '', title: '', state: 'idle', turn: 0, step: 0 },
    balance: { available: false, display: '' },
    usage: { today: 0, last5h: 0, last7d: 0, last30d: 0 },
  };
}

/** 读卡片状态；任何失败都退化为空状态（卡片显示"暂无数据"，不炸）。 */
export function readCardState(filesDir: string): CardState {
  const path: string = `${filesDir}/dsh/home/card-state.json`;
  try {
    if (!fs.accessSync(path)) return emptyCardState();
    const parsed = JSON.parse(fs.readTextSync(path)) as CardState;
    const state = emptyCardState();
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.updatedAt === 'number') state.updatedAt = parsed.updatedAt;
      if (parsed.session && typeof parsed.session === 'object') {
        state.session = {
          sessionId: typeof parsed.session.sessionId === 'string' ? parsed.session.sessionId : '',
          title: typeof parsed.session.title === 'string' ? parsed.session.title : '',
          state: typeof parsed.session.state === 'string' ? parsed.session.state : 'idle',
          turn: typeof parsed.session.turn === 'number' ? parsed.session.turn : 0,
          step: typeof parsed.session.step === 'number' ? parsed.session.step : 0,
        };
      }
      if (parsed.balance && typeof parsed.balance === 'object') {
        state.balance = {
          available: parsed.balance.available === true,
          display: typeof parsed.balance.display === 'string' ? parsed.balance.display : '',
        };
      }
      if (parsed.usage && typeof parsed.usage === 'object') {
        state.usage = {
          today: typeof parsed.usage.today === 'number' ? parsed.usage.today : 0,
          last5h: typeof parsed.usage.last5h === 'number' ? parsed.usage.last5h : 0,
          last7d: typeof parsed.usage.last7d === 'number' ? parsed.usage.last7d : 0,
          last30d: typeof parsed.usage.last30d === 'number' ? parsed.usage.last30d : 0,
        };
      }
    }
    return state;
  } catch (e) {
    return emptyCardState();
  }
}

/** 状态 → 卡片绑定数据（key 与 UsageCard 的 @LocalStorageProp 一一对应）。 */
export function buildCardBinding(state: CardState): Record<string, string | boolean> {
  const running: boolean = state.session.state === 'running';
  const done: boolean = state.session.state === 'done';
  let sessionTitle: string = state.session.title;
  if (sessionTitle.length === 0) sessionTitle = '暂无会话';
  const sessionStateText: string = running ? '执行中' : (done ? '已完成' : '空闲');
  // 进度在"执行中"和"已完成"都显示（用户反馈：只有"执行中"、看不到第几步）
  const sessionProgress: string = state.session.step > 0 ? `第 ${state.session.step} 步` : '';
  const useBalance: boolean = state.balance.available && state.balance.display.length > 0;
  const balanceText: string = useBalance ? `余额 ${state.balance.display}` : '';
  let updatedText: string = '等待数据';
  if (state.updatedAt > 0) {
    const d: Date = new Date(state.updatedAt);
    const hh: string = d.getHours() < 10 ? '0' + d.getHours() : String(d.getHours());
    const mm: string = d.getMinutes() < 10 ? '0' + d.getMinutes() : String(d.getMinutes());
    updatedText = `${hh}:${mm} 更新`;
  }
  return {
    'sessionId': state.session.sessionId,
    'sessionTitle': sessionTitle,
    'sessionStateText': sessionStateText,
    'sessionProgress': sessionProgress,
    'useBalance': useBalance,
    'balanceText': balanceText,
    /*
     * FormBindingData 跨进程会序列化为字符串。若这里给 number、卡片侧又声明 number，
     * 卡片进程会拿不到值并回落到 0（真机表现：余额正常，四档 token 全 0）。
     * 因此统一传十进制字符串，卡片侧再显式 Number() 后绘图。
     */
    'usageToday': String(state.usage.today),
    'usage5h': String(state.usage.last5h),
    'usage7d': String(state.usage.last7d),
    'usage30d': String(state.usage.last30d),
    'updatedText': updatedText,
  };
}

/** 已添加卡片的 formId 列表（FormExtensionAbility 写、主应用读）。 */
export function loadFormIds(filesDir: string): string[] {
  const path: string = `${filesDir}/dsh/home/form-ids.json`;
  try {
    if (!fs.accessSync(path)) return [];
    const parsed = JSON.parse(fs.readTextSync(path)) as string[];
    return Array.isArray(parsed) ? parsed.filter((x: string): boolean => typeof x === 'string' && x.length > 0) : [];
  } catch (e) {
    return [];
  }
}

/** 覆盖写 formId 列表（调用方负责去重）。 */
export function saveFormIds(filesDir: string, ids: string[]): void {
  const path: string = `${filesDir}/dsh/home/form-ids.json`;
  const tmp: string = path + '.tmp';
  try {
    const f: fs.File = fs.openSync(tmp, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
    fs.writeSync(f.fd, JSON.stringify(ids));
    fs.closeSync(f);
    fs.renameSync(tmp, path);
  } catch (e) {
    // 卡片列表落盘失败只影响推送，不影响卡片首帧
  }
}
