/**
 * 意图框架 · 自定义意图「新建会话」（docs/172 §5.3）。
 *
 * ## 这是什么
 *
 * 把"在 DSHM 中新建一个会话"注册成系统可发现、可执行的**意图**：用户通过系统入口
 * （小艺对话 / 小艺建议等）表达"打开 DSHM 新建会话"这类请求时，系统匹配到本意图，
 * 拉起 `EntryAbility`（前台）并执行 `onExecute()`。
 *
 * ## 为什么是"装饰器 + 自定义意图"
 *
 * - 装饰器方式（API 20+，官方推荐）：意图定义写在代码里，与执行逻辑同文件；
 *   配置文件 `insight_intent.json` 只声明执行文件路径。
 * - 自定义意图而非标准意图：标准意图清单（影音/出行/金融……）**没有 AI 编码助手垂类**，
 *   最接近的 `JumpFunctionPage`（ToolsDomain）语义是"跳转功能页"、且其 llmDescription /
 *   keywords 由系统按标准值覆盖 —— 无法表达"新建会话"。
 *   自定义意图可自带 `llmDescription` / `keywords`，语义匹配更准。
 * - `domain` 取 `ToolsDomain`（实用工具）—— domain 必须落在官方 14 个垂域内。
 *
 * ## 执行链路（复用桌面快捷方式验证过的通道）
 *
 * `onExecute()` 只做一件事：`AppStorage.setOrCreate('dshLaunchAction', 'new-session')`。
 * 其后与 `shortcuts_config.json` 完全同路：WebApp 页三层消费点
 * （aboutToAppear / onPageShow / @Watch）→ 白名单 → `NEW_SESSION_SCRIPT` DOM 注入点击
 * 前端「新建会话」按钮。真机判据：hilog 搜 `DSHM-INTENT`（本文件）与 `DSHM-ACTION`（页面侧）。
 *
 * 【为什么可以直接写 AppStorage】意图执行（UI_ABILITY_FOREGROUND）与 `EntryAbility`、
 * WebApp 页面**同进程同主线程**（意图框架通过 startAbility 拉起绑定 Ability，
 * 执行器在其上下文中运行）⇒ AppStorage 这张进程级状态表三方可见。
 * 时序上无论页面"已创建"（@Watch 接住）还是"尚未创建"（@StorageProp 初始化读到），
 * 三层消费点都能覆盖 —— 这正是那条通道设计三层的原因。
 *
 * ## 验证
 *
 * - 静态：编译通过 + 包内 `resources/base/profile/insight_intent.json` 在场。
 * - 真机：设备「设置 → 系统 → 开发者选项 → 意图框架调试」里可查到 `StartNewSession`
 *   并执行（官方工具，仅手机支持）。执行后应看到 DSHM 被拉起且新建会话。
 */
import { insightIntent, InsightIntentEntry, InsightIntentEntryExecutor } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'DSHM-Intent';

/** 意图执行结果（自定义意图的结果类型；本意图无入参，结果仅一句人话说明）。 */
class StartNewSessionResultDef {
  public msg?: string = '';
}

@InsightIntentEntry({
  intentName: 'StartNewSession',
  domain: 'ToolsDomain',
  intentVersion: '1.0.1',
  displayName: '新建会话',
  displayDescription: '在 DSHM 中新建一个 AI 会话',
  icon: $r('app.media.startIcon'),
  llmDescription: '当用户希望在 DSHM 中开始一个新的 AI 编码会话、新建对话或开始一个新任务时，调用此意图。',
  keywords: ['新建会话', '新会话', '开始新任务', 'DSHM'],
  abilityName: 'EntryAbility',
  executeMode: [insightIntent.ExecuteMode.UI_ABILITY_FOREGROUND],
  parameters: {
    '$schema': 'http://json-schema.org/draft-07/schema#',
    'type': 'object',
    'properties': {},
    'required': []
  }
})
export default class StartNewSessionImpl extends InsightIntentEntryExecutor<StartNewSessionResultDef> {
  onExecute(): Promise<insightIntent.IntentResult<StartNewSessionResultDef>> {
    hilog.info(DOMAIN, TAG, 'DSHM-INTENT StartNewSession onExecute（发布 dshLaunchAction=new-session）');
    // 复用桌面快捷方式通道：页面侧三层消费点会接住并注入点击前端「新建会话」按钮
    AppStorage.setOrCreate<string>('dshLaunchAction', 'new-session');
    const result: insightIntent.IntentResult<StartNewSessionResultDef> = {
      code: 0,
      result: {
        msg: '已在 DSHM 中开始新建会话'
      }
    };
    return Promise.resolve(result);
  }
}
