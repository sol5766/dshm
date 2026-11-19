/**
 * 端侧 A2A：AgentExtensionAbility 服务端（docs/172 §5.4）。
 *
 * ## 这是什么
 *
 * 端侧 A2A 框架（API 24+）的服务端载体：**系统侧客户端**（小艺 Client Agent）连接本组件后，
 * 通过 `onAuth` 握手、`onData`/`sendData` 双向通道与本应用内的智能体能力交互。
 * 它让 DSHM 的"会话能力"以标准 A2A 形态暴露给系统入口，而**不必重写已有 Agent**。
 *
 * ## 接入三件套（官方口径）
 *
 * 1. 本文件（AgentExtensionAbility 生命周期实现）；
 * 2. `module.json5` 的 `extensionAbilities` 项：`type: "agent"` + `exported: true` +
 *    metadata `ohos.extension.agent` → `$profile:agent_config`；
 * 3. `resources/base/profile/agent_config.json`（AgentCard：agentId/name/description/skills/...）。
 *
 * ## 平台侧（不在本文件范围）
 *
 * 小艺开放平台"端 A2A 模式"需关联 AGC 已发布应用、填写**应用服务名称**（= module.json5 里
 * `type:"agent"` 那一项的 `name`，即本类名 `AgentExtAbility`，**写错即无法通信**）、
 * 导入本仓 `agent_config.json`。平台联调阶段如需认证/协议对齐，改 `onAuth` 与 `onData` 的
 * 报文格式即可，接入骨架不动。
 *
 * ## 首版范围（2026-10-16）
 *
 * - **最小指令协议**：`onData` 收到含 `new-session` / `新建会话` 的报文 → 复用已验证通道
 *   （`AppStorage 'dshLaunchAction'` → WebApp 三层消费 → DOM 注入点击前端「新建会话」按钮）
 *   → 回 `{"code":0,...}`；其余报文一律回 `{"code":1,"msg":"unsupported"}`（fail-closed，
 *   不自作主张执行）。
 * - **认证**：首版 `onAuth` 直接放行（本地联调）；真正的 A2A 握手格式待平台联调对齐 ——
 *   在此之前，本组件"最多被外部触发一次新建会话"，无更高破坏面。
 * - 真机判据：hilog 搜 `DSHM-A2A`（本组件）与 `DSHM-ACTION`（页面侧，被触发时）。
 */
import { AgentExtensionAbility, common, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'DSHM-A2A';

export default class AgentExtAbility extends AgentExtensionAbility {
  /** 连接代理（onConnect 保存、onDisconnect 清理；供将来主动推送用） */
  private hostProxy: common.AgentHostProxy | null = null;

  onCreate(want: Want): void {
    hilog.info(DOMAIN, TAG, 'DSHM-A2A onCreate');
  }

  onConnect(want: Want, proxy: common.AgentHostProxy): void {
    hilog.info(DOMAIN, TAG, 'DSHM-A2A onConnect');
    this.hostProxy = proxy;
  }

  onAuth(proxy: common.AgentHostProxy, handshakeData: string): void {
    hilog.info(DOMAIN, TAG, 'DSHM-A2A onAuth len=%{public}d', handshakeData.length);
    try {
      // 首版放行（本地联调）；平台联调阶段按 A2A 握手规范校验后回 authorize
      proxy.authorize('{"code":0,"msg":"accepted"}');
    } catch (err) {
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, 'DSHM-A2A authorize 失败 code=%{public}d msg=%{public}s', e.code, e.message);
    }
  }

  onData(proxy: common.AgentHostProxy, data: string): void {
    hilog.info(DOMAIN, TAG, 'DSHM-A2A onData len=%{public}d', data.length);
    const reply: string = this.handleInstruction(data);
    try {
      proxy.sendData(reply);
    } catch (err) {
      const e = err as BusinessError;
      hilog.warn(DOMAIN, TAG, 'DSHM-A2A sendData 失败 code=%{public}d msg=%{public}s', e.code, e.message);
    }
  }

  onDisconnect(want: Want, proxy: common.AgentHostProxy): void {
    hilog.info(DOMAIN, TAG, 'DSHM-A2A onDisconnect');
    this.hostProxy = null;
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, 'DSHM-A2A onDestroy');
    this.hostProxy = null;
  }

  /**
   * 最小指令协议（首版）：命中"新建会话"→ 发布 dshLaunchAction；否则 fail-closed。
   *
   * 【为什么用 contains 而不是 JSON 解析】首版尚无与客户端约定的报文格式（平台联调时对齐），
   * 用最宽进严出的做法：识别即执行白名单里唯一允许的动作，识别不出就什么都不做。
   */
  private handleInstruction(data: string): string {
    const hit: boolean = data.indexOf('new-session') >= 0 || data.indexOf('新建会话') >= 0;
    if (!hit) {
      return '{"code":1,"msg":"unsupported instruction"}';
    }
    // 复用桌面快捷方式/意图框架验证过的通道：页面侧三层消费点接住后注入点击
    AppStorage.setOrCreate<string>('dshLaunchAction', 'new-session');
    hilog.info(DOMAIN, TAG, 'DSHM-A2A 命中新建会话，已发布 dshLaunchAction');
    return '{"code":0,"msg":"session creation started"}';
  }
}
