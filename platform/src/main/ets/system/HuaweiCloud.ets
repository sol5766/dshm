/**
 * 华为账号（Account Kit）的**能力封装**。
 *
 * ── 2026-10-30 生产清理（docs/313 批次 A）────────────────────────────────
 * 本文件**曾经**还包装了 `cloudStorage`（开发者云存储）的上传/下载/列表/删除，
 * 那是 docs/298 时期的 Drive 路线探路代码。该路线需要 AGC 建存储实例（bucket），
 * 已按 [`docs/307`](../docs/307-官方答复落地分析（Asset资产端云同步架构）.md) 决策
 * **放弃**，改走 ArkData 端云同步 + Asset 资产通道 ⇒ 那些包装与验证页一并删除，
 * 不再保留"跑起来必然失败"的死代码。
 *
 * ── 现存职责 ─────────────────────────────────────────────────────────────
 * · `huaweiAccountCapability()`   —— Account Kit 的 syscap 探测（可降级）；
 * · `silentSignIn()`              —— 用户确认后的交互登录：必要时拉起华为账号登录页，
 *                                    返回应用后校验 state 并取 UnionID；失败给出可读原因；
 * · `fetchAccountDisplayName()`   —— **账号展示名**（docs/378）：profile scope 拿昵称，
 *                                    未设昵称时官方返回匿名手机号/邮箱；
 * · `maskAccountLabel()`          —— 展示名二次脱敏（任何情况下不出口明文手机号/邮箱）；
 * · `maskUnionId()`               —— UnionID 脱敏（**仅供诊断，不再上 UI**）；
 * · `deviceSummary()`             —— 设备/系统摘要（诊断与报告用）。
 *
 * ── 分层纪律（与 `ShareBoard.ets` / `FilePreview.ets` 同一套）────────────────
 * · 只提供**机制**，不含产品策略（什么时候登录、同步什么 —— 全在调用方）；
 * · **不抛异常出口**：一律 catch 后返回结果对象，让 UI 决定怎么提示；
 * · **能力探测优先**：`canIUse` 不过就整条静默降级，不弹窗、不报错刷屏。
 *
 * ── 凭据纪律 ─────────────────────────────────────────────────────────────
 * 登录凭据（`authorizationCode` / `idToken`）**只在内存**、只在回调里短暂持有；
 * 本文件不落盘、不打日志原文。`fetchAccountDisplayName()` **不设 permissions**，
 * 因此连 `authorizationCode` 都不会返回 —— 读取资料与持有凭据是两件事。
 *
 * ── 权限面铁律（docs/378）─────────────────────────────────────────────────
 * 只用 `profile` scope：官方《获取头像昵称》指南明文「此场景无需申请账号权限」。
 * `phone` / `quickLoginAnonymousPhone` / `email` scope 需要 AGC 单独申请账号权限
 * （且「获取您的手机号」仅游戏类应用、企业开发者可申请）⇒ **一律不接、不预留分支**。
 * 明文手机号 REST 接口还要求开发者服务器，本应用是纯端侧 ⇒ 同样不接。
 *
 * @module platform/system/HuaweiCloud
 */
import { authentication } from '@kit.AccountKit';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';

const DOMAIN: number = 0xD5A2;
const TAG: string = 'platform/huawei-cloud';

/** 一个能力是否可用：不可用时 `reason` 必须能被人读懂（不许只回 false）。 */
export interface Capability {
  supported: boolean;
  reason: string;
}

/**
 * 华为账号登录能力探测。
 *
 * 判据用 `SystemCapability.AuthenticationServices.HuaweiID.UIComponent`
 * （`LoginWithHuaweiIDButton` 声明的 syscap 逐字）。
 */
export function huaweiAccountCapability(): Capability {
  try {
    if (!canIUse('SystemCapability.AuthenticationServices.HuaweiID.UIComponent')) {
      return { supported: false, reason: '本设备不支持华为账号登录组件（缺少 HuaweiID.UIComponent）' };
    }
    return { supported: true, reason: '' };
  } catch (e) {
    return { supported: false, reason: `能力探测异常：${(e as BusinessError).message}` };
  }
}

/** 把凭据转成"可以安全展示"的形态（只留尾 4 位）。【仅供诊断，不再上 UI】 */
export function maskUnionId(unionID: string): string {
  const v: string = unionID === undefined || unionID === null ? '' : String(unionID);
  if (v.length <= 4) {
    return v.length === 0 ? '(空)' : '****';
  }
  return `****${v.slice(v.length - 4)}`;
}

/**
 * 账号展示名的二次脱敏（docs/378）。
 *
 * 【为什么要再来一层】官方 `profile` scope 返回的 `nickName`，在用户未设置昵称时
 * 是"华为账号绑定的匿名手机号/邮箱"（官方已脱敏，形如 `182******74`）；但用户
 * **可能设置了昵称**，昵称里也可能恰好写了手机号或邮箱。⇒ 不信任上游返回值，
 * 出口前统一按形态再脱敏一次，保证任何情况下都不会把明文手机号/邮箱送到 UI。
 *
 * 形态判定：
 *   · 含 `@` ⇒ 邮箱：`abc@example.com` → `a***@example.com`；官方匿名邮箱本身已含
 *     `***`，走同一分支后仍是脱敏串（幂等）。
 *   · 纯数字/带国际冠码 ⇒ 手机号：`13812345678` → `138****5678`。
 *   · 其它（昵称、官方匿名串 `182******74`，数字位不足 7）⇒ 原样限长返回。
 */
export function maskAccountLabel(raw: string): string {
  const v: string = String(raw === undefined || raw === null ? '' : raw).trim();
  if (v.length === 0) {
    return '';
  }
  const at: number = v.indexOf('@');
  if (at > 0 && at < v.length - 1) {
    return v.slice(0, 1) + '***@' + v.slice(at + 1);
  }
  const digits: string = v.replace(/[^0-9]/g, '');
  if (digits.length >= 7 && /^[+0-9][0-9\s\-()]*$/.test(v)) {
    const plus: string = v.startsWith('+') ? '+' : '';
    return plus + digits.slice(0, 3) + '****' + digits.slice(digits.length - 4);
  }
  /* 昵称或官方已脱敏串：只限长，不改动（避免把 `182******74` 再糊一次） */
  return v.length > 24 ? v.slice(0, 24) : v;
}

/** 账号展示名读取结果；`ok=false` 时 `label` 恒为空串，调用方据此降级。 */
export interface AccountDisplayNameResult {
  ok: boolean;
  /** 已二次脱敏、可直接上 UI 的展示名 */
  label: string;
  /** 失败原因（人话，不含任何凭据） */
  reason: string;
  /** 原始错误码（诊断用，可 0） */
  code: number;
}

/**
 * 读取华为账号的**展示名**（昵称 / 匿名手机号 / 匿名邮箱）。
 *
 * ── 为什么这条路能显示"手机号或邮箱"（docs/378 查证结论）────────────────
 * 官方《获取头像昵称》指南原文：「未设置昵称默认返回华为账号绑定的匿名手机号/邮箱」，
 * 且「此场景无需申请账号权限」（只需已配置签名指纹与 Client ID —— 静默登录能跑通
 * 即说明这两项已就绪，见 docs/302 的 `Client ID = 6917614360926110054`）。
 * 用户反馈「显示的很像内部代号」指的是旧 UI 的 `****abcd`（脱敏 UnionID），
 * 而 `nickName` 正是用户自己认识的账号形态。
 *
 * ── 交互口径 ────────────────────────────────────────────────────────────
 * `forceAuthorization = true` 跟随官方示例：用户**首次**未授权过 profile 时，
 * 系统会拉起一次授权页；授权过之后本调用即静默返回。该调用只在用户点过
 * 「登录」确认框之后发生，不是启动即弹。拒绝授权 / 设备不支持 / 未配置 ⇒ 一律
 * 如实降级为「华为账号（已登录）」，**绝不退回显示 `****abcd`**。
 *
 * ── 凭据纪律 ────────────────────────────────────────────────────────────
 * 只设 `scopes = ['profile']`，**不设 permissions** ⇒ 不返回 `authorizationCode`
 * 与 `idToken`，本函数也不读这两个字段。`state` 用一次性随机串并校验回包，
 * 防跨站伪造。失败原因里不含任何凭据原文。
 *
 * @param context 壳层的 UIAbilityContext（必须传，否则系统组件可能 401）
 * @returns 结果对象（**永不抛异常**；`ok=false` 时调用方按 `reason` 降级）
 */
export async function fetchAccountDisplayName(
  context?: common.UIAbilityContext
): Promise<AccountDisplayNameResult> {
  const unsupported: AccountDisplayNameResult = {
    ok: false,
    label: '',
    reason: '本设备不支持读取华为账号展示名',
    code: 0
  };
  try {
    if (!canIUse('SystemCapability.AuthenticationServices.HuaweiID.Auth')) {
      return unsupported;
    }
    const request: authentication.AuthorizationWithHuaweiIDRequest =
      new authentication.HuaweiIDProvider().createAuthorizationWithHuaweiIDRequest();
    /* 权限面铁律：只这一个 scope，不接 phone / email / quickLoginAnonymousPhone */
    request.scopes = ['profile'];
    request.forceAuthorization = true;
    request.state = util.generateRandomUUID();
    const controller: authentication.AuthenticationController =
      context === undefined || context === null
        ? new authentication.AuthenticationController()
        : new authentication.AuthenticationController(context);
    const response: authentication.AuthorizationWithHuaweiIDResponse =
      await controller.executeRequest(request) as authentication.AuthorizationWithHuaweiIDResponse;
    /* state 一致性：响应带回 state 就必须与请求一致，否则丢弃整包 */
    const returned: string = response.state === undefined || response.state === null
      ? '' : String(response.state);
    if (returned.length > 0 && returned !== String(request.state)) {
      return { ok: false, label: '', reason: '账号资料响应校验未通过', code: 0 };
    }
    const credential: authentication.AuthorizationWithHuaweiIDCredential | undefined = response?.data;
    if (credential === undefined || credential === null) {
      return { ok: false, label: '', reason: '未获得账号资料授权', code: 0 };
    }
    const raw: string = credential.nickName === undefined || credential.nickName === null
      ? '' : String(credential.nickName);
    const label: string = maskAccountLabel(raw);
    if (label.length === 0) {
      return { ok: false, label: '', reason: '账号未返回可用的展示名', code: 0 };
    }
    return { ok: true, label: label, reason: '', code: 0 };
  } catch (e) {
    const err: BusinessError = e as BusinessError;
    const code: number = err === undefined || err === null || err.code === undefined ? 0 : Number(err.code);
    return { ok: false, label: '', reason: `未读取到账号展示名（code=${code}）`, code: code };
  }
}

/** 设备与运行时读数（验证页顶部展示，便于测试端回传现场）。 */
export function deviceSummary(): string {
  /*
   * 【为什么逐项 try】`deviceInfo` 的个别字段在老设备/新 API 上可能不存在；
   * 一次读全会让"型号读不到"变成"整块读数失败"。与 `DeviceFacts.safeString` 同立场。
   */
  let api: string = '?';
  let market: string = '?';
  let model: string = '?';
  try { api = `${deviceInfo.sdkApiVersion}`; } catch (e) { api = '?'; }
  try { market = String(deviceInfo.marketName); } catch (e) { market = '?'; }
  try { model = String(deviceInfo.productModel); } catch (e) { model = '?'; }
  return `API ${api} · ${market} · ${model}`;
}


// ───────────────────────── 静默登录（docs/322 方案 C）─────────────────────────

/**
 * 静默登录的结果。
 *
 * 【为什么用一个显式的 kind 而不是只回 unionID】调用方要决定"提示什么、还允许做什么"：
 *   · `ok`            —— 拿到身份，直接进已登录态；
 *   · `not_signed_in` —— 系统里没有登录华为账号（错误码 1001502001）：这是**最常见的正常分支**，
 *                        应提示"请先在系统里登录华为账号"，而不是弹登录页；
 *   · `unsupported`   —— 设备/版本不具备该 API：退回提示"本设备不支持静默登录"；
 *   · `failed`        —— 其它错误（网络、协议、签名）：如实显示原因，允许重试。
 */
export enum SilentSignInKind {
  OK = 'ok',
  CANCELED = 'canceled',
  NOT_SIGNED_IN = 'not_signed_in',
  UNSUPPORTED = 'unsupported',
  FAILED = 'failed'
}

/** 华为账号登录结果；`unionId` 只在 `kind === OK` 时有值，且**不落盘、不打日志**。 */
export interface SilentSignInResult {
  kind: SilentSignInKind;
  unionId: string;
  /** 给用户看的一句话（`OK` 时为空） */
  reason: string;
  /** 原始错误码（诊断用，可 0） */
  code: number;
}

/** 系统未登录华为账号的错误码（SDK 明文：`1001502001`）。 */
const ERR_NOT_SIGNED_IN: number = 1001502001;

/**
 * 用户确认后的华为账号登录：需要时拉起系统登录/授权页，完成后返回本应用。
 *
 * Account Kit 的 `LoginWithHuaweiIDRequest.forceLogin = true` 会在系统账号未登录或
 * 尚未授权时显示官方登录/授权页面；`executeRequest()` 完成后由 Promise 返回调用方。
 *
 * ── 安全口径 ──────────────────────────────────────────────────────────────
 * · 只取 `unionID`（跨应用稳定、用于同步归属），**不请求 profile 头像昵称**；
 * · `authorizationCode` / `idToken` **不取、不存、不上报**（本函数不读这两个字段）；
 * · 失败原因里不含任何凭据；`code` 只是数字。
 *
 * 【必须传 context（2026-10-31 真机日志实证）】`AuthenticationController(context?)` 的
 * context 是可选参数，但**不传就会出现**：
 *   `huaweiId_framewrok_base: AuthenticationControllerConstructor argc is empty.`
 * 而 SDK 原文写着——"This parameter is mandatory when the HUAWEI ID sign-in and
 * authorization screens need to be started"，且缺它时执行请求会返回 **401**。
 * 系统需要拉起登录/授权组件时仍要这个 context，
 * 所以**必须**从壳层传进来。
 *
 * @param context 壳层的 UIAbilityContext（缺省时仍会尝试，但可能 401，属如实降级）
 * @returns 结果对象（**永不抛异常**，调用方按 `kind` 分派）
 */
export async function silentSignIn(context?: common.UIAbilityContext): Promise<SilentSignInResult> {
  const unsupported: SilentSignInResult = {
    kind: SilentSignInKind.UNSUPPORTED,
    unionId: '',
    reason: '本设备不支持华为账号登录',
    code: 0
  };
  try {
    if (!canIUse('SystemCapability.AuthenticationServices.HuaweiID.Auth')) {
      return unsupported;
    }
    const request: authentication.LoginWithHuaweiIDRequest =
      new authentication.HuaweiIDProvider().createLoginWithHuaweiIDRequest();
    request.forceLogin = true;
    request.state = util.generateRandomUUID();
    const controller: authentication.AuthenticationController =
      context === undefined || context === null
        ? new authentication.AuthenticationController()
        : new authentication.AuthenticationController(context);
    const response: authentication.LoginWithHuaweiIDResponse = await controller.executeRequest(request);
    const returnedState: string = response.state === undefined || response.state === null
      ? '' : String(response.state);
    if (returnedState !== String(request.state)) {
      return { kind: SilentSignInKind.FAILED, unionId: '', reason: '账号登录响应校验未通过', code: 0 };
    }
    const credential: authentication.LoginWithHuaweiIDCredential | undefined = response?.data;
    if (credential === undefined || credential === null || credential.unionID === undefined) {
      return { kind: SilentSignInKind.FAILED, unionId: '', reason: '登录未返回账号标识', code: 0 };
    }
    const unionId: string = String(credential.unionID);
    if (unionId.length === 0) {
      return { kind: SilentSignInKind.FAILED, unionId: '', reason: '登录返回的账号标识为空', code: 0 };
    }
    return { kind: SilentSignInKind.OK, unionId: unionId, reason: '', code: 0 };
  } catch (e) {
    const err: BusinessError = e as BusinessError;
    const code: number = err === undefined || err === null || err.code === undefined ? 0 : Number(err.code);
    if (code === 1001502012) {
      return { kind: SilentSignInKind.CANCELED, unionId: '', reason: '已取消华为账号登录', code: code };
    }
    if (code === ERR_NOT_SIGNED_IN) {
      return {
        kind: SilentSignInKind.NOT_SIGNED_IN,
        unionId: '',
        reason: '华为账号尚未登录，请重试或在系统设置中登录',
        code: code
      };
    }
    const msg: string = err === undefined || err === null || err.message === undefined ? '未知错误' : err.message;
    return { kind: SilentSignInKind.FAILED, unionId: '', reason: `华为账号登录失败：${msg}`, code: code };
  }
}
