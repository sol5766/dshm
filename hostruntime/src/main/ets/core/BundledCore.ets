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

const TAG: string = 'DSHM-BundledCore';
const DOMAIN: number = 0x0000;

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
   * 被换掉的旧树先挪到一边，安装结束后再**异步**删。
   * 见下面替换点处的实测说明（D6 E47）：同步删 25k 文件会把主线程锁死。
   * 目录名以 `.tmp` 结尾：`CoreStore.listInstalled` 明确忽略该后缀，
   * 因此即使异步删除没跑完，也不会被当成"已安装版本"。
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
    try {
      srcSize = fs.statSync(src).size;
    } catch (e) {
      srcSize = 0; // 拿不到大小 ⇒ 当作"需要装"（保守）
    }
    if (installed.includes(version)) {
      let stamp: string = '';
      try {
        const stampPath: string = `${store.coreDir(version)}/.dshm-bundled-stamp`;
        if (fs.accessSync(stampPath)) {
          stamp = fs.readTextSync(stampPath).trim();
        }
      } catch (e) {
        stamp = '';
      }
      if (srcSize > 0 && stamp === String(srcSize)) {
        result.skipped.push(version);
        continue;
      }
      /*
       * 指纹不同 ⇒ 换树重装：把旧树**改名挪开**（一次元数据操作，毫秒级）。
       *
       * 【为什么不能 `fs.rmdirSync(旧树)`】真机实测（D6 E47）：换包后首次启动，
       * 同步删除 216 MB / 25k 个文件把 ArkUI 主线程锁住十余秒，系统判定
       * `Reason:LIFECYCLE_TIMEOUT` + `SYS_FREEZE` 并把进程 kill
       * （日志：`onProcessDied … pid:62616`、`SaveFaultLogToFile … Reason:LIFECYCLE_TIMEOUT`），
       * 表现为"应用起来就消失、连一条自己的日志都没有"。
       * 改名后真正的删除放到安装末尾用**异步** `fs.rmdir` 做（见下面的循环），
       * 它在文件系统的异步工作线程上执行，主线程保持可响应。
       */
      try {
        const oldDir: string = store.coreDir(version);
        if (fs.accessSync(oldDir)) {
          const stale: string = `${oldDir}.stale-${Date.now()}.tmp`;
          fs.renameSync(oldDir, stale);
          staleDirs.push(stale);
        }
      } catch (e) {
        // 挪不动也不致命：下面的解包/落位会给出真实结论
      }
    }
    const tmp: string = `${workDir}/bundled-${name}`;
    try {
      // 第一步：把只读的 resfile 拷到可写目录（解压 API 要求可读写路径）
      if (fs.accessSync(tmp)) {
        fs.unlinkSync(tmp);
      }
      await fs.copyFile(src, tmp);

      // 第二步：解包并落位到 cores/<version>（内部会校验顶层目录与树内元数据）
      const staged: OpResult = await store.stageFromZip(tmp, version);
      if (staged.ok) {
        result.installed.push(version);
        // 记下本次的指纹，供下次判断"资源包是否换过"
        try {
          if (srcSize > 0) {
            const stampFile: fs.File = fs.openSync(`${store.coreDir(version)}/.dshm-bundled-stamp`,
              fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
            try {
              fs.writeSync(stampFile.fd, String(srcSize));
            } finally {
              fs.closeSync(stampFile);
            }
          }
        } catch (e) {
          // 写指纹失败不影响本次安装成功
        }
      } else {
        result.failed.push(`${version}：${staged.message}`);
      }
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      result.failed.push(`${version}：拷贝/解包异常 ${err.code} ${err.message}`);
    } finally {
      // 无论成败都清掉临时文件——63 MB × N 份留在沙箱里是纯浪费
      try {
        if (fs.accessSync(tmp)) {
          fs.unlinkSync(tmp);
        }
      } catch (e) {
        hilog.warn(DOMAIN, TAG, '清理内置核心临时文件失败（不影响结果）');
      }
    }
  }

  /*
   * 异步清理被挪走的旧树。放在这里而不是拦在安装前：安装路径上不能出现
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

  if (result.installed.length > 0) {
    result.note = `已安装内置核心：${result.installed.join('、')}`;
  } else if (result.failed.length > 0) {
    result.note = `内置核心安装失败：${result.failed.join('；')}`;
  } else if (result.skipped.length > 0) {
    result.note = '内置核心已全部安装过，无需重复解包';
  } else {
    result.note = '应用内没有内置核心包';
  }
  return result;
}
