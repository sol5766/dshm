/**
 * 系统文件预览能力（PreviewKit：`@kit.PreviewKit` → `@hms.filemanagement.filepreview`）。
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────────────
 * Office 系文档（doc/docx/xls/xlsx/ppt/pptx/csv/ofd）与 pdf、图片、音视频等**不是**
 * 文本，DSH 上游的预览链路把它们交给 `dsh-office-to-pdf`（LibreOffice 转换）——
 * 而 `libreoffice-kit` 的 `resolveEngine()` 只认 darwin/win32/linux（openharmony
 * 直接 `Unsupported LibreOfficeKit host`，WASM 回退在 `--jitless` 下必然不可用）。
 * 也就是说引擎路线在本平台**结构性不可达**，只能走设备自带能力。
 *
 * 系统侧的现成能力就是本模块：`filePreview.openPreview()` 弹**系统原生预览窗**，
 * 官方支持表（d.ts 头注释）逐字含 Office 全族 ⇒ 这也是"arkts 原生体验"的落点。
 *
 * ── 分层纪律（与 `FilePicker.ets` / `OpenLink.ets` 同一套）─────────────────────
 * · 只提供**机制**：路径 → URI、后缀 → MIME、可用性探测、打开/关闭系统预览窗。
 * · **不认识** DSH 上游：不知道什么是"侧边栏"、什么是会话、什么是资源地址。
 *   调用方（`entry` 的壳）负责把上游语义翻译成本模块的入参。
 * · **不含产品策略**：什么时候该弹窗、弹哪一档、要不要先问用户 —— 全在调用方。
 * · 异常不出口：一律 catch 后返回 `boolean`，让 UI 决定怎么提示（绝不静默失败）。
 *
 * ── 已知的平台行为（踩坑前先读）──────────────────────────────────────────────
 * · `openPreview` 的 context **只支持 UIAbilityContext**（d.ts 逐字）。
 * · **1 秒内重复调用不生效**（d.ts 逐字）⇒ 调用方要自己去重，本模块不做节流，
 *   因为"该不该重开"是策略。
 * · 预览窗是**单例**：`hasDisplayed()` 在窗创建前恒 false；`closePreview()` 在窗
 *   不存在时会失败（本模块按"已关"处理，不往外抛）。
 * · 前置条件（d.ts 三处重复）逐字：`The calling app must ensure that the provided URI
 *   supports delegated access.` ⇒ 传入的 URI 必须来自本应用有权访问的路径
 *   （本应用沙箱、或本应用经 picker/DOWNLOAD 模式认领过的公共目录）。
 * · **2in1 不支持数组重载**（`openPreview(context, files[], index?)` 正文逐字
 *   `This API is not supported for 2-in-1 devices.`，`@throws 801`）⇒ 本模块只封装
 *   单文件重载，不提供数组版本。
 * · syscap：`SystemCapability.FileManagement.FilePreview.Core`。SDK 的
 *   `device-define/2in1-hmos.json` 含 `FilePreview`，`phone.json`/`tablet.json` 不含
 *   ⇒ 手机/平板上调用会失败，调用方须按返回的 false 走自己的回退（不要崩）。
 */

import { common, Want } from '@kit.AbilityKit';
import { fileUri, picker } from '@kit.CoreFileKit';
import { filePreview } from '@kit.PreviewKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'platform/filepreview';

/**
 * 系统预览服务官方支持的后缀（来源：`@hms.filemanagement.filepreview.d.ts` 头注释的
 * 「File Format Support」表，逐项照抄）。
 *
 * 【为什么要把这张表放在 mechanism 层】它是**设备事实**（这台机器上这个服务认哪些
 * 后缀），不是产品策略。调用方拿它判断"该不该走系统预览"，而不是自己去猜。
 */
export const SYSTEM_PREVIEW_SUFFIXES: string[] = [
  // Text
  'txt', 'cpp', 'c', 'h', 'java', 'xhtml', 'xml',
  // Web
  'html', 'htm',
  // Image
  'jpg', 'png', 'gif', 'webp', 'bmp', 'svg',
  // Audio
  'm4a', 'aac', 'mp3', 'ogg', 'wav',
  // Video
  'mp4', 'mkv', 'ts',
  // Document
  'pdf',
  // Office
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'ofd'
];

/**
 * 后缀 → MIME（Office 那一档照抄 d.ts 头注释给的 mimeType；其余常用档补齐）。
 *
 * 【表里没有的怎么办】回空串。d.ts 的 `PreviewInfo.mimeType` 注释逐字允许：
 * 无法确定时可给空串，系统按 URI 后缀自行推断 —— 比我们瞎填一个错的更安全。
 */
const MIME_BY_SUFFIX: Record<string, string> = {
  'doc': 'application/msword',
  'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'xls': 'application/vnd.ms-excel',
  'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'ppt': 'application/vnd.ms-powerpoint',
  'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'csv': 'text/csv',
  'ofd': 'general.ofd',
  'pdf': 'application/pdf',
  'txt': 'text/plain',
  'xml': 'text/xml',
  'html': 'text/html',
  'htm': 'text/html',
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'bmp': 'image/bmp',
  'svg': 'image/svg+xml',
  'mp3': 'audio/mpeg',
  'wav': 'audio/wav',
  'mp4': 'video/mp4'
};

/** 取文件名后缀（小写、去点）。没有后缀返回空串。 */
function suffixOf(name: string): string {
  const base: string = name.trim();
  const slash: number = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
  const leaf: string = slash >= 0 ? base.substring(slash + 1) : base;
  const dot: number = leaf.lastIndexOf('.');
  if (dot <= 0 || dot === leaf.length - 1) {
    return '';
  }
  return leaf.substring(dot + 1).toLowerCase();
}

/** 该文件名是否是系统预览服务官方支持的类型（按后缀判断，**不碰文件系统**）。 */
export function isSystemPreviewableName(name: string): boolean {
  const suffix: string = suffixOf(name);
  return suffix.length > 0 && SYSTEM_PREVIEW_SUFFIXES.includes(suffix);
}

/** 后缀对应的 MIME；表中没有则返回空串（由系统按 URI 后缀推断，见上）。 */
export function mimeTypeForName(name: string): string {
  const suffix: string = suffixOf(name);
  const mime: string | undefined = MIME_BY_SUFFIX[suffix];
  return mime === undefined ? '' : mime;
}

/**
 * 把文件路径转成 file URI（`@ohos.file.fileuri` 的 `getUriFromPath`）。
 *
 * 【为什么必须过这一手】PreviewKit 吃的是 URI 而不是路径。同一条链路上，
 * `FilePicker.ets` 反着用 `new fileUri.FileUri(uri).path` 把 picker 返回值转成路径，
 * 两边严格互逆。
 *
 * 【失败返回空串】非法路径/无权限时 `getUriFromPath` 抛 `401`。这里吞掉异常返回空串，
 * 由调用方按"拿不到 URI"处理（不猜、不拼字符串兜底 —— 拼错了只会得到更难查的错）。
 */
export function uriFromPath(path: string): string {
  const target: string = typeof path === 'string' ? path.trim() : '';
  if (target.length === 0) {
    return '';
  }
  try {
    return fileUri.getUriFromPath(target);
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, '路径转 URI 失败：code=%{public}d msg=%{public}s', e.code, e.message);
    return '';
  }
}

/**
 * 探测"这个文件能不能用系统预览打开"。
 *
 * d.ts 注释逐字：`only checks whether the file exists and whether the file type is
 * supported` ⇒ **只**判存在性与类型，不代表一定能渲出来。用作"要不要显示入口"的
 * 判据是合适的，用作"打开一定成功"的保证则不是。
 *
 * @returns 出错一律 false（绝不把失败说成可用）。
 */
export async function canPreviewFile(context: common.UIAbilityContext, uri: string): Promise<boolean> {
  if (uri.length === 0) {
    return false;
  }
  try {
    const ok: boolean = await filePreview.canPreview(context, uri);
    return ok === true;
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, 'canPreview 失败：code=%{public}d msg=%{public}s', e.code, e.message);
    return false;
  }
}

/**
 * 打开系统原生预览窗。
 *
 * 【同步返回 void / 异步 bool】`openPreview` 返回 Promise，但它在**窗口创建成功**
 * 时就 resolve —— 之后的渲染失败（文档损坏等）不在这个 Promise 里。所以 `true`
 * 的含义是"系统受理并弹了窗"，不是"文档一定能看"。
 *
 * @param title 预览窗标题；空串则系统按 URI 解析文件名（d.ts 逐字）。
 * @param mimeType 空串则系统按 URI 后缀推断（d.ts 逐字）。
 * @returns 系统是否受理。失败（含手机/平板无此 syscap 时的 801、非法 URI 的 401）
 *          一律 false，由调用方决定提示文案 —— 本层不认识产品文案。
 */
export async function openSystemPreview(context: common.UIAbilityContext, uri: string,
  title: string, mimeType: string): Promise<boolean> {
  if (uri.length === 0) {
    return false;
  }
  try {
    const file: filePreview.PreviewInfo = { title: title, uri: uri, mimeType: mimeType };
    await filePreview.openPreview(context, file);
    hilog.info(DOMAIN, TAG, '系统预览已受理：%{public}s', uri);
    return true;
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, 'openPreview 失败：code=%{public}d msg=%{public}s', e.code, e.message);
    return false;
  }
}

/** 预览窗是否已经开着（单例，创建前恒 false）。出错按"没开"处理。 */
export async function isPreviewDisplayed(context: common.UIAbilityContext): Promise<boolean> {
  try {
    const shown: boolean = await filePreview.hasDisplayed(context);
    return shown === true;
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, 'hasDisplayed 失败：code=%{public}d msg=%{public}s', e.code, e.message);
    return false;
  }
}

/**
 * 关闭预览窗。
 *
 * 【为什么返回 void 而不返回 bool】d.ts 说"窗不存在时失败"—— 这不是异常而是**终态
 * 已达成**（我们想要的结果就是"没有预览窗"）。再往上报一个 false 只会让调用方写出
 * 无意义的判断。
 */
export async function closeSystemPreview(context: common.UIAbilityContext): Promise<void> {
  try {
    await filePreview.closePreview(context);
  } catch (err) {
    const e = err as BusinessError;
    hilog.info(DOMAIN, TAG,
      'closePreview 未成功（窗不存在时属预期）：code=%{public}d msg=%{public}s', e.code, e.message);
  }
}

/**
 * 系统「文件」App 的包名 / Ability。
 *
 * 【为什么不是 com.huawei.hmos.filemanager】那是 PC / 2in1 的「文件管理」；
 * 手机 / 平板上的文件浏览器是 `com.huawei.hmos.files`（HmFiles），它的 EntryAbility
 * 支持 `fileUri` 参数：传入**文件**的 `file://docs/...` URI，会打开该文件所在的
 * 文件夹并把文件列出来。`com.huawei.hmos.filemanager` 的 DesktopPathPickerAbility
 * 对我们不可见（真机 `aa start` 报 10103001），不能作为兜底。
 */
const FILE_MANAGER_BUNDLE: string = 'com.huawei.hmos.files';
const FILE_MANAGER_ABILITY: string = 'EntryAbility';

/**
 * 用系统「文件」App 打开文件所在文件夹（真实的文件管理器视图）。
 *
 * `DocumentViewPicker` 是**选择器**（只能选、不能看），这就是上一版"点了只进
 * 选择器"的根因。`fileUri` 参数是 Files App 的入口：传文件 URI，它打开父目录
 * 并选中该文件；传目录 URI，它只打开父目录。所以这里传**文件**的 URI。
 *
 * @returns 是否受理（拒绝时由调用方回退到 picker）
 */
function openWithFileManager(context: common.UIAbilityContext, uri: string): Promise<boolean> {
  const want: Want = {
    bundleName: FILE_MANAGER_BUNDLE,
    abilityName: FILE_MANAGER_ABILITY,
    parameters: { fileUri: uri }
  };
  return context.startAbility(want).then((): boolean => {
    hilog.info(DOMAIN, TAG, '系统文件管理器已受理：%{public}s', uri);
    return true;
  }).catch((err: BusinessError): boolean => {
    hilog.warn(DOMAIN, TAG, '系统文件管理器未受理（回退选择器）：code=%{public}d msg=%{public}s',
      err.code, err.message);
    return false;
  });
}

/** 旧方案：文件选择器定位（Files App 不可用时的兜底）。 */
function openWithPicker(context: common.UIAbilityContext | common.Context, uri: string): string {
  try {
    const options: picker.DocumentSelectOptions = new picker.DocumentSelectOptions();
    options.defaultFilePathUri = uri;
    options.maxSelectNumber = 1;
    options.selectMode = picker.DocumentSelectMode.FILE;
    const view: picker.DocumentViewPicker = new picker.DocumentViewPicker(context);
    view.select(options).then((): void => {
      hilog.info(DOMAIN, TAG, '文件选择器定位已返回：%{public}s', uri);
    }).catch((err: BusinessError): void => {
      hilog.warn(DOMAIN, TAG, '文件选择器定位结束：code=%{public}d msg=%{public}s',
        err.code, err.message);
    });
    return 'ok';
  } catch (err) {
    const e = err as BusinessError;
    hilog.warn(DOMAIN, TAG, '打开文件选择器定位失败：code=%{public}d msg=%{public}s',
      e.code, e.message);
    return 'threw';
  }
}

/**
 * 打开系统文件管理器并定位到指定文件所在位置。
 *
 * 优先走系统「文件」App（`com.huawei.hmos.files` + `fileUri` 参数）——它会打开
 * 文件所在**文件夹并选中文件**；只有 startAbility 被拒（旧系统/无 Files App）
 * 才回退到 `DocumentViewPicker`（选择器，只能选不能看）。
 *
 * 返回值供同步 JavaScriptProxy 桥使用：ok / empty / nouri / context。
 * 注意：startAbility 是异步的，返回 'ok' 只表示"已发起"；失败会在后台回退
 * 到 picker，并写 hilog（不把异步失败伪装成同步错误）。
 */
export function openFileLocation(context: common.UIAbilityContext | common.Context,
  path: string): string {
  const target: string = typeof path === 'string' ? path.trim() : '';
  if (target.length === 0) {
    return 'empty';
  }
  const uri: string = uriFromPath(target);
  if (uri.length === 0) {
    return 'nouri';
  }
  if (context === undefined || context === null) {
    return 'context';
  }
  const abilityCtx: common.UIAbilityContext = context as common.UIAbilityContext;
  openWithFileManager(abilityCtx, uri).then((accepted: boolean): void => {
    if (accepted) {
      return;
    }
    const status: string = openWithPicker(abilityCtx, uri);
    if (status !== 'ok') {
      hilog.warn(DOMAIN, TAG, '文件管理器定位失败且选择器兜底未成功：%{public}s', status);
    }
  }).catch((err: BusinessError): void => {
    hilog.warn(DOMAIN, TAG, '文件管理器定位异步失败：%{public}s', err.message);
  });
  return 'ok';
}
