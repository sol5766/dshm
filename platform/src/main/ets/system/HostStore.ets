/**
 * Host 连接信息的持久化（「下次启动自动重连」的基础）。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 存在理由（D1 §7.1「多 Host 管理」+ D3 §1「添加 Host」）
 *   在此之前，**每次启动应用都要重新粘贴带 token 的启动链接**。
 *   这既是明显的产品缺口，也让真机验收极难复现（每次重启设备都要重新走一遍
 *   粘贴 → 授权 → 连接）。把「记住上次连上的 Host」做掉，是验收效率的前提。
 *
 * 【敏感与非敏感必须分开存】
 *   - **非敏感**（Host 地址、上次选中的会话 id）：`preferences` 明文。
 *     这些不是秘密——地址在本机 Host 场景下就是 `127.0.0.1:3111`。
 *   - **token**：走 `SecretStore`（Asset Store Kit / HUKS 之上），**不落明文**。
 *     D1 §6.4 明确要求 token 不得进明文文件。
 *   两者分成两个 store 而不是「一个 json 里放全部」，是为了让
 *   「哪些字段是敏感的」在代码结构上就成立——混在一起早晚会被顺手写进明文。
 *
 * 【token 与地址分开存的另一个理由】
 *   同一个地址可能换 token（Host 重启会重新生成 token，D2 §2.1），
 *   换 token 时不该丢掉「上次选的会话」等非敏感状态；反之亦然。
 * ────────────────────────────────────────────────────────────────────────
 */

import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { SecretLoadState, SecretStore } from './SecretStore';
import type { SecretLoadResult } from './SecretStore';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'platform/hoststore';
const STORE: string = 'dsh_host_state';

/** 上次连接过的 Host（非敏感部分） */
export interface RememberedHost {
  /** 形如 `http://127.0.0.1:3111`（不含 token，也不含尾斜杠） */
  baseUrl: string;
  /** 上次选中的会话 id（空串 = 无） */
  lastSessionId: string;
  /** 记录时间（毫秒），用于界面显示「上次连接」 */
  savedAt: number;
}

/** token 的读取结果——沿用 `SecretStore` 的三态，理由见那边 */
export interface RememberedToken {
  state: SecretLoadState;
  value: string;
}

/**
 * token 的存储别名。
 *
 * 【为什么别名里带地址】Host 重启会换 token（D2 §2.1：token 每个进程只生成一次）。
 * 若只用一个固定别名，连过 A 之后再连 B 会**覆盖** A 的 token；
 * 用户下次切回 A 时，客户端会拿 B 的 token 去认证 A——症状是 401，
 * 而用户会以为是 Host 的问题。按地址分别名让每个 Host 各自记住自己的 token。
 */
function tokenAlias(baseUrl: string): string {
  return `dsh-host-token:${baseUrl}`;
}

export class HostStore {
  private store?: preferences.Preferences;

  /** 绑定宿主上下文并打开偏好库；失败只记日志（不阻塞连接流程） */
  async attach(context: common.UIAbilityContext): Promise<void> {
    try {
      this.store = await preferences.getPreferences(context, STORE);
    } catch (err) {
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, 'open preferences failed: %{public}s', e.message);
      this.store = undefined;
    }
  }

  /** 记住一个 Host 的地址（token 由 `saveToken` 单独写入加密存储） */
  async saveHost(baseUrl: string, lastSessionId: string): Promise<void> {
    if (this.store === undefined) {
      return;
    }
    try {
      const record: RememberedHost = {
        baseUrl: baseUrl,
        lastSessionId: lastSessionId,
        savedAt: Date.now()
      };
      await this.store.put('last-host', JSON.stringify(record));
      await this.store.flush();
    } catch (err) {
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, 'saveHost failed: %{public}s', e.message);
    }
  }

  /**
   * 读取上次的 Host。
   *
   * 返回 `undefined` 表示「没有记录」或「记录坏了」——两种情况对调用方
   * 的处置相同（不要自动重连，显示「添加 Host」）。这里不再细分三态，
   * 因为非敏感数据读失败没有第二种含义。
   */
  async loadHost(): Promise<RememberedHost | undefined> {
    if (this.store === undefined) {
      return undefined;
    }
    try {
      const raw: string = await this.store.get('last-host', '') as string;
      if (raw.length === 0) {
        return undefined;
      }
      const parsed: RememberedHost = JSON.parse(raw) as RememberedHost;
      if (parsed.baseUrl === undefined || parsed.baseUrl.length === 0) {
        return undefined;
      }
      return {
        baseUrl: parsed.baseUrl,
        lastSessionId: parsed.lastSessionId === undefined ? '' : parsed.lastSessionId,
        savedAt: parsed.savedAt === undefined ? 0 : parsed.savedAt
      };
    } catch (err) {
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, 'loadHost failed: %{public}s', e.message);
      return undefined;
    }
  }

  /** 记住某个 Host 的 token（走加密存储） */
  async saveToken(baseUrl: string, token: string): Promise<boolean> {
    return SecretStore.save(tokenAlias(baseUrl), token);
  }

  /** 读取某个 Host 的 token */
  async loadToken(baseUrl: string): Promise<RememberedToken> {
    const result: SecretLoadResult = await SecretStore.load(tokenAlias(baseUrl));
    return { state: result.state, value: result.value };
  }

  /** 忘记某个 Host（地址 + token 一起清） */
  async forget(baseUrl: string): Promise<void> {
    await SecretStore.remove(tokenAlias(baseUrl));
    if (this.store === undefined) {
      return;
    }
    try {
      await this.store.delete('last-host');
      await this.store.flush();
    } catch (err) {
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, 'forget failed: %{public}s', e.message);
    }
  }
}
