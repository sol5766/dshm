/**
 * DSHM 工作区授权模块（ArkTS）。
 *
 * 职责：
 * 1. 首次启动请求全盘文件访问授权（系统权限弹窗，仅一次）——参考 demo 项目
 *    的授权引导方式；授权后默认工作区直接落在鸿蒙 PC 个人文件夹
 *    （/storage/Users/currentUser，数据外置，卸载/重置不丢），无需用户挑目录；
 * 2. 对用户另行选择的目录用 DocumentViewPicker（FOLDER 模式）+ fileshare
 *    persistPermission 持久授权，并把 URI 持久化到 preferences；
 * 3. node 子进程以真实路径访问个人文件夹（libdsh_host 已 chdir 到
 *    /storage/Users/currentUser）；仅对非默认盘目录保持"同步到沙箱 workspace"
 *    的兜底路径。
 */
import { picker } from '@kit.CoreFileKit';
import { fileShare } from '@kit.CoreFileKit';
import { fileIo } from '@kit.CoreFileKit';
import { preferences } from '@kit.ArkData';
import { abilityAccessCtrl, common, PermissionRequestResult, Permissions } from '@kit.AbilityKit';
import { DshmLogger } from '../utils/Logger';

const TAG: string = 'WorkspaceAccess';
const PREFS_NAME: string = 'dshm_workspace';
const KEY_FOLDER_URI: string = 'folder_uri';
const KEY_FOLDER_NAME: string = 'folder_name';
const KEY_SKIP_SELECTION: string = 'skip_selection';
const KEY_FULL_GRANTED: string = 'full_disk_granted_asked';
/** 是否已就"全盘访问需手动开启"给过一次提示。 */
const KEY_FULL_DISK_NOTIFIED: string = 'full_disk_notified';
/** 全盘访问权限（module.json5 的 requestPermissions 已声明）。
 *
 *  注意：按官方《受限开放权限》定义，ohos.permission.ACCESS_USER_FULL_DISK 是
 *  system_basic + **manual_settings** 的受限权限（需 AGC 审核、且只能由用户在
 *  系统设置里手动开启），**没有弹窗形态**。对它调 requestPermissionsFromUser
 *  必然抛错 —— 这正是"首次安装没有弹出全盘授权提示"的根因。
 *  因此它只用于状态探测，实际弹窗交给下面两个可申请的公共目录权限。 */
const PERM_FULL_DISK: Permissions = 'ohos.permission.ACCESS_USER_FULL_DISK';
/**
 * 可唤起系统授权弹窗的公共目录权限（2in1 专用，normal + user_grant）。
 * 见官方《开放权限(用户授权)》：READ_WRITE_DOWNLOAD_DIRECTORY /
 * READ_WRITE_DOCUMENTS_DIRECTORY 自 API 12 起为 normal 级别，声明即可弹窗。
 */
const PERM_PUBLIC_DIRS: Array<Permissions> = [
  'ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY',
  'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY'
];
/** 授权弹窗等待上限：用户长时间不操作时不无限期卡住启动。 */
const PERM_DIALOG_TIMEOUT_MS: number = 30000;
/**
 * 鸿蒙 2in1 PC 个人文件夹（全盘授权后沙箱内真实路径可读写，node/libdsh_host
 * 直接 chdir 到它作为默认工作区，数据外置到用户个人盘更安全）。
 */
const PERSONAL_DIR_REAL: string = '/storage/Users/currentUser';
/** 个人文件夹对应的文件 URI（picker 默认落点与授权记录用）。 */
const PERSONAL_DIR_URI: string = 'file://docs/storage/Users/currentUser';
const PERSONAL_DIR_NAME: string = '个人文件夹';

export class WorkspaceAccess {
  /** 当前设备是否支持 picker 选择目录（FOLDER 模式）。 */
  static supportsFolderSelection(): boolean {
    return canIUse('SystemCapability.FileManagement.UserFileService.FolderSelection');
  }

  /**
   * 首次启动引导：申请文件访问授权（系统权限弹窗，一次性）。
   *
   * 弹的是**能弹**的那两个权限：READ_WRITE_DOWNLOAD_DIRECTORY /
   * READ_WRITE_DOCUMENTS_DIRECTORY（2in1、normal + user_grant）。全盘访问权
   * ACCESS_USER_FULL_DISK 没有弹窗形态（manual_settings 受限权限），这里只做
   * 状态探测并记日志，由界面侧给出"去系统设置手动开启"的引导。
   *
   * 授权通过后把默认工作区落为鸿蒙"个人文件夹"（/storage/Users/currentUser）
   * —— node/libdsh_host 直接以该路径为工作目录，数据放在用户个人盘（外置，
   * 卸载不丢），无需用户再手动挑选目录。
   */
  static async ensureInitialSelection(context: common.UIAbilityContext): Promise<void> {
    try {
      const store = await preferences.getPreferences(context, PREFS_NAME);
      const asked = await store.get(KEY_FULL_GRANTED, false);
      const hasRecord: boolean = (await WorkspaceAccess.loadUri(context)) !== '';
      if (asked === true && hasRecord) {
        return; // 本次安装内已引导过且已有工作区记录，不重复弹窗
      }

      // 1) 系统授权弹窗：用户公共目录（下载 / 文档）。
      let grantedAny: boolean = false;
      const atManager = abilityAccessCtrl.createAtManager();
      try {
        const result = await Promise.race([
          atManager.requestPermissionsFromUser(context, PERM_PUBLIC_DIRS),
          new Promise<PermissionRequestResult | null>((resolve) => {
            setTimeout(() => resolve(null), PERM_DIALOG_TIMEOUT_MS);
          })
        ]);
        if (result !== null && result.authResults !== undefined && result.authResults.length > 0) {
          for (let i = 0; i < result.authResults.length; i++) {
            if (result.authResults[i] === 0) {
              grantedAny = true;
            }
          }
          DshmLogger.info(TAG, '公共目录授权结果: ' + JSON.stringify(result.authResults));
        } else {
          DshmLogger.warn(TAG, '公共目录授权弹窗无响应（超时或无人操作），下次启动重试');
          return;
        }
      } catch (e) {
        DshmLogger.warn(TAG, '申请公共目录权限失败（跳过，不影响启动）: ' + String(e));
      }

      // 2) 全盘访问权：manual_settings 受限权限，无法弹窗，只探测状态。
      const fullDisk: boolean = await WorkspaceAccess.isFullDiskGranted(context);
      DshmLogger.info(TAG, '全盘文件访问权限: ' +
        (fullDisk ? '已开启' : '未开启（需在系统设置中手动开启）'));

      await store.put(KEY_FULL_GRANTED, true);
      await store.flush();
      if (grantedAny || fullDisk) {
        // 授权成功：默认工作区落盘为"个人文件夹"（记录 URI，供 loadUri 非空
        // 短路；真正 chdir 由 libdsh_host 的 access 探测决定）。
        await WorkspaceAccess.saveWorkspaceRecord(context, PERSONAL_DIR_URI, PERSONAL_DIR_NAME);
      }
    } catch (e) {
      DshmLogger.warn(TAG, '授权引导失败（跳过，不影响启动）: ' + String(e));
    }
  }

  /**
   * 探测全盘文件访问权限是否已开启。
   *
   * ACCESS_USER_FULL_DISK 是 system_basic + manual_settings 权限，普通应用在
   * 未获 AGC 授权时 checkAccessToken 也可能直接抛错，此处一律按"未开启"处理。
   */
  static async isFullDiskGranted(context: common.UIAbilityContext): Promise<boolean> {
    try {
      const atManager = abilityAccessCtrl.createAtManager();
      const tokenId: number = context.applicationInfo.accessTokenId;
      const status = await atManager.checkAccessToken(tokenId, PERM_FULL_DISK);
      return status === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED;
    } catch (e) {
      return false;
    }
  }

  /**
   * 是否需要向用户提示"全盘访问需手动开启"（每次安装只提示一次）。
   *
   * 全盘访问权限没有系统弹窗，只能引导用户去系统设置里开；为避免每次启动都
   * 打扰，这里用 preferences 记一次性标记。已开启时直接返回 false。
   */
  static async shouldNotifyFullDisk(context: common.UIAbilityContext): Promise<boolean> {
    try {
      const store = await preferences.getPreferences(context, PREFS_NAME);
      const notified = await store.get(KEY_FULL_DISK_NOTIFIED, false);
      if (notified === true) {
        return false;
      }
      if (await WorkspaceAccess.isFullDiskGranted(context)) {
        return false;
      }
      await store.put(KEY_FULL_DISK_NOTIFIED, true);
      await store.flush();
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 当前默认工作区真实路径（node/libdsh_host 以此为 chdir 目标）。 */
  static personalDirPath(): string {
    return PERSONAL_DIR_REAL;
  }

  /**
   * 拉起系统目录选择器，选中目录后立即持久授权，并把 URI 存入 preferences。
   * @returns 授权目录 URI；用户取消或失败返回空串。
   */
  static async selectAndPersistFolder(context: common.UIAbilityContext): Promise<string> {
    if (!WorkspaceAccess.supportsFolderSelection()) {
      DshmLogger.warn(TAG, '当前设备不支持 picker 目录选择（FolderSelection 能力缺失）');
      return '';
    }
    const documentPicker = new picker.DocumentViewPicker(context);
    const options = new picker.DocumentSelectOptions();
    options.selectMode = picker.DocumentSelectMode.FOLDER;
    options.maxSelectNumber = 1;
    // 默认落在鸿蒙个人文件夹（file://docs/storage/Users/currentUser），
    // 而不是系统默认/最近使用目录 —— 与"默认工作区=个人文件夹"语义一致。
    try {
      options.defaultFilePathUri = PERSONAL_DIR_URI;
    } catch (e) {
      // 老 SDK 无该字段时忽略，走 picker 默认页
    }
    let uris: Array<string> = [];
    try {
      uris = await documentPicker.select(options);
    } catch (e) {
      const msg: string = e instanceof Error ? e.message : String(e);
      DshmLogger.error(TAG, '目录选择失败: ' + msg);
      return '';
    }
    if (uris.length === 0) {
      DshmLogger.info(TAG, '用户取消目录选择');
      return '';
    }
    const uri: string = uris[0];
    const ok: boolean = await WorkspaceAccess.persistUri(uri);
    if (!ok) {
      return '';
    }
    await WorkspaceAccess.saveUri(context, uri, WorkspaceAccess.displayNameOf(uri));
    DshmLogger.info(TAG, '目录授权成功: ' + uri);
    return uri;
  }

  /** 对单个 URI 申请持久读写授权。 */
  static async persistUri(uri: string): Promise<boolean> {
    const policy: fileShare.PolicyInfo = {
      uri: uri,
      operationMode: fileShare.OperationMode.READ_MODE | fileShare.OperationMode.WRITE_MODE
    };
    try {
      await fileShare.persistPermission([policy]);
      return true;
    } catch (e) {
      const msg: string = e instanceof Error ? e.message : String(e);
      DshmLogger.error(TAG, '持久授权失败: ' + msg);
      return false;
    }
  }

  /** 激活已持久化的授权（应用重启后恢复访问能力）。 */
  static async activatePersisted(context: common.UIAbilityContext): Promise<void> {
    const uri: string = await WorkspaceAccess.loadUri(context);
    if (uri === '') {
      return;
    }
    const policy: fileShare.PolicyInfo = {
      uri: uri,
      operationMode: fileShare.OperationMode.READ_MODE | fileShare.OperationMode.WRITE_MODE
    };
    try {
      await fileShare.activatePermission([policy]);
      DshmLogger.info(TAG, '已激活持久授权: ' + uri);
    } catch (e) {
      const msg: string = e instanceof Error ? e.message : String(e);
      DshmLogger.warn(TAG, '激活持久授权失败（可能已失效）: ' + msg);
    }
  }

  /**
   * 把已授权的用户目录内容同步到沙箱 workspace（<filesDir>/workspace）。
   * dsh 的 node 子进程无法直接访问公共目录 URI，只能读写沙箱路径；
   * 授权目录内容落到沙箱 workspace 后，tool-fs/bash 即可读写。
   * 无授权记录或同步失败时静默跳过（不阻塞 DSH 启动）。
   */
  static async syncAuthorizedToWorkspace(context: common.UIAbilityContext): Promise<void> {
    const uri: string = await WorkspaceAccess.loadUri(context);
    if (uri === '') {
      return;
    }
    await WorkspaceAccess.activatePersisted(context);
    if (uri === PERSONAL_DIR_URI) {
      // 默认工作区=个人文件夹：node/libdsh_host 已直接 chdir 到真实路径
      // /storage/Users/currentUser，无需再复制一份到沙箱 workspace。
      DshmLogger.info(TAG, '默认工作区=个人文件夹（node 直用真实路径，跳过沙箱复制）');
      return;
    }
    const workspaceDir: string = context.filesDir + '/workspace';
    try {
      if (!fileIo.accessSync(workspaceDir)) {
        fileIo.mkdirSync(workspaceDir);
      }
      // 授权 URI 作为源，复制到沙箱 workspace（copyDirSync 支持 URI 源）
      fileIo.copyDirSync(uri, workspaceDir);
      DshmLogger.info(TAG, '授权目录已同步到沙箱 workspace: ' + workspaceDir);
    } catch (e) {
      const msg: string = e instanceof Error ? e.message : String(e);
      DshmLogger.warn(TAG, '授权目录同步失败（跳过，不影响启动）: ' + msg);
    }
  }

  /** 持久化 URI 到 preferences。 */
  private static async saveUri(context: common.UIAbilityContext, uri: string, name: string): Promise<void> {
    try {
      const store = await preferences.getPreferences(context, PREFS_NAME);
      await store.put(KEY_FOLDER_URI, uri);
      await store.put(KEY_FOLDER_NAME, name);
      await store.flush();
    } catch (e) {
      const msg: string = e instanceof Error ? e.message : String(e);
      DshmLogger.error(TAG, '保存授权记录失败: ' + msg);
    }
  }

  /** 外部（授权引导/菜单）公共入口：持久化工作区 URI。 */
  static async saveWorkspaceRecord(context: common.UIAbilityContext, uri: string, name: string): Promise<void> {
    await WorkspaceAccess.saveUri(context, uri, name);
  }

  /** 从 preferences 读取已保存的授权目录 URI。 */
  static async loadUri(context: common.UIAbilityContext): Promise<string> {
    try {
      const store = await preferences.getPreferences(context, PREFS_NAME);
      const v = await store.get(KEY_FOLDER_URI, '');
      return typeof v === 'string' ? v : '';
    } catch (e) {
      const msg: string = e instanceof Error ? e.message : String(e);
      DshmLogger.error(TAG, '读取授权记录失败: ' + msg);
      return '';
    }
  }

  /** 清除已保存的授权记录（不撤销系统授权）。 */
  static async clearSaved(context: common.UIAbilityContext): Promise<void> {
    try {
      const store = await preferences.getPreferences(context, PREFS_NAME);
      await store.delete(KEY_FOLDER_URI);
      await store.delete(KEY_FOLDER_NAME);
      await store.flush();
    } catch (e) {
      const msg: string = e instanceof Error ? e.message : String(e);
      DshmLogger.error(TAG, '清除授权记录失败: ' + msg);
    }
  }

  /** 从 URI 提取可读的目录名（file://docs/storage/.../name 取末段）。 */
  private static displayNameOf(uri: string): string {
    const idx: number = uri.lastIndexOf('/');
    const seg: string = idx >= 0 ? uri.substring(idx + 1) : uri;
    return seg !== '' ? seg : uri;
  }

  /**
   * 菜单"选择工作区"：拉起目录选择器（可选个人目录下任意位置），
   * 选中后持久授权并同步到沙箱 workspace。
   * @returns 授权目录 URI；用户取消/不支持返回空串。
   */
  static async chooseWorkspaceFromMenu(context: common.UIAbilityContext): Promise<string> {
    const uri: string = await WorkspaceAccess.selectAndPersistFolder(context);
    if (uri !== '') {
      await WorkspaceAccess.syncAuthorizedToWorkspace(context);
    }
    return uri;
  }
}
