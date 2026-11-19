/**
 * 云同步的**动作面**：两个原生壳（`entry` 与 `phone`）共用的同一份判据。
 *
 * ── 为什么单独抽出来（2026-10-30，docs/320）────────────────────────────
 * 「设置 → 云同步」分区是**网页侧**渲染的，它只认一组动作名
 * （`login` / `signout` / `enable` / `disable` / `upload` / `pull` / `restore`）。
 * 这些动作在 `entry` 与 `phone` 两个壳里**必须给出完全相同的判定与答复**：
 * 什么情况下受理、什么情况下拒绝、拒绝时对用户说什么话。
 *
 * 如果两个壳各写一份，漂移是必然的 —— 而且漂移的表现极其隐蔽：
 * 同一个按钮在一台设备上是"请先登录"，在另一台上是"点了没反应"。
 * 所以把**纯判定**收到这里，壳只负责"按判定去做那件事"（开面板 / 跑任务）。
 *
 * ── 边界 ───────────────────────────────────────────────────────────────
 * 本模块**不碰任何设备能力**：不发登录、不跑同步、不开面板，
 * 只吃一个状态快照、吐一个决定。因此它可以被离线门禁真跑（见
 * `tools/check-cloud-sync-plugin.mjs` 的壳层部分）。
 *
 * @module sync/SyncActions
 */

/** 桥接面的动作名（与网页侧插件发来的字符串**逐字一致**；改名 = 两侧同时改）。 */
export const CLOUD_ACTION_LOGIN: string = 'login';
export const CLOUD_ACTION_SIGNOUT: string = 'signout';
export const CLOUD_ACTION_ENABLE: string = 'enable';
export const CLOUD_ACTION_DISABLE: string = 'disable';
export const CLOUD_ACTION_UPLOAD: string = 'upload';
export const CLOUD_ACTION_PULL: string = 'pull';
export const CLOUD_ACTION_RESTORE: string = 'restore';

/** 判定代码（壳按它分派；**不是**给用户看的文案）。 */
export enum CloudActionCode {
  ACCEPTED = 'accepted',
  UNKNOWN = 'unknown',
  NOT_SIGNED_IN = 'not_signed_in',
  BUSY = 'busy',
  DISABLED = 'disabled'
}

/** 判定结果。 */
export interface CloudActionDecision {
  ok: boolean;
  code: CloudActionCode;
  /** 给用户的一句话（受理时是"正在做什么"，拒绝时是原因） */
  message: string;
}

/** 判定所需的**事实**（由壳从 `SyncEngine` 读出来，本模块不自己去读）。 */
export interface CloudActionFacts {
  signedIn: boolean;
  enabled: boolean;
  running: boolean;
}

/**
 * 判定一个动作。
 *
 * 【判据与顺序】未登录 → 正忙 → （上传要求）已开启 → 受理。
 * 顺序是有意义的：先说"请先登录"比说"已有任务在进行"更有用；
 * 而"正忙"放在"未开启"前面，是因为用户此刻最该知道的是"在跑着呢"。
 *
 * 【为什么上传要"已开启"而拉取不要】开启云同步代表"允许把本机数据传上去"；
 * 拉取只是取回云端内容，不涉及上传，因此不受该开关约束（与入口面板同一口径）。
 *
 * @param action 网页侧发来的动作名（大小写敏感、逐字比较）
 * @param facts 当前事实快照
 * @returns 判定；`ok:false` 时 `message` 必须能直接显示给用户（不得为空串）
 */
export function decideCloudAction(action: string, facts: CloudActionFacts): CloudActionDecision {
  const a: string = action === undefined || action === null ? '' : String(action).trim();
  const signedIn: boolean = facts.signedIn === true;
  const enabled: boolean = facts.enabled === true;
  const running: boolean = facts.running === true;

  if (a === CLOUD_ACTION_LOGIN) {
    /*
     * 【2026-10-31 修复（docs/323）】**登录不再打开任何面板**。
     *
     * 旧判定是"受理 = 请壳去开原生面板"——那是 `LoginPanel` 时代的产物：
     * 官方登录面板只能渲染在 ArkTS 页面里，所以必须先把面板拉起来。
     * 改成静默授权后这条前提已经不存在：`silentSignIn()` 在**当前进程内**就能完成，
     * 不需要任何界面。而用户的原话是「点击登录的时候会跳转一个二级菜单，不需要这样，
     * 直接在设置 UI 里面完成」—— 壳若还置 `cloudSyncOpen = true`，整屏面板照旧盖下来，
     * 诉求就没被真正满足。
     *
     * ⇒ 现在 login 的语义是"**就地静默登录**"：壳只调 `silentSignIn()`，
     * 成功后状态经 `cloudSyncState()` 回流，分区自然变成已登录态；失败就地显示原因。
     */
    return { ok: true, code: CloudActionCode.ACCEPTED, message: '正在登录华为账号…' };
  }
  if (a === CLOUD_ACTION_SIGNOUT) {
    /* 退出是纯内存动作，任何时候都允许（即便正在同步：任务会随状态下一次读取落到"请先登录"） */
    return { ok: true, code: CloudActionCode.ACCEPTED, message: '已退出华为账号' };
  }
  if (a === CLOUD_ACTION_ENABLE) {
    if (!signedIn) {
      return { ok: false, code: CloudActionCode.NOT_SIGNED_IN, message: '请先登录华为账号' };
    }
    return { ok: true, code: CloudActionCode.ACCEPTED, message: '已开启云同步' };
  }
  if (a === CLOUD_ACTION_DISABLE) {
    return { ok: true, code: CloudActionCode.ACCEPTED, message: '已关闭云同步' };
  }
  if (a === CLOUD_ACTION_UPLOAD || a === CLOUD_ACTION_PULL) {
    if (!signedIn) {
      return { ok: false, code: CloudActionCode.NOT_SIGNED_IN, message: '请先登录华为账号' };
    }
    if (running) {
      return { ok: false, code: CloudActionCode.BUSY, message: '已有同步任务在进行' };
    }
    if (a === CLOUD_ACTION_UPLOAD && !enabled) {
      return { ok: false, code: CloudActionCode.DISABLED, message: '请先开启云同步' };
    }
    return {
      ok: true,
      code: CloudActionCode.ACCEPTED,
      message: a === CLOUD_ACTION_UPLOAD ? '已开始上传' : '已开始拉取'
    };
  }
  if (a === CLOUD_ACTION_RESTORE) {
    /*
     * 插件恢复要**逐项勾选**，官方设置分区里没有现成的多选控件 ⇒
     * 受理 = 请壳打开原生面板的插件分组（那里有完整闭环）。
     */
    if (!signedIn) {
      return { ok: false, code: CloudActionCode.NOT_SIGNED_IN, message: '请先登录华为账号' };
    }
    return { ok: true, code: CloudActionCode.ACCEPTED, message: '请在设置面板里勾选要恢复的插件' };
  }
  return { ok: false, code: CloudActionCode.UNKNOWN, message: '未知动作：' + a };
}

/** 判定结果序列化成桥的返回值（`{"ok":…,"message":"…"}`）。 */
export function encodeCloudActionReply(d: CloudActionDecision): string {
  return JSON.stringify({ ok: d.ok, message: d.message });
}
