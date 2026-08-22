/**
 * DSHM 工作区授权模块（ArkTS）。
 *
 * 移植自 dsh-OHDSH/HDSH（MIT）：https://gitcode.com/MakeBlackSheepGreat/dsh-OHDSH
 *
 * 职责：
 * 1. 通过 DocumentViewPicker 选择用户目录（FOLDER 模式，需系统能力
 *    SystemCapability.FileManagement.UserFileService.FolderSelection；
 *    手机/平板 API 23 可能不支持，用 canIUse 检测并降级）；
 * 2. 用 @ohos.fileshare.persistPermission 对选中目录做持久授权
 *    （需要 ohos.permission.FILE_ACCESS_PERSIST），使授权跨应用重启保留；
 * 3. 把授权 URI 持久化到 preferences，启动时可 activatePermission 恢复。
 *
 * 注意：鸿蒙沙箱内 node 子进程无法直接以 URI 访问公共目录，
 * 授权目录最终通过导入/导出同步到 <filesDir>/workspace 由 dsh 使用。
 */
import { picker } from '@kit.CoreFileKit';
import { fileShare } from '@kit.CoreFileKit';
import { fileIo } from '@kit.CoreFileKit';
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { HdshLogger } from '../utils/Logger';

const TAG: string = 'WorkspaceAccess';
const PREFS_NAME: string = 'hdsh_workspace';
const KEY_FOLDER_URI: string = 'folder_uri';
const KEY_FOLDER_NAME: string = 'folder_name';

export class WorkspaceAccess {
  /** 当前设备是否支持 picker 选择目录（FOLDER 模式）。 */
  static supportsFolderSelection(): boolean {
    return canIUse('SystemCapability.FileManagement.UserFileService.FolderSelection');
  }

  /**
   * 拉起系统目录选择器，选中目录后立即持久授权，并把 URI 存入 preferences。
   * @returns 授权目录 URI；用户取消或失败返回空串。
   */
  static async selectAndPersistFolder(context: common.UIAbilityContext): Promise<string> {
    if (!WorkspaceAccess.supportsFolderSelection()) {
      HdshLogger.warn(TAG, '当前设备不支持 picker 目录选择（FolderSelection 能力缺失）');
      return '';
    }
    const documentPicker = new picker.DocumentViewPicker(context);
    const options = new picker.DocumentSelectOptions();
    options.selectMode = picker.DocumentSelectMode.FOLDER;
    options.maxSelectNumber = 1;
    let uris: Array<string> = [];
    try {
      uris = await documentPicker.select(options);
    } catch (e) {
      const msg: string = e instanceof Error ? e.message : String(e);
      HdshLogger.error(TAG, '目录选择失败: ' + msg);
      return '';
    }
    if (uris.length === 0) {
      HdshLogger.info(TAG, '用户取消目录选择');
      return '';
    }
    const uri: string = uris[0];
    const ok: boolean = await WorkspaceAccess.persistUri(uri);
    if (!ok) {
      return '';
    }
    await WorkspaceAccess.saveUri(context, uri, WorkspaceAccess.displayNameOf(uri));
    HdshLogger.info(TAG, '目录授权成功: ' + uri);
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
      HdshLogger.error(TAG, '持久授权失败: ' + msg);
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
      HdshLogger.info(TAG, '已激活持久授权: ' + uri);
    } catch (e) {
      const msg: string = e instanceof Error ? e.message : String(e);
      HdshLogger.warn(TAG, '激活持久授权失败（可能已失效）: ' + msg);
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
    const workspaceDir: string = context.filesDir + '/workspace';
    try {
      if (!fileIo.accessSync(workspaceDir)) {
        fileIo.mkdirSync(workspaceDir);
      }
      // 授权 URI 作为源，复制到沙箱 workspace（copyDirSync 支持 URI 源）
      fileIo.copyDirSync(uri, workspaceDir);
      HdshLogger.info(TAG, '授权目录已同步到沙箱 workspace: ' + workspaceDir);
    } catch (e) {
      const msg: string = e instanceof Error ? e.message : String(e);
      HdshLogger.warn(TAG, '授权目录同步失败（跳过，不影响启动）: ' + msg);
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
      HdshLogger.error(TAG, '保存授权记录失败: ' + msg);
    }
  }

  /** 从 preferences 读取已保存的授权目录 URI。 */
  static async loadUri(context: common.UIAbilityContext): Promise<string> {
    try {
      const store = await preferences.getPreferences(context, PREFS_NAME);
      const v = await store.get(KEY_FOLDER_URI, '');
      return typeof v === 'string' ? v : '';
    } catch (e) {
      const msg: string = e instanceof Error ? e.message : String(e);
      HdshLogger.error(TAG, '读取授权记录失败: ' + msg);
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
      HdshLogger.error(TAG, '清除授权记录失败: ' + msg);
    }
  }

  /** 从 URI 提取可读的目录名（file://docs/storage/.../name 取末段）。 */
  private static displayNameOf(uri: string): string {
    const idx: number = uri.lastIndexOf('/');
    const seg: string = idx >= 0 ? uri.substring(idx + 1) : uri;
    return seg !== '' ? seg : uri;
  }
}
