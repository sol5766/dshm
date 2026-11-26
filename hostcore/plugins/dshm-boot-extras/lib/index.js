/**
 * DSHM 启动编排插件（2026-11-26）。
 *
 * ───────────────────────── 为什么需要它 ─────────────────────────
 * 端侧冷启动实测 p50 9.27s / p90 15.06s，其中一次同步停顿占 75%–96%；
 * 而同步停顿里包含大量「首屏用不到」的插件初始化（市场、宠物、皮肤等）。
 * 缓存已经热了（编译缓存 143 MB / 解析缓存 17,025 条），继续加缓存收益见顶
 * ⇒ 该做的是「少加载、晚加载」，而不是「加载得更快」。
 *
 * ───────────────────────── 为什么不用 profile 的 deferredBundles ─────────────────────────
 * 上游 0.2.3-alpha.2 的 profile schema **没有** `deferredBundles` 字段
 * （`dsh.profile` 只有 `bundles` / `removeBundles` / `patchReload`）。
 * 但 loader 支持运行时挂载：`ctx.loader.create({ id, name, config })`
 * （见 `dsh-app-boot/lib/index.js` 的 `mountRootInclude`，`Loader extends EntryTree`）。
 * 所以编排放在插件里，靠真实 API 完成，而不是等上游加字段。
 *
 * ───────────────────────── 为什么不默认延迟任何东西 ─────────────────────────
 * 「先延迟谁」必须由实测数据决定（SYNC-COUNT Top12 / REQUIRE-COUNT Top15），
 * 而不是按文件名猜。默认清单为空 ⇒ 插件加载后立即返回，行为与未挂载等价。
 * 数据回来之后，只需在 profile 的 `cordis.patch.yml` 里填 `deferredBundles`，
 * 不改这份代码。
 *
 * ───────────────────────── 纪律 ─────────────────────────
 *   · 每个延迟项独立 try/catch：一个失败只降级该功能，绝不影响壳；
 *   · 每项之间 `setImmediate` 让出事件循环：避免把一个大停顿搬成另一个大停顿；
 *   · 全部 `unref` 定时器：不阻止进程退出；
 *   · 每项打一行 `BOOT-DEFER` 日志（含耗时），与 SYNC-COUNT 同口径可对账。
 *
 * @module @deepseek-ai/dshm-boot-extras
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 插件名（与 package.json 逐字一致）。 */
const name = '@deepseek-ai/dshm-boot-extras';

/** 默认清单：空 = 不延迟任何插件（零行为变更）。 */
const DEFAULT_DEFERRED = [];

/** 用户 bundle 延迟清单文件名（与 hostcore/app/dshm-deferred-bundles.js 一致）。 */
const DEFERRED_FILENAME = '.dshm-deferred-bundles.json';

/** 默认延迟起点：壳就绪（host-ready 落盘）后再等这么久，避免与首屏抢 CPU。 */
const DEFAULT_DELAY_MS = 3000;

/** 每项之间的让出间隔：把长任务切片，避免形成新的同步停顿。 */
const YIELD_MS = 16;

function diag(ctx, line) {
  const text = '[dshm-boot-extras] ' + line;
  /*
   * 【为什么先走 console.log】宿主把插件 stdout 落进 node-output.log；而 Cordis
   * 的 logger.info 在当前日志级别下不落盘 ⇒ 启动编排的 `BOOT-DEFER-*` 会"看起来
   * 没执行"。console.log 与 dshm-boot-rescue 同一条通道，排查时能直接 grep。
   * console 不可用时再退回 ctx.logger（保持原契约）。
   */
  try {
    if (typeof console !== 'undefined' && typeof console.log === 'function') {
      console.log(text);
      return;
    }
  } catch (e) { /* 继续尝试 ctx.logger */ }
  try {
    const logger = ctx && ctx.logger;
    if (logger && typeof logger.info === 'function') {
      logger.info(text);
    }
  } catch (e) { /* 日志失败不影响编排 */ }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer && typeof timer.unref === 'function') { timer.unref(); }
  });
}

/**
 * 挂载一个延迟项。
 *
 * @param ctx cordis 上下文（`ctx.loader` 由 loader 服务提供）
 * @param item `{ id, name, config? }`；`name` 是插件包名
 * @returns 是否成功
 */
async function mountOne(ctx, item) {
  const loader = ctx && ctx.loader;
  if (!loader || typeof loader.create !== 'function') {
    diag(ctx, 'BOOT-DEFER-SKIP ' + String(item && item.name) + '（loader 不可用）');
    return false;
  }
  // 行已存在 ⇒ 本次 bundle 仍被同步加载（清单写入与 bundle 移除之间存在竞态，
  // 或用户手动把 bundle 加回了 dsh.profile.bundles）。此时**不能**再 create：
  // 同一个 id 的 create 会更新既有入口（force 重启插件），等于把插件跑两遍。
  try {
    if (typeof loader.resolve === 'function' && loader.resolve(item.id)) {
      diag(ctx, 'BOOT-DEFER-SKIP ' + item.id + '（入口已存在，保持同步加载的那份）');
      return false;
    }
  } catch (e) {
    // resolve 对不存在的 id 抛错：正是期望路径
  }
  const started = Date.now();
  try {
    const options = { id: item.id, name: item.name };
    for (const key of Object.keys(item)) {
      if (key === 'id' || key === 'name' || item[key] === undefined) {
        continue;
      }
      options[key] = item[key];
    }
    if (options.config === undefined) {
      options.config = {};
    }
    await loader.create(options);
    diag(ctx, 'BOOT-DEFER ' + item.name + ' +' + String(Date.now() - started) + 'ms');
    return true;
  } catch (error) {
    /* 单项失败只降级该功能：壳已经起来了，不能因为一个插件把整个启动拖下水 */
    diag(ctx, 'BOOT-DEFER-FAIL ' + item.name + ' ' + String(error && error.message));
    return false;
  }
}

/**
 * 定位 profile 目录：优先用宿主已经发布的 `DSH_HOME` / `DSHM_PROFILE`。
 * 两者缺一就返回空串（此时只走 profile patch 里的显式 deferredBundles）。
 */
function resolveProfileDir() {
  const home = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME : '';
  if (home.length === 0) {
    return '';
  }
  const profile = typeof process.env.DSHM_PROFILE === 'string'
    && process.env.DSHM_PROFILE.length > 0 ? process.env.DSHM_PROFILE : 'ondevice';
  return join(home, 'profiles', profile);
}

/**
 * 读取宿主在 profile boot 前生成的用户 bundle 延迟清单。
 *
 * 文件由 `hostcore/app/dshm-deferred-bundles.js` 写入，行是上游 bundle patch
 * 里原样的 `{ id, name, config?, disabled? }`。读不到/损坏一律当作"没有清单"
 * （不能让一个坏 JSON 把启动编排变成启动失败）。
 */
function readDeferredManifest() {
  const dir = resolveProfileDir();
  if (dir.length === 0) {
    return { rows: [], bundles: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(join(dir, DEFERRED_FILENAME), 'utf8'));
    return {
      rows: Array.isArray(parsed && parsed.rows) ? parsed.rows : [],
      bundles: Array.isArray(parsed && parsed.bundles) ? parsed.bundles : [],
    };
  } catch (e) {
    return { rows: [], bundles: [] };
  }
}

/**
 * 插件入口。
 *
 * 配置（全部可选）：
 *   deferredBundles: Array<{ id: string, name: string, config?: object }>
 *   delayMs: number   —— 从此刻起延迟多久开始挂载，默认 3000
 *
 * 注意：`apply` 必须是同步返回的（不要 await 挂载），否则会阻塞插件图装载，
 * 反而把「延迟」变成「更慢的启动」。
 */
function apply(ctx, config) {
  const conf = config === undefined || config === null ? {} : config;
  const explicit = Array.isArray(conf.deferredBundles) ? conf.deferredBundles : DEFAULT_DEFERRED;
  // 【自动模式（2026-11-26）】宿主在 profile boot 前把"用户自己装的 bundle"写进
  // `.dshm-deferred-bundles.json`；这里默认读取它。false 可关闭（只吃显式清单）。
  const auto = conf.autoDeferUserBundles !== false;
  const manifest = auto ? readDeferredManifest() : { rows: [], bundles: [] };

  // 显式清单优先（同名 id 覆盖清单里的行），便于按实测继续微调。
  const byId = new Map();
  for (const item of manifest.rows) {
    if (!item || typeof item.name !== 'string' || item.name.length === 0) { continue; }
    const id = typeof item.id === 'string' && item.id.length > 0 ? item.id : 'deferred-' + item.name;
    byId.set(id, Object.assign({}, item, { id }));
  }
  for (const item of explicit) {
    if (!item || typeof item.name !== 'string' || item.name.length === 0) { continue; }
    const id = typeof item.id === 'string' && item.id.length > 0 ? item.id : 'deferred-' + item.name;
    byId.set(id, Object.assign({}, item, { id }));
  }
  const list = Array.from(byId.values());
  if (list.length === 0) {
    /* 空清单：直接返回。保留一行日志，便于确认插件确实被加载（而不是没挂上）。 */
    diag(ctx, 'BOOT-DEFER-IDLE（清单为空，不延迟任何插件）');
    return;
  }
  const delayMs = typeof conf.delayMs === 'number' && conf.delayMs >= 0 ? conf.delayMs : DEFAULT_DELAY_MS;
  diag(ctx, 'BOOT-DEFER-PLAN ' + String(list.length) + ' 项（用户 bundle '
    + String(manifest.bundles.length) + ' 个：' + manifest.bundles.join('、') + '），'
    + String(delayMs) + 'ms 后开始');

  const run = async () => {
    for (const row of list) {
      /* eslint-disable no-await-in-loop -- 逐个挂载是有意的：并发会把切片收益吃掉 */
      await mountOne(ctx, row);
      await sleep(YIELD_MS);
      /* eslint-enable no-await-in-loop */
    }
    diag(ctx, 'BOOT-DEFER-DONE');
  };

  const timer = setTimeout(() => { void run(); }, delayMs);
  if (timer && typeof timer.unref === 'function') { timer.unref(); }
}

export { apply, name };
