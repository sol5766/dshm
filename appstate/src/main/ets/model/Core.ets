/**
 * 端侧核心的**呈现契约**（D6 §2/§6；体验规范沿用 D3 §4 的「失败必须给下一步」纪律）。
 *
 * 分层规则（D1 §10.1）：视图只认本文件的类型与纯函数；版本仓库/解包/激活事务在 hostruntime；
 * 上游协议事实仍只允许出现在 dshcompat。
 *
 * 这里全部是**纯函数**，因此"某个阶段该显示什么、某个动作能不能点、不能点时说什么"
 * 可以在没有设备、没有核心的情况下被单测钉死——这是本页最容易"说谎"的地方。
 */

/** 核心阶段。注意 UNWIRED 是一等状态：运行时还没接线时必须如实说，而不是假装在初始化。 */
export enum CorePhase {
  /** 运行时载体尚未接线（当前阶段一的真实状态） */
  UNWIRED = 'unwired',
  /** 已接线但一个核心版本都没装 */
  EMPTY = 'empty',
  /** 已安装、未启动 */
  IDLE = 'idle',
  /** 正在解包核心 */
  EXTRACTING = 'extracting',
  /** 正在启动 Host */
  STARTING = 'starting',
  /** 健康检查通过、可服务 */
  READY = 'ready',
  /** 能跑但能力不全（例如某个原生件没加载） */
  DEGRADED = 'degraded',
  /** 起不来 */
  FAILED = 'failed',
}

export function corePhaseLabel(phase: CorePhase): string {
  if (phase === CorePhase.UNWIRED) {
    return '运行时未接线';
  }
  if (phase === CorePhase.EMPTY) {
    return '尚未安装核心';
  }
  if (phase === CorePhase.IDLE) {
    return '待启动';
  }
  if (phase === CorePhase.EXTRACTING) {
    return '正在解包';
  }
  if (phase === CorePhase.STARTING) {
    return '正在启动';
  }
  if (phase === CorePhase.READY) {
    return '就绪';
  }
  if (phase === CorePhase.DEGRADED) {
    return '降级可用';
  }
  return '启动失败';
}

/** 版本行。 */
export interface CoreVersionRow {
  version: string;
  /** 徽标文案：当前 / 上一版 / 已安装 */
  badge: string;
  /** 该行是否可被选为切换目标 */
  selectable: boolean;
  /** 不可选时的原因（禁止静默禁用） */
  reason: string;
}

/** 运行时事实一行。 */
export interface CoreFact {
  label: string;
  value: string;
  /** 'ok' | 'warn' | 'unknown' */
  verdict: string;
  hint: string;
}

export function fact(label: string, value: string, verdict: string, hint: string): CoreFact {
  return { label: label, value: value, verdict: verdict, hint: hint };
}

/** 未探测事实的标准写法：值说明"没测"，并给出下一步——不要写"未知"就算完。 */
export function unknownFact(label: string, howToProbe: string): CoreFact {
  return { label: label, value: '未探测', verdict: 'unknown', hint: howToProbe };
}

/** 可执行动作。 */
export interface CoreActionSpec {
  id: string;
  label: string;
  enabled: boolean;
  /** 不可用时的原因，会直接显示给用户 */
  reason: string;
}

/**
 * 插件是否含原生模块——**三态，不能是两态**。
 *
 * 【为什么必须有 UNKNOWN】能不能在运行时安装一个插件，取决于它是否依赖原生码。
 * 两条数据来源的**能力不同**，必须都容纳：
 *   - 连远程 Host：`pluginInventory.list` 只给 `entryId / moduleName / enabled / fiberPhase`，
 *     **没有**原生信息 ⇒ 只能 UNKNOWN；
 *   - 端侧自足运行：我们自己就是核心树的主人，打包时已沿依赖闭包判定并写进树内元数据
 *     （D6 §6.2.1）⇒ 端侧拿到的是真实取值，正常情况**不该再出现 UNKNOWN**。
 * 把"不知道"硬塞进 `hasNative: false` 就会把"未知"渲染成"可安装"——
 * 用户点了才发现装不了，或者更糟：以为装上了。所以这里保留 UNKNOWN 并如实呈现。
 */
export enum PluginNative {
  /** 确认纯 JS：可在运行时安装/停用 */
  PURE_JS = 'pure-js',
  /** 确认依赖原生 .node：只能随应用发版提供（D6 §6.2 的硬约束） */
  NATIVE = 'native',
  /** 尚未判断：需要读取插件包清单 */
  UNKNOWN = 'unknown',
}

/**
 * 核心树清单里的 `nativeKind`（打包器取值 `'PURE_JS' | 'NATIVE' | 'UNKNOWN'`）
 * → `PluginNative` 的取值。
 *
 * 【为什么要一个显式映射】两侧的字符串**故意不是同一套**：清单里的是打包器的取值，
 * 枚举里的是界面契约的取值。直接传字符串就成了"两个模块碰巧用了同名常量"，
 * 任何一侧改名都会静默变成 UNKNOWN 而不是编译错误。映射收在这里，可单测。
 */
export function pluginNativeOf(manifestKind: string): string {
  if (manifestKind === 'PURE_JS') {
    return PluginNative.PURE_JS;
  }
  if (manifestKind === 'NATIVE') {
    return PluginNative.NATIVE;
  }
  return PluginNative.UNKNOWN;
}

/** 插件分类结果（决定"能不能运行时安装"）。 */
export interface PluginRow {
  /** cordis 行 id（比包名短，是用户在 profile 里改启停时写的那个名字） */
  id: string;
  name: string;
  version: string;
  /** `PluginNative` 的取值 */
  nativeKind: string;
  /** 是否允许运行时安装 */
  installable: boolean;
  /** 徽标文案（可安装 / 需发版 / 待确认） */
  badge: string;
  /** 不可安装时的原因，会直接显示给用户 */
  reason: string;
  /** 该行在 profile 里是否被禁用 */
  disabled: boolean;
}

/**
 * 插件分类：只有"确认不含原生模块"的插件才允许运行时安装（D6 §6.2 的硬约束）。
 * UNKNOWN **不**视为可安装——宁可让用户看到"待确认"，也不要给一个会失败的承诺。
 *
 * `id` / `disabled` 可选，是为了不破坏只关心可安装性的调用点（远程 Host 路径没有这两个事实，
 * 它连"是否被禁用"都只在 `pluginInventory` 的 enabled 里、语义与 profile 的 disabled 不同）。
 */
export function classifyPlugin(name: string, version: string, nativeKind: string,
  id: string = '', disabled: boolean = false): PluginRow {
  if (nativeKind === PluginNative.PURE_JS) {
    return {
      id: id,
      name: name,
      version: version,
      nativeKind: PluginNative.PURE_JS,
      installable: true,
      badge: '可安装',
      reason: '',
      disabled: disabled,
    };
  }
  if (nativeKind === PluginNative.NATIVE) {
    return {
      id: id,
      name: name,
      version: version,
      nativeKind: PluginNative.NATIVE,
      installable: false,
      badge: '需发版',
      reason: '含原生模块（.node）。鸿蒙只允许加载随 HAP 打包且已签名的原生库，无法在运行时安装——需随应用发版提供。',
      disabled: disabled,
    };
  }
  return {
    id: id,
    name: name,
    version: version,
    nativeKind: PluginNative.UNKNOWN,
    installable: false,
    badge: '待确认',
    reason: '无法判断该插件是否依赖原生模块。端侧清单由打包时沿依赖闭包判定并写进核心树，'
      + '因此这里出现「待确认」说明该版本的核心包没有带清单（旧包），或该插件的包在树里解析不到。',
    disabled: disabled,
  };
}

export interface CoreViewState {
  phase: CorePhase;
  /** 阶段徽标文案 */
  badge: string;
  /** 一句话结论 */
  title: string;
  /** 补充说明（建议/下一步） */
  detail: string;
  busy: boolean;
  currentVersion: string;
  previousVersion: string;
  profileName: string;
  versions: CoreVersionRow[];
  facts: CoreFact[];
  actions: CoreActionSpec[];
  plugins: PluginRow[];
}

export interface CoreViewInput {
  phase: CorePhase;
  title: string;
  detail: string;
  busy: boolean;
  installed: string[];
  currentVersion: string;
  previousVersion: string;
  profileName: string;
  facts: CoreFact[];
  plugins: PluginRow[];
}

/**
 * 由事实构造视图模型。
 *
 * 关键判据（都是纯函数，可单测）：
 *  - 只有 READY / DEGRADED 才允许"停止/重启"；
 *  - 只有存在 previous 且 previous 仍是已安装版本时才允许"回滚"；
 *  - UNWIRED 阶段**所有**运行类动作都不可用，且给出的是"运行时未接线"而不是"请稍后"；
 *  - 版本行只在"不是当前版本"时可选。
 */
export function buildCoreView(input: CoreViewInput): CoreViewState {
  const phase: CorePhase = input.phase;
  const running: boolean = phase === CorePhase.READY || phase === CorePhase.DEGRADED;
  const hasPrevious: boolean = input.previousVersion.length > 0
    && input.installed.includes(input.previousVersion)
    && input.previousVersion !== input.currentVersion;

  const actions: CoreActionSpec[] = [];

  if (phase === CorePhase.UNWIRED) {
    actions.push({ id: 'start', label: '启动核心', enabled: false, reason: '运行时载体尚未接线，无法启动（见核心页的运行时事实）' });
  } else if (running) {
    actions.push({ id: 'restart', label: '重启核心', enabled: true, reason: '' });
    actions.push({ id: 'stop', label: '停止核心', enabled: true, reason: '' });
  } else if (input.busy) {
    actions.push({ id: 'start', label: '启动核心', enabled: false, reason: '正在进行中' });
  } else if (input.installed.length === 0) {
    actions.push({ id: 'start', label: '启动核心', enabled: false, reason: '还没有安装任何核心版本' });
  } else {
    actions.push({ id: 'start', label: '启动核心', enabled: true, reason: '' });
  }

  actions.push({
    id: 'rollback',
    label: '回滚到上一版',
    enabled: hasPrevious && !input.busy,
    reason: hasPrevious ? '' : '没有可回滚的上一版本',
  });
  // 「安装内置核心」**不依赖运行时载体**（只是解包落位），因此未接线时也允许——
  // 这样用户可以先把它装好，等载体接上就能直接起。
  if (input.installed.length === 0) {
    actions.push({
      id: 'install',
      label: '安装内置核心',
      enabled: !input.busy,
      reason: input.busy ? '正在进行中' : '',
    });
  }
  actions.push({ id: 'import', label: '导入核心包', enabled: !input.busy, reason: input.busy ? '正在进行中' : '' });
  actions.push({ id: 'diagnose', label: '导出诊断', enabled: true, reason: '' });

  const versions: CoreVersionRow[] = [];
  for (const v of input.installed) {
    const isCurrent: boolean = v === input.currentVersion;
    const isPrevious: boolean = v === input.previousVersion;
    versions.push({
      version: v,
      badge: isCurrent ? '当前' : (isPrevious ? '上一版' : '已安装'),
      selectable: !isCurrent && !input.busy,
      reason: isCurrent ? '已经是当前版本' : (input.busy ? '正在进行中' : ''),
    });
  }

  return {
    phase: phase,
    badge: corePhaseLabel(phase),
    title: input.title,
    detail: input.detail,
    busy: input.busy,
    currentVersion: input.currentVersion,
    previousVersion: input.previousVersion,
    profileName: input.profileName,
    versions: versions,
    facts: input.facts,
    actions: actions,
    plugins: input.plugins,
  };
}

/** 插件分类见上方三态版本（PluginNative + classifyPlugin）。 */

/** 空态文案（标题 + 说明）。 */
export interface EmptyCopy {  title: string;
  hint: string;
}

/**
 * 会话页的空态文案**按核心阶段分档**（D7 §3 第 7 项）。
 *
 * 为什么不能只有一句"还没有会话"：新架构下"看不到会话"最常见的原因是
 * **本机核心还没起来**（未安装 / 解包中 / 启动中 / 失败），而不是"Host 上没有会话"。
 * 用同一句话覆盖这四种情况，会把用户引向错误的排查方向（去查地址，而问题在设备上）。
 *
 * 纯函数：不依赖网络、不依赖设备，可单测。
 */
export function sessionEmptyCopy(phase: CorePhase): EmptyCopy {
  if (phase === CorePhase.UNWIRED) {
    return {
      title: '本机核心尚未接线',
      hint: '运行时载体还没接上，会话暂时不可用。到「核心」页可以看到运行时与版本的真实状态。',
    };
  }
  if (phase === CorePhase.EMPTY) {
    return {
      title: '还没有安装核心',
      hint: '核心随应用内置，首次启动会自动解包；也可以在「核心」页导入核心包。',
    };
  }
  if (phase === CorePhase.EXTRACTING) {
    return {
      title: '正在解包核心',
      hint: '首次启动需要解包一次（约 63 MB 压缩包 / 2.5 万个文件），完成后这里会出现会话。',
    };
  }
  if (phase === CorePhase.STARTING) {
    return {
      title: '正在启动本机核心',
      hint: '核心起来后会自动连上本机回环地址，无需手填任何地址。',
    };
  }
  if (phase === CorePhase.FAILED) {
    return {
      title: '本机核心启动失败',
      hint: '到「核心」页看运行时事实与失败原因，那里给出的是可执行建议而不是一句"失败了"。',
    };
  }
  return {
    title: '还没有会话',
    hint: '在本机核心上新建会话后会自动出现在这里。',
  };
}

/**
 * 把 hostruntime 的 HostState 映射成呈现层的 CorePhase。
 *
 * 【为什么用字符串而不是 import hostruntime 的枚举】分层规则（D1 §10.1）要求
 * appstate 不反向依赖机制层；而**映射本身是需要被审视的一步**——
 * 例如底层 READY 在呈现层必须真的是"就绪"，不能因为字符串写错而退化成默认分支。
 * 因此这里逐值显式映射，未知值一律落到 UNWIRED（保守：宁可说"未就绪"，也不谎称就绪）。
 */
export function corePhaseOfHostState(state: string): CorePhase {
  if (state === 'ready') {
    return CorePhase.READY;
  }
  if (state === 'degraded') {
    return CorePhase.DEGRADED;
  }
  if (state === 'failed') {
    return CorePhase.FAILED;
  }
  if (state === 'starting') {
    return CorePhase.STARTING;
  }
  if (state === 'extracting') {
    return CorePhase.EXTRACTING;
  }
  if (state === 'empty') {
    return CorePhase.EMPTY;
  }
  if (state === 'idle') {
    return CorePhase.IDLE;
  }
  return CorePhase.UNWIRED;
}

/** 初始（未接线）视图：用于运行时还没接上时的如实呈现。 */export function emptyCoreView(): CoreViewState {
  return buildCoreView({
    phase: CorePhase.UNWIRED,
    title: '端侧核心尚未接线',
    detail: '应用已具备核心管理的骨架（版本仓库、激活事务、端侧 profile），但运行时载体还没接上，因此现在还不能在设备上起 Host。',
    busy: false,
    installed: [],
    currentVersion: '',
    previousVersion: '',
    profileName: 'ondevice',
    facts: [
      unknownFact('Node 运行时', '接上运行时载体后，这里会显示实际版本（要求 ≥ 22.17.0）'),
      unknownFact('zlib zstd 能力', '会话持久化依赖 node:zlib 的 zstd，接线后自动探测'),
      unknownFact('JIT 状态', '本项目统一按 jitless 运行，不申请任何特殊权限'),
      unknownFact('原生件加载', 'koffi / node-pty / sharp 三个鸿蒙移植件的加载结果'),
      unknownFact('监听地址', '核心起来后应只监听 127.0.0.1'),
    ],
    plugins: [],
  });
}
