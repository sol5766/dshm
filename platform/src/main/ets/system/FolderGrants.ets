/**
 * 目录授权的**持久化与跨启动恢复**（手持档"侧边栏工作区文件"能不能用的真正开关）。
 *
 * ───────────────────────── 它解决什么 ─────────────────────────
 * 手机 / 平板上，用户用系统 picker 选的目录（例：`…/Download/harness`）对本应用的授权是
 * **进程级临时授权**：picker 授予的 URI 权限活在"这次进程"里，进程一结束就没了。宿主
 * （Node、`dsh-fs-local` 的裸 `node:fs`）与应用**同 UID、同进程**，因此它能不能 `readdir`
 * 那个目录，完全取决于这份授权还在不在 —— 这就是「选完目录当场可用、重启后文件页报
 * `cannot list …: permission denied`」的全部原因（真机原始读数见 docs/105）。
 *
 * 平台给了让授权跨启动的两步 API（`@ohos.fileshare`，`ohos.permission.FILE_ACCESS_PERSIST`
 * 是 **normal + system_grant**，本包已声明，见 module.json5 / SDK PermissionDefinitions.json）：
 *   ① `persistPermission()` —— 把用户这一次的选择**持久化**（重启后仍在）；
 *   ② `activatePermission()` —— 进程重启后把**已持久化**的授权**重新启用**。
 * 只做 ① 不做 ② 是本仓 2026-10-06 之前的形态：授权记下了、却没人重新启用 ⇒ 重启后照样读不到。
 *
 * ───────────────────────── 边界（不要越界）─────────────────────────
 *   · 本模块**只**管"用户选过的目录"这一件事。默认工作区（`Download/<包名>/`）不归它管：
 *     那是按**包名归属**的路径级授权（官方 FAQ `faqs-local-file-manager-67`），跨重启本来就有效。
 *   · 本模块**不做产品策略**：要不要因此采纳用户选的路径，由 `FilePicker` 决定；
 *     这里只如实回答"这份授权现在有效吗、重启后还认不认"。
 *   · 绝不为"让结果好看"而吞掉读数：每一步的 status（ok/超时/错误码）都落 `diag-folder-grants`。
 */

import { common } from '@kit.AbilityKit';
import { fileShare } from '@kit.CoreFileKit';
import { fileIo } from '@kit.CoreFileKit';
import { preferences } from '@kit.ArkData';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'platform/foldergrants';

/** 授权上限：用户换目录不会无限增长；超出的按"最久没用"淘汰（授权本身仍留在系统里）。 */
const MAX_GRANTS: number = 16;
/** 单步看门狗（ms）。本机实测 `persistPermission` 可能永不 settle（WebApp.ets 的历史读数），
 *  故每一步都必须带超时，否则"选完无反应"会以挂起的形式复现。 */
const STEP_TIMEOUT_MS: number = 3000;
/** 诊断文件名（在 `filesDir` 下，追加写；与 FilePicker/WebApp 的 diag 同一套口径）。 */
const DIAG_FILE: string = 'diag-folder-grants';
/** 偏好库与键（与 `LocalPrefs`/`WindowMemory` 同一个库、不同键）。 */
const STORE: string = 'dsh_folder_grants';
const KEY_GRANTS: string = 'grants';

/** 一条"用户选过的目录"登记。 */
export interface FolderGrant {
  /** picker 给的原始 URI（`file://docs/…`）；`activatePermission` 只认它，不认路径 */
  uri: string;
  /** URI 对应的真实路径（给人看；宿主按路径干活） */
  path: string;
  /** 最近一次登记时间（ms） */
  at: number;
}

/** 一次 `rememberFolderGrant` 的读数。 */
export interface GrantOutcome {
  /** 持久授权**是否已生效**：true = 现在能用，且重启后 `restoreFolderGrants()` 能把它启用回来 */
  persisted: boolean;
  /** 一行给人读的原始读数（各步 status / 错误码），失败时进提示文案与 diag */
  note: string;
}

/** 诊断标记：在 `filesDir` 追加一行「ISO 时间戳 + 详情」。写失败静默（诊断不碰业务路径）。 */
function diag(context: common.Context, line: string): void {
  try {
    const p: string = `${context.filesDir}/${DIAG_FILE}`;
    const f: fileIo.File = fileIo.openSync(p,
      fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.APPEND);
    fileIo.writeSync(f.fd, `${new Date().toISOString()} ${line}\n`);
    fileIo.closeSync(f);
  } catch (e) {
    hilog.warn(DOMAIN, TAG, '诊断写入失败：%{public}s', (e as Error).message);
  }
}

/** 读写的权限集合：读 + 写（宿主除了预览还要能改文件）。 */
function policyOf(uri: string): fileShare.PolicyInfo {
  const policy: fileShare.PolicyInfo = {
    uri: uri,
    operationMode: fileShare.OperationMode.READ_MODE | fileShare.OperationMode.WRITE_MODE
  };
  return policy;
}

/**
 * 给一个 Promise 套看门狗：超时返回 `undefined`（**不是**"失败"，调用方必须把两者分开记）。
 *
 * 【为什么不用 Promise.race 配 setTimeout 裸写在各处】超时与异常是两种不同的读数
 * （"服务没回"vs"服务明确拒绝"），散着写迟早会把它们合并成一句"失败了"。
 */
function withWatchdog<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  const wrapped: Promise<T | undefined> = work.then((v: T): T | undefined => v);
  const watchdog: Promise<undefined> = new Promise<undefined>((resolve: (v: undefined) => void): void => {
    setTimeout((): void => {
      resolve(undefined);
    }, ms);
  });
  return Promise.race<T | undefined>([wrapped, watchdog]);
}

/** 错误码的可读形式（`BusinessError.code` 是我们判断"哪一类拒绝"的唯一依据）。 */
function codeOf(e: Object): string {
  const err = e as BusinessError;
  return `${err.code} ${err.message}`;
}

/** 打开偏好库；失败返回 `undefined`（调用方按"没有登记"处理，不抛）。 */
async function openStore(context: common.Context): Promise<preferences.Preferences | undefined> {
  try {
    return await preferences.getPreferences(context, STORE);
  } catch (e) {
    hilog.warn(DOMAIN, TAG, '打开偏好库失败：%{public}s', codeOf(e as Object));
    return undefined;
  }
}

/** 读全部登记（无登记 / 读失败 / JSON 坏 ⇒ 空数组——不猜、不抛）。 */
export async function storedGrants(context: common.Context): Promise<FolderGrant[]> {
  const store: preferences.Preferences | undefined = await openStore(context);
  if (store === undefined) {
    return [];
  }
  try {
    const raw: string = await store.get(KEY_GRANTS, '[]') as string;
    const parsed: FolderGrant[] = JSON.parse(raw) as FolderGrant[];
    const out: FolderGrant[] = [];
    for (const g of parsed) {
      if (g !== undefined && g.uri !== undefined && g.uri.length > 0) {
        out.push({ uri: g.uri, path: g.path === undefined ? '' : g.path, at: g.at === undefined ? 0 : g.at });
      }
    }
    return out;
  } catch (e) {
    diag(context, `stored 读取失败（按空处理）：${codeOf(e as Object)}`);
    return [];
  }
}

/** 记一条登记（按 uri 去重、新的在前、超上限淘汰最旧）。返回是否落盘成功。 */
async function addStoredGrant(context: common.Context, uri: string, path: string): Promise<boolean> {
  const store: preferences.Preferences | undefined = await openStore(context);
  if (store === undefined) {
    return false;
  }
  try {
    const old: FolderGrant[] = await storedGrants(context);
    const kept: FolderGrant[] = [];
    for (const g of old) {
      if (g.uri !== uri) {
        kept.push(g);
      }
    }
    kept.unshift({ uri: uri, path: path, at: Date.now() });
    const list: FolderGrant[] = kept.length > MAX_GRANTS ? kept.slice(0, MAX_GRANTS) : kept;
    await store.put(KEY_GRANTS, JSON.stringify(list));
    await store.flush();
    return true;
  } catch (e) {
    hilog.warn(DOMAIN, TAG, '登记失败：%{public}s', codeOf(e as Object));
    return false;
  }
}

/**
 * 记住"用户选了哪个目录"：① 登记（跨启动的名单）→ ② `persistPermission` → ③ 查证。
 *
 * 【判据为什么是 `checkPersistentPermission` 而不是 `persistPermission` 没抛错】
 * 本机实测 `persistPermission` 有"永不 settle"的前科 ⇒ 没抛错不等于成功；而
 * `checkPersistentPermission()` 是**问系统"这条 URI 的持久授权在不在"**，是同一件事的
 * 正面回答。采纳与否以它为准（见 `FilePicker` 的判据）。
 */
export async function rememberFolderGrant(context: common.Context,
  uri: string, path: string): Promise<GrantOutcome> {
  if (uri.length === 0) {
    return { persisted: false, note: 'uri 为空' };
  }
  const stored: boolean = await addStoredGrant(context, uri, path);
  const notes: string[] = [stored ? '登记=ok' : '登记=失败'];
  const policy: fileShare.PolicyInfo = policyOf(uri);
  // ① 持久化
  try {
    // 把"settle 了"归一成 `true`：本步只关心**看门狗内回没回**（回什么都不影响判据，
    // 判据是下面 ② 的 check —— 见函数头注释）。
    const settled: boolean | undefined = await withWatchdog(
      fileShare.persistPermission([policy]).then((): boolean => true), STEP_TIMEOUT_MS);
    notes.push(settled === undefined ? 'persist=超时' : 'persist=ok');
  } catch (e) {
    notes.push(`persist=失败(${codeOf(e as Object)})`);
  }
  // ② 查证（唯一判据）
  let persisted: boolean = false;
  try {
    const r: boolean[] | undefined =
      await withWatchdog(fileShare.checkPersistentPermission([policy]), STEP_TIMEOUT_MS);
    if (r === undefined) {
      notes.push('check=超时');
    } else {
      persisted = r.length > 0 && r[0] === true;
      notes.push(`check=[${r.join(',')}]`);
    }
  } catch (e) {
    notes.push(`check=失败(${codeOf(e as Object)})`);
  }
  const note: string = notes.join(' ');
  diag(context, `remember persisted=${persisted ? 'true' : 'false'} path=${path} uri=${uri} ${note}`);
  hilog.info(DOMAIN, TAG, '目录授权：persisted=%{public}s %{public}s', persisted ? 'true' : 'false', note);
  return { persisted: persisted, note: note };
}

/**
 * 启动期把**已登记**的目录授权重新启用（`activatePermission`）。
 *
 * 【为什么逐个调而不是一次传一批】`activatePermission` 对一条没有持久授权的 URI 会整批抛错
 * （13900001 一类），一批里混进一条失效登记就会把**其余有效的**一起拖垮。逐个调 + 逐条记
 * 读数，既不会互相牵连，`diag-folder-grants` 里也能看出**具体是哪一条**失活。
 *
 * @returns 一行汇总（给启动日志用）
 */
export async function restoreFolderGrants(context: common.Context): Promise<string> {
  const list: FolderGrant[] = await storedGrants(context);
  if (list.length === 0) {
    diag(context, 'restore：无已登记目录（跳过）');
    return '无已登记目录';
  }
  let ok: number = 0;
  const details: string[] = [];
  for (const g of list) {
    let line: string = '';
    try {
      const settled: boolean | undefined = await withWatchdog(
        fileShare.activatePermission([policyOf(g.uri)]).then((): boolean => true), STEP_TIMEOUT_MS);
      if (settled === undefined) {
        line = '超时';
      } else {
        line = 'ok';
        ok += 1;
      }
    } catch (e) {
      line = `失败(${codeOf(e as Object)})`;
    }
    details.push(`${g.path}=${line}`);
  }
  const summary: string = `${ok}/${list.length} 已启用`;
  diag(context, `restore ${summary}：${details.join(' | ')}`);
  hilog.info(DOMAIN, TAG, '目录授权：启动恢复 %{public}s', summary);
  return `${summary}（${details.join(' | ')}）`;
}
