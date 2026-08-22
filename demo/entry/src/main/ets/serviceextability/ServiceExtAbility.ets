/*
 * ServiceExtAbility.ets — Binder service for Native IPC PING test
 * Receives: code=1, int32=123 → Responds: int32=456
 */
import { AppServiceExtensionAbility } from '@kit.AbilityKit';
import { Want } from '@kit.AbilityKit';
import { rpc } from '@kit.IPCKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN = 0x0000;
const TAG = 'HapIpcSvc';

class StubTest extends rpc.RemoteObject {
  constructor(des: string) { super(des); }

  onRemoteMessageRequest(code: number, data: rpc.MessageSequence,
                         reply: rpc.MessageSequence,
                         _options: rpc.MessageOption): boolean | Promise<boolean> {
    hilog.info(DOMAIN, TAG, 'onRemoteRequest code=%{public}d', code);
    if (code === 1) {
      let input = data.readInt();
      hilog.info(DOMAIN, TAG, 'PING received: %{public}d', input);
      reply.writeInt(input > 0 ? input * 2 : 456);
      return true;
    }
    hilog.warn(DOMAIN, TAG, 'Unknown code: %{public}d', code);
    return false;
  }
}

export default class ServiceExtAbility extends AppServiceExtensionAbility {
  onCreate(want: Want): void {
    hilog.info(DOMAIN, TAG, 'onCreate');
  }
  onRequest(want: Want, startId: number): void {
    hilog.info(DOMAIN, TAG, 'onRequest');
  }
  onConnect(want: Want): rpc.RemoteObject {
    hilog.info(DOMAIN, TAG, 'onConnect');
    return new StubTest('hapipc_ping');
  }
  onDisconnect(want: Want): void {
    hilog.info(DOMAIN, TAG, 'onDisconnect');
  }
  onDestroy(): void {
    hilog.info(DOMAIN, TAG, 'onDestroy');
  }
}
