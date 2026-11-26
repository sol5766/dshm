import { window } from '@kit.ArkUI';

/** dsh-pet 子窗句柄与最近一次宠物本体包围盒（物理像素）：PetAbility 据此把宿主主窗藏到宠物身下。 */
export class PetWindowHolder {
  static sub: window.Window | undefined = undefined;
  static boxX: number = -1;
  static boxY: number = -1;
  static boxSize: number = 0;
}
