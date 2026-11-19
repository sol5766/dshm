/**
 * 本机文件选择与读取（附件「投喂」的端侧那一半）。
 *
 * ───────────────────────── 这一层为什么必须存在 ─────────────────────────
 * 上游的附件链路是两段：
 *   1. `fileUploads/upload`（我们发 base64）→ 得到**不透明回执** `receiptId`；
 *   2. 把回执照放进 `session/prompt.request.content[].type='file'`。
 * 第 2 段在 `appstate/model/Wire.ets` 里早就写好了（`filePart()` / `projectFileUpload()`），
 * 缺的一直是第 1 段的**输入**：把用户选中的本机文件变成 base64。
 * 没有这一层时，界面上的「附件」按钮只能塞一个编造的文件名（历史上就是这么做的），
 * 或者静默无反应——两者都在骗人。
 *
 * ───────────────────────── 为什么在这里做而不是在 UI 里 ─────────────────────────
 * 选择器、文件 IO、base64 都是**设备能力**，不是产品策略；UI 只应决定
 * 「什么时候问用户要文件」，不应知道 `picker`/`fileIo` 的用法。
 * 与 `Clipboard` / `SecretStore` 同一立场。
 *
 * ───────────────────────── 一条纪律：绝不静默失败 ─────────────────────────
 * `PickOutcome` 把「用户取消」「文件过大」「读取失败」分成三种**明确结果**。
 * 合并成 `undefined` 会让 UI 无法区分「用户按了取消」与「读取真的失败了」——
 * 前者不该提示任何错误，后者必须提示，否则用户会以为文件已经带上了。
 */

// 【2026-10-03 改：不再需要 abilityAccessCtrl】本文件已**不申请任何权限**（见下方
// 权限说明注释）。`common` 仍用于选择器上下文，`bundleManager` 仍用于定位
// `Download/<包名>/`；原先导入的那两个权限类型也已一并删除。
import { abilityAccessCtrl, common, bundleManager } from '@kit.AbilityKit';
import type { PermissionRequestResult, Permissions } from '@kit.AbilityKit';
import { Environment, picker } from '@kit.CoreFileKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { fileUri } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
// 形态事实（手机/平板 vs 2in1）：判据只对前者收口，见 isHandheldForm() 的长注释。
import { FormFactor, readDeviceFacts, isFoldableDevice } from './DeviceFacts';
// 目录授权的持久化与跨启动恢复：手持档"选完能读、重启也能读"的唯一开关，见 docs/105。
import { GrantOutcome, rememberFolderGrant } from './FolderGrants';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'platform/filepicker';
const FOLDER_SELECTION_SYSCAP: string = 'SystemCapability.FileManagement.UserFileService.FolderSelection';

/**
 * 当前设备是否真的有系统文件夹选择能力。
 *
 * 该能力在 2in1 上从 API 13 可用，但 phone / tablet 到 API 26 才进入系统能力表。
 * 不能只看 API 版本：同为 API 23，2in1 可用而手机/平板不可用。
 */
export function folderSelectionAvailable(): boolean {
  try {
    return canIUse(FOLDER_SELECTION_SYSCAP);
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, '系统目录选择能力查询失败，按不可用处理：code=%{public}d msg=%{public}s',
      e.code, e.message);
    return false;
  }
}

/** 把用户最终选中的公共目录映射到声明里的 user_grant 权限。 */
function publicDirectoryPermission(path: string): Permissions | undefined {
  const normalized: string = path.replace(/\\/g, '/').toLowerCase();
  if (normalized.indexOf('/documents') >= 0) {
    return 'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY';
  }
  if (normalized.indexOf('/download') >= 0) {
    return 'ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY';
  }
  if (normalized.indexOf('/desktop') >= 0) {
    return 'ohos.permission.READ_WRITE_DESKTOP_DIRECTORY';
  }
  return undefined;
}

/**
 * 用户选中公共目录后按需申请对应 user_grant，并用 Environment 的正向读数确认生效。
 * 手机 HAP 不声明三条公共目录权限，因此直接跳过；不做启动期批量弹窗。
 */
export async function requestPublicDirectoryPermission(context: common.Context,
  path: string): Promise<boolean> {
  const facts = readDeviceFacts();
  if (facts.form === FormFactor.PHONE || facts.form === FormFactor.UNKNOWN) {
    return false;
  }
  const permission: Permissions | undefined = publicDirectoryPermission(path);
  if (permission === undefined) {
    return false;
  }
  try {
    const manager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
    const result: PermissionRequestResult =
      await manager.requestPermissionsFromUser(context, [permission]);
    const granted: boolean = result.authResults.length > 0 && result.authResults[0] === 0;
    if (!granted) {
      hilog.info(DOMAIN, TAG, '公共目录权限未授予：%{public}s', permission);
      return false;
    }
    let publicDir: string = '';
    if (permission === 'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY') {
      publicDir = Environment.getUserDocumentDir();
    } else if (permission === 'ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY') {
      publicDir = Environment.getUserDownloadDir();
    } else {
      publicDir = Environment.getUserDesktopDir();
    }
    hilog.info(DOMAIN, TAG, '公共目录权限已授予：%{public}s pathLen=%{public}d',
      permission, publicDir.length);
    return publicDir.length > 0;
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, '公共目录权限申请失败（沿用 picker 授权）：%{public}s code=%{public}d',
      e.message, e.code);
    return false;
  }
}

/** 文件夹选择器错误码是否表示用户主动取消（不是故障，不能触发默认工作区切换）。 */
export function isFolderPickerCancelCode(code: number): boolean {
  // 13900020 = 参数错误（部分系统用它表示用户取消）；其他实现直接给 0/undefined。
  return code === 13900020 || code === 0;
}

/**
 * 手持档文件夹选择器的统一兜底判据。
 *
 * Kirin 平板 / 手机在部分 ROM 上会先让能力预检为真，随后 select() 才返回
 * 801、202 或厂商自定义错误码。除用户主动取消外，结果都相同：该设备拿不到
 * 可用的文件夹选择授权，直接使用现有的 Download/<bundle> 工作区。
 */
export function shouldAutoFallbackFolderPicker(code: number, handheld: boolean): boolean {
  return handheld && !isFolderPickerCancelCode(code);
}

/**
 * ── 本路线**不申请任何权限**（2026-10-03 定稿，就地更正上一版方案）──
 *
 * 上一版曾计划额外声明并运行时申请**两条 Download / Documents 目录权限**
 * （权限名见 `dsh-移植研究/30-DSHM文件能力植入-侦察与设计.md` §4.2 的"已废弃"一行），
 * 以换取任意 Download/Documents 子树的**路径级**读写。**该方案已废弃**，两条硬理由：
 *
 *   ① 【权限面恒 8 条】本包的 `requestPermissions` 只有 **8 条**（已获批的 2 条 ACL +
 *      6 条免申请权限），见 `entry/src/main/module.json5` 的"权限面铁律"。多声明任何
 *      一条受限条目都会破坏与发布 profile 的对齐 ⇒ 设备侧 `PERMISSION_ACL_RULE` 拒装。
 *   ② 【ACL 审批面只有已获批的 2 条】用户的 AGC profile
 *      （`.cert-work/com_dshm_dshclient.p7b`）`acls.allowed-acls` 只有
 *      `FILE_ACCESS_PERSIST` / `ALLOW_EXTERNAL_NATIVE_CODE`；任何**超出**它们的 ACL
 *      需求都会导致 `grant request permissions failed`（**已实测踩过**，
 *      见 `.cert-work/apply_profile_dshm.py` 头注）。
 *
 *      【2026-10-14 用户拍板】其余受限条目**永久删除** —— 源码、包体、文档都不再出现，
 *      也不再申请；官方给出的等价路线正是本文件这条路（picker 选目录 +
 *      `FILE_ACCESS_PERSIST` 持久化），落点判据在下面 `probePathWritable()`。
 *
 * ⇒ 落点改为 `DocumentPickerMode.DOWNLOAD`：官方 FAQ `faqs-local-file-manager-67`
 * 与安全控件 `DownloadFileButton` 口径一致——**这条路不需要任何权限**，
 * 配合 `probePathWritable()` 的**实测**判据（而不是按权限表推断）。
 * 取证见 `dsh-移植研究/30-DSHM文件能力植入-侦察与设计.md` §4.2/§6.1。
 */

/** 探写用的临时文件名（建在目标目录里，探完即删）。 */
const WRITE_PROBE_NAME: string = 'dshm-write-probe.tmp';

/**
 * 端侧单文件上限（字节）。
 *
 * 【这是**我们**的护栏，不是上游的限制】上游只对**图片**给了
 * `imageLimits.maxImageBytes = 20971520`（20 MiB，实测自 `session/list` 的投影），
 * 通用文件的限制没有公开。取 16 MiB 的理由是 base64 会膨胀约 33%：
 * 16 MiB 的文件会变成约 21 MB 的 JSON，一条 RPC 里塞这么大已经足够冒险。
 * 因此这里**主动拒绝并说明**，而不是让它在 RPC 层以超时/截断的形式失败——
 * 后者在用户看来只是「发送卡住了」。
 */
export const MAX_ATTACHMENT_BYTES: number = 16 * 1024 * 1024;

/** 选择的三种明确结果 + 一个「用户取消」 */
export enum PickOutcome {
  /** 选到了并已读成 base64 */
  PICKED = 'picked',
  /** 用户主动取消（**不是错误**，UI 不该报错） */
  CANCELLED = 'cancelled',
  /** 选到了但超过端侧上限（UI 要说明原因与大小） */
  TOO_LARGE = 'too_large',
  /** 选择器或读取失败（UI 要给出可执行建议） */
  FAILED = 'failed'
}

/** 选择结果 */
export interface PickedFile {
  outcome: PickOutcome;
  /** 原始 URI（诊断与去重可用；**不要**展示给用户，它很长且含编码） */
  uri: string;
  /** 展示名（URI 末段，已解码） */
  name: string;
  /** 推断出的 MIME 类型（仅用于展示与图片内联判断） */
  mediaType: string;
  /** 精确字节数 */
  bytes: number;
  /** 规范 base64（仅 `PICKED` 时有值） */
  base64: string;
  /** 可直接展示给用户的原因（`CANCELLED` 时为空串） */
  reason: string;
}

/** 造一个只有结果与原因的结果对象（避免各处重复写字面量）。 */
function outcomeOf(outcome: PickOutcome, uri: string, reason: string): PickedFile {
  return {
    outcome: outcome, uri: uri, name: '', mediaType: '', bytes: 0, base64: '', reason: reason
  };
}

/** 选中的**文件夹**（E102）：URI 与**真实路径**都带回来（Host 侧用路径）。 */
export interface PickedFolder {
  outcome: PickOutcome;
  /** 原始 URI（file://docs/...） */
  uri: string;
  /** 供 Host（Node）使用的真实路径；取不到时为空串（那时**不猜**，按失败处理） */
  path: string;
  name: string;
  reason: string;
}

/**
 * 拉起系统**文件夹**选择器，用于把设备上的真实项目目录选作工作区。
 *
 * 【平台边界（API 26 能力表实测）】`FolderSelection` 在 2in1 上从 API 13 可用，
 * phone / tablet 到 API 26 才可用。因此必须用 `canIUse()` 按设备能力判断，
 * 不能只按 API 版本或设备形态猜。能力缺失时回退到官方 DOWNLOAD 模式建立的
 * `Download/<包名>` 专属工作区，而不是让按钮点了没反应。
 *
 * 【路径怎么来】选择器给的是 `file://docs/...` URI，而 Host 是 Node、按**路径**干活，
 * 因此用 `fileUri.FileUri(uri).path` 换成真实路径。转换失败就返回空路径，
 * 由调用方按"不可用"处理（不拿 URI 冒充路径）。
 */
export async function pickFolder(context: common.Context): Promise<PickedFolder> {
  // 【2026-10-03 更正】这里原本先申请一次"公共目录路径级权限"。**已删除**：
  // 本路线不申请任何权限（权限零差异铁律 + ACL 白名单只有 5 条，理由见文件顶部注释）。
  // 用户若选了写不进去的目录，下面的探写会失败并自动退到 `publicDownloadFolder()` 兜底。
  if (!folderSelectionAvailable()) {
    const fallback: PickedFolder = await publicDownloadFolder(context);
    if (fallback.outcome === PickOutcome.PICKED && fallback.path.length > 0) {
      return {
        outcome: PickOutcome.PICKED,
        uri: fallback.uri,
        path: fallback.path,
        name: fallback.name,
        reason: ''
      };
    }
    return {
      outcome: PickOutcome.FAILED,
      uri: '',
      path: '',
      name: '',
      reason: `当前系统没有系统文件夹选择能力，专属下载目录也无法建立：${fallback.reason}`
    };
  }
  let uris: string[] = [];
  try {
    const options: picker.DocumentSelectOptions = new picker.DocumentSelectOptions();
    options.maxSelectNumber = 1;
    options.selectMode = picker.DocumentSelectMode.FOLDER;
    const view: picker.DocumentViewPicker = new picker.DocumentViewPicker(context);
    uris = await view.select(options);
  } catch (err) {
    const e = err as BusinessError;
    const cancelled: boolean = isFolderPickerCancelCode(e.code);
    hilog.info(DOMAIN, TAG, 'pickFolder rejected: code=%{public}d', e.code);
    if (shouldAutoFallbackFolderPicker(e.code, isHandheldForm())) {
      hilog.info(DOMAIN, TAG, '目录选择自动使用默认工作区');
      const fallback: PickedFolder = await publicDownloadFolder(context);
      if (fallback.outcome === PickOutcome.PICKED && fallback.path.length > 0) {
        return {
          outcome: PickOutcome.PICKED,
          uri: fallback.uri,
          path: fallback.path,
          name: fallback.name,
          reason: ''
        };
      }
      return {
        outcome: PickOutcome.FAILED,
        uri: '', path: '', name: fallback.name,
        reason: `默认工作区无法建立：${fallback.reason}`
      };
    }
    return {
      outcome: cancelled ? PickOutcome.CANCELLED : PickOutcome.FAILED,
      uri: '', path: '', name: '',
      reason: cancelled ? '' : `系统文件夹选择器不可用：${e.message}（code=${e.code}）`
    };
  }
  if (uris.length === 0) {
    return { outcome: PickOutcome.CANCELLED, uri: '', path: '', name: '', reason: '' };
  }
  const uri: string = uris[0];
  let realPath: string = '';
  try {
    realPath = new fileUri.FileUri(uri).path;
  } catch (e) {
    const e2 = e as BusinessError;
    hilog.warn(DOMAIN, TAG, 'URI → 路径失败：%{public}s', e2.message);
  }
  if (realPath.length === 0) {
    return {
      outcome: PickOutcome.FAILED, uri: uri, path: '', name: nameOfUri(uri),
      reason: '已选中文件夹，但拿不到它的真实路径（Host 需要路径而不是 URI），因此无法作为工作区。'
    };
  }
  // 公共目录是 user_grant：只在用户明确选中后申请，成功后再走持久授权与探写。
  await requestPublicDirectoryPermission(context, realPath);
  // 【2026-10-03 新增；2026-10-06 收口】非手持档（2in1 / PC）走探写："Host 能不能在这个目录里真写"。
  // 【为什么必须探】Host 是 Node、按 POSIX 路径干活（`dsh-fs-local` 是纯 node:fs，
  // 自身不做任何路径转换/沙箱判断），而"能读"不等于"能写"：本应用拿不到路径级写权时，
  // 选中的目录只读得动——用户看到的正是"agent 只能读、写不进、bash rm 也删不掉"。
  // 探得到的结论是**实测**，比按权限表推断可靠（hmfs 上元数据会撒谎，见 docs/70 §2.1）。
  // 【2026-10-06 晚 更正：判据从"宿主验过的目录"改成"授权能不能跨重启"】
  // 同日下午那一版判据是"只接受落在宿主自己验过的目录里的路径"，依据是"宿主读不到 picker
  // 目录"。**那条读数是真的，但结论错了**：宿主读不到不是平台边界，而是 picker 给的授权
  // **只活这一次进程** —— 同一条路径、同一台机（Mate 80 / OH 7.0.0.105）：
  //   · 选完当场：`workspaceFiles/list` 返回 `data.csv/hello.txt/notes.md` 三个文件；
  //   · 重启之后：同一条调用报 `cannot list "…/Download/harness": permission denied`。
  // 两次原始读数与完整时间线见 docs/105。于是这一档只接受**两类**路径：
  //   ① 本应用**按包名归属**的公共目录内（`Download/<包名>/`；官方 FAQ
  //      `faqs-local-file-manager-67` 口径：该 URI 自带持久权限，跨重启有效）；
  //   ② 用户自己的目录 + 这一次的持久授权**已确认生效**（`checkPersistentPermission` 为真；
  //      重启后由 `restoreFolderGrants()` 重新启用）。
  // 两类都不满足才回落到应用专属目录 —— 那时回落是**如实**的：这条路径重启后确实读不到。
  // 【2026-10-14 更正：三端同一套授权链】旧口径"PC 上宿主本来就读得到 picker 目录
  // （docs/30 实测）"在 **8 条权限面**下**已不成立**：PC 档实测与手持档**逐字同构** ——
  // 同一进程里宿主能列出 `harness`/`test`，`aa force-stop` 后重启，同一条调用就报
  // `Errno 1 Operation not permitted`（现场读数见 docs/157）。根因不是平台边界，而是
  // picker 授权**只活一次进程**：PC 档此前既不登记（`rememberFolderGrant`）、启动也不
  // `activatePermission` ⇒ 重启必然失权。现在**三端都**走"登记 + persist + check"，
  // PC 再用探写多兜一层"能读不能写"的保护。见 `EntryAbility.onCreate` 的启动恢复。
  const handheld: boolean = isHandheldForm();
  const claimed: PickedFolder | undefined = handheld ? await publicDownloadFolder(context) : undefined;
  const owned: boolean = claimed !== undefined && claimed.outcome === PickOutcome.PICKED
    && isPathWithin(realPath, claimed.path);
  const granted: GrantOutcome = await rememberFolderGrant(context, uri, realPath);
  // 【判据为什么是"或"而不是"与"】`persisted` 回答的是"重启后还认不认"，探写回答的是
  // "现在能不能写"：两者都会在**正常**情况下为真，也都会在**正常**的边界下为假
  //（check 看门狗超时 ≠ 授权没建起来；只读目录 ≠ 这条路径不可用）。任一为真即采纳；
  // 两者皆假才判"这条路径重启后读不到"——那是**如实的**，此时才回落并说明原因。
  const acceptable: boolean = handheld ? (owned || granted.persisted)
    : (granted.persisted || probePathWritable(realPath));
  if (!acceptable) {
    hilog.warn(DOMAIN, TAG,
      '所选目录不可用 path=%{public}s handheld=%{public}s granted=%{public}s',
      realPath, handheld ? 'true' : 'false', granted.note);
    const fallback: PickedFolder = claimed !== undefined ? claimed : await publicDownloadFolder(context);
    if (fallback.outcome === PickOutcome.PICKED && fallback.path.length > 0) {
      return {
        outcome: PickOutcome.PICKED, uri: fallback.uri, path: fallback.path,
        name: fallback.name,
        reason: handheld
          ? `所选目录（${realPath}）没能建立跨启动的目录授权（${granted.note}）：手机/平板上`
            + `选择器给的授权只对本次运行有效，重启后宿主会读不到它；已改用本应用在系统`
            + `「文件管理 → 下载」下的专属目录，它在文件管理器里可见且 agent 可读写删。`
          : `所选目录（${realPath}）没能建立跨启动的目录授权（${granted.note}），`
            + `且宿主现在也写不进它；已改用本应用在系统「文件管理 → 下载」下的专属目录，`
            + `它在文件管理器里可见且 agent 可读写删。`
      };
    }
    // 兜底也拿不到 ⇒ 保持原行为（返回用户选的路径）。宁可"能读不能写"，
    // 也不要在这里发明第二种失败形态（调用方对 FAILED 的处置是回退沙箱浏览）。
    hilog.warn(DOMAIN, TAG, '公共目录兜底不可用：%{public}s', fallback.reason);
  }
  return { outcome: PickOutcome.PICKED, uri: uri, path: realPath, name: nameOfUri(uri), reason: '' };
}

/**
 * 实测"Host 能不能在这个目录里写/删"。
 *
 * 【为什么用真写而不是查元数据或查权限状态】三条都不可靠：
 *   · hmfs 的 `stat`/`access` 会撒谎（docs/70 §2.1：「对占位全部返回成功且 mode=0777」）；
 *   · 权限状态"已授予"不等于这条路径可写（授权是按 URI/包名归属的，不是按权限位）；
 *   · 只有真跑一次 `open(CREATE)` + `unlink`，才是"Host 侧 node:fs 能不能干成事"的同口径证据。
 * 【为什么要 unlink 而不是留个空文件】留下垃圾文件会让"用户可见目录"变脏；
 * 且**删除本身就本 patch 要验的能力之一**——探针删不掉，说明这个目录同样删不掉 agent 的文件。
 * 【失败一律静默返回 false】探写是判据，不是业务；它自己不该抛错给 UI。
 *
 * @returns true = 该目录下 create+write+unlink 全部成功
 */
export function probePathWritable(path: string): boolean {
  if (path.length === 0) {
    return false;
  }
  let ownedDir: string = '';
  let probe: string = '';
  let file: fs.File | undefined = undefined;
  let created: boolean = false;
  try {
    // SDK没有公开EXCL；唯一临时目录将探针与所有既存平面文件隔离。
    ownedDir = fs.mkdtempSync(`${path}/dshm-write-probe-XXXXXX`);
    probe = `${ownedDir}/${WRITE_PROBE_NAME}`;
    file = fs.openSync(probe, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    created = true;
    fs.writeSync(file.fd, 'ok');
    fs.closeSync(file);
    file = undefined;
    fs.unlinkSync(probe);
    created = false; // 已自行清理 ⇒ 别让 finally 再删一次（否则会打一条无意义的"清理失败"）
    fs.rmdirSync(ownedDir);
    ownedDir = '';
    return true;
  } catch (err) {
    const e = err as BusinessError;
    hilog.info(DOMAIN, TAG, '探写未确认（可能仅不可建目录）：code=%{public}d msg=%{public}s', e.code, e.message);
    return false;
  } finally {
    if (file !== undefined) {
      try {
        fs.closeSync(file);
      } catch (closeErr) {
        // 关闭失败不影响判据（上面已经按失败收场）
        hilog.warn(DOMAIN, TAG, '探写文件关闭失败');
      }
    }
    if (created) {
      // 清理：write 失败时文件可能已被创建，别把它留在用户目录里。
      try {
        fs.unlinkSync(probe);
      } catch (cleanupErr) {
        hilog.warn(DOMAIN, TAG, '探写残留清理失败（不影响判据）');
      }
    }
    if (ownedDir.length > 0) {
      try {
        fs.rmdirSync(ownedDir);
      } catch (cleanupErr) {
        hilog.warn(DOMAIN, TAG, '本次探测目录清理失败');
      }
    }
  }
}

/**
 * 手持档（手机 / 平板）：picker 给的目录授权**只活一次进程**，所以这一档要额外过"持久授权"这道闸。
 *
 * ── 现象（同一路径、同一台机 Mate 80 / VYG-AL00 / OH 7.0.0.105 / API 26）──────
 *   · 用户选完目录**当场**：宿主 `workspaceFiles/list` 正常返回内容（真机读数：重启前那次
 *     `…/Download/harness` 返回 `data.csv` / `hello.txt` / `notes.md` 三个文件）；同一时刻
 *     ArkTS 侧 `probePathWritable()` 也通过（`diag-resolve-dispatched path=…`）。
 *   · **重启之后**：ArkTS 侧探写**照样通过**（`fileIo` 走服务代理），而宿主同一条调用报
 *     `cannot list "…/Download/harness": permission denied` ⇒ 文件页整页读不出来。
 *   两条读数并列时看着"互相矛盾"，其实只是**授权有生命周期**。
 *
 * ── 为什么 ───────────────────────────────────────────────────────────────
 *   · picker 授予的目录权限是**进程级临时授权**：`fileIo`（服务代理）与宿主（Node 裸
 *     `node:fs`）用的是**同一份**授权（同 UID、同进程）⇒ "当场能读"与"重启读不到"是
 *     同一件事的两个时刻，不是两条通路。
 *   · 本仓 2026-10-06 之前只在选完时调了 `persistPermission()`（把授权**记下来**），
 *     **没在启动时 `activatePermission()`**（把它**启用回来**）⇒ 记了却没人启用，
 *     重启后照样读不到。两步的语义是 SDK 原文（`@ohos.fileshare.d.ts`：activate =
 *     "Enable the URI that have been permanently authorized"），权限为
 *     normal / system_grant（本包已声明，见 module.json5）。落地见 `FolderGrants.ets`。
 *
 * ── 判据（实现见 `pickFolder()` 里那一段）──────────────────────────────────
 *   ① 本应用**按包名归属**的公共目录内（`Download/<包名>/`）：授权跨重启有效（官方 FAQ
 *      `faqs-local-file-manager-67` 口径）；
 *   ② 用户目录 + `checkPersistentPermission()` 为真（重启后由 `restoreFolderGrants()` 启用）。
 *   两类都不满足才回落到应用专属目录 —— 那时回落是**如实**的：这条路径重启后确实读不到。
 *
 * ── 它现在还管什么（2026-10-14 收窄后的用途）──────────────────────────────
 * 两件事：① **产品行为分派** —— 是否给出"本应用公共下载目录"兜底与对应的文案
 *（PC 上没有那条兜底路线，文案逐字不同）；② **界面呈现** —— 顶部栏三键配色、底部手势区
 * 沉浸、跟屏旋转等（见各调用点）。
 * 【2026-10-14 更正】它**不再**决定"要不要持久化目录授权"：那条链（登记 + persist +
 * 启动 `activatePermission`）**三端同一套**。旧注释写的"2in1 / PC 上宿主能读 picker 目录
 * ⇒ 不需要持久化"是 docs/30 时代的读数，在 8 条权限面下已不成立（PC 档实测与手持档
 * 逐字同构，见 docs/157）。设备事实读不到时仍返回 false（退回 2in1 行为）——保守方向：
 * 宁可少分派产品行为，也不误伤桌面。
 */
export function isHandheldForm(): boolean {
  try {
    const form: FormFactor = readDeviceFacts().form;
    return form === FormFactor.PHONE || form === FormFactor.TABLET;
  } catch (e) {
    const err = e as BusinessError;
    hilog.warn(DOMAIN, TAG, '形态读取失败（按非手持处理，保持 2in1 旧行为）：%{public}s', err.message);
    return false;
  }
}

/**
 * 本机是否为**直板手机**形态（平板 / 折叠屏**都不算**）。
 *
 * ── 与 `isHandheldForm()` 的分工（2026-10-13 用户裁决）──────────────────────
 * 手持档（手机 / 平板）共用整套"窄屏"适配（抽屉侧栏、浮动 ⊞、朝向跟随、底部手势区沉浸…），
 * 两边都该有。但**设置面板的手机化布局**只对直板机成立：官方那套"左侧 188px 竖向导航 +
 * 右侧内容"在平板宽度下本来就放得下，改成顶部横条反而白丢一截内容高度。用户原话：
 * "平板端其实设置的 UI 用 PC 端的，因为平板的宽度是足够的，只有手机端的才需要横过来"；
 * 随后追加（同日）："设置的 UI 手机只是直板机是横着的，折叠机也是 PC 竖着的 UI"。
 *
 * 判据 = 手机形态 **且非折叠屏**（`isFoldableDevice()`：折叠屏展开后宽度与平板相当 ⇒ 同平板）。
 * 与 `isHandheldForm()` **同源**读 `readDeviceFacts()`；读不到设备事实 / 折叠能力时返回 false
 * （= 不当直板机处理 ⇒ 平板、折叠屏、桌面都走官方布局）。保守方向：宁可少收口，也不误伤
 * 平板与桌面 —— 这个函数只用来**缩小**适配面，绝不能因为读失败而把适配面放大。
 */
export function isPhoneForm(): boolean {
  try {
    const form: FormFactor = readDeviceFacts().form;
    return form === FormFactor.PHONE && !isFoldableDevice();
  } catch (e) {
    const err = e as BusinessError;
    hilog.warn(DOMAIN, TAG, '形态读取失败（按非直板机处理，平板/折叠屏/桌面走官方布局）：%{public}s', err.message);
    return false;
  }
}

/**
 * `child` 是否等于 `parent`，或位于 `parent` 之下。
 *
 * 纯字符串判据（不做 realpath）：两个入参都来自系统给的绝对路径（picker 返回值 /
 * `Download/<包名>` 直拼），不含 `..` 也不经符号链接，落盘反而引入新的失败形态。
 */
export function isPathWithin(child: string, parent: string): boolean {
  if (parent.length === 0 || child.length === 0) {
    return false;
  }
  if (child === parent) {
    return true;
  }
  const base: string = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(base);
}

/**
 * 取"本应用在系统公共目录里的专属文件夹"，并确认它**可读写删**。
 *
 * 【为什么是它】`DocumentPickerMode.DOWNLOAD`（API 12+）是**唯一**不依赖任何受限权限、
 * 又能给到"用户可见 + 路径级可读写"的路子。官方文档（docId
 * `.../保存用户文件/save-user-file` 的「DOWNLOAD模式保存文件 / 模式特点」与 FAQ
 * `faqs-local-file-manager-67`）逐字：
 *   · 「自动创建在Download/包名/目录。跳过文件选择界面直接保存。」
 *   · 「返回的URI已具备持久化权限，用户可在该URI下创建文件。」
 *   · 「应用可以通过系统预定义的用户文件目录**直接使用@ohos.file.fs的能力进行访问**。
 *      注意该方式应用只能访问到Download目录下的自己包名下的文件或文件夹。」
 *   · 「**应用卸载重装后若包名未修改，应用也可直接访问卸载前存放在该目录下的文件或文件夹。**」
 * FAQ 的示例甚至**不用 picker 的返回值**，而是自己拼
 * `'file://docs/storage/Users/currentUser/Download/' + bundleName` 再用绝对路径 open(READ_WRITE)
 * ⇒ 这是**按包名归属的路径级授权**，进程内任何代码（含 Host 的 node:fs 与 bash 的 rm）
 * 都吃同一份授权。
 *
 * 【两步走】① 先按包名直拼路径并探写（重装后/二次进入时命中，**不再调 save**，
 * 避免每次多造一个空文件）；② 不命中才用 DOWNLOAD 模式的 `save()` 建立归属与目录。
 *
 * 【未核实】① `save()` 返回的 URI 指向的是**目录**还是它预置的那个空文件——
 * 文档示例写的是 `uri + '/test.txt'`，暗示目录；本函数两种都兼容（见下）。
 * ② Node/koffi 侧是否与 `fileIo` 同权（文档完全未涉及 node），以及归属授权是否覆盖
 * `unlink`——**唯一判据是真机跑一次 `bash rm`**（见 30 号文档 §7.2）。
 */
/**
 * 给"不受我们控制的系统 await"加硬超时。
 *
 * 【为什么必须自己实现】`DocumentViewPicker.save()` 是系统 API，没有超时参数；
 * 一旦它不返回，调用方就无限期挂住。启动链上任何这样的点都等于"应用卡死"。
 *
 * 超时用**带固定标记的 Error** 拒绝，让调用方能把"超时"与"系统报错"分开处理
 * （两者的处置不同：超时是一种可接受的回退，报错要如实上报）。
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled: boolean = false;
    const timer: number = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(`__DSHM_TIMEOUT__ ${ms}ms`));
    }, ms);
    p.then((value: T) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }).catch((err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function publicDownloadFolder(context: common.Context): Promise<PickedFolder> {
  const bundleName: string = readBundleName();
  if (bundleName.length === 0) {
    return {
      outcome: PickOutcome.FAILED, uri: '', path: '', name: '',
      reason: '拿不到本应用包名，无法定位 Download 下的专属目录。'
    };
  }
  const dirUri: string = `file://docs/storage/Users/currentUser/Download/${bundleName}`;
  let path: string = pathOfUri(dirUri);
  // ① 已存在且可写 ⇒ 直接用（不碰 save()，不产生多余文件）
  if (path.length > 0 && probePathWritable(path)) {
    hilog.info(DOMAIN, TAG, '公共目录：命中已存在的应用专属目录 %{public}s', path);
    return { outcome: PickOutcome.PICKED, uri: dirUri, path: path, name: bundleName, reason: '' };
  }
  // ② 用 DOWNLOAD 模式建立归属（自动创建 Download/<包名>/，跳过文件选择界面）
  let createdUri: string = '';
  /*
   * 【2026-11-01 真机日志实证：首次启动卡死在启动页】
   *
   * 现象（手机端首次安装）：点图标后一直停在启动页；`hilog` 里
   * **没有 `startHost 设备事实` / `startHost 返回` 两行**，只有零星
   * `host-ready.json 属于旧进程（pid 不符）`。⇒ 启动链根本没走到 spawn，
   * 而是挂在 `start()` 里 spawn **之前**唯一的 await —— 本函数。
   *
   * 而本函数的 ① 分支（直拼 Download/<包名> 探写）在首启必然不命中（目录还不存在），
   * 于是走 ② 的 `view.save()`。这一步：
   *   · 之前**没有任何日志**（成功才由调用方打，失败才 warn）⇒ 卡住时日志一片空白；
   *   · **没有超时** ⇒ 系统侧不返回就无限期 await；
   * 用户第二次进入时目录已被创建，① 命中，于是"杀掉重进就好"——与真机表现完全一致。
   *
   * 修法：**进入前先打日志**（下次一眼定位）+ **给 save() 加硬超时**。
   * 超时按"认领失败"处理（返回空串），Host 回退沙箱工作区 —— 应用仍能启动，
   * 用户不至于卡在启动页。这符合本文件既有的"认领失败不阻断启动"纪律。
   */
  const CLAIM_SAVE_TIMEOUT_MS: number = 6000;
  hilog.info(DOMAIN, TAG,
    '公共目录：未命中已存在的专属目录，改用 DOWNLOAD 模式建立归属（最多等 %{public}d ms）',
    CLAIM_SAVE_TIMEOUT_MS);
  try {
    const options: picker.DocumentSaveOptions = new picker.DocumentSaveOptions();
    options.pickerMode = picker.DocumentPickerMode.DOWNLOAD;
    const view: picker.DocumentViewPicker = new picker.DocumentViewPicker(context);
    const uris: string[] = await withTimeout(view.save(options), CLAIM_SAVE_TIMEOUT_MS);
    if (uris.length > 0) {
      createdUri = uris[0];
      path = pathOfUri(createdUri);
      // 返回值可能是"目录 URI"也可能是 picker 预置的那个空文件的 URI —— 两种都要能吃：
      // 指向文件时取它的父目录（FAQ/save-user-file 的示例是在返回值后面接 '/xxx.txt' 用，
      // 说明正常的返回值是目录，但这里不赌）。
      if (path.length > 0 && !isDirectory(path)) {
        const slash: number = path.lastIndexOf('/');
        if (slash > 0) {
          path = path.substring(0, slash);
        }
      }
    }
  } catch (err) {
    const e = err as BusinessError;
    /*
     * 超时与"系统报错"分开处理：超时的正确处置是**回退**（Host 走沙箱工作区），
     * 而不是把错误抛到启动链上。日志里必须留痕，否则下次又会看到"卡死但没日志"。
     */
    const msg: string = e.message === undefined ? '' : e.message;
    if (msg.indexOf('__DSHM_TIMEOUT__') >= 0) {
      hilog.warn(DOMAIN, TAG,
        'DOWNLOAD 模式 %{public}d ms 未返回 ⇒ 判为认领超时，回退沙箱工作区（不阻断启动）',
        CLAIM_SAVE_TIMEOUT_MS);
      return {
        outcome: PickOutcome.FAILED, uri: '', path: '', name: bundleName,
        reason: `公共下载目录认领超时（DOWNLOAD 模式 ${CLAIM_SAVE_TIMEOUT_MS} ms 未返回）。`
      };
    }
    hilog.warn(DOMAIN, TAG, 'DOWNLOAD 模式不可用：code=%{public}d msg=%{public}s', e.code, e.message);
    return {
      outcome: PickOutcome.FAILED, uri: '', path: '', name: bundleName,
      reason: `公共下载目录不可用（DOWNLOAD 模式失败：${e.code} ${e.message}）。`
    };
  }
  if (path.length === 0) {
    return {
      outcome: PickOutcome.FAILED, uri: createdUri, path: '', name: bundleName,
      reason: 'DOWNLOAD 模式没有返回可用路径。'
    };
  }
  if (!probePathWritable(path)) {
    return {
      outcome: PickOutcome.FAILED, uri: createdUri, path: '', name: bundleName,
      reason: `已建立 ${path}，但 Host 仍写不进去（真机需按 30 号文档 §7.2 的失败判别取证）。`
    };
  }
  hilog.info(DOMAIN, TAG, '公共目录：DOWNLOAD 模式已建立 %{public}s', path);
  return { outcome: PickOutcome.PICKED, uri: createdUri, path: path, name: bundleName, reason: '' };
}

/**
 * 【2026-10-03 新增】启动期**幂等认领**一次"本应用在公共 Download 下的专属目录"。
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────────────
 * 37 轮真机判据 1 失败的直接原因是：Host 侧 `resolveWorkspaceDir()` 自己 `mkdir`
 * `Download/<包名>/` 必然 EPERM（31 轮已定性：应用进程**直拼路径 mkdir 公共目录**
 * 不被放行），于是默认工作区退回沙箱、用户的产物落在文件管理器看不见的地方。
 * 而 **`DocumentPickerMode.DOWNLOAD` 的 `save()` 能建出这个目录**（31 轮真机：
 * 106 ms、无 UI、返回目录 URI、`pickerPath == 直拼路径`）——官方 FAQ
 * `faqs-local-file-manager-67` 的原话就是「自动创建在 Download/包名/ 目录。
 * 跳过文件选择界面直接保存。」⇒ 认领这件事**只能**在 ArkTS 侧（拿到授权的那一层）
 * 做，Host 补不出来（30 号文档 §2.2/§5.2）。
 *
 * ── 为什么**每次启动**都要认领，而不是"建过一次就够"───────────────────────────
 * 官方 FAQ `faqs-local-file-manager-46` 逐字警告：「应用在冷启动后，系统可能不会
 * 自动授予之前通过 picker 等系统能力获取的 URI 的持续读取权限」⇒ "上次建成功"
 * **不能**推断"这次还可用"。本函数因此不读任何持久化状态，每次都实测一遍：
 * `publicDownloadFolder()` 内部先直拼路径探写（命中即复用，不产生多余文件），
 * 不命中才走 DOWNLOAD 模式的 `save()` 重建归属。
 *
 * ── 纪律 ─────────────────────────────────────────────────────────────────────
 * · **不申请任何权限**（权限零差异铁律，见本文件顶部说明）：只调 picker，不碰 manifest。
 * · **失败绝不阻断启动**：拿不到就返回空串，Host 明确走沙箱回退分支并记 diag。
 * · **每次启动都调**、进程内只成功一次（结果缓存，避免多处重复拉起选择器）。
 * · 结果交给 Host 的通道是 `DSHM_PUBLIC_DOWNLOAD`（`hostruntime` 的 `buildHostEnv()`），
 *   在 **spawn 前**写进 env ⇒ 天然无竞态（Host 读到的一定是本次认领的结果）。
 *
 * @param context UIAbility 上下文（`DocumentViewPicker` 需要它）
 * @returns 认领到的绝对路径；失败/不可用返回空串（**不猜**）
 */
export async function claimPublicDownloadFolder(context: common.Context): Promise<string> {
  if (claimedDownloadDir.length > 0) {
    return claimedDownloadDir;
  }
  try {
    const folder: PickedFolder = await publicDownloadFolder(context);
    if (folder.outcome === PickOutcome.PICKED && folder.path.length > 0) {
      claimedDownloadDir = folder.path;
      // 与 Host 的 diag 同前缀，端侧 grep 一条 `默认工作区：` 就能同时看到两侧读数。
      hilog.info(DOMAIN, TAG,
        '默认工作区：认领 %{public}s（DOWNLOAD 模式，无 UI；每次启动重认一次，见 FAQ-46）',
        folder.path);
      return folder.path;
    }
    hilog.warn(DOMAIN, TAG, '默认工作区：认领失败（%{public}s）⇒ Host 将回退沙箱工作区', folder.reason);
    return '';
  } catch (err) {
    // publicDownloadFolder 自身已吞掉各类错误；这里再兜一层，保证"认领"永远不会把启动搞崩。
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, '默认工作区：认领异常（按失败处理）：code=%{public}d msg=%{public}s',
      e.code, e.message);
    return '';
  }
}

/**
 * 进程内认领缓存（空串 = 尚未成功认领过）。
 *
 * 【为什么失败不留哨兵】失败可能是"这一次"的（如系统临时拒绝）：留哨兵会把一次瞬时
 * 失败变成整个进程内的永久失败。这里的调用点只有一处（Host 启动前），所以重复调用
 * 的代价只发生在"Host 反复启动"时，而那时**本该**重新实测一次（FAQ-46）。
 */
let claimedDownloadDir: string = '';

/**
 * 取本应用包名（`Download/<包名>/` 的那一段）。取不到返回空串（不猜）。
 *
 * 【为什么导出】两条理由，都要求包名只有**一份**来源：
 *  ① `publicDownloadFolder()` 在本文件内就要用它拼 `Download/<包名>/`；
 *  ② `entry/.../runtime/NodeRuntime.ets` 构造时取一次打诊断日志，用来核对
 *     `DSHM_PUBLIC_DOWNLOAD` 的末段是不是本应用（归属关系一眼可读）。
 * 两处各写一遍 `bundleManager` 调用迟早会分叉，而分叉的后果是"日志指向的目录与实际
 * 认领到的目录不是同一个"，排查时会被带偏。故只此一份，导出复用。
 * 【注意】它**不是路径来源**：默认工作区路径的唯一来源是本文件认领后经
 * `DSHM_PUBLIC_DOWNLOAD` 交给 Host 的那份值（Host 的 `resolveWorkspaceDir()` 只消费它）。
 */
export function readBundleName(): string {
  try {
    const flags: number = bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION;
    const info: bundleManager.BundleInfo = bundleManager.getBundleInfoForSelfSync(flags);
    return info.name;
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, '取包名失败：code=%{public}d msg=%{public}s', e.code, e.message);
    return '';
  }
}

/**
 * 本应用的版本文本（`<versionName> (<versionCode>)`）——「关于」页客户端版本的**唯一**来源。
 *
 * 【为什么必须问系统】它曾经在 `appstate/model/StubData2.ets` 里**写死**成
 * `'1.1.0 (1010000)'`：包已经发到 `1.1.2/1010002`，界面还显示 1.1.0。上架自检把这条
 * 列为 P0 —— 用户看到的版本与实际不符。同一轮里商店文案的 `appDesc` 也犯过同一个病
 * （写着 `本版本 1.1.0（versionCode 1010000）`），两处都是"手抄版本号"的后果。
 *
 * 【口径】与 `readBundleName()` 同一个来源（`bundleManager.getBundleInfoForSelfSync`）、
 * 同一套 try-catch 口径，故放在同一处、只此一份。**读不到就返回空串**，由 UI 如实显示
 * 「—」：宁可显示"未知"，也不显示一个写死的假版本。
 */
export function readAppVersionText(): string {
  try {
    const flags: number = bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT;
    const info: bundleManager.BundleInfo = bundleManager.getBundleInfoForSelfSync(flags);
    const name: string = info.versionName;
    if (name === undefined || name === null || name === '') {
      return '';
    }
    return `${name} (${info.versionCode})`;
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, '取版本失败：code=%{public}d msg=%{public}s', e.code, e.message);
    return '';
  }
}

/** URI → 真实路径；失败返回空串（沿用 `pickFolder` 的"不拿 URI 冒充路径"口径）。 */
function pathOfUri(uri: string): string {
  try {
    return new fileUri.FileUri(uri).path;
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, 'URI → 路径失败：%{public}s', e.message);
    return '';
  }
}

/** 路径是否目录（stat 失败按"不是目录"处理——那说明它压根不可访问）。 */
function isDirectory(path: string): boolean {
  try {
    return fs.statSync(path).isDirectory();
  } catch (err) {
    return false;
  }
}

/**
 * 拉起系统文件选择器并读取选中的文件。
 *
 * `context` 必须由调用方（UI 层）传入：本模块没有 UI，`getContext()` 在这里
 * 拿不到窗口上下文。传进来比在这里猜要诚实。
 *
 * 只允许单选。理由：多选会让「哪几个上传成功了」变成一个需要逐个报错的状态机，
 * 而当前的 UI 只有一个附件列表；在能逐条显示失败原因之前，多选只会制造歧义。
 */
export async function pickDocument(context: common.Context): Promise<PickedFile> {
  let uris: string[] = [];
  try {
    const options: picker.DocumentSelectOptions = new picker.DocumentSelectOptions();
    options.maxSelectNumber = 1;
    const view: picker.DocumentViewPicker = new picker.DocumentViewPicker(context);
    uris = await view.select(options);
  } catch (err) {
    const e = err as BusinessError;
    // 用户取消在多数系统上表现为一次 reject（错误码 13900020 / 或 message 含 cancel）。
    // 取消不提示错误，因此必须与真正的失败分开：
    hilog.info(DOMAIN, TAG, 'select rejected: code=%{public}d', e.code);
    const cancelled: boolean = isFolderPickerCancelCode(e.code);
    return outcomeOf(cancelled ? PickOutcome.CANCELLED : PickOutcome.FAILED, '',
      cancelled ? '' : `无法拉起文件选择器：${e.message}（code=${e.code}）`);
  }
  if (uris.length === 0) {
    return outcomeOf(PickOutcome.CANCELLED, '', '');
  }
  return await readPickedFile(uris[0]);
}

/** 读取一个已选中的 URI 并把内容编码成 base64。 */
async function readPickedFile(uri: string): Promise<PickedFile> {
  const name: string = nameOfUri(uri);
  let file: fs.File | undefined = undefined;
  try {
    file = fs.openSync(uri, fs.OpenMode.READ_ONLY);
    const size: number = fs.statSync(file.fd).size;
    if (size > MAX_ATTACHMENT_BYTES) {
      return {
        outcome: PickOutcome.TOO_LARGE, uri: uri, name: name,
        mediaType: mediaTypeOf(name), bytes: size, base64: '',
        reason: `文件 ${formatBytes(size)} 超过端侧附件上限 ${formatBytes(MAX_ATTACHMENT_BYTES)}`
      };
    }
    const buffer: ArrayBuffer = new ArrayBuffer(size);
    const read: number = fs.readSync(file.fd, buffer);
    // 只编码**实际读到**的字节：`stat` 与 `read` 之间文件可能被改动，
    // 按 size 编码会在尾部带上未写入的 0，产生一个「能上传但内容坏了」的附件。
    const bytes: Uint8Array = new Uint8Array(buffer, 0, read);
    const helper: util.Base64Helper = new util.Base64Helper();
    const base64: string = helper.encodeToStringSync(bytes);
    return {
      outcome: PickOutcome.PICKED, uri: uri, name: name, mediaType: mediaTypeOf(name),
      bytes: read, base64: base64, reason: ''
    };
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, 'read failed: %{public}s', e.message);
    return outcomeOf(PickOutcome.FAILED, uri, `读取文件失败：${e.message}（code=${e.code}）`);
  } finally {
    if (file !== undefined) {
      try {
        fs.closeSync(file);
      } catch (closeErr) {
        // 关闭失败不影响已读到的数据，仅记录
        hilog.warn(DOMAIN, TAG, 'close failed');
      }
    }
  }
}

/** 从 URI 末段取展示名并解码百分号转义。 */
function nameOfUri(uri: string): string {
  let end: number = uri.length;
  const query: number = uri.indexOf('?');
  if (query >= 0) {
    end = query;
  }
  const slash: number = uri.lastIndexOf('/', end - 1);
  const raw: string = uri.substring(slash + 1, end);
  try {
    return decodeURIComponent(raw);
  } catch (err) {
    // 非法转义序列（少见）：原样使用比抛错好，名字只是展示
    return raw;
  }
}

/** 常见扩展名 → MIME。未知一律 `application/octet-stream`（不猜成 text/plain）。 */
function mediaTypeOf(name: string): string {
  const dot: number = name.lastIndexOf('.');
  if (dot < 0) {
    return 'application/octet-stream';
  }
  const ext: string = name.substring(dot + 1).toLowerCase();
  if (ext === 'png') {
    return 'image/png';
  }
  if (ext === 'jpg' || ext === 'jpeg') {
    return 'image/jpeg';
  }
  if (ext === 'webp') {
    return 'image/webp';
  }
  if (ext === 'gif') {
    return 'image/gif';
  }
  if (ext === 'txt' || ext === 'log' || ext === 'md') {
    return 'text/plain';
  }
  if (ext === 'json' || ext === 'json5') {
    return 'application/json';
  }
  if (ext === 'pdf') {
    return 'application/pdf';
  }
  return 'application/octet-stream';
}

/** 字节数的可读形式（本模块自用，避免为一个格式化函数反向依赖 appstate）。 */
function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${Math.round(n / 1024)} KB`;
  }
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
