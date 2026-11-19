/**
 * 内置核心的安装（BundledCore）—— 把随应用分发的核心包落地成"可运行的一版核心"。
 *
 * 这是 D6 §4.1 R5 与 §6.1 的第一步：**核心随包内置，首启解包**。
 *
 * 容器放在 `entry/src/main/resources/resfile/`。为什么是 resfile 而不是 rawfile（**实测依据，不要改**）：
 *   1. resfile 资源在应用安装后**会被解压到应用沙箱**，可用 `Context.resourceDir`
 *      按真实文件路径只读访问 ⇒ 可以用 `fileIo.copyFile(真实路径 → 真实路径)`；
 *   2. rawfile 的 `resourceManager.getRawFd().fd` **不是文件系统的 fd**，直接丢给
 *      `fileIo.copyFile` 会拷出大小与内容都错误的文件（华为官方 FAQ：faqs-local-file-manager-62）；
 *      而正确的替代 `getRawFileContent` 会把整个文件读进内存——对 63 MB 的核心包不合适。
 *
 * 因此：**大文件资源走 resfile**。这条结论写在代码里，避免以后有人"顺手换成 rawfile"。
 *
 * 分层：本文件只依赖 core/ 与系统文件 API，不认识 UI、不认识 Context 的具体类型
 * （调用方把 resourceDir / workDir 传进来），便于在没有 UI 的环境里复用与测试。
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { CoreStore, OpResult } from './CoreStore';
import { parseArchiveName } from './Naming';
import { sha256OfFile } from 'platform';

const TAG: string = 'DSHM-BundledCore';
const DOMAIN: number = 0x0000;

export function matchesBundledIdentity(stamp: string, identity: string): boolean {
  return identity.startsWith('sha256:') && identity.length === 71 && stamp === identity;
}

/**
 * 写"容器大小指纹"（`cores/<version>/.dshm-bundled-stamp`），**写完回读校验**。
 *
 * 【为什么要单独一个函数】这段逻辑有三处调用（安装成功时、stamp 缺失但验树通过时），
 * 而旧实现**写失败被静默吞掉**——一旦没落盘，之后每次启动都会重解一遍 99 MB 核心
 * （端侧实测：固定 11 秒、启动页像卡死），而日志里看不出任何异常。
 * 现在：失败/回读不一致一律打 W 日志；返回值让调用方知道有没有写上。
 *
 * `size <= 0` 表示"容器大小没读到"，此时不写（写上 0 会让下次判据误判）。
 */
function writeStamp(store: CoreStore, version: string, identity: string): boolean {
  if (!identity.startsWith('sha256:') || identity.length !== 71) {
    return false;
  }
  const path: string = `${store.coreDir(version)}/.dshm-bundled-stamp`;
  try {
    const f: fs.File = fs.openSync(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
    try {
      fs.writeSync(f.fd, identity);
    } finally {
      fs.closeSync(f);
    }
  } catch (e) {
    const err = e as BusinessError;
    hilog.warn(DOMAIN, TAG, '写容器指纹失败（下次启动可能重复解包）：%{public}s', `${err.code} ${err.message}`);
    return false;
  }
  /* 回读校验：写成功不等于内容对（TRUNC 与并发写都可能出岔子） */
  try {
    const back: string = fs.readTextSync(path).trim();
    if (back !== identity) {
      hilog.warn(DOMAIN, TAG, '容器内容指纹回读不一致');
      return false;
    }
    return true;
  } catch (e) {
    const err = e as BusinessError;
    hilog.warn(DOMAIN, TAG, '容器指纹回读失败：%{public}s', `${err.code} ${err.message}`);
    return false;
  }
}

export interface BundledInstallResult {
  /** 本次真正落地成功的版本 */
  installed: string[];
  /** 已经在设备上、跳过的版本 */
  skipped: string[];
  /** 失败的，附原因 */
  failed: string[];
  /** 给用户看的一句话结论（允许为空串） */
  note: string;
}

function emptyResult(note: string): BundledInstallResult {
  return { installed: [], skipped: [], failed: [], note: note };
}

/**
 * 把 resfile 里的核心容器逐个落地。
 *
 * 幂等：已经安装过的版本直接跳过（不重解、不覆盖）。
 * 失败隔离：某一个版本失败不影响其他版本（每个版本独立收集失败原因）。
 */
export async function installBundledCores(resourceDir: string, workDir: string,
  store: CoreStore): Promise<BundledInstallResult> {
  const key: string = JSON.stringify([normalizeBundledPath(resourceDir), normalizeBundledPath(workDir),
    normalizeBundledPath(store.baseDir())]);
  const existing: Promise<BundledInstallResult> | undefined = BundledInstallState.inflight.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const task: Promise<BundledInstallResult> = BundledInstallState.queue.then((): Promise<BundledInstallResult> => {
    return runBundledInstall(resourceDir, workDir, store);
  }).finally((): void => {
    BundledInstallState.inflight.delete(key);
  });
  BundledInstallState.queue = task.then((): void => {}, (): void => {});
  BundledInstallState.inflight.set(key, task);
  return task;
}

class BundledInstallState {
  static queue: Promise<void> = Promise.resolve();
  static readonly inflight: Map<string, Promise<BundledInstallResult>> =
    new Map<string, Promise<BundledInstallResult>>();
}

function normalizeBundledPath(path: string): string {
  let end: number = path.length;
  while (end > 1 && path.charAt(end - 1) === '/') {
    end--;
  }
  return path.slice(0, end);
}

async function runBundledInstall(resourceDir: string, workDir: string,
  store: CoreStore): Promise<BundledInstallResult> {
  const result: BundledInstallResult = emptyResult('');

  try {
    if (resourceDir.length === 0 || !fs.accessSync(resourceDir)) {
      result.note = `未找到内置资源目录（${resourceDir}），跳过内置核心的安装`;
      return result;
    }
  } catch (e) {
    result.note = '访问内置资源目录失败';
    return result;
  }

  const layout: OpResult = store.ensureLayout();
  if (!layout.ok) {
    result.note = layout.message;
    return result;
  }

  let names: string[] = [];
  try {
    names = fs.listFileSync(resourceDir);
  } catch (e) {
    const err: BusinessError = e as BusinessError;
    result.note = `列出内置资源失败：${err.code} ${err.message}`;
    return result;
  }

  const installed: string[] = store.listInstalled();
  /*
   * 【2026-10-29 修复：先成功、后挪走，失败必须回滚】
   *
   * 原来的顺序是"**先把旧树 rename 走**（放进 staleDirs）→ 再拷/解压/校验 → 最后无条件
   * `rmdir` 掉旧树"。实测风险（docs/291 复核）：覆盖安装一个**同版本号但内容损坏**
   * 的新容器时 —— 旧树已经被挪走，新树却在解压/哨兵校验处失败 ⇒ 失败分支只记一条
   * `failed`，末尾仍把旧树删掉 ⇒ 设备上**该版本一棵树都不剩**，而 `state.current`
   * 还指着它 ⇒ 下次 `host.start()` 直接报"没有可用的核心树"，App 起不来。
   * `CoreStore.stageFromZip` 里那条"current 版本拒绝覆盖"的守卫也一起失效（目录早被挪空了）。
   *
   * 现在的语义（每个版本都走 `installOneVersion`）：
   *   ① 拷到可写目录 → ② `store.stage()` 解包 + 四道校验，**不碰 cores/<version>**
   *   → ③ 新树已证明完整，才把旧树改名成 `.stale-*.tmp`
   *   → ④ `store.commitStaged()` 落位 → ⑤ 落位/异常失败一律把旧树**改名回去**。
   * 成功的旧树延后到循环外统一**异步**删（E47：同步删 25k 文件会把主线程锁死）。
   * 回滚失败也绝不删（宁可留一棵 `.tmp`，也不能让用户失去能跑的那棵树）。
   */
  const staleDirs: string[] = [];
  for (const name of names) {
    const version: string = parseArchiveName(name);
    if (version.length === 0) {
      continue; // 不是本项目的核心容器，忽略（不猜）
    }
    const src: string = `${resourceDir}/${name}`;
    // 【为什么不能只看"版本已安装"就跳过】实测踩过：改了核心包（补平台别名）并重装应用后，
    // 端侧仍报 `内置核心已全部安装过，无需重复解包` ⇒ 设备上一直跑**旧核心树**，新改动根本没进去。
    // 换包必须能生效，否则"核心版本安装/切换/回滚"这条功能形同虚设。
    // 判据用**资源包大小**这个廉价指纹：与上次安装时记下的一致才跳过。
    let srcSize: number = 0;
    let identity: string = '';
    try {
      srcSize = fs.statSync(src).size;
      identity = 'sha256:' + await sha256OfFile(src);
    } catch (e) {
      srcSize = 0; // 拿不到大小 ⇒ 当作"需要装"（保守）
    }
    if (installed.includes(version)) {
      let stamp: string = '';
      let stampExists: boolean = false;
      try {
        const stampPath: string = `${store.coreDir(version)}/.dshm-bundled-stamp`;
        if (fs.accessSync(stampPath)) {
          stampExists = true;
          stamp = fs.readTextSync(stampPath).trim();
        }
      } catch (e) {
        stamp = '';
        stampExists = false;
      }
      /*
       * ── 决策表（2026-11-01 修正：解包只应在"初次安装/换容器"时发生）────────
       *
       * 端侧实测（17:58 日志）：**每次启动都在重新解包 99 MB 核心，固定花 11 秒**，
       * 表现为"启动页停 20 秒"（11 s 解包 + 9 s Node 启动）。
       * 而 `installed=[…]` 明明是"本次真装了"，说明跳过分支从未命中。
       *
       * 根因是下面的判据太脆：它要求 `.dshm-bundled-stamp` **存在且等于当前容器大小**。
       * stamp 的写入在上一次安装的尾部，且失败时被静默吞掉（旧代码 `catch {}`）——
       * 一旦它没落盘，之后**每次**启动都会重解一遍，而日志里看不出任何异常。
       *
       * 现在的三层判据，从强到弱：
       *   ① stamp 存在且等于 srcSize            ⇒ 容器没换过，跳过（最强证据）
       *   ② stamp 存在但不等于 srcSize          ⇒ **容器换过**，必须重装（保留原有纪律）
       *   ③ stamp 缺失（或读不到）              ⇒ 先验树：`dshm-core.json` 在、且其中的
       *      `coreVersion` 等于本版本 ⇒ 判为已装，**补写 stamp** 后跳过；
       *      验树不过才重装。
       *
       * ③ 为什么敢信版本号：本仓的纪律是"核心树内容一变就必须递增 `+dshm.<n>`"
       * （AGENTS.md 出包三坑之二），所以版本号相同 ⇒ 树内容应当相同；
       * 而"同版本换了容器"这种情形，只要 stamp 还在就会被 ② 拦住。
       * ③ 命中时会打一行 W 日志留痕，万一将来真出现同版本换树，日志里查得到。
       */
      if (stampExists && matchesBundledIdentity(stamp, identity)) {
        result.skipped.push(version);
        continue;
      }
      if (stampExists && srcSize > 0 && stamp !== String(srcSize)) {
        hilog.warn(DOMAIN, TAG,
          '内置核心 %{public}s：容器已更换（stamp=%{public}s ≠ 当前 %{public}d）⇒ 重新解包',
          version, stamp, srcSize);
      } else if (!stampExists) {
        /*
         * ③ 验树：必须同时满足三个**实打实**的条件，缺一不可：
         *    · `.dshm-bundled-stamp` 确实不存在（上面已判）；
         *    · 树信息文件 `dshm-core.json` **真的在磁盘上**（`readTreeInfo` 失败时
         *      会返回一个 coreVersion 等于入参的默认对象，**不能**拿 coreVersion 当判据，
         *      否则这条永远为真 —— 这是本轮差点写错的坑）；
         *    · 该文件里的 `builtAt` 非空（说明是真正解包出来的树，不是半成品）。
         */
        let treeOk: boolean = false;
        try {
          if (fs.accessSync(store.treeInfoPath(version))) {
            const info = store.readTreeInfo(version);
            treeOk = info.builtAt.length > 0;
          }
        } catch (e) {
          treeOk = false;
        }
        if (treeOk && identity.length === 0) {
          hilog.warn(DOMAIN, TAG, '内置核心 %{public}s：树信息不是内容身份证据，安全重装', version);
          // 未知容器身份不认证旧树；仍走事务重装。
        }
        hilog.warn(DOMAIN, TAG,
          '内置核心 %{public}s：stamp 缺失且树信息不可用 ⇒ 重新解包', version);
      }
    }
    /*
     * 首次安装与"同版本换树"走同一个函数：顺序是这份实现的核心（见函数头注）。
     * 首次安装时 `oldDir` 不存在 ⇒ 函数自动跳过"挪开旧树"这一步。
     */
    const outcome: InstallOutcome = await installOneVersion(store, workDir, src, name, version, identity);
    if (outcome.installed) {
      result.installed.push(version);
      if (outcome.stale.length > 0) {
        staleDirs.push(outcome.stale);
      }
    } else {
      result.failed.push(`${version}：${outcome.failed}`);
    }
  }

  /*
   * 异步清理被换下来的旧树。放在这里而不是拦在安装前：安装路径上不能出现
   * 任何"删几万个文件"的**同步**调用（E47）。`fs.rmdir` 走异步接口，
   * 主线程在删除期间保持可响应；失败也只是留下一个 `.tmp` 目录，
   * 不会被 `listInstalled()` 当成已安装版本。
   */
  for (const stale of staleDirs) {
    try {
      await fs.rmdir(stale);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '清理旧核心树失败：%{public}s', stale);
    }
  }

  /*
   * 清掉"已经不会再被启动"的旧树。
   *
   * 【为什么必须在这里做】核心树是**每版一份**解包落地的（`cores/<version>/`，实测 ~350 MB/棵），
   * 而安装器只在"同一版本换了容器"时替换**同一棵** ⇒ 跨版本升级**只增不减**：
   * 2026-10-08 真机清点出 **15 棵并存 ≈ 5 GB**（最老的是 0.1.7-rc.2）。
   * `CoreStore.evict()` 与它的判据（`Types.evictionCandidates`）早就写好了，
   * 但**一个调用点都没有** —— 这就是那 5 GB 的成因。
   *
   * 【为什么放在安装之后算】判据里保护"会真正启动的那棵树"（current 缺失时 = 最新那棵），
   * 安装之后再算，刚落地的新树才是被保护的那棵。
   * 【为什么把 result.installed 点名叫 keepExtra】万一装进来的容器**比设备上已有的还旧**
   * （回退到旧侧载包的场景），被保护的就是旧树、刚装的这棵反而落进"可删" ⇒
   * 会出现"刚装完就被删掉"，所以刚装进来的版本一律点名保护。
   * 【为什么整段吞异常】清理是顺手的卫生，不能把"装成功"这件事拖下水。
   * 【为什么**不**只在"本次真装了东西"时清】用户升级一次之后，之后每次启动
   * `installBundledCores` 都只会走"已安装过 ⇒ 跳过"（判据是容器大小指纹）——
   * 若清理只在"真装了"时跑，那么"这一轮之前攒下来的旧树"要等到**下一次换容器**才可能被清，
   * 而设备上恰恰就是这种状态（实测 15 棵）。所以这里**每次走完都清一次**：
   * 没东西可清时它只是一次 `readState + listInstalled + 逐棵 readdir`，代价可忽略。
   */
  let evicted: string[] = [];
  try {
    evicted = await store.evict(0, result.installed);
    if (evicted.length > 0) {
      hilog.info(DOMAIN, TAG, '已清理旧核心树 %{public}s 棵：%{public}s',
        String(evicted.length), evicted.join('、'));
    }
  } catch (e) {
    const err: BusinessError = e as BusinessError;
    hilog.warn(DOMAIN, TAG, '清理旧核心树失败（不影响本次安装）：%{public}s', `${err.code} ${err.message}`);
  }

  if (result.installed.length > 0) {
    result.note = `已安装内置核心：${result.installed.join('、')}`;
  } else if (result.failed.length > 0) {
    result.note = `内置核心安装失败：${result.failed.join('；')}`;
  } else if (result.skipped.length > 0) {
    result.note = '内置核心已全部安装过，无需重复解包';
  } else {
    result.note = '应用内没有内置核心包';
  }
  if (evicted.length > 0) {
    result.note = `${result.note}；已清理不再启动的旧核心树 ${evicted.length} 棵（${evicted.join('、')}）`;
  }
  return result;
}

/**
 * 单个版本的安装结果。
 *
 * 三态而不是"直接改 result"：安装步骤必须让"成功"与"旧树清理"分开表达 ——
 * 只有**落位成功**时，被换下来的旧树才允许被删；失败/回滚成功时它是空的。
 */
interface InstallOutcome {
  /** 新树已落位 */
  installed: boolean;
  /** 失败原因（installed 为 true 时为空串） */
  failed: string;
  /** 落位成功后待异步删除的旧树路径（否则为空串） */
  stale: string;
}

/**
 * 安装一个版本的核心树。**顺序是这份实现的核心**，不要调整。
 *
 *  ① 拷到可写目录（解压 API 要求可读写路径）
 *  ② `store.stage()`：解包 + 四道校验，**完全不碰 `cores/<version>`**
 *  ③ 新树已证明完整，才把旧树改名为 `.stale-<ts>.tmp`（一次元数据操作，毫秒级）
 *  ④ `store.commitStaged()` 把 staging 树落位到 `cores/<version>`
 *  ⑤ ③/④ 的任何失败都把旧树**改名回去**；搬不回来时保留 `.tmp` 不删
 *
 * 【为什么不能先挪后装（2026-10-29，docs/291 复核）】覆盖安装一个同版本号但
 * 内容损坏的新容器时，"先挪后装"的失败分支会让设备上该版本**一棵树都不剩**，
 * 而 `state.current` 还指着它 ⇒ 下次启动直接报"没有可用的核心树"。
 * 首装（旧树不存在）走同一条路径，只是第 ③ 步被跳过。
 *
 * 【为什么不能同步删旧树（D6 E47）】同步删除 216 MB / 25k 文件会把 ArkUI 主线程
 * 锁住十余秒，系统判 `LIFECYCLE_TIMEOUT` + `SYS_FREEZE` 并 kill 进程；
 * 因此旧树只改名，删除交给调用方用异步 `fs.rmdir` 延后做。
 */
async function installOneVersion(store: CoreStore, workDir: string, src: string, name: string,
  version: string, identity: string): Promise<InstallOutcome> {
  const tmp: string = `${workDir}/bundled-${name}`;
  const oldDir: string = store.coreDir(version);
  let stale: string = '';
  let outcome: InstallOutcome = { installed: false, failed: '', stale: '' };
  try {
    // ── ① 只读资源拷到可写目录 ──────────────────────────────────────────
    if (fs.accessSync(tmp)) {
      fs.unlinkSync(tmp);
    }
    await fs.copyFile(src, tmp);

    // ── ② 先只解包 + 校验；这一步失败 ⇒ 旧树原封不动，无需任何回滚 ────
    const staged: OpResult = await store.stage(tmp, version);
    if (!staged.ok) {
      outcome.failed = staged.message;
      return outcome;
    }

    // ── ③ 新树已完整，才挪开旧树 ────────────────────────────────────────
    if (fs.accessSync(oldDir)) {
      const to: string = `${oldDir}.stale-${Date.now()}.tmp`;
      try {
        fs.renameSync(oldDir, to);
        stale = to;
      } catch (e) {
        const err: BusinessError = e as BusinessError;
        outcome.failed = `旧树无法挪开（${err.code} ${err.message}）`;
        return outcome;
      }
    }

    // ── ④ 落位 ──────────────────────────────────────────────────────────
    const hadOld: boolean = stale.length > 0;
    const committed: OpResult = await store.commitStaged(version, hadOld);
    if (!committed.ok) {
      outcome.failed = committed.message;
      return outcome;
    }
    outcome.installed = true;

    // 记下本次的指纹，供下次判断"资源包是否换过"。
    // 【走 writeStamp】旧实现内联写、失败静默吞掉；一旦没落盘，之后每次启动都会重解
    // 99 MB 核心（端侧实测 11 秒）且日志无异常。现在失败会留 W 日志并回读校验。
    // 写失败不影响本次安装成功 —— 顶多下次多解一遍，不能因此判安装失败。
    writeStamp(store, version, identity);

    if (stale.length > 0) {
      outcome.stale = stale;
      stale = '';
    }
    return outcome;
  } catch (e) {
    const err: BusinessError = e as BusinessError;
    outcome.failed = `拷贝/解包异常 ${err.code} ${err.message}`;
    return outcome;
  } finally {
    /*
     * ── ⑤ 回滚与清理 ────────────────────────────────────────────────────
     * 走到这里时若 `stale` 仍非空，说明旧树已经被挪开但新树没落位成
     * （commitStaged 失败或中途抛异常）⇒ 必须搬回去。
     * 搬不回来就**保留**那棵 `.tmp` 并把位置写进 failed —— 绝不删除。
     */
    if (stale.length > 0) {
      try {
        fs.renameSync(stale, oldDir);
        hilog.info(DOMAIN, TAG, '安装未成功，已回滚旧核心树：%{public}s', oldDir);
      } catch (e2) {
        const err2: BusinessError = e2 as BusinessError;
        const keep: string = stale;
        outcome.failed = `${outcome.failed}；旧树未能搬回（已保留在 ${keep}，${err2.code} ${err2.message}）`;
        hilog.error(DOMAIN, TAG, '旧核心树回滚失败，已原样保留：%{public}s', keep);
      }
    }
    // 临时容器文件无论成败都清 —— 63 MB × N 份留在沙箱里是纯浪费
    try {
      if (fs.accessSync(tmp)) {
        fs.unlinkSync(tmp);
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '清理内置核心临时文件失败（不影响结果）');
    }
  }
}
