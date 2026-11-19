/**
 * 主应用侧的卡片推送器（2026-10-17，docs/178）。
 *
 * 【为什么需要它】FormExtensionAbility 只在"添加/定时刷新/用户事件"时被系统拉起；
 * 宿主 Node 进程把会话进度写进 `card-state.json` 后，没有任何系统回调能主动通知卡片进程。
 * 因此在主应用活着时（含后台常驻），每 2s 看一眼状态文件；**只有内容变化且确实存在已添加
 * 卡片**时才推 `formProvider.updateForm` —— 没有卡片时零开销，有卡片时也只是两个小文件的读。
 *
 * formId 登记表由 `UsageFormAbility` 在 onAddForm/onRemoveForm 维护（`form-ids.json`）。
 */
import { formBindingData, formProvider } from '@kit.FormKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { buildCardBinding, loadFormIds, readCardState } from '../form/CardState';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'DSHM-CARD';

/** 模块级：主窗可能被复用重建，推送器只挂一个。 */
let watcherStarted: boolean = false;

export function startCardStateWatcher(filesDir: string): () => void {
  if (watcherStarted) {
    return (): void => void 0;
  }
  watcherStarted = true;
  /**
   * 按 formId 记录**已成功推送**的状态版本。
   * 不能在 updateForm 发起前就记成功：一次失败（卡片进程重建、系统短暂拒绝）会让同一份
   * 内容此后永远被跳过，桌面卡片就停在旧数据上。
   */
  const deliveredRaw = new Map<string, string>();
  const timer: number = setInterval((): void => {
    try {
      const ids: string[] = loadFormIds(filesDir);
      if (ids.length === 0) {
        deliveredRaw.clear();
        return;   // 没添加卡片：不做任何读取
      }
      const wanted = new Set<string>(ids);
      for (const known of deliveredRaw.keys()) {
        if (!wanted.has(known)) deliveredRaw.delete(known);
      }
      const statePath: string = `${filesDir}/dsh/home/card-state.json`;
      if (!fs.accessSync(statePath)) {
        return;
      }
      const raw: string = fs.readTextSync(statePath);
      const pending: string[] = ids.filter((id: string): boolean => deliveredRaw.get(id) !== raw);
      if (pending.length === 0) {
        return;
      }
      const binding: formBindingData.FormBindingData =
        formBindingData.createFormBindingData(buildCardBinding(readCardState(filesDir)));
      hilog.info(DOMAIN, TAG, '准备更新卡片 forms=%{public}d rawLen=%{public}d', pending.length, raw.length);
      for (const id of pending) {
        formProvider.updateForm(id, binding).then((): void => {
          deliveredRaw.set(id, raw);
          hilog.info(DOMAIN, TAG, '卡片更新成功 formId=%{public}s', id);
        }).catch((error: BusinessError): void => {
          // 失败不记版本 ⇒ 下一拍仍会重试同一份内容。
          hilog.warn(DOMAIN, TAG, '卡片更新失败 formId=%{public}s code=%{public}d msg=%{public}s',
            id, error.code, error.message);
        });
      }
    } catch (e) {
      const error = e as BusinessError;
      hilog.warn(DOMAIN, TAG, '卡片状态读取失败 code=%{public}d msg=%{public}s', error.code, error.message);
    }
  }, 5000);
  if (timer < 0) {
    watcherStarted = false;
  }
  return (): void => {
    clearInterval(timer);
    watcherStarted = false;
  };
}
