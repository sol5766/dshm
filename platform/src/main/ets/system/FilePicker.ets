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

import { common } from '@kit.AbilityKit';
import { picker } from '@kit.CoreFileKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { fileUri } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'platform/filepicker';

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
  return { outcome: PickOutcome.PICKED, uri: uri, path: realPath, name: nameOfUri(uri), reason: '' };
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
