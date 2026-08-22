/**
 * DSHM 鸿蒙信息桥（ArkTS）。
 *
 * 移植自 dsh-OHDSH/HDSH（MIT）：https://gitcode.com/MakeBlackSheepGreat/dsh-OHDSH
 *
 * 把鸿蒙侧事实（设备信息、工作区授权状态、环境版本）写入
 * <filesDir>/etc/hdsh-ohos-info.json，供 dsh Web UI 的"鸿蒙设置"
 * 设置段通过 dsh host HTTP 端点读取展示。
 */
import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { HdshLogger } from '../utils/Logger';
import { WorkspaceAccess } from '../access/WorkspaceAccess';

const TAG: string = 'OhosInfoBridge';
const ETC_SUBDIR: string = 'etc';
const INFO_FILE: string = 'hdsh-ohos-info.json';

/** 写入鸿蒙信息 JSON（每次启动调用，覆盖旧内容）。 */
export async function writeOhosInfo(context: common.UIAbilityContext): Promise<void> {
  try {
    const etcDir: string = context.filesDir + '/' + ETC_SUBDIR;
    if (!fileIo.accessSync(etcDir)) {
      fileIo.mkdirSync(etcDir);
    }
    const uri: string = await WorkspaceAccess.loadUri(context);
    const info: string = JSON.stringify({
      deviceType: deviceInfo.deviceType,
      marketName: deviceInfo.marketName,
      productModel: deviceInfo.productModel,
      osFullName: deviceInfo.osFullName,
      displayVersion: deviceInfo.displayVersion,
      sdkApiVersion: deviceInfo.sdkApiVersion,
      folderSelectionSupported: WorkspaceAccess.supportsFolderSelection(),
      workspaceAuthorizedUri: uri
    });
    const file = fileIo.openSync(etcDir + '/' + INFO_FILE,
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    fileIo.writeSync(file.fd, info);
    fileIo.closeSync(file);
    HdshLogger.info(TAG, '鸿蒙信息已写入 ' + INFO_FILE);
  } catch (e) {
    const msg: string = e instanceof Error ? e.message : String(e);
    HdshLogger.warn(TAG, '写入鸿蒙信息失败: ' + msg);
  }
}
