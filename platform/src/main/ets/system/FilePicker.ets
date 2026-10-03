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
import { common, bundleManager } from '@kit.AbilityKit';
import { picker } from '@kit.CoreFileKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { fileUri } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'platform/filepicker';

/**
 * ── 本路线**不申请任何权限**（2026-10-03 定稿，就地更正上一版方案）──
 *
 * 上一版曾计划额外声明并运行时申请**两条 Download / Documents 目录权限**
 * （权限名见 `dsh-移植研究/30-DSHM文件能力植入-侦察与设计.md` §4.2 的"已废弃"一行），
 * 以换取任意 Download/Documents 子树的**路径级**读写。**该方案已废弃**，两条硬理由：
 *
 *   ① 【权限零差异铁律】新构建的包必须与作者成品 HAP
 *      （`/tmp/DSHM-1.0.0-arm64-signed.hap`，`requestPermissions` 恰 **11 项**）
 *      **逐项一致**，否则装不上。多声明任何一项都直接破坏这条等价关系。
 *   ② 【ACL 白名单只有 5 条】用户的 AGC profile
 *      （`.cert-work/com_dshm_dshclient.p7b`）`acls.allowed-acls` 只有
 *      `FILE_ACCESS_PERSIST` / `READ_WRITE_USER_FILE` / `ACCESS_USER_FULL_DISK` /
 *      `CUSTOM_SANDBOX` / `ALLOW_EXTERNAL_NATIVE_CODE`；任何**超出**这 5 条的 ACL
 *      需求都会导致 `grant request permissions failed`（**已实测踩过**，
 *      见 `.cert-work/apply_profile_dshm.py` 头注）。而这两项在官方文档里自相矛盾
 *      （列为 normal 用户授权，正文又要求"继续采用受限权限申请方式"）⇒ 真机上
 *      很可能仍在 ACL 射程内，正是上一条禁令要挡的形态。
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
 * 【平台边界（SDK 原文）】`DocumentSelectMode` 的注释明确写着
 * "Only 2-in-1 devices are supported" ⇒ **手机/平板拿不到文件夹选择**。
 * 所以调用方必须准备好回退路径（我们的做法：回退到"浏览沙箱目录"，
 * 并把原因说清楚），而不是让按钮点了没反应。
 *
 * 【路径怎么来】选择器给的是 `file://docs/...` URI，而 Host 是 Node、按**路径**干活，
 * 因此用 `fileUri.FileUri(uri).path` 换成真实路径。转换失败就返回空路径，
 * 由调用方按"不可用"处理（不拿 URI 冒充路径）。
 */
export async function pickFolder(context: common.Context): Promise<PickedFolder> {
  // 【2026-10-03 更正】这里原本先申请一次"公共目录路径级权限"。**已删除**：
  // 本路线不申请任何权限（权限零差异铁律 + ACL 白名单只有 5 条，理由见文件顶部注释）。
  // 用户若选了写不进去的目录，下面的探写会失败并自动退到 `publicDownloadFolder()` 兜底。
  let uris: string[] = [];
  try {
    const options: picker.DocumentSelectOptions = new picker.DocumentSelectOptions();
    options.maxSelectNumber = 1;
    options.selectMode = picker.DocumentSelectMode.FOLDER;
    const view: picker.DocumentViewPicker = new picker.DocumentViewPicker(context);
    uris = await view.select(options);
  } catch (err) {
    const e = err as BusinessError;
    const cancelled: boolean = isCancelCode(e.code);
    hilog.info(DOMAIN, TAG, 'pickFolder rejected: code=%{public}d', e.code);
    return {
      outcome: cancelled ? PickOutcome.CANCELLED : PickOutcome.FAILED,
      uri: '', path: '', name: '',
      reason: cancelled ? '' : `文件夹选择器不可用（该能力仅 2in1 支持）：${e.message}（code=${e.code}）`
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
  // 【2026-10-03 新增】探一次"Host 能不能在这个目录里真写"。
  // 【为什么必须探】Host 是 Node、按 POSIX 路径干活（`dsh-fs-local` 是纯 node:fs，
  // 自身不做任何路径转换/沙箱判断），而"能读"不等于"能写"：本应用拿不到路径级写权时，
  // 选中的目录只读得动——用户看到的正是"agent 只能读、写不进、bash rm 也删不掉"。
  // 探得到的结论是**实测**，比按权限表推断可靠（hmfs 上元数据会撒谎，见 docs/70 §2.1）。
  if (!probePathWritable(realPath)) {
    hilog.warn(DOMAIN, TAG,
      '所选目录不可写 path=%{public}s，改用应用公共目录', realPath);
    const fallback: PickedFolder = await publicDownloadFolder(context);
    if (fallback.outcome === PickOutcome.PICKED && fallback.path.length > 0) {
      return {
        outcome: PickOutcome.PICKED, uri: fallback.uri, path: fallback.path,
        name: fallback.name,
        reason: `所选目录（${realPath}）Host 只能读、不能写入/删除；已改用本应用在系统`
          + `「文件管理 → 下载」下的专属目录，它在文件管理器里可见且 agent 可读写删。`
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
  const probe: string = `${path}/${WRITE_PROBE_NAME}`;
  let file: fs.File | undefined = undefined;
  let created: boolean = false;
  try {
    file = fs.openSync(probe, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    created = true;
    fs.writeSync(file.fd, 'ok');
    fs.closeSync(file);
    file = undefined;
    fs.unlinkSync(probe);
    created = false; // 已自行清理 ⇒ 别让 finally 再删一次（否则会打一条无意义的"清理失败"）
    return true;
  } catch (err) {
    const e = err as BusinessError;
    hilog.info(DOMAIN, TAG, '探写失败（按不可写处理）：code=%{public}d msg=%{public}s', e.code, e.message);
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
  }
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
  try {
    const options: picker.DocumentSaveOptions = new picker.DocumentSaveOptions();
    options.pickerMode = picker.DocumentPickerMode.DOWNLOAD;
    const view: picker.DocumentViewPicker = new picker.DocumentViewPicker(context);
    const uris: string[] = await view.save(options);
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
    const cancelled: boolean = isCancelCode(e.code);
    return outcomeOf(cancelled ? PickOutcome.CANCELLED : PickOutcome.FAILED, '',
      cancelled ? '' : `无法拉起文件选择器：${e.message}（code=${e.code}）`);
  }
  if (uris.length === 0) {
    return outcomeOf(PickOutcome.CANCELLED, '', '');
  }
  return await readPickedFile(uris[0]);
}

/** 判断一个错误码是否表示「用户取消」。 */
function isCancelCode(code: number): boolean {
  // 13900020 = 参数错误（部分系统用它表示用户取消）；其他实现直接给 0/undefined。
  return code === 13900020 || code === 0;
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
