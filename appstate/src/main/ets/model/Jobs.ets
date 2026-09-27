/**
 * 后台任务（P2 §"jobs"：会话头部的后台任务列表）。
 *
 * ## 要解决的问题
 *
 * 矩阵 `jobs` 行的缺口是"官方在会话头有后台任务列表；DSHM 只在轨迹里显示 `JOB` 行，且不是 live 注册表视图"。
 * 排查后发现真实情况更基础：**`JOBS` 控制帧到达后被记一行日志就丢掉了**——
 * `Wire.readJobs()` 已经把 `{id, kind, label, status, detail?, startedAt, finishedAt?}` 解析好，
 * 但**没有任何调用方**；`BASELINE` 帧里带的 `jobs` 也同样没读。也就是说这批数据一直在到，
 * 只是从没进过界面（与 `sessionStats` 是同一类缺陷：**投影了但没人显示**）。
 *
 * ## 判定基准（不靠猜）
 *
 * 逐条对齐官方 `dsh-client-ui-jobs/lib/client.js`：
 *
 * | 项 | 官方事实（原文） |
 * |---|---|
 * | 哪些算"进行中" | `isLive(job)`: `status === "running" \\|\\| status === "stopping"` |
 * | 状态点语义 | `dotState`: `running→ongoing`、`stopping→warning`、`completed→done`、`killed→warning`、`failed→error`。**注释原文**：`stopping` 与 `killed` 共用 attention 色，因为两者都表示"这次工作是按请求结束（或正在结束）的"，而不是自己跑完的 |
 * | 状态文案 | 运行中 / 正在停止 / 已完成 / 已取消 / 已失败 |
 * | 时长 | `formatDuration`：最多**两个相邻单位**，**小时是最大单位**（官方注释：后台任务活过一小时已经算异常，再往上不再长出天/月的词汇） |
 * | 时长算法 | 进行中 = `now - startedAt`；已结束 = `(finishedAt ?? startedAt) - startedAt` |
 * | 排序 | `ordered`：**进行中的在前、按开始时间升序**；然后已结束的**按结束时间倒序**；同一毫秒结束的退回开始时间升序（官方注释：这样排序不依赖宿主的 map 迭代顺序） |
 * | 计数文案 | 有进行中 → `{count} 个后台任务运行中`；否则 → `{count} 个后台任务` |
 * | 行的状态文字 | `job.detail ?? statusLabel`（有 detail 就显示 detail） |
 * | 无任务时 | **整个控件不渲染**（官方注释：一段普通对话不该为一个它没用到的能力长出控件） |
 *
 * ## 为什么是纯函数
 *
 * "哪个算进行中""怎么排""时长怎么算"都是**判断**，放这里之后可在本机直接测
 * （`tools/check-layout-fixtures.mjs`），视图只把结果映射到 ArkUI。
 */


/**
 * 后台任务在**线上**的形状（`JOBS` 控制帧 / `BASELINE` 帧的 `jobs[sessionId]`）。
 *
 * 【为什么声明在领域模型而不是 `Wire`】这份形状的每个字段都由本文件使用与判定
 * （状态、时长、排序），放这里让**纯逻辑模型不依赖任何解析层**——它也因此在
 * `tools/check-layout-fixtures.mjs` 里可以直接编译测试（`Wire` 依赖 `dshcompat` 包，
 * 不适合纳入那个扁平编译环境）。线协议一侧反过来 `import { SessionJob } from './Jobs'`。
 */
export interface SessionJob {
  id: string;
  kind: string;
  label: string;
  /** `'running'` / `'stopping'` / `'completed'` / `'killed'` / `'failed'` */
  status: string;
  detail?: string;
  startedAt: number;
  finishedAt?: number;
}

/** 状态点语义（与官方 `dotState` 一一对应；视图把它映射到颜色） */
export enum JobDot {
  ONGOING = 'ongoing',
  WARNING = 'warning',
  DONE = 'done',
  ERROR = 'error',
}

/** 官方 `isLive`：这两种状态都表示"还没结束"（`stopping` 是请求停止后尚未落地） */
export function jobIsLive(job: SessionJob): boolean {
  return job.status === 'running' || job.status === 'stopping';
}

/**
 * 官方 `dotState`。
 *
 * `stopping` 与 `killed` 都是 `warning`：**两者都表示"按请求结束"**，与"自己跑完"（done）
 * 和"出错"（error）不是一回事。未知状态按 error 处理——宁可提示异常，也不要显示成"正常"。
 */
export function jobDotState(status: string): JobDot {
  if (status === 'running') {
    return JobDot.ONGOING;
  }
  if (status === 'stopping' || status === 'killed') {
    return JobDot.WARNING;
  }
  if (status === 'completed') {
    return JobDot.DONE;
  }
  return JobDot.ERROR;
}

/** 官方 `statusLabel` */
export function jobStatusLabel(status: string): string {
  if (status === 'running') {
    return '运行中';
  }
  if (status === 'stopping') {
    return '正在停止';
  }
  if (status === 'completed') {
    return '已完成';
  }
  if (status === 'killed') {
    return '已取消';
  }
  if (status === 'failed') {
    return '已失败';
  }
  return status;
}

/**
 * 官方 `formatDuration`：最多两个相邻单位，**小时封顶**。
 *
 * 【为什么不复用 `Present.formatDuration`】那个是给"一轮/一步耗时"用的，超过一分钟就只给
 * "n 分 m 秒"、小时数会被算成很大的分钟数（后台任务活几小时就会显示成"243 分 12 秒"）。
 * 后台任务的时长要按官方这套秒/分/小时的三档给——两者服务的是不同场景，故各留一份。
 */
export function jobDurationText(elapsedMs: number): string {
  const total: number = Math.max(0, Math.floor(elapsedMs / 1000));
  const seconds: number = total % 60;
  const minutes: number = Math.floor(total / 60) % 60;
  const hours: number = Math.floor(total / 3600);
  if (hours > 0) {
    return `${hours}小时${minutes}分`;
  }
  if (minutes > 0) {
    return `${minutes}分${seconds}秒`;
  }
  return `${seconds}秒`;
}

/**
 * 某一行的时长（毫秒）。
 *
 * 进行中按 `now` 算（这行会随时间跳动），已结束按 `finishedAt`（缺失时退回 `startedAt`，
 * 于是时长算成 0——宁可显示 0 秒，也不要拿"现在"去算一个已经结束的任务）。
 */
export function jobElapsedMs(job: SessionJob, nowMs: number): number {
  if (jobIsLive(job)) {
    return Math.max(0, nowMs - job.startedAt);
  }
  const end: number = job.finishedAt === undefined ? job.startedAt : job.finishedAt;
  return Math.max(0, end - job.startedAt);
}

/**
 * 官方 `ordered`：进行中在前（按开始时间升序），已结束按结束时间倒序。
 *
 * 同毫秒结束的退回开始时间升序——**这一条是官方为了"排序不依赖宿主 map 的迭代顺序"**，
 * 缺少它会让同一批任务在不同设备/不同次刷新下顺序不定。
 */
export function orderedJobs(jobs: SessionJob[]): SessionJob[] {
  const out: SessionJob[] = jobs.slice();
  out.sort((left: SessionJob, right: SessionJob): number => {
    const liveLeft: boolean = jobIsLive(left);
    const liveRight: boolean = jobIsLive(right);
    if (liveLeft !== liveRight) {
      return liveLeft ? -1 : 1;
    }
    if (liveLeft) {
      return left.startedAt - right.startedAt;
    }
    const leftEnd: number = left.finishedAt === undefined ? left.startedAt : left.finishedAt;
    const rightEnd: number = right.finishedAt === undefined ? right.startedAt : right.finishedAt;
    const byEnd: number = rightEnd - leftEnd;
    return byEnd !== 0 ? byEnd : left.startedAt - right.startedAt;
  });
  return out;
}

/** 进行中的任务数（触发控件上的状态点据此决定是否出现） */
export function liveJobCount(jobs: SessionJob[]): number {
  let n: number = 0;
  for (let i = 0; i < jobs.length; i++) {
    if (jobIsLive(jobs[i])) {
      n += 1;
    }
  }
  return n;
}

/**
 * 官方计数文案：有进行中时说"运行中"，否则只说数量。
 *
 * 中文不分单复数（官方英文分了 one/other），故这里只有两种形态。
 */
export function jobCountLabel(jobs: SessionJob[]): string {
  const live: number = liveJobCount(jobs);
  if (live > 0) {
    return `${live} 个后台任务运行中`;
  }
  return `${jobs.length} 个后台任务`;
}

/**
 * 控件是否应该出现。
 *
 * 官方：**一个任务都没有时整个控件不渲染**（"一段普通对话不该为一个它没用到的能力长出控件"）。
 * 这条规则放在模型里，因为它是一个判定，而不是布局偏好。
 */
export function jobListVisible(jobs: SessionJob[]): boolean {
  return jobs.length > 0;
}

/** 行上的状态文字：官方 `job.detail ?? statusLabel` */
export function jobRowStatusText(job: SessionJob): string {
  const detail: string | undefined = job.detail;
  if (detail !== undefined && detail.length > 0) {
    return detail;
  }
  return jobStatusLabel(job.status);
}

/** 行上时长文字的标题（悬停/无障碍用）；官方 `duration.title.live` = "Running for {duration}" */
export function jobDurationTitle(job: SessionJob, nowMs: number): string {
  const text: string = jobDurationText(jobElapsedMs(job, nowMs));
  return jobIsLive(job) ? `已运行 ${text}` : `共 ${text}`;
}

/**
 * 是否需要在跑定时器（用于让"进行中"的时长自己跳）。
 *
 * 【为什么单独一个判定】没有进行中的任务时启一个每秒的定时器纯属浪费电——
 * 而移动端上"多余的定时器"是实打实的耗电与掉帧来源。视图据此决定起/停定时器。
 */
export function jobTickerNeeded(jobs: SessionJob[]): boolean {
  return liveJobCount(jobs) > 0;
}

/** 无障碍：整个列表的一段话（官方 `list.aria` = "后台任务"） */
export function jobListA11y(jobs: SessionJob[]): string {
  return `后台任务：${jobCountLabel(jobs)}`;
}
