/**
 * 敏感字符串的安全存储（**不落明文**，D1 §6.4 / POC-9 / S3）。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 存在理由
 *   Host 的访问 token 是本客户端最敏感的一件东西：持有它就等于持有 Host 的
 *   完整会话权限（D2 §2.1 的信任栅栏只为「有没有 cookie」把关）。
 *   一旦明文落在 `preferences` 里，任何能读到应用沙箱的应用或备份都能拿走它。
 *   D1 §6.4 因此明确要求：「设备密钥、签名 cookie、token 一律进 HUKS 加密存储
 *   （或 preferences + 加密），**不落明文文件**」。
 *
 * 为什么用 Asset Store Kit 而不是裸 HUKS
 *   Asset Store Kit（`@ohos.security.asset`）就是系统为「应用自己的口令/令牌」
 *   提供的封装：它在 HUKS 之上做了别名、可访问性、认证策略与自动加解密。
 *   裸 HUKS 需要自己管密钥别名、加密模式、IV 与失败恢复——多出来的每一步
 *   都是可能写错的地方，而且写错的方式通常是**悄悄退回明文**。
 *   这里选择「用系统的正确封装」，只保留一条纪律：**调用失败就当作没有存过**，
 *   绝不降级为明文（见 `load` 的失败分支）。
 *
 * 与 `preferences` 的分工
 *   - 非敏感数据（Host 地址、上次会话 id、窗口几何）走 `preferences`，明文无妨；
 *   - **只有 token 走本模块**。
 *   两者分开是为了让「哪些东西是敏感的」在代码结构上看得见——
 *   把它们混在一个 key-value store 里，早晚会有人顺手把 token 也放进去。
 * ────────────────────────────────────────────────────────────────────────
 */

import { asset } from '@kit.AssetStoreKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { util } from '@kit.ArkTS';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'platform/secret';

/**
 * 读取结果。
 *
 * 用三态而不是 `string | undefined`：**「没存过」与「读取失败」必须分开**。
 * 两者都返回空串的话，界面无法区分「首次使用，请填 token」与
 * 「token 在，但取不出来（例如设备锁屏策略变化）」——
 * 后者提示用户「重新粘贴 token」是错的，因为 token 还在，只是这次读不到。
 */
export enum SecretLoadState {
  /** 取到了值 */
  FOUND = 'found',
  /** 确认没有这条记录（首次使用） */
  ABSENT = 'absent',
  /** 有记录但读取失败（策略、锁屏状态、系统错误）；**不要**让用户重新输入 */
  UNAVAILABLE = 'unavailable'
}

/** 一次读取的结果 */
export interface SecretLoadResult {
  state: SecretLoadState;
  /** 仅 `FOUND` 时有效 */
  value: string;
}

/** 把字符串编码为 Asset Store 要求的 `Uint8Array` */
function toBytes(text: string): Uint8Array {
  const encoder: util.TextEncoder = new util.TextEncoder();
  return encoder.encode(text);
}

/** 把 `Uint8Array` 解码回字符串 */
function fromBytes(bytes: Uint8Array): string {
  const decoder: util.TextDecoder = util.TextDecoder.create('utf-8');
  return decoder.decodeToString(bytes);
}

/**
 * 敏感字符串的存取。
 *
 * 所有方法都**不抛异常**：调用方（连接流程）不应该因为一次存储系统故障
 * 而无法连接——但那也不意味着可以退回明文，所以失败只影响「会不会记住」，
 * 不影响「这次能不能连」。
 */
export class SecretStore {
  /**
   * 保存一个敏感字符串（覆盖同别名的旧值）。
   *
   * @param alias - 记录别名（如 `host-token:<authority>`）
   * @param value - 明文值（只在内存与本函数栈上存在）
   * @returns 是否保存成功；false 表示「这次没记住」，调用方**不应**因此报连接失败
   */
  static async save(alias: string, value: string): Promise<boolean> {
    try {
      // 先删后写：Asset Store 的 `add` 对已存在的别名会失败，
      // 而 `update` 在记录不存在时也会失败。先 remove（容忍不存在）再 add
      // 是唯一在两种状态下都成立的做法。
      await SecretStore.remove(alias);
      const attributes: asset.AssetMap = new Map<asset.Tag, asset.Value>();
      attributes.set(asset.Tag.ALIAS, toBytes(alias));
      attributes.set(asset.Tag.SECRET, toBytes(value));
      // DEVICE_UNLOCKED：解锁后才可读。选择它的理由：本应用的 token 用于
      // 后台长连接，而 DEVICE_FIRST_UNLOCKED 允许开机后未解锁即读取——
      // 那会让「设备被盗但未解锁」的场景也能取到 token。
      attributes.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_UNLOCKED);
      // AUTH_TYPE_NONE：不额外要求生物认证。连接是自动重连路径，
      // 每次弹认证会让「后台恢复连接」变得不可用；保护靠设备锁屏本身。
      attributes.set(asset.Tag.AUTH_TYPE, asset.AuthType.NONE);
      // 【不要设 IS_PERSISTENT】实测：带上它会得到 `201 The caller doesn't have
      // the permission`——该标签要求 `ohos.permission.STORE_PERSISTENT_DATA`，
      // 而那条权限只对系统应用开放。省略它即可正常读写（应用的普通资产本来
      // 就会随应用卸载而删除，这是期望行为）。
      await asset.add(attributes);
      return true;
    } catch (err) {
      const e = err as BusinessError;
      // 不降级为明文：宁可不记住，也不要把 token 写到明文 store 里
      hilog.warn(DOMAIN, TAG, 'secret save failed: code=%{public}d', e.code);
      return false;
    }
  }

  /**
   * 读取一个敏感字符串。
   *
   * **不返回 undefined**：调用方必须能区分「没存过」与「读不到」，见 `SecretLoadState`。
   */
  static async load(alias: string): Promise<SecretLoadResult> {
    try {
      const query: asset.AssetMap = new Map<asset.Tag, asset.Value>();
      query.set(asset.Tag.ALIAS, toBytes(alias));
      query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
      const found: asset.AssetMap[] = await asset.query(query);
      if (found.length === 0) {
        return { state: SecretLoadState.ABSENT, value: '' };
      }
      const secret: asset.Value | undefined = found[0].get(asset.Tag.SECRET);
      if (secret === undefined) {
        // 记录在但没有 SECRET：数据损坏。按「读不到」处理，不能当「没存过」
        hilog.warn(DOMAIN, TAG, 'secret record without SECRET field');
        return { state: SecretLoadState.UNAVAILABLE, value: '' };
      }
      return { state: SecretLoadState.FOUND, value: fromBytes(secret as Uint8Array) };
    } catch (err) {
      const e = err as BusinessError;
      // 24000002 = NOT_FOUND（正常：首次使用）
      if (e.code === 24000002) {
        return { state: SecretLoadState.ABSENT, value: '' };
      }
      hilog.warn(DOMAIN, TAG, 'secret load failed: code=%{public}d %{public}s', e.code, e.message);
      return { state: SecretLoadState.UNAVAILABLE, value: '' };
    }
  }

  /** 删除一个敏感字符串（容忍不存在） */
  static async remove(alias: string): Promise<void> {
    try {
      const query: asset.AssetMap = new Map<asset.Tag, asset.Value>();
      query.set(asset.Tag.ALIAS, toBytes(alias));
      await asset.remove(query);
    } catch (err) {
      const e = err as BusinessError;
      // 24000002 = NOT_FOUND：本来就不存在，是预期分支而不是错误
      if (e.code !== 24000002) {
        hilog.warn(DOMAIN, TAG, 'secret remove failed: %{public}s', e.message);
      }
    }
  }
}
