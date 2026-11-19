/**
 * 外开桥（ArkTS 侧）——把 Host 的「打开外部链接 / 拉起浏览器」请求转成系统 `openLink`。
 *
 * ── 为什么需要这座桥（2026-10-17 用户口径：浏览器没启动时也要能直接拉起）────────
 * browser_* 工具链要靠**浏览器里的 DSHM Browser Bridge 扩展**回连宿主 WS；浏览器没起时
 * 就没有客户端，工具只能报"没有已连接的浏览器扩展"。而"把 https 链接交给系统默认方式
 * 打开（没有浏览器就拉起它）"是 ArkTS 的 `openLink` 能力（登录流程外开授权页走的就是这条，
 * 见 `platform/src/main/ets/system/OpenLink.ets`）——Host 里的 Node 进程调不到。
 * 所以沿用项目既成的**文件队列**范式（`host-stop-request` / `host-exit-mode` / 语音桥
 * `HmsSpeechBridge`）：Host 写请求文件，本模块轮询并执行**只有 ArkTS 才能做**的事。
 *
 * ── 协议（与 Host 侧 `hostcore/app/main.js` 的「外开桥端点」逐字对齐）────────────
 * 目录：`$DSH_HOME/open-link/`（真机 = `<filesDir>/dsh/home/open-link`）
 *   · Host 写 `<id>.req` —— JSON `{ "url": "https://…", "bundle": "com.haitai.htbrowser", "requestedAt": 1234567890 }`
 *     （`bundle` 可缺省；有则**优先显式 startAbility** 拉起该浏览器 —— 真机实测：`openLink`
 *      走系统默认浏览器，本机默认不是装了扩展的海泰，只走 openLink 会拉起"另一个浏览器"）
 *   · 本模块写 `<id>.done` —— JSON `{ "ok": true, "detail": "launched" }`
 *   · 失败写 `<id>.fail` —— JSON `{ "ok": false, "error": "原因" }`
 * Host 侧 `/dshm-open-link?token&url&timeout` 等到 `.done/.fail` 再作答，失败不静默。
 *
 * ── 已由既有桥验证的关键约束（照抄，避免重踩）────────────────────────────────
 * 1. **必须显式传 UIAbilityContext**：本模块在 `EntryAbility.onCreate` 里启动，
 *    那个阶段 `getContext()` 拿不到可靠的 UIAbilityContext（语音桥真机教训）。
 * 2. **陈旧回收必须包含 `.req`**：半截/无人处理的 `.req` 会堵死 `sort()[0]` 那条路
 *    （语音桥真机缺陷），故 `.req/.wip/.done/.fail` 一律按 mtime 回收。
 * 3. **结果先写 `.tmp` 再改名**：Host 一旦看到 `.done/.fail` 就会读全文。
 * 4. **心跳与主流程分开**：`<filesDir>/open-link-bridge-heartbeat` 回答"桥是否真在轮询"，
 *    这是"没请求"与"桥没跑"的判别依据。
 */

import { common, Want } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { openExternalUrl, isOpenableUrl } from 'platform';

const DOMAIN: number = 0xD5A1;
const TAG: string = 'platform/openlink-bridge';

/** 轮询间隔：500ms（与语音桥同值 —— 拉起浏览器是低频显式动作，这个延迟无感）。 */
const POLL_MS: number = 500;

/**
 * 陈旧文件回收阈值。
 *
 * 【为什么 5 分钟】一次合法外开从看到 `.req` 到写回执只有毫秒级；5 分钟足够覆盖
 * 任何"壳层刚起还没跑第一轮"的窗口，同时保证堵死的队列能自愈。
 */
const STALE_MS: number = 5 * 60 * 1000;

/** 心跳文件的轮转阈值（与语音桥同口径）。 */
const MAX_HEARTBEAT_BYTES: number = 65536;

/** 模块级标志：主窗可能被复用重建，桥只挂一个。 */
let bridgeStarted: boolean = false;

/** 轮询计数：用于「桥是否真在跑」的可观测证据。 */
let pollTicks: number = 0;

interface OpenLinkPayload {
  url?: string;
  bundle?: string;
  requestedAt?: number;
}

interface OpenLinkRequest {
  id: string;
  /** 处理中改名后的路径（`.wip`），处理完在 finally 里删掉 */
  wipPath: string;
  url: string;
  /** 目标浏览器 bundle（可空；有则优先显式 startAbility，失败回退 openLink） */
  bundle: string;
}

/**
 * 启动外开桥的轮询（幂等：重复调用只挂一个）。
 *
 * @param filesDir 应用的 `context.filesDir`（真机上即 `.../haps/entry/files`）
 * @param abilityCtx UIAbilityContext —— `openLink` 要用它（必须显式传入，见头注 1）
 * @returns 停止函数（目前仅用于测试；正式运行随进程存活）
 */
export function startOpenLinkBridge(filesDir: string, abilityCtx: common.UIAbilityContext): () => void {
  if (bridgeStarted) {
    return (): void => void 0;
  }
  bridgeStarted = true;
  const queueDir: string = `${filesDir}/dsh/home/open-link`;
  try {
    if (!fs.accessSync(queueDir)) {
      fs.mkdirSync(queueDir, true);
    }
  } catch (e) {
    // 首次调用时目录不存在，mkdir 即可；失败则每轮轮询时重试
  }
  const heartbeat: string = `${filesDir}/open-link-bridge-heartbeat`;
  writeHeartbeat(heartbeat, `started dir=${queueDir}`);
  hilog.info(DOMAIN, TAG, '外开桥已就绪，队列=%{public}s', queueDir);

  /* 串行处理：一次只开一个链接（用户动作低频，没必要并发） */
  let busy: boolean = false;
  const timer: number = setInterval((): void => {
    pollTicks++;
    if (pollTicks % 20 === 0) {
      writeHeartbeat(heartbeat, `alive ticks=${pollTicks} busy=${busy}`);
    }
    if (busy) {
      return;
    }
    const req: OpenLinkRequest | undefined = takeNextRequest(queueDir);
    if (req === undefined) {
      return;
    }
    writeHeartbeat(heartbeat, `got request id=${req.id} url=${req.url.slice(0, 80)}`);
    busy = true;
    handleRequest(queueDir, req, abilityCtx, heartbeat).then((ok: boolean): void => {
      busy = false;
      writeHeartbeat(heartbeat, `done id=${req.id} ok=${ok}`);
    }, (e: Object): void => {
      busy = false;
      hilog.error(DOMAIN, TAG, '外开处理异常：%{public}s', String(e));
      writeHeartbeat(heartbeat, `handle error id=${req.id}: ${String(e).slice(0, 120)}`);
    });
  }, POLL_MS);

  if (timer < 0) {
    hilog.error(DOMAIN, TAG, '轮询器未能启动');
  }
  return (): void => {
    clearInterval(timer);
    bridgeStarted = false;
  };
}

/** 取下一个请求：认领（改名 `.wip`）→ 解析 → 校验；任何一步失败都如实写回执。 */
function takeNextRequest(queueDir: string): OpenLinkRequest | undefined {
  let names: string[];
  try {
    names = fs.listFileSync(queueDir);
  } catch (e) {
    return undefined;
  }
  reapStale(queueDir, names);

  const reqs: string[] = names.filter((n: string): boolean => n.endsWith('.req')).sort();
  if (reqs.length === 0) {
    return undefined;
  }
  const name: string = reqs[0];
  const id: string = name.slice(0, -4);
  const reqPath: string = `${queueDir}/${name}`;
  let payload: string;
  try {
    payload = fs.readTextSync(reqPath);
  } catch (e) {
    return undefined; // 下轮再试
  }
  // 内容还没写完（Host 先写 .wreq 再改名，正常不会到这里；防御半截文件）
  if (payload.length === 0 || !payload.endsWith('}')) {
    return undefined;
  }
  const wipPath: string = `${queueDir}/${id}.wip`;
  try {
    fs.renameSync(reqPath, wipPath);
  } catch (e) {
    return undefined;
  }
  let url: string = '';
  let bundle: string = '';
  try {
    const parsed: OpenLinkPayload = JSON.parse(payload) as OpenLinkPayload;
    url = typeof parsed.url === 'string' ? parsed.url.trim() : '';
    bundle = typeof parsed.bundle === 'string' ? parsed.bundle.trim() : '';
  } catch (e) {
    writeResult(queueDir, id, true, `请求 JSON 解析失败：${(e as Error).message}`);
    try { fs.unlinkSync(wipPath); } catch (e) { /* 下轮 reap */ }
    return undefined;
  }
  if (url.length === 0) {
    writeResult(queueDir, id, true, '请求里没有 url 字段');
    try { fs.unlinkSync(wipPath); } catch (e) { /* 下轮 reap */ }
    return undefined;
  }
  if (!isOpenableUrl(url)) {
    writeResult(queueDir, id, true, `只放行 http(s)：${url.slice(0, 120)}`);
    try { fs.unlinkSync(wipPath); } catch (e) { /* 下轮 reap */ }
    return undefined;
  }
  return { id, wipPath, url, bundle };
}

/**
 * 执行外开并把结果写回执；无论成败都清掉 `.wip`。
 *
 * 【先 startAbility 再 openLink（2026-10-17 真机实测的理由）】`openLink` 走**系统默认浏览器**：
 * 本机默认是 `com.huawei.hmos.browser`，而 DSHM 扩展装在 `com.haitai.htbrowser` ⇒ 只走 openLink
 * 会把"另一个浏览器"拉起来，扩展永远不回连。请求里带 `bundle` 时先用
 * `startAbility({bundleName, action:viewData, entities:[browsable], uri})` 显式拉起它
 * （海泰 `EntryAbility` 的 skills 实测声明了这两条），失败/没带 bundle 才回退 openLink。
 */
async function handleRequest(queueDir: string, req: OpenLinkRequest,
  abilityCtx: common.UIAbilityContext, heartbeat: string): Promise<boolean> {
  try {
    let ok: boolean = false;
    let detail: string = '';
    if (req.bundle.length > 0) {
      ok = await startBrowserBundle(req.bundle, req.url, abilityCtx);
      detail = ok ? `startAbility(${req.bundle})` : '';
      writeHeartbeat(heartbeat, ok
        ? `startAbility ok id=${req.id} bundle=${req.bundle}`
        : `startAbility 失败 id=${req.id} bundle=${req.bundle}，回退 openLink`);
    }
    if (!ok) {
      ok = await openExternalUrl(req.url, abilityCtx);
      detail = ok ? 'openLink(系统默认浏览器)' : '系统未受理 openLink（没有可用浏览器？）';
    }
    writeResult(queueDir, req.id, !ok, detail);
    return ok;
  } catch (e) {
    writeResult(queueDir, req.id, true, `外开异常：${(e as Error).message}`);
    writeHeartbeat(heartbeat, `openLink threw id=${req.id}: ${(e as Error).message.slice(0, 120)}`);
    return false;
  } finally {
    try {
      fs.unlinkSync(req.wipPath);
    } catch (e) {
      // 下轮 reap 回收
    }
  }
}

/**
 * 显式拉起指定 bundle 的浏览器打开 URL。
 *
 * 只钉 `bundleName` + `viewData` + `browsable`（**不钉 abilityName** —— 由系统在该 bundle 内
 * 按 skills 解析，换浏览器版本/改 ability 名都不受影响）。
 */
async function startBrowserBundle(bundle: string, url: string,
  abilityCtx: common.UIAbilityContext): Promise<boolean> {
  try {
    const want: Want = {
      bundleName: bundle,
      action: 'ohos.want.action.viewData',
      entities: ['entity.system.browsable'],
      uri: url,
    };
    await abilityCtx.startAbility(want);
    return true;
  } catch (e) {
    hilog.warn(DOMAIN, TAG, 'startAbility(%{public}s) 失败：%{public}s', bundle, String(e));
    return false;
  }
}

/**
 * 把结果写成 `<id>.done` / `<id>.fail`（原子性：先写 `.tmp` 再改名）。
 * 载荷形状与 Host 侧读取口径逐字对齐：done = `{ok:true,detail}`；fail = `{ok:false,error}`。
 */
function writeResult(queueDir: string, id: string, failed: boolean, detail: string): void {
  const suffix: string = failed ? '.fail' : '.done';
  const payload: string = failed
    ? JSON.stringify({ ok: false, error: detail })
    : JSON.stringify({ ok: true, detail });
  const tmp: string = `${queueDir}/${id}.tmp`;
  const dest: string = `${queueDir}/${id}${suffix}`;
  try {
    const f: fs.File = fs.openSync(tmp, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
    fs.writeSync(f.fd, payload);
    fs.closeSync(f);
    fs.renameSync(tmp, dest);
  } catch (e) {
    hilog.error(DOMAIN, TAG, '写结果失败 %{public}s：%{public}s', dest, String(e));
  }
}

/** 清理陈旧中间文件（写入方已死的残留）。`.req` 必须在内——半截请求会堵死队列（语音桥实证）。 */
function reapStale(queueDir: string, names: string[]): void {
  const now: number = Date.now();
  for (const n of names) {
    if (!(n.endsWith('.req') || n.endsWith('.wip') || n.endsWith('.done') || n.endsWith('.fail'))) {
      continue;
    }
    const p: string = `${queueDir}/${n}`;
    try {
      const st: fs.Stat = fs.statSync(p);
      if (now - st.mtime * 1000 > STALE_MS) {
        hilog.warn(DOMAIN, TAG, '回收陈旧文件：%{public}s', n);
        fs.unlinkSync(p);
      }
    } catch (e) {
      // 单文件失败不影响其它
    }
  }
}

/**
 * 追加一行到桥的诊断日志（与语音桥同范式：追加 + 超限整体重写，
 * 避免"事件被周期心跳冲掉"与"长期无限增长"两个极端）。
 */
function writeHeartbeat(path: string, detail: string): void {
  const line: string = `${new Date().toISOString()} ${detail}\n`;
  try {
    let size: number = 0;
    try {
      size = fs.statSync(path).size;
    } catch (e) {
      size = 0;
    }
    if (size > MAX_HEARTBEAT_BYTES) {
      const f: fs.File = fs.openSync(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      fs.writeSync(f.fd, `--- 日志超过 ${MAX_HEARTBEAT_BYTES}B，已轮转 ---\n${line}`);
      fs.closeSync(f);
      return;
    }
    const f: fs.File = fs.openSync(path, fs.OpenMode.WRITE_ONLY | fs.OpenMode.CREATE | fs.OpenMode.APPEND);
    fs.writeSync(f.fd, line);
    fs.closeSync(f);
  } catch (e) {
    // 诊断失败不影响主流程
  }
}
