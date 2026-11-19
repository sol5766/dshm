/**
 * 桌面服务卡片（FormExtensionAbility，2026-10-17，docs/178）。
 *
 * 卡片内容：当前会话进度 + 模型账户余额；**余额取不到时改显示 token 用量**
 * （今天 / 近5小时 / 近7天 / 近30天）。
 *
 * 生命周期里的三件事：
 *   · onAddForm     —— 登记 formId（主应用据此推送进度更新）+ 读 card-state.json 出首帧；
 *   · onUpdateForm  —— 周期刷新（form_config 的 updateDuration）重新读文件；
 *   · onRemoveForm  —— 把 formId 从登记表移除。
 * 数据只读 `<filesDir>/dsh/home/card-state.json`（宿主 Node 写），本组件不碰网络。
 */
import { formBindingData, FormExtensionAbility, formInfo, formProvider } from '@kit.FormKit';
import { Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { buildCardBinding, loadFormIds, readCardState, saveFormIds } from './CardState';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'DSHM-CARD';

export default class UsageFormAbility extends FormExtensionAbility {
  onAddForm(want: Want): formBindingData.FormBindingData {
    const filesDir: string = this.context.filesDir;
    let formId: string = '';
    try {
      const raw = want.parameters ? want.parameters[formInfo.FormParam.IDENTITY_KEY] : undefined;
      formId = raw === undefined || raw === null ? '' : String(raw);
    } catch (e) {
      formId = '';
    }
    if (formId.length > 0) {
      const ids: string[] = loadFormIds(filesDir);
      if (!ids.includes(formId)) {
        ids.push(formId);
        saveFormIds(filesDir, ids);
      }
    }
    hilog.info(DOMAIN, TAG, 'onAddForm formId=%{public}s', formId);
    return formBindingData.createFormBindingData(buildCardBinding(readCardState(filesDir)));
  }

  onUpdateForm(formId: string): void {
    const filesDir: string = this.context.filesDir;
    const data: formBindingData.FormBindingData =
      formBindingData.createFormBindingData(buildCardBinding(readCardState(filesDir)));
    formProvider.updateForm(formId, data).catch((error: BusinessError) => {
      hilog.warn(DOMAIN, TAG, 'onUpdateForm 更新失败 code=%{public}d msg=%{public}s', error.code, error.message);
    });
  }

  onFormEvent(formId: string, message: string): void {
    hilog.info(DOMAIN, TAG, 'onFormEvent formId=%{public}s message=%{public}s', formId, message);
    this.onUpdateForm(formId);
  }

  onRemoveForm(formId: string): void {
    const filesDir: string = this.context.filesDir;
    const ids: string[] = loadFormIds(filesDir).filter((x: string): boolean => x !== formId);
    saveFormIds(filesDir, ids);
    hilog.info(DOMAIN, TAG, 'onRemoveForm formId=%{public}s', formId);
  }
}
