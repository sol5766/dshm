/**
 * DSH 运行时引导（ArkTS 层）。
 *
 * 职责：
 * 1. 首次启动时将 HAP 内 rawfile/dsh 的 DSH 运行环境解压到应用沙箱 filesDir/dsh；
 * 2. 解压 rawfile/busybox 的 busybox 二进制并建立 applet 软链（sh/bash 等），
 *    为 dsh 提供 bash/Linux 命令环境（PATH/SHELL 等环境变量由 libdsh_host 注入）；
 * 3. 启动 native 子进程（libdsh_host.so:Main），子进程内 dlopen(libnode.so) →
 *    node::Start → 启动 DSH web server (127.0.0.1:3080)；
 * 4. 轮询 3080 端口就绪，供 ArkWeb 加载。
 */
import { common } from '@kit.AbilityKit';
import { childProcessManager } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { http } from '@kit.NetworkKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import process from '@ohos.process';
import resourceManager from '@ohos.resourceManager';
import { DshmLogger } from '../utils/Logger';

const TAG: string = 'DshBootstrap';
const RAWFILE_ROOT: string = 'dsh';
const DSH_SUBDIR: string = 'dsh';
const SERVER_URL: string = 'http://127.0.0.1:3080';

// 鸿蒙专属技能：随 HAP 分发（rawfile/ohos-skills），启动时覆盖复制到
// <filesDir>/home/.dsh/skills（dsh 的 dsh-skill-filesystem 默认扫描 ~/.dsh/skills，
// 自动发现并暴露给模型与技能目录）。文件极小（KB 级），整目录覆盖即可。
const OHOS_SKILLS_RAWFILE: string = 'ohos-skills';

// 环境版本号：rawfile/dsh、busybox、pnpm 内容变化时递增。
// 覆盖安装（install -r）不清应用数据，靠版本文件判断是否需要重新解压，
// 避免旧环境残留、新环境不更新；会话/工作区/API key 存于 filesDir/home，
// 不随环境重建而丢失。
// v64 → v65：dshm-terminal 1.0.1（pty_host highlighter、zsh PATH 解析、ui/event、
// update 端点、read flush），覆盖安装后强制重新解压环境生效。
// v65 → v66：dshm-terminal 1.0.2（修复 node:fs 无 X_OK 命名导出导致服务启动崩溃，
// 改 fs.constants.X_OK），覆盖安装后强制重新解压环境生效。
// v66 → v67：dshm-terminal 1.0.3（修复 ESM 下 __dirname undefined 导致 pty addon
// 无法加载、会话启动失败），覆盖安装后强制重新解压环境生效。
// v67 → v68：设置页"鸿蒙适配"修复（client 读取 device 而非 deviceInfo、sameOrigin
// 放行无 Origin 的 loopback GET）+ 终端会话诊断日志（start 结果、管道 spawn 错误
// 事件）+ 终端侧边栏改终端样式，覆盖安装后强制重新解压环境生效。
// v68 → v69：dshm-terminal 加载 pty addon 前先 chmod 0755（沙箱内 rawfile 解压/
// 镜像的 .node 为 0660 无执行位，dlopen 报 ERR_DLOPEN_FAILED "No error
// information"，导致只能走管道回退），覆盖安装后强制重新解压环境生效。
// v69 → v70：pty addon 移入 el1 bundle 库目录（entry/libs/arm64-v8a 随 hap
// 原生库安装，与 libnode.so 同目录），dshm-terminal 依据 /proc/self/maps 解析
// bundle libs 绝对路径优先加载（沙箱 el2 用户数据区 dlopen 被拒），失败回退
// vendor/pty_host.node，覆盖安装后强制重新解压环境生效。
// v70 → v71：dshm-terminal /start 返回 user（id -un 解析个人目录真实用户名，
// 修复空 $USER 时 prompt 角色名缺失）/host/cwd，覆盖安装后强制重新解压环境生效。
// v71 → v72：user 解析改为优先 id -un（沙箱 $USER 为数值 uid 100，pw_name
// 才是个人目录归属账户名如 Sol），覆盖安装后强制重新解压环境生效。
// v72 → v73：dshm-terminal 补 import execFileSync（此前 ReferenceError 被
// 吞掉回退 uid），user 才能真正解析出 pw_name，覆盖安装后强制重新解压。
// v73 → v74：dshm-terminal 1.0.4（Harness 更新改为同进程 Worker 跑 pnpm +
// 后台任务轮询：原 execFile(process.execPath) 在沙箱里是
// /system/bin/nativespawn EACCES，更新必失败；并备份/回填 dshm-* 与
// _fetch-shim.cjs，避免 pnpm 清掉 DSHM 自有 bundle），覆盖安装后强制重新解压。
// v74 → v75：解压健壮性修复（rawfile 条目目录判定不再依赖抛异常、哨兵增加
// 目录内容校验、并发 boot 合并为一次解压），覆盖安装后强制重新解压。
// v88 → v89：修正 Plan B 原生模块的加载路径 —— 鸿蒙沙箱只允许从 el1 bundle
// 库目录 dlopen（el2 解压目录会 ERR_DLOPEN_FAILED "No error information"），
// 所以 koffi 改以 libkoffi.so 随 native 库分发 + 加载器走 process.dlopen，
// native 侧用 DSHM_KOFFI_PATH 指路；上一版放在 el2 的 koffi.node 必须清掉。
//
// v87 → v88：内嵌模式（Plan B）补齐"真编译的原生模块"：
//   - koffi 3.2.1 用 DevEco OHOS clang/sysroot 编译成 arm64 N-API 模块随包分发
//     （tools/prebuilt/koffi-3.2.1-ohos-arm64.node），不再用 JS stub，FFI 可用；
//   - node-pty 换成基于 libpty_host.so 的兼容层（tools/node-pty-ohos/），
//     终端/交互式子进程能力真实可用；
//   - dshm-terminal 1.0.11 的 /dshm-admin/version 增加 koffi 状态，供「关于版本」显示。
// 20260911-91：修复 koffiStatusOf 误报（struct({}) 探活改成 sizeof 探活），并给更新流程
// 加「构建期适配齐备性」闸门（0.1.5 缺适配会在 boot 时死循环）。bump 版本号以触发内置
// 环境重新解压，让活环境拿到修好的 dshm-terminal。
// 20260911-94：修「环境解压不完整」误判 —— 0.1.5-rc.1 环境解压 26564 文件全部成功
// （contentFailed=0/writeFailed=0）却因哨兵清单对不上而失败：DSHM 的 dshm-terminal 覆盖层
// 被 prepare-dsh-env.sh 重建 node_modules 时冲掉（已从资产补回），配置编辑器改名为
// dshm-config-editor（哨兵改为两者满足其一）。
// 20260911-95：把 dshm-terminal 挂进 0.1.5 的 web profile（dsh-app-boot 的
// PROFILE_TEMPLATES.web.bundles）。之前它只在 node_modules 里存在却没被加载，导致
// /dshm-admin/* 全 404、日志缺 "[dshm-terminal] pty addon 加载成功" 行；而 0.1.5 的
// WebUI 用 window.__ModuleLoader__ 队列等客户端模块挂载，很可能因此白屏。
// 20260911-96：补回丢失的 dshm-ohos-settings（DSHM 的鸿蒙设置面板 bundle，client 侧
// inject @deepseek-ai/dsh-client-ui-settings），并挂进 web profile。缺它时症状是
// 「设置里面都不可用、无法选择工作区目录」。哨兵同步纳入该包，缺失即快速失败。
// 20260911-97：真正的主因 —— _fetch-shim.cjs 的 ShRequest 缺 text()/json()/arrayBuffer()，
// 使 dsh-client-connection 读 RPC 信封时抛错并被包成 `400 body is not JSON`，于是
// settings/describe、llm/listProviders、agentPresets/list、directoryPicker/list、
// pluginInventory/list 全部 400（与 docs/device-runtime-fixes.md §5.1 同一处，修复曾丢失）。
// 已补上并同步 scripts/_fetch-shim.cjs；bump 版本号让活环境重新解压拿到新 shim。
// 20260911-98：修复对话时报 lock is not supported on openharmony-arm64 —— @deepseek-ai/node-addon-system 只为 linux/darwin 提供预编译 system.node，鸿蒙没有该包；已在 flock.js 里加纯 JS 等价实现（O_EXCL 锁文件 + 轮询 fd 关闭释放）。
// 20260911-99：修复「API key 正确、网络可达，但对话永远失败」——报错为
// `DeepSeek API stream from https://api.deepseek.com failed`（code TRANSPORT，重试 5/5）。
// 根因在 _fetch-shim.cjs 的响应体：自制的 "ReadableStream-lite" 只有 getReader +
// asyncIterator，没有 pipeThrough；而 dsh 的 SSE 解析链是
//   stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream())
// （@deepseek-ai/dsh-llm-deepseek/lib/index.js 的 parseSse，MCP streamableHttp 同写法），
// 于是 fetch 已拿到 HTTP 200 之后仍抛 TypeError，被上层包成 TRANSPORT。
// 已把响应体改为 node:stream/web 的真 ReadableStream（--jitless 可用、纯 JS），
// 并在主机上用 dsh 真实的 parseSse + gzip/真实 HTTPS 401 路径全部验证通过。
// 20260911-101：修**冷启动慢**的真凶 —— @deepseek-ai/dsh-client-modules 的
// newlineCount 用 `for (const char of value)` 逐码点遍历字符串（每个字符分配一个
// 单字符字符串），而它每轮启动都要在约 11MB 的客户端合并包（/plugins/??…）上跑。
// V8 --cpu-prof 实测：wall 19.6s 中 newlineCount 占 57.8%（11.4s），
// identitySectionMap 5.6%，buildCombo 8.3%。改为原生 indexOf 扫描后主机冷启动
// 19.6s → 6.1s（3.2 倍）。补丁见 scripts/patch-dsh-env-client-modules.mjs，
// 等价性由 scripts/verify-client-modules-patch.mjs 逐值比对（含 9.3MB 真实 bundle）。
// 同时把 _fetch-shim.cjs 的启动剖析器改为 DSHM_BOOT_PROFILE=1 才启用（生产零开销）。
// 20260911-102：冷启动第二步 —— 同一进程内的合并包记忆化。实测一轮启动里
// buildCombo 被调用 469 次却只有 65 个互不相同的产物，约 400 次是**同一输入的
// 重复拼装**（MB 级字符串拼接/数行/造 source map/JSON/UTF-8 编码/哈希）。加进程内
// Map（键 = (entry.id, entry.rev) + revision，entry.rev 本身就是内容指纹）后，
// 主机冷启动 6.0s → 4.5s；等价性用 DSHM_COMBO_VERIFY=1 在**运行时自证**：
// 404 次命中全部重建并逐字节比对，mismatches=0。
// 20260911-104：回退 103 的实验（同步 fs 记忆化）。真机 A/B 实测 10.48s vs 10.64s，
// 差异在噪声内（主机同样无收益：4.60s vs 4.45s）——设备页缓存已让重复读很便宜，
// 而代价是给全局 fs 打补丁。既然无收益就移除，负面结论记入 bug-log 以免重试。
// 20260911-105：品牌统一 —— 仓库内残留的 hdsh/HDSH 命名全部改为 dshm/DSHM
// （目录 entry/src/main/ets/hdsh → dshm、pages/hdsh → pages/dshm、HdshLogger → DshmLogger、
//  HdshWebPage → DshmWebPage、环境侧包 hdsh-config-editor → dshm-config-editor、
//  标记 .hdsh-env-ready → .dshm-env-ready 等）。环境侧包名变了，必须 bump 让活环境
// 重新解压，否则哨兵会因找不到新包名而判「解压不完整」。
// 20260911-107：环境瘦身修正版 —— 裁掉鸿蒙运行时用不到的文件（平台构建产物 / 调试符号 /
// 服务端 source map / *.d.ts / test / *.md），env 253.5MB → 110.7MB（-56%），HAP 385MB → 238MB。
// ⚠️ 106 版本曾因裁剪规则过激而损坏环境（把 @deepseek-ai/dsh-win32-process 与 isexe/dist/*/win32.js
// 这类「名字里带 win32 的跨平台 JS」删掉，内嵌模式启动即 ERR_MODULE_NOT_FOUND + SIGNAL 6）。
// 现已把规则收紧到「平台构建产物」形状（prebuilds/、<os>-<arch> 路径段、.pdb/.dll/.exe），
// 并在 scripts/prune-dsh-env.mjs 里加了**包入口自检**（缺 main/exports 目标就退出码 1）。
// 20260913-116：把 boot-state.json 写入器正式落进 _fetch-shim.cjs（A1 结构化启动
//   状态）。此前的 A1 是直接手改进环境树的，重建/回退即丢失（本次实测确认丢失），
//   现在由脚本生成、随环境重建可复现。
const ENV_VERSION: string = '20260913-120';
const VERSION_FILE: string = '.dshm-version';

// 品牌迁移（2026-09-11）：配置编辑器 bundle 由 `hdsh-config-editor` 更名为
// `dshm-config-editor`。**这里保留旧名常量是有意的** —— 用户 profile 位于
// <filesDir>/home/.dsh/profiles/*（用户数据，install -r 不重置），存量安装里仍写着旧名，
// 而 dsh-app-boot 启动时会按 `dsh.profile.bundles` 逐项解析 bundle 目录，
// 解析不到就 throw → node 直接 abort（实测 SIGNAL 6）。故必须做一次性幂等迁移。
const CONFIG_EDITOR_BUNDLE: string = 'dshm-config-editor';
const LEGACY_CONFIG_EDITOR_BUNDLE: string = 'hdsh-config-editor';

// 壳侧给 dshmarket 打的「同进程 pnpm 桥接」标记（scripts/patch-market-pnpm-bridge.mjs）。
// 用来判断某份 dshmarket 副本是否已带桥接：pnpm 从 npm 装出来的副本不含它。
const PNPM_BRIDGE_MARKER: string = '同进程 pnpm 桥接';

// profile patch 层（<DSH_HOME>/profiles/<name>/cordis.patch.yml）的规范空内容。
// dsh-app-boot 的 parsePatchList 要求该文件是**顶层 YAML 数组**；只有注释会被解析成
// null 并直接 throw（宿主 dsh abort，2026-09-13 实测）。内容与 dsh 官方 web 模板等价。
const EMPTY_PROFILE_PATCH: string =
  '# DSHM 壳侧 profile patch 层（由 App 生成）：必须是顶层 YAML 数组。\n' +
  '# 默认留空；需要覆盖/禁用/插入 loader 条目时在此按数组项追加。\n' +
  '[]\n';

// busybox：随 HAP 分发（rawfile/busybox/busybox），解压到 filesDir/busybox
// 注意：可执行权限（0755）由 libdsh_host（C++）在 node 启动前 chmod，
// 因为 @ohos.file.fs 未提供 chmod 类 API（chmodSync 仅存在于旧 @ohos.fileio）。
const BUSYBOX_RAWFILE: string = 'busybox/busybox';
const BUSYBOX_SUBDIR: string = 'busybox';

// pnpm：M1 已移除独立 standalone（rawfile/pnpm 占 138MB）。dsh 的 plugin
// 前向器在同 node 进程内以 worker 执行 node_modules/pnpm/dist/pnpm.cjs
//（见 dsh/lib/plugin-*.js），不再需要外部 pnpm 二进制；PNPM_* 保留为常量
// 说明，无文件处理逻辑。
const PNPM_SUBDIR: string = 'pnpm';

/** 需要建立的 busybox applet（复制 busybox 本体，按 argv[0] 分发）。
 *  鸿蒙沙箱禁止 symlink/hardlink（官方文档证实三方应用不可用），
 *  故采用复制本体到每个 applet 名；可执行权限由 libdsh_host（C++）chmod 补齐。
 *
 *  M2 评估（2026-09-09 真机）：/system/bin 实测 405 项，toybox 已提供
 *  ls/cat/grep/sed/awk/tar/gzip/… 之绝大多数；busybox 86 项 applet 中仅
 *  以下 10 项系统缺失（其余 76 项由系统覆盖，不应重复复制占 el2 空间）。
 *  命令行工具走 /system/bin 语义（toybox），此处只兜底系统没有的：
 *  ash/bash/hush —— 常见 shell 脚本解释器；bzip2/xz —— 压缩格式；
 *  hexdump — 十六进制查看；less —— 分页器；nc —— netcat；
 *  unzip —— ZIP 解压（系统无 unzip，dsh 插件安装依赖它）；vi —— 编辑器。
 */
const BUSYBOX_APPLETS: string[] = [
  'ash', 'bash', 'hush',
  'bzip2', 'xz', 'hexdump', 'less', 'nc', 'unzip', 'vi'
];

/** 运行模式信息（native 侧实际采用值，供「关于版本」展示）。 */
export interface RuntimeModeInfo {
  mode: string;      // 'host' | 'embedded'
  dshPath: string;   // 宿主模式下 brew 的 dsh 路径
  version: string;   // 宿主模式下 brew Cellar 里的 dsh 版本
  nodeVersion: string; // 宿主模式下 brew node 的版本
  home: string;      // 宿主模式下的 HOME
  dshHome: string;   // 当前模式生效的会话库（DSH_HOME，两模式分离）
}

/**
 * 结构化启动状态（阶段0 A1）：由 _fetch-shim.cjs 在 dsh 打印就绪 URL 时
 * 原子写入 <filesDir>/boot-state.json。ArkTS 优先读它，读不到再回退日志刮削。
 */
export interface DshBootState {
  mode: string;      // 'embedded'
  pid: number;       // 写入该文件的 node 进程（活性校验用）
  url: string;       // 带 token 的完整 web URL
  dshVersion: string;
  nodeVersion: string;
  arch: string;
  readyAt: string;   // ISO 时间
}

export class DshBootstrap {
  /**
   * 确保 DSH 运行环境在沙箱中就绪，返回 DSH 目录绝对路径。
   * 版本匹配（存在 .dshm-version 且等于 ENV_VERSION）则跳过复制；
   * 版本不一致时递归清理旧目录后重新解压（会话/工作区存于 filesDir/home，不受影响）。
   */
  static async ensureDshDir(context: common.UIAbilityContext): Promise<string> {
    const dshDir: string = context.filesDir + '/' + DSH_SUBDIR;
    const versionPath: string = dshDir + '/' + VERSION_FILE;
    // 跨进程保护：应用存在多个进程（UI 进程 + 托盘保活进程），窗口重建时
    // 也可能再起一次 boot。若另一进程正在解压，只能等待——一旦这边走
    // resetDir，就会把它正在写的环境删成半成品（实测：2506 个目录只剩 26 个
    // 文件，版本文件却已落盘，node 预加载 _fetch-shim.cjs 失败直接 abort）。
    if (!DshBootstrap.isEnvVersionOk(versionPath, true) && DshBootstrap.isExtractInProgress(dshDir)) {
      DshmLogger.warn(TAG, '另一进程正在解压 DSH 环境，等待其完成');
      if (await DshBootstrap.waitEnvReady(versionPath, DshBootstrap.EXTRACT_WAIT_MS)) {
        DshmLogger.info(TAG, '另一进程解压完成，直接复用');
        return dshDir;
      }
      DshmLogger.warn(TAG, '等待另一进程解压超时，本进程接管重建');
    }
    // 并发保护：窗口重建/重复启动可能让 boot() 跑两次；若两次都走
    // “版本不符 → resetDir → 解压”，后一次的 resetDir 会把前一次正在写的
    // 环境删成半成品（实测：517 个空目录 + 26 个文件，版本文件却已写入 →
    // node 预加载 _fetch-shim.cjs 失败直接 abort，界面表现为白屏）。
    if (DshBootstrap.extracting !== null) {
      DshmLogger.warn(TAG, 'DSH 环境解压已在进行中，复用同一次结果');
      return DshBootstrap.extracting;
    }
    const task: Promise<string> = DshBootstrap.ensureDshDirOnce(context);
    DshBootstrap.extracting = task;
    try {
      return await task;
    } finally {
      DshBootstrap.extracting = null;
    }
  }

  /** 正在进行的解压任务（并发 boot() 复用），完成后置空。 */
  private static extracting: Promise<string> | null = null;

  private static readonly EXTRACT_LOCK_FILE: string = '.dshm-extract.lock';
  private static readonly EXTRACT_WAIT_MS: number = 5 * 60 * 1000;

  /** 进程存活判定：/proc/<pid> 存在即活（写锁者与判定者同在沙箱内，相互可见）。 */
  private static pidAlive(pid: number): boolean {
    if (pid <= 0) {
      return false;
    }
    try {
      return fileIo.accessSync('/proc/' + pid);
    } catch (e) {
      return false;
    }
  }

  /**
   * 落一条「正在解压」锁文件，供同机其他进程判断，避免并发 reset 互删。
   * 内容 = "<pid> <unix秒>"：残留锁用「写锁进程是否还活着」秒级判定
   * （借鉴上游 Desktop project-manager.withLock 的 PID 探活），取代旧的
   * 时间戳 600s 过期 + 最长 5 分钟等待。
   */
  private static markExtractInProgress(dshDir: string): void {
    try {
      if (!fileIo.accessSync(dshDir)) {
        DshBootstrap.mkdirRecursive(dshDir);
      }
      const f = fileIo.openSync(dshDir + '/' + DshBootstrap.EXTRACT_LOCK_FILE,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      fileIo.writeSync(f.fd, String(process.pid) + ' ' + String(Math.floor(Date.now() / 1000)) + '\n');
      fileIo.closeSync(f);
    } catch (e) {
      DshmLogger.warn(TAG, '写解压锁失败: ' + String(e));
    }
  }

  private static clearExtractInProgress(dshDir: string): void {
    try {
      const p: string = dshDir + '/' + DshBootstrap.EXTRACT_LOCK_FILE;
      if (fileIo.accessSync(p)) {
        fileIo.unlinkSync(p);
      }
    } catch (e) {
      DshmLogger.warn(TAG, '清理解压锁失败: ' + String(e));
    }
  }

  /**
   * 是否存在「正在解压」的活锁：
   * 新格式（"<pid> <unix秒>"）→ 写锁进程仍存活即视为持锁（秒级判定，
   * 不再有 600s 过期猜测）；解析失败或 PID 已死 → 视为残留锁。
   * 旧格式（纯时间戳，升级前的存量安装可能留下）→ 按 600s 过期兜底判定。
   */
  private static isExtractInProgress(dshDir: string): boolean {
    const p: string = dshDir + '/' + DshBootstrap.EXTRACT_LOCK_FILE;
    try {
      if (!fileIo.accessSync(p)) {
        return false;
      }
      const content: string = fileIo.readTextSync(p).trim();
      const spaceAt: number = content.indexOf(' ');
      if (spaceAt > 0) {
        const pid: number = Number(content.substring(0, spaceAt));
        return DshBootstrap.pidAlive(pid);
      }
      const ageSec: number = Date.now() / 1000 - Number(content);
      return ageSec < 600;
    } catch (e) {
      return false;
    }
  }

  /** 等待另一进程解压完成（版本号 + 哨兵同时就绪）。 */
  private static async waitEnvReady(versionPath: string, timeoutMs: number): Promise<boolean> {
    const deadline: number = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise<void>((resolve: () => void) => {
        setTimeout(resolve, 1000);
      });
      if (DshBootstrap.isEnvVersionOk(versionPath, true)) {
        return true;
      }
    }
    return false;
  }

  // 解压诊断计数（一次性排查用；成功路径不受影响）。
  private static diagDirs: number = 0;
  private static diagFiles: number = 0;
  private static diagListThrew: number = 0;
  private static diagListEmpty: number = 0;
  private static diagContentFailed: number = 0;
  private static diagWriteFailed: number = 0;
  private static diagSamples: string[] = [];

  private static diagNote(sample: string): void {
    if (DshBootstrap.diagSamples.length < 12) {
      DshBootstrap.diagSamples.push(sample);
    }
  }

  private static writeExtractDiag(dir: string, note: string): void {
    const lines: string[] = [];
    lines.push('note=' + note);
    lines.push('dirs=' + DshBootstrap.diagDirs);
    lines.push('files=' + DshBootstrap.diagFiles);
    lines.push('listThrew=' + DshBootstrap.diagListThrew);
    lines.push('listEmpty=' + DshBootstrap.diagListEmpty);
    lines.push('contentFailed=' + DshBootstrap.diagContentFailed);
    lines.push('writeFailed=' + DshBootstrap.diagWriteFailed);
    for (let i = 0; i < DshBootstrap.diagSamples.length; i++) {
      lines.push('sample[' + i + ']=' + DshBootstrap.diagSamples[i]);
    }
    try {
      const f = fileIo.openSync(dir + '/dsh-extract-diag.txt',
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      fileIo.writeSync(f.fd, lines.join('\n') + '\n');
      fileIo.closeSync(f);
    } catch (e) {
      DshmLogger.warn(TAG, '写解压诊断失败: ' + String(e));
    }
  }

  private static async ensureDshDirOnce(context: common.UIAbilityContext): Promise<string> {
    const dshDir: string = context.filesDir + '/' + DSH_SUBDIR;
    const versionPath: string = dshDir + '/' + VERSION_FILE;
    if (DshBootstrap.isEnvVersionOk(versionPath, true)) {
      DshmLogger.info(TAG, 'DSH 环境已就绪 (v' + ENV_VERSION + '): ' + dshDir);
      return dshDir;
    }
    DshmLogger.info(TAG, 'DSH 环境版本变化或首次启动，解压到 ' + dshDir);
    DshBootstrap.markExtractInProgress(dshDir);
    DshBootstrap.resetDir(dshDir);
    // resetDir 会连锁文件一起删除，重建目录后立刻补回。
    DshBootstrap.markExtractInProgress(dshDir);
    const resMgr: resourceManager.ResourceManager = context.resourceManager;
    // M0 实测发现：冷启动偶发出现 rawfile 递归复制提前结束（目录在、哨兵文件缺失），
    // 版本标记却已写入 → node 启动即 MODULE_NOT_FOUND。此处复制后做哨兵完整性校验，
    // 不达标准则重试一次；仍失败则抛错（不放行坏环境）。
    let copied: boolean = false;
    for (let attempt: number = 1; attempt <= 2 && !copied; attempt++) {
      DshBootstrap.diagDirs = 0;
      DshBootstrap.diagFiles = 0;
      DshBootstrap.diagListThrew = 0;
      DshBootstrap.diagListEmpty = 0;
      DshBootstrap.diagContentFailed = 0;
      DshBootstrap.diagWriteFailed = 0;
      DshBootstrap.diagSamples = [];
      let copyError: string = '';
      try {
        DshBootstrap.copyRawfileRecursive(resMgr, RAWFILE_ROOT, dshDir);
      } catch (e) {
        copyError = String(e);
        DshmLogger.error(TAG, '解压抛出异常: ' + copyError);
      }
      const sentinelOk: boolean = DshBootstrap.verifyDshSentinel(dshDir);
      DshBootstrap.writeExtractDiag(context.filesDir,
        'attempt=' + attempt + ' copyError=' + copyError + ' sentinel=' + sentinelOk);
      if (sentinelOk) {
        copied = true;
        DshmLogger.info(TAG, 'DSH 环境解压完成 (attempt ' + attempt + ')');
      } else if (attempt === 1) {
        DshmLogger.warn(TAG, 'DSH 解压不完整，清空重试');
        DshBootstrap.resetDir(dshDir);
        DshBootstrap.markExtractInProgress(dshDir);
      }
    }
    if (!copied) {
      DshBootstrap.clearExtractInProgress(dshDir);
      throw new Error('DSH 环境解压不完整（哨兵校验失败），请重试或重新安装');
    }
    DshBootstrap.writeEnvVersion(versionPath);
    DshBootstrap.clearExtractInProgress(dshDir);
    // 版本变化后清除 profiles fallback 缓存：dsh 运行时从
    // home/.dsh/profiles/node_modules 解析依赖副本（heal 对已存在目录不更新），
    // 不清除则 host-apiproxy 等新端点/新插件不会生效。
    DshBootstrap.clearProfilesFallback(context);
    DshmLogger.info(TAG, 'DSH 环境解压完成');
    return dshDir;
  }

  /**
   * 确保 busybox 就绪并建立 applet 软链，返回 busybox 目录绝对路径。
   * 版本匹配则跳过复制（applet 幂等补齐）；版本变化时递归清理后重新解压。
   */
  static async ensureBusybox(context: common.UIAbilityContext): Promise<string> {
    const busyboxDir: string = context.filesDir + '/' + BUSYBOX_SUBDIR;
    const busyboxPath: string = busyboxDir + '/busybox';
    const versionPath: string = busyboxDir + '/' + VERSION_FILE;
    if (DshBootstrap.isEnvVersionOk(versionPath, false)) {
      DshBootstrap.installBusyboxApplets(busyboxDir, busyboxPath);
      DshmLogger.info(TAG, 'busybox 已就绪: ' + busyboxPath);
      return busyboxDir;
    }
    DshmLogger.info(TAG, 'busybox 版本变化或首次启动，解压到 ' + busyboxDir);
    DshBootstrap.resetDir(busyboxDir);
    const resMgr: resourceManager.ResourceManager = context.resourceManager;
    const data: Uint8Array = resMgr.getRawFileContentSync(BUSYBOX_RAWFILE);
    const file = fileIo.openSync(busyboxPath,
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    fileIo.writeSync(file.fd, data.buffer as ArrayBuffer);
    fileIo.closeSync(file);
    // 可执行权限由 libdsh_host（C++）在 node 启动前 chmod（@ohos.file.fs 无 chmod API）
    DshBootstrap.installBusyboxApplets(busyboxDir, busyboxPath);
    DshBootstrap.writeEnvVersion(versionPath);
    DshmLogger.info(TAG, 'busybox 解压完成，applet 软链就绪');
    return busyboxDir;
  }

  /**
   * 确保 pnpm 可用（M1：no-op）。
   * dsh plugin 前向器为同 node 进程内 worker 执行 node_modules/pnpm/dist/pnpm.cjs，
   * 沙箱内 node（libnode）随 DSH 环境进入，无需再分发独立 pnpm 二进制。
   * 保留此方法仅为保持 boot() 调用点与 t3 打点结构不变。
   */
  static async ensurePnpm(context: common.UIAbilityContext): Promise<string> {
    return PNPM_SUBDIR;
  }

  /**
   * 确保鸿蒙专属技能就绪：把 rawfile/ohos-skills 下的 skill 文件覆盖复制到
   * <filesDir>/home/.dsh/skills（dsh 的用户技能根），使模型能直接读取
   * 鸿蒙设备实况/工具缺失导览/工作区语义（ohos-pc、ohos-shell、ohos-workspace）。
   * 每次启动整目录覆盖，文件小（KB 级），失败不阻断 DSH 启动。
   */
  static async ensureOhosSkills(context: common.UIAbilityContext): Promise<void> {
    try {
      const homeDir: string = context.filesDir + '/home';
      DshBootstrap.mkdirRecursive(homeDir);
      const dshHome: string = homeDir + '/.dsh';
      DshBootstrap.mkdirRecursive(dshHome);
      const skillsDir: string = dshHome + '/skills';
      DshBootstrap.mkdirRecursive(skillsDir);
      DshBootstrap.copyRawfileRecursive(context.resourceManager, OHOS_SKILLS_RAWFILE, skillsDir);
      DshmLogger.info(TAG, '鸿蒙专属技能已就绪: ' + skillsDir);
    } catch (e) {
      DshmLogger.warn(TAG, '安装鸿蒙专属技能失败（跳过）: ' + String(e));
    }
  }

  /**
   * 准备内嵌 node_shim 可执行环境（embedded 模式）。
   *
   * 1. 确保 <envRoot>/node/bin/node 可执行（CMake 编译的 node_shim，通过
   *    POST_BUILD 复制到 rawfile，解压后为 0644，需要 chmod +x）。
   * 2. 写入 <envRoot>/node_flags.txt（C++ shim 读此文件追加 argv），
   *    反映当前的 JIT 策略（probe 结果或默认 --jitless --expose-internals）。
   * 3. 生成 pnpm wrapper 到 <filesDir>/bin/pnpm，指向 node_shim，
   *    供 dsh plugin install、pnpm add 等子进程 spawn 使用。
   *
   * 本方法只在 embedded 模式下调用（由 DshmWebPage.boot 在 ensurePnpmWrapper
   * 前根据 active mode 决定）。
   */
  static prepareNodeShim(context: common.UIAbilityContext): void {
    const dshDir: string = context.filesDir + '/dsh';
    const nodeBin: string = dshDir + '/node/bin/node';
    try {
      // 1. 确保 node_shim 可执行（rawfile 解压默认为 0644，prepare-dsh-env.sh
      //    会做 chmod +x；此处若失败则 pnpm 将不可用，但不应阻止启动）
      if (!fileIo.accessSync(nodeBin)) {
        DshmLogger.warn(TAG, 'node_shim 不存在: ' + nodeBin + '（pnpm 子进程不可用）');
      }

      // 2. 写 node_flags.txt（C++ shim 读此文件追加 argv）
      //    内嵌模式必定需要 --jitless --expose-internals
      const flagsPath: string = dshDir + '/node_flags.txt';
      const flags: string = '--jitless\n--expose-internals\n';
      try {
        const f = fileIo.openSync(flagsPath,
          fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
        fileIo.writeSync(f.fd, flags);
        fileIo.closeSync(f);
        DshmLogger.info(TAG, 'node_flags.txt 已写入');
      } catch (e) {
        DshmLogger.warn(TAG, '写 node_flags.txt 失败: ' + String(e));
      }

      // 3. 生成 pnpm wrapper 指向 node_shim
      const pnpmCjs: string = dshDir + '/node_modules/pnpm/bin/pnpm.cjs';
      if (!fileIo.accessSync(pnpmCjs)) {
        DshmLogger.warn(TAG, 'pnpm.cjs 不存在，跳过 pnpm wrapper');
        return;
      }
      const binDir: string = context.filesDir + '/bin';
      DshBootstrap.mkdirRecursive(binDir);
      const wrapper: string = binDir + '/pnpm';
      // node_shim 由 nativespawn 启动（CMake PIE ELF，系统可 exec）
      const content: string = '#!/system/bin/sh\nexec /system/bin/nativespawn '
        + nodeBin + ' ' + pnpmCjs + ' "$@"\n';
      try {
        const file = fileIo.openSync(wrapper,
          fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
        fileIo.writeSync(file.fd, content);
        fileIo.closeSync(file);
        DshmLogger.info(TAG, 'pnpm wrapper 已生成（embedded node_shim）: ' + wrapper);
      } catch (e) {
        DshmLogger.warn(TAG, '写 pnpm wrapper 失败: ' + String(e));
      }
    } catch (e) {
      DshmLogger.warn(TAG, 'prepareNodeShim 异常: ' + String(e));
    }
  }

  /**
   * 生成 pnpm wrapper 到 <filesDir>/bin/pnpm（宿主模式用）。
   *
   * embedded 沙箱内没有独立 node 可执行文件，但 Harmonybrew 的 node
   * （/storage/Users/currentUser/.harmonybrew/bin/node，v26.8.1）在沙箱内
   * 可 exec（2026-09-11 实测）。生成 wrapper 把 pnpm.cjs 桥接到该 node。
   * Harmonybrew 不存在时跳过（pty/bash 仍可用系统命令）。
   *
   * 注意：嵌入式模式不再走此函数（用 prepareNodeShim 替代）。
   */
  static ensurePnpmWrapper(context: common.UIAbilityContext): void {
    try {
      const brewNode: string = '/storage/Users/currentUser/.harmonybrew/bin/node';
      if (!fileIo.accessSync(brewNode)) {
        DshmLogger.info(TAG, 'Harmonybrew node 不存在，跳过 pnpm wrapper');
        return;
      }
      const pnpmCjs: string = context.filesDir + '/dsh/node_modules/pnpm/bin/pnpm.cjs';
      if (!fileIo.accessSync(pnpmCjs)) {
        DshmLogger.warn(TAG, 'pnpm.cjs 不存在，跳过 pnpm wrapper');
        return;
      }
      const binDir: string = context.filesDir + '/bin';
      DshBootstrap.mkdirRecursive(binDir);
      const wrapper: string = binDir + '/pnpm';
      const content: string = '#!/system/bin/sh\nexec ' + brewNode
        + ' ' + pnpmCjs + ' "$@"\n';
      const file = fileIo.openSync(wrapper,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      fileIo.writeSync(file.fd, content);
      fileIo.closeSync(file);
      DshmLogger.info(TAG, 'pnpm wrapper 已生成: ' + wrapper);
    } catch (e) {
      DshmLogger.warn(TAG, 'pnpm wrapper 生成失败（跳过）: ' + String(e));
    }
  }

  /**
   * 把壳侧自研插件（`dshm-terminal` / `dshm-ohos-settings` / `dshm-config-editor`）
   * 接入**宿主模式**（Harmonybrew dsh）的 web profile。
   *
   * 背景（2026-09-12 实测）：宿主模式的 dsh 是 brew 安装的独立发行版，只带官方
   * 插件，**不含**壳侧的 `dshm-terminal`。而 App 的终端面板依赖它暴露的
   * `/dshm-terminal/start|write|read` 端点，缺失时 `POST /dshm-terminal/start`
   * 返回 **405 Method Not Allowed**，UI 显示「会话启动失败」。
   *
   * 接入需要**两步**（缺一不可，均由 `dsh-app-boot` 的 profile 机制决定）：
   *   1. **模块可达**：把插件目录放到 `$DSH_HOME/profiles/node_modules/` 下
   *      —— 满足 Node 的 parent-walk 解析（`$DSH_HOME` = `~/.dsh`，
   *      因宿主模式 `HOME=/storage/Users/currentUser`）。
   *   2. **显式声明**：在 `$DSH_HOME/profiles/web/package.json` 的
   *      `dsh.profile.bundles` 数组里列出插件名。dsh-app-boot 的文档原文：
   *      「Bundles are npm packages whose manifest declares
   *      `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; the tree is
   *      composed by applying each bundle's patch list in `dsh.profile.bundles`
   *      order」—— **只放 node_modules 不写 bundles 列表不会被加载**。
   *
   * 内嵌环境是靠适配脚本直接改 `dsh-app-boot` 的 `PROFILE_TEMPLATES.web.bundles`
   * 源码实现的；宿主模式改不了 brew 的源码，因此改为**写 profile 的
   * package.json**（这正是该字段的设计用途）。
   *
   * 全部失败都静默降级并写诊断文件，不影响 dsh 核心启动。
   */
  static ensureHostModeTerminal(context: common.UIAbilityContext): void {
    const diag: Array<string> = [];
    try {
      const brewDsh: string = '/storage/Users/currentUser/.harmonybrew/bin/dsh';
      if (!fileIo.accessSync(brewDsh)) {
        diag.push('brew dsh 不存在，跳过');
        DshBootstrap.writeHostDiag(context, diag);
        return;
      }
      diag.push('brew dsh 存在');
      const srcRoot: string = context.filesDir + '/dsh/node_modules';
      // 宿主模式的 DSH_HOME 由 native 侧固定为 <filesDir>/home-host/.dsh（与内嵌模式分离）。
      // 壳侧插件镜像必须落在同一个库里，否则 dsh 从 $DSH_HOME/profiles 解析不到它们，
      // 宿主模式会失去终端/设置等壳侧端点。规则与 dsh_host.cpp 的 DshHomeForMode 一致。
      const hostHome: string = DshBootstrap.dshHomeForMode(context, true);
      const hostNM: string = hostHome + '/profiles/node_modules';
      const webProfileDir: string = hostHome + '/profiles/web';
      const webPkg: string = webProfileDir + '/package.json';
      diag.push('hostNM=' + hostNM);

      // ---- 第 1 步：模块可达 ----
      try {
        DshBootstrap.mkdirRecursive(hostNM);
        diag.push('mkdir hostNM OK');
      } catch (e) {
        diag.push('mkdir hostNM 失败: ' + String(e));
      }
      // 宿主模式同样启用内置插件市场：dshmarket 会随下面的循环被镜像进
      // <hostDshHome>/profiles/node_modules，dsh 才能从 profile 里解析到它
      // （brew 侧 dsh 树里没有 dshmarket，只写 bundles 不镜像会解析失败而 abort）。
      const bundles: Array<string> = ['dshm-config-editor', 'dshm-terminal', 'dshm-ohos-settings', 'dshmarket'];
      for (let i = 0; i < bundles.length; i++) {
        const name: string = bundles[i];
        const src: string = srcRoot + '/' + name;
        if (!fileIo.accessSync(src + '/package.json')) {
          diag.push(name + ': 源不存在');
          continue;
        }
        const dst: string = hostNM + '/' + name;
        try {
          if (!DshBootstrap.bundleMirrorCurrent(src, dst)) {
            DshBootstrap.removeDirRecursive(dst);
            DshBootstrap.copyDirRecursive(src, dst);
            diag.push(name + ': 已复制');
          } else {
            diag.push(name + ': 已是最新');
          }
        } catch (e) {
          diag.push(name + ': 复制失败 ' + String(e));
        }
      }

      // ---- 第 2 步：写 web profile 的 bundles 声明（B1 事务式写入）----
      try {
        DshBootstrap.mkdirRecursive(webProfileDir);
        if (DshBootstrap.isWebProfileBroken(webProfileDir)) {
          // 残留标记 / 半截 JSON：先按模板重建（含默认官方 bundle + dshm-*）。
          DshBootstrap.rebuildWebProfile(webProfileDir);
        }
        DshBootstrap.markProfilePending(webProfileDir);
        const merged: string = DshBootstrap.mergeWebProfileBundles(webPkg, bundles);
        const file = fileIo.openSync(webPkg + '.tmp',
          fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
        fileIo.writeSync(file.fd, merged);
        fileIo.closeSync(file);
        fileIo.renameSync(webPkg + '.tmp', webPkg);
        DshBootstrap.clearProfilePending(webProfileDir);
        diag.push('web/package.json 已写入 bundles（事务式）');
      } catch (e) {
        diag.push('写 web/package.json 失败: ' + String(e));
      }

      // ---- 第 3 步：profile 自带 patch 层（dsh-app-boot 会读 cordis.patch.yml）----
      // 内容必须与 dsh 官方模板一致：**顶层 YAML 数组**。只写注释会让 YAML 解析成
      // null，dsh-app-boot 的 parsePatchList 直接抛
      // 「must be a top-level YAML array of loader patch entries」→ 宿主 dsh 启动即退出
      // （2026-09-13 实测：宿主模式 t5.serverReady 永不出现，日志 status=256）。
      try {
        const patchPath: string = webProfileDir + '/cordis.patch.yml';
        // 自愈：不仅缺失时创建，**已存在但不是顶层数组**时也要改写。
        // 旧版本壳侧只写了注释行，设备上存量 profile 里就有这种坏文件，
        // 光靠「缺失才写」永远修不好（宿主模式会一直 abort）。
        if (!DshBootstrap.profilePatchLooksValid(patchPath)) {
          const f2 = fileIo.openSync(patchPath,
            fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
          fileIo.writeSync(f2.fd, EMPTY_PROFILE_PATCH);
          fileIo.closeSync(f2);
          diag.push('web/cordis.patch.yml 已写入/修复');
        }
      } catch (e) {
        diag.push('创建 profile patch 失败: ' + String(e));
      }

      diag.push('完成');
      DshmLogger.info(TAG, '宿主插件接入完成');
    } catch (e) {
      diag.push('整体异常: ' + String(e));
      DshmLogger.warn(TAG, '宿主插件接入失败（跳过）: ' + String(e));
    }
    DshBootstrap.writeHostDiag(context, diag);
  }

  /**
   * 判断 profile 的 `cordis.patch.yml` 是否为「顶层 YAML 数组」形态。
   *
   * 只做壳侧能可靠判定的最小检查：跳过注释行与空行后，首个有效字符必须是 `[`。
   * 不引入 YAML 依赖，也不把其它合法写法误判成坏文件 —— 凡以 `[` 开头者一律放行，
   * 交给 dsh 自己解析。
   */
  private static profilePatchLooksValid(path: string): boolean {
    try {
      if (!fileIo.accessSync(path)) {
        return false;
      }
      const lines: string[] = fileIo.readTextSync(path).split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line: string = lines[i].trim();
        if (line.length === 0 || line.startsWith('#')) {
          continue;
        }
        return line.startsWith('[');
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  /**
   * 生成/合并 web profile 的 `package.json`，把壳侧 bundle 并入
   * `dsh.profile.bundles`（保留官方 bundle 与其顺序，追加缺失项，去重）。
   *
   * 已存在时读取原文件并只改 bundles 数组，避免覆盖 dsh 自己写入的字段
   * （如 `dependencies`、`dsh.profile.patchReload`）。
   *
   * 阶段0 B1（借鉴上游 DesktopProjectManager 的 fail-forward 事务标记）：
   * 写入前落 `.dshm-profile-pending` 标记，写成功后清除。若写入中途崩溃
   * （半截 JSON → dsh-app-boot 解析失败直接 SIGNAL 6，2026-09-11 实测过的
   * 崩溃类），下次启动 detectBrokenWebProfile 会看到残留标记，按模板重建。
   * 原子性兜底：先写 .tmp 再 rename（沙箱 rename 同目录原子）。
   */
  private static mergeWebProfileBundles(webPkg: string, extra: Array<string>): string {
    // dsh 官方 web profile 的默认 bundle（见 dsh-app-boot 的 PROFILE_TEMPLATES）。
    let existing: Array<string> = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
    let patchReload: string = 'live';
    // 解析成功时保留原始对象：只改 dsh.profile.bundles，其余字段（尤其
    // dependencies —— dshmarket 等 profile 托管插件的依赖声明就写在这里）
    // 必须原样保留。早期实现会重建整个 JSON，一旦覆写就会把 dependencies 抹掉，
    // 导致已启用插件解析失败、dsh 启动即 abort（2026-09-13 修正）。
    let original: Record<string, Object> | null = null;
    if (fileIo.accessSync(webPkg)) {
      try {
        const meta: Record<string, Object> =
          JSON.parse(fileIo.readTextSync(webPkg)) as Record<string, Object>;
        original = meta;
        const dshNode: Object | undefined = meta['dsh'] as Object | undefined;
        if (dshNode !== undefined) {
          const profile: Object | undefined = (dshNode as Record<string, Object>)['profile'] as Object | undefined;
          if (profile !== undefined) {
            const prof: Record<string, Object> = profile as Record<string, Object>;
            const list: Object | undefined = prof['bundles'] as Object | undefined;
            if (list !== undefined) {
              existing = list as Array<string>;
            }
            const pr: Object | undefined = prof['patchReload'] as Object | undefined;
            if (pr !== undefined) {
              patchReload = pr as string;
            }
          }
        }
      } catch (e) {
        // 解析失败时用默认模板重建，保证可用性。
        original = null;
      }
    }
    const merged: Array<string> = [];
    for (let i = 0; i < existing.length; i++) {
      merged.push(existing[i]);
    }
    for (let i = 0; i < extra.length; i++) {
      if (merged.indexOf(extra[i]) < 0) {
        merged.push(extra[i]);
      }
    }
    if (original !== null) {
      // 保留原对象其余字段，只替换 bundles。
      // 注：ArkTS 禁止无类型对象字面量，空对象一律用 JSON.parse('{}') 构造。
      const dshValue: Object | undefined = original['dsh'] as Object | undefined;
      const dshNode: Object = dshValue !== undefined ? dshValue : (JSON.parse('{}') as Object);
      const profValue: Object | undefined = (dshNode as Record<string, Object>)['profile'] as Object | undefined;
      const prof: Record<string, Object> = profValue !== undefined
        ? (profValue as Record<string, Object>)
        : (JSON.parse('{}') as Record<string, Object>);
      prof['bundles'] = merged;
      if (prof['patchReload'] === undefined) {
        prof['patchReload'] = patchReload;
      }
      (dshNode as Record<string, Object>)['profile'] = prof;
      original['dsh'] = dshNode;
      return JSON.stringify(original, null, 2) + '\n';
    }
    // 无原文件/解析失败：按官方模板重建（bundles 列表单行化，保持可读）。
    const lines: Array<string> = [];
    for (let i = 0; i < merged.length; i++) {
      lines.push('    "' + merged[i] + '"');
    }
    return '{\n'
      + '  "name": "dsh-profile-web",\n'
      + '  "private": true,\n'
      + '  "dsh": {\n'
      + '    "profile": {\n'
      + '      "bundles": [\n' + lines.join(',\n') + '\n      ],\n'
      + '      "patchReload": "' + patchReload + '"\n'
      + '    }\n'
      + '  }\n'
      + '}\n';
  }

  /**
   * 确保内置 dshmarket 出现在两种模式**各自**的 web profile bundles 列表里。
   *
   * 新 profile 由 dsh-app-boot 模板创建（模板已含 dshmarket，见 patch-market-bundle.mjs）；
   * 存量 profile 需要这里补写一次，否则已有用户看不到插件市场。
   * 两种模式的库互不影响（内嵌 <filesDir>/home/.dsh，宿主 <filesDir>/home-host/.dsh）。
   * 幂等：内容未变化不写盘；写入走 pending 标记 + tmp/rename 事务。
   */
  static ensureMarketBundle(context: common.UIAbilityContext): void {
    const marketDir: string = context.filesDir + '/' + DSH_SUBDIR + '/node_modules/dshmarket';
    const marketManifest: string = marketDir + '/package.json';
    if (!fileIo.accessSync(marketManifest)) {
      DshmLogger.info(TAG, '未内置 dshmarket，跳过 web bundle 注入');
      return;
    }
    const profileDirs: Array<string> = [
      DshBootstrap.dshHomeForMode(context, false) + '/profiles/web',
      DshBootstrap.dshHomeForMode(context, true) + '/profiles/web'
    ];
    for (let i = 0; i < profileDirs.length; i++) {
      const dir: string = profileDirs[i];
      const pkg: string = dir + '/package.json';
      if (!fileIo.accessSync(pkg)) {
        // 该模式尚未初始化 profile：交给 dsh-app-boot 用模板创建（已含 dshmarket）。
        continue;
      }
      try {
        // 先清除 pnpm 装出来的「遮蔽副本」（2026-09-13 实测的 pnpm:false 根因）。
        // profile 的 dependencies 里声明了 dshmarket，pnpm 会把它从 npm 装成
        // profiles/web/node_modules/dshmarket —— 那是**未打补丁**的上游包，而 Node
        // 解析优先近层，dsh 实际加载的就是它，壳侧的「同进程 pnpm 桥接」永远不生效
        // （/dsh-market/status 恒为 pnpm:false，市场能打开但装不了插件）。
        // 删掉它，解析回落到壳侧镜像的 profiles/node_modules/dshmarket（已打补丁）；
        // pnpm 下次安装会重建，本步骤每次启动重清一次，幂等。
        DshBootstrap.dropShadowMarketCopy(dir + '/node_modules/dshmarket', marketDir);
        let merged: string = DshBootstrap.mergeWebProfileBundles(pkg, ['dshmarket']);
        // 除 bundles 外还要声明依赖：dsh 依据 profile 的 dependencies 托管第三方
        // bundle（dsh-app-boot 的 profile-managed seed 也是这么写的）。缺依赖声明
        // 时市场包可能不被物化到 profiles/node_modules，bundle 会解析失败。
        // 注：ArkTS 禁止无类型对象字面量，空对象用 JSON.parse('{}') 构造。
        try {
          const marketMeta: Record<string, Object> =
            JSON.parse(fileIo.readTextSync(marketManifest)) as Record<string, Object>;
          const marketVersion: Object = marketMeta['version'] as Object;
          const meta: Record<string, Object> = JSON.parse(merged) as Record<string, Object>;
          const depsValue: Object | undefined = meta['dependencies'] as Object | undefined;
          const deps: Record<string, Object> = depsValue !== undefined
            ? (depsValue as Record<string, Object>)
            : (JSON.parse('{}') as Record<string, Object>);
          if (deps['dshmarket'] !== marketVersion) {
            deps['dshmarket'] = marketVersion;
            meta['dependencies'] = deps;
            merged = JSON.stringify(meta, null, 2) + '\n';
          }
        } catch (e) {
          DshmLogger.warn(TAG, '写 dshmarket 依赖声明失败（' + dir + '）: ' + String(e));
        }
        const current: string = fileIo.readTextSync(pkg);
        if (current === merged) {
          continue;
        }
        DshBootstrap.markProfilePending(dir);
        const file = fileIo.openSync(pkg + '.tmp',
          fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
        fileIo.writeSync(file.fd, merged);
        fileIo.closeSync(file);
        fileIo.renameSync(pkg + '.tmp', pkg);
        DshBootstrap.clearProfilePending(dir);
        DshmLogger.info(TAG, 'web profile 已补入 dshmarket bundle: ' + dir);
      } catch (e) {
        DshBootstrap.clearProfilePending(dir);
        DshmLogger.warn(TAG, '补写 dshmarket bundle 失败（' + dir + '）: ' + String(e));
      }
    }
  }

  /**
   * 解除 pnpm 装出来的 dshmarket「遮蔽」（生效副本不含桥接补丁时才处理）。
   *
   * 实测形态（2026-09-13）：
   *   profiles/web/node_modules/dshmarket ->
   *     .pnpm/dshmarket@1.45.1_.../node_modules/dshmarket          （未打补丁的 npm 副本）
   * 或者 pnpm 直接在 web/node_modules 下放的真实目录。Node 解析优先近层，于是 dsh 加载的
   * 是它，壳侧的「同进程 pnpm 桥接」永不生效（/dsh-market/status 恒为 pnpm:false）。
   *
   * 处理顺序：
   *   1. 符号链接 → 只删链接（`.pnpm` 里的真实副本留着），解析回落到已打补丁的
   *      profiles/node_modules/dshmarket；
   *   2. 真实目录 → **连目录一起删**（只清内容会留下空目录，Node 仍会把它当 dshmarket
   *      解析，bundle 加载直接 ERR_MODULE_NOT_FOUND —— 实测内嵌模式启动失败）；
   *   3. 删不掉（权限/占用）→ 退化为用已打补丁的副本覆盖，至少保证是完整包。
   */
  private static dropShadowMarketCopy(path: string, srcPkgDir: string): void {
    try {
      if (!fileIo.accessSync(path)) {
        return;
      }
      // 先看**生效内容**（readTextSync 会跟随符号链接）：已带桥接就什么都不做。
      const cli: string = path + '/lib/dsh-cli.js';
      if (fileIo.accessSync(cli)) {
        if (fileIo.readTextSync(cli).indexOf(PNPM_BRIDGE_MARKER) >= 0) {
          return;
        }
      }
      if (fileIo.lstatSync(path).isSymbolicLink()) {
        fileIo.unlinkSync(path);
        DshmLogger.info(TAG, '已解除 pnpm 遮蔽链接（未打补丁的 dshmarket）: ' + path);
        return;
      }
      DshBootstrap.removeDirRecursive(path);
      if (fileIo.accessSync(path)) {
        try {
          fileIo.rmdirSync(path);
        } catch (e) {
          DshmLogger.warn(TAG, '删除遮蔽目录失败（' + path + '）: ' + String(e));
        }
      }
      if (!fileIo.accessSync(path)) {
        DshmLogger.info(TAG, '已清除 pnpm 遮蔽副本（未打补丁的 dshmarket）: ' + path);
        return;
      }
      DshBootstrap.copyDirRecursive(srcPkgDir, path);
      DshmLogger.info(TAG, '遮蔽副本删不掉，已用打补丁副本覆盖: ' + path);
    } catch (e) {
      DshmLogger.warn(TAG, '解除 dshmarket 遮蔽失败（' + path + '）: ' + String(e));
    }
  }

  /** B1：web profile 写入事务标记（写入前落，成功后清；残留=上次写入中断）。 */
  private static markProfilePending(webProfileDir: string): void {
    try {
      if (!fileIo.accessSync(webProfileDir)) {
        DshBootstrap.mkdirRecursive(webProfileDir);
      }
      const f = fileIo.openSync(webProfileDir + '/.dshm-profile-pending',
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      fileIo.writeSync(f.fd, String(process.pid) + '\n');
      fileIo.closeSync(f);
    } catch (e) {
      DshmLogger.warn(TAG, '写 profile pending 标记失败: ' + String(e));
    }
  }

  private static clearProfilePending(webProfileDir: string): void {
    try {
      const p: string = webProfileDir + '/.dshm-profile-pending';
      if (fileIo.accessSync(p)) {
        fileIo.unlinkSync(p);
      }
    } catch (e) {
      /* 清理失败不影响主流程 */
    }
  }

  /**
   * B1 自愈入口：web profile 是否处于「写入中断」状态。
   * 判据 = 残留 pending 标记，或 package.json 存在但 JSON 解析失败。
   * 两者任一成立，调用方按默认模板重建 profile（重解压/重置本来也会重建，
   * 这里只是把「半写状态导致 node 启动即 SIGNAL 6」提前拦截成确定性自愈）。
   */
  static isWebProfileBroken(webProfileDir: string): boolean {
    const pending: string = webProfileDir + '/.dshm-profile-pending';
    const webPkg: string = webProfileDir + '/package.json';
    if (fileIo.accessSync(pending)) {
      return true;
    }
    if (!fileIo.accessSync(webPkg)) {
      return false; // 不存在 = 首启，不算坏
    }
    try {
      JSON.parse(fileIo.readTextSync(webPkg));
      return false;
    } catch (e) {
      DshmLogger.warn(TAG, 'web profile package.json 解析失败（疑似半写），判定为损坏');
      return true;
    }
  }

  /** B1：按默认模板重建 web profile（保留目录内其余 dsh 自管文件）。 */
  static rebuildWebProfile(webProfileDir: string): void {
    try {
      DshBootstrap.markProfilePending(webProfileDir);
      const merged: string = DshBootstrap.mergeWebProfileBundles(
        webProfileDir + '/package.json',
        ['dshm-config-editor', 'dshm-terminal', 'dshm-ohos-settings']);
      const file = fileIo.openSync(webProfileDir + '/package.json.tmp',
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      fileIo.writeSync(file.fd, merged);
      fileIo.closeSync(file);
      fileIo.renameSync(webProfileDir + '/package.json.tmp', webProfileDir + '/package.json');
      DshBootstrap.clearProfilePending(webProfileDir);
      DshmLogger.info(TAG, 'web profile 已按模板重建');
    } catch (e) {
      DshmLogger.warn(TAG, 'web profile 重建失败: ' + String(e));
    }
  }

  /** 把宿主插件安装诊断写到 filesDir/host-plugin-diag.txt（供 hdc 回读排查）。 */
  private static writeHostDiag(context: common.UIAbilityContext, lines: Array<string>): void {
    try {
      const path: string = context.filesDir + '/host-plugin-diag.txt';
      const file = fileIo.openSync(path,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      fileIo.writeSync(file.fd, lines.join('\n') + '\n');
      fileIo.closeSync(file);
    } catch (e) {
      /* 诊断写入失败不影响主流程 */
    }
  }

  /** 逐级创建目录（fileIo.mkdirSync 不递归父目录）。 */
  private static mkdirRecursive(dir: string): void {
    const parent: string = dir.substring(0, dir.lastIndexOf('/'));
    if (parent.length > 0 && parent !== '/' && !fileIo.accessSync(parent)) {
      DshBootstrap.mkdirRecursive(parent);
    }
    if (!fileIo.accessSync(dir)) {
      fileIo.mkdirSync(dir);
    }
  }

  /**
   * 为 busybox 建立 applet（复制 busybox 本体，缺失才创建）。
   * 鸿蒙沙箱禁止 symlink/hardlink，只能复制；可执行权限由 libdsh_host（C++）
   * 在启动前统一 chmod 0755。
   */
  private static installBusyboxApplets(busyboxDir: string, busyboxPath: string): void {
    for (let i = 0; i < BUSYBOX_APPLETS.length; i++) {
      const applet: string = busyboxDir + '/' + BUSYBOX_APPLETS[i];
      if (fileIo.accessSync(applet)) {
        continue;
      }
      try {
        fileIo.copyFileSync(busyboxPath, applet);
      } catch (e) {
        // 单个 applet 复制失败不阻断整体初始化
        DshmLogger.warn(TAG, '创建 applet 失败: ' + applet + ', ' + String(e));
      }
    }
  }

  /**
   * 判断环境版本文件是否与当前 ENV_VERSION 匹配（容忍尾部换行）。
   * 版本号匹配 + arch 绑定匹配（阶段0 B3）+ checkSentinel 为 true 时哨兵抽查
   * 全部通过，才视为就绪。arch 行缺失（旧版本文件）视为匹配——升级首启仍走
   * ENV_VERSION 变更触发重解压，不额外强刷。
   */
  private static isEnvVersionOk(versionPath: string, checkSentinel: boolean): boolean {
    try {
      if (!fileIo.accessSync(versionPath)) {
        return false;
      }
      const content: string = fileIo.readTextSync(versionPath);
      const firstLineEnd: number = content.indexOf('\n');
      const v: string = (firstLineEnd < 0 ? content : content.substring(0, firstLineEnd)).trim();
      if (v !== ENV_VERSION) {
        return false;
      }
      if (firstLineEnd >= 0) {
        const rest: string = content.substring(firstLineEnd + 1);
        const archAt: number = rest.indexOf('arch=');
        if (archAt >= 0) {
          const boundArch: string = rest.substring(archAt + 5).split('\n')[0].trim();
          if (boundArch.length > 0 && boundArch !== DshBootstrap.deviceArch()) {
            DshmLogger.warn(TAG, '环境 arch 不匹配（绑定 ' + boundArch
              + '，当前 ' + DshBootstrap.deviceArch() + '），将重解压');
            return false;
          }
        }
      }
      const dshDir: string = versionPath.substring(0, versionPath.lastIndexOf('/'));
      if (checkSentinel) {
        return DshBootstrap.verifyDshSentinel(dshDir);
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 单个哨兵文件是否「存在且非空」（不抛异常的判定，供可选哨兵复用）。 */
  private static sentinelFileOk(dshDir: string, rel: string): boolean {
    try {
      const s = fileIo.statSync(dshDir + '/' + rel);
      return s.isFile() && s.size > 0;
    } catch (e) {
      return false;
    }
  }

  /**
   * 当前设备 CPU 架构识别（哨兵 arch 行用）。
   * HarmonyOS PC/2in1 为 arm64；x86_64 仅出现在模拟器等特殊镜像上。
   * marketName 不含 "x86" 即按 arm64 处理（默认值，保证未来新机型不误判）。
   */
  static deviceArch(): string {
    try {
      const name: string = deviceInfo.marketName;
      return name.includes('x86') ? 'x86_64' : 'arm64';
    } catch (e) {
      return 'arm64';
    }
  }

  /**
   * 写入环境版本文件：第 1 行 = 环境版本号，第 2 行 = arch 绑定（阶段0 B3）。
   * arch 行用于拒绝「真机/模拟器环境互窜」——x86_64 模拟器上解压过的环境拿到
   * arm64 真机上时，快速失败并重解压，而不是让 node 报一堆难懂的
   * ERR_DLOPEN_FAILED（借鉴上游 desktop-runtime.json 的 platform/arch 绑定断言）。
   */
  private static writeEnvVersion(versionPath: string): void {
    try {
      const file = fileIo.openSync(versionPath,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      fileIo.writeSync(file.fd, ENV_VERSION + '\n' + 'arch=' + DshBootstrap.deviceArch() + '\n');
      fileIo.closeSync(file);
    } catch (e) {
      DshmLogger.warn(TAG, '写入环境版本失败: ' + String(e));
    }
  }

  /** 递归删除目录（rmdirSync 不支持递归，手动遍历删除文件与子目录）。 */
  private static removeDirRecursive(dir: string): void {
    // 入口必须「先 lstat 再决定」：accessSync/listFileSync/statSync 都会**跟随**符号
    // 链接。若入口本身就是链接（典型：profiles/node_modules/@deepseek-ai/* 是指向
    // <filesDir>/dsh/node_modules/** 的 dsh heal 链接），下面的遍历会把**链接目标的
    // 真实内容**逐个删掉，最终只留下一个空目录 + 一条悬空链接。
    // 实测（2026-09-13 10:49）：环境树 @deepseek-ai 下 242 个包被清空，node 预加载
    // _fetch-shim.cjs 直接 MODULE_NOT_FOUND，两种模式都无法启动。
    // 因此：链接一律只删链接本身（unlink），非目录（文件/链接）同理，绝不递归。
    try {
      const entryStat = fileIo.lstatSync(dir);
      if (entryStat.isSymbolicLink() || !entryStat.isDirectory()) {
        fileIo.unlinkSync(dir);
        return;
      }
    } catch (e) {
      // 路径不存在或不可读：没有可清理的内容，静默返回。
      return;
    }
    let entries: Array<string> = [];
    try {
      entries = fileIo.listFileSync(dir);
    } catch (e) {
      DshmLogger.warn(TAG, '列出目录失败，跳过清理: ' + String(e));
      return;
    }
    for (let i = 0; i < entries.length; i++) {
      const child: string = dir + '/' + entries[i];
      try {
        // 必须用 lstatSync：profiles/node_modules 里大量条目是指向
        // <filesDir>/dsh/node_modules/** 的符号链接，statSync 会跟随链接把
        // 链接目标当目录递归删掉，等于把刚解压好的 DSH 环境连根删除
        //（实测：2506 目录 / 12305 文件被删到只剩 26 个文件，随后 node
        // 预加载 _fetch-shim.cjs 失败 abort，界面白屏）。符号链接只删链接本身。
        const stat = fileIo.lstatSync(child);
        if (stat.isSymbolicLink()) {
          fileIo.unlinkSync(child);
        } else if (stat.isDirectory()) {
          DshBootstrap.removeDirRecursive(child);
          fileIo.rmdirSync(child);
        } else {
          fileIo.unlinkSync(child);
        }
      } catch (e) {
        DshmLogger.warn(TAG, '清理 ' + child + ' 失败: ' + String(e));
      }
    }
  }

  /** 重置目录：递归清空内容 → 删除目录本身 → 重新创建（用于版本变化时重建环境）。 */
  private static resetDir(dir: string): void {
    DshBootstrap.removeDirRecursive(dir);
    if (fileIo.accessSync(dir)) {
      try {
        fileIo.rmdirSync(dir);
      } catch (e) {
        DshmLogger.warn(TAG, '删除目录失败: ' + String(e));
      }
    }
    fileIo.mkdirSync(dir);
  }

  /**
   * 两种运行模式各自的 DSH_HOME（[0] 内嵌、[1] 宿主）。
   *
   * profiles 卫生清理（clearProfilesFallback / cleanUnmanagedHealFallback）必须同时
   * 覆盖两份：壳侧在启动前无法预知 auto 模式的最终归属，而清理只针对「dsh 可重建的
   * 缓存」（符号链接一律保留、真实目录副本才删），对未被使用的那一份执行同样安全。
   */
  private static allDshHomes(context: common.UIAbilityContext): Array<string> {
    const homes: Array<string> = [];
    homes.push(DshBootstrap.dshHomeForMode(context, false));
    homes.push(DshBootstrap.dshHomeForMode(context, true));
    return homes;
  }

  /** 清除 dsh profiles fallback 缓存（<DSH_HOME>/profiles/node_modules），
   *  让 dsh 下次启动时按新环境重新生成依赖副本。 */
  private static clearProfilesFallback(context: common.UIAbilityContext): void {
    const homes: Array<string> = DshBootstrap.allDshHomes(context);
    for (let i = 0; i < homes.length; i++) {
      const fallbackDir: string = homes[i] + '/profiles/node_modules';
      DshBootstrap.removeDirRecursive(fallbackDir);
      if (fileIo.accessSync(fallbackDir)) {
        try {
          fileIo.rmdirSync(fallbackDir);
        } catch (e) {
          DshmLogger.warn(TAG, '删除 fallback 目录失败: ' + String(e));
        }
      }
      DshmLogger.info(TAG, '已清除 profiles fallback 缓存: ' + fallbackDir);
    }
  }

  /**
   * 将 dshm-* 自定义 bundle 镜像到 <home>/.dsh/profiles/node_modules。
   *
   * dsh 的 web profile 在加载 bundle 时会按 Node 语义从 profiles/web 逐级
   * 向上解析 node_modules（profiles/web/node_modules → profiles/node_modules）；
   * 内置的 dshm-config-editor 即位于该目录而可加载，若新 bundle 缺失会
   * 报 ERR_MODULE_NOT_FOUND 并使整个 DSH 进程终止。此处幂等镜像：
   * 目标包 name+version 与源一致则跳过，避免每次启动整目录重拷。
   */
  /**
   * 品牌迁移（一次性、幂等）：把用户 profile 里遗留的 `hdsh-config-editor`
   * 改名成 `dshm-config-editor`。
   *
   * 为什么必须在壳里做：`<filesDir>/home/.dsh/profiles/<name>/package.json` 里的
   * `dsh.profile.bundles` 属于**用户数据**，`install -r` 不会重置；而 dsh-app-boot
   * 启动时会按该列表逐项 `resolveBundleDir()`，解析不到就 throw → node 直接
   * `SIGNAL 6 (Aborted)` 崩溃（2026-09-11 实测：改了环境包名后设备启动即崩）。
   *
   * 只改这一个字符串：profiles/node_modules 下的包目录由 ensureBundleMirror 负责，
   * 且实测已随新环境生成新名目录。
   */
  static migrateLegacyProfileBundleNames(context: common.UIAbilityContext): void {
    const profilesDir: string = context.filesDir + '/home/.dsh/profiles';
    let entries: Array<string> = [];
    try {
      entries = fileIo.listFileSync(profilesDir);
    } catch (e) {
      return;
    }
    for (let i = 0; i < entries.length; i++) {
      const path: string = profilesDir + '/' + entries[i] + '/package.json';
      try {
        if (!fileIo.accessSync(path)) {
          continue;
        }
        const text: string = fileIo.readTextSync(path);
        if (!text.includes(LEGACY_CONFIG_EDITOR_BUNDLE)) {
          continue;
        }
        const fixed: string = text.split(LEGACY_CONFIG_EDITOR_BUNDLE).join(CONFIG_EDITOR_BUNDLE);
        const file = fileIo.openSync(path,
          fileIo.OpenMode.WRITE_ONLY | fileIo.OpenMode.TRUNC);
        fileIo.writeSync(file.fd, fixed);
        fileIo.closeSync(file);
        DshmLogger.info(TAG, '品牌迁移完成: ' + entries[i] + '/package.json 中 '
          + LEGACY_CONFIG_EDITOR_BUNDLE + ' → ' + CONFIG_EDITOR_BUNDLE);
      } catch (e) {
        DshmLogger.warn(TAG, '品牌迁移失败（' + entries[i] + '）: ' + String(e));
      }
    }
  }

  /**
   * 清理 dsh 自身 heal 出来的「非托管副本」，避免下次启动直接 abort。
   *
   * 背景（2026-09-12 实测）：`dsh-app-boot` 的 `healProfilesModuleFallbackLocked`
   * 会用 `ensureSymlink` 在 `<DSH_HOME>/profiles/node_modules` 下建立指向 dsh 安装
   * 目录的**符号链接**。本沙箱**禁止 symlink**，dsh 的降级路径退化为**整目录复制**，
   * 于是留下一个**真实目录** `profiles/node_modules/@deepseek-ai/dsh`。
   * 下次启动时 heal 检测到
   * `exists and is not a symlink or dsh-managed module proxy` 直接 throw，
   * 进程 abort（`SIGNAL 6`），表现为「重启后应用起不来 / 会话无法对话」。
   *
   * 修复策略：启动前扫描该目录，凡属 `@deepseek-ai/*` 且**不是** dsh 托管代理包
   * （package.json 无 `dsh.moduleFallback` 标记）的普通目录一律删除，交还 dsh 重新
   * 生成。幂等：dsh 托管产物与符号链接都会被保留。
   *
   * 只清理 `@deepseek-ai/` 命名空间下的条目 —— 那是 dsh 自己的依赖域，
   * 壳侧镜像的 `dshm-*` bundle 不在此列，不会被误删。
   */
  static cleanHealFallbackProfiles(context: common.UIAbilityContext): void {
    // 两种运行模式各有独立会话库（内嵌 <filesDir>/home/.dsh、宿主 <filesDir>/home-host/.dsh），
    // 都要做同一套卫生清理，不能再硬编码内嵌那一份。
    const homes: Array<string> = DshBootstrap.allDshHomes(context);
    for (let h = 0; h < homes.length; h++) {
      const scopeDir: string = homes[h] + '/profiles/node_modules/@deepseek-ai';
      try {
        if (!fileIo.accessSync(scopeDir)) {
          continue;
        }
        const entries: string[] = fileIo.listFileSync(scopeDir);
        for (let i = 0; i < entries.length; i++) {
          const name: string = entries[i];
          const target: string = scopeDir + '/' + name;
          try {
            // 符号链接就是 dsh 自己 heal 出来的**托管入口**（dsh-app-boot 的
            // ensureSymlink），必须原样保留。这里必须先 lstat 判链接：
            // readTextSync(target + '/package.json') 会跟随链接读到环境树里的
            // manifest（其中没有 dsh.moduleFallback 标记），据此误判「非托管」再
            // 删除，就等于把 dsh 的 fallback 入口连同其目标一起破坏掉。
            if (fileIo.lstatSync(target).isSymbolicLink()) {
              continue;
            }
            const manifest: string = target + '/package.json';
            if (!fileIo.accessSync(manifest)) {
              // 无 package.json：dsh 卸载后的残渣，直接清。
              DshBootstrap.removeDirRecursive(target);
              DshmLogger.info(TAG, '已清理 heal 残渣（无 manifest）: @deepseek-ai/' + name);
              continue;
            }
            const text: string = fileIo.readTextSync(manifest);
            if (text.indexOf('moduleFallback') < 0) {
              DshBootstrap.removeDirRecursive(target);
              DshmLogger.info(TAG, '已清理非托管 heal 副本: @deepseek-ai/' + name);
            }
          } catch (e) {
            DshmLogger.warn(TAG, '清理 heal 副本失败（' + name + '）: ' + String(e));
          }
        }
      } catch (e) {
        // 目录不存在（首次启动）或不可读：静默跳过，不影响启动。
      }
    }
  }

  static ensureBundleMirror(context: common.UIAbilityContext): void {
    // 启动前先清掉 dsh 自己 heal 出来的非托管副本（见 cleanHealFallbackProfiles 说明）。
    DshBootstrap.cleanHealFallbackProfiles(context);
    const dshNM: string = context.filesDir + '/' + DSH_SUBDIR + '/node_modules';
    const profilesNM: string = context.filesDir + '/home/.dsh/profiles/node_modules';
    const names: Array<string> = ['dshm-config-editor', 'dshm-ohos-settings', 'dshm-terminal'];
    for (let i = 0; i < names.length; i++) {
      const name: string = names[i];
      const src: string = dshNM + '/' + name;
      if (!fileIo.accessSync(src)) {
        continue;
      }
      // dshm-config-editor 是 `@deepseek-ai/dsh` 在 package.json 里声明的依赖，因此
      // dsh 的 module-fallback 会**自己**在 profiles/node_modules 下建「符号链接或
      // 带 dsh.moduleFallback.targets 的代理包」。若壳侧在这里放真实目录，dsh 侧
      // ensureSymlink()/ensureModuleProxy() 会判定「既非符号链接也非托管代理」并
      // 直接 throw → node abort（2026-09-11 实测 SIGNAL 6）。所以这个名字只清理旧的
      // 普通目录、不做镜像，交还给 dsh 托管。
      if (name === CONFIG_EDITOR_BUNDLE) {
        DshBootstrap.removeUnmanagedMirror(profilesNM + '/' + name, name);
        continue;
      }
      if (DshBootstrap.bundleMirrorCurrent(src, profilesNM + '/' + name)) {
        continue;
      }
      const dst: string = profilesNM + '/' + name;
      DshBootstrap.removeDirRecursive(dst);
      DshBootstrap.copyDirRecursive(src, dst);
      DshmLogger.info(TAG, '已镜像 profiles bundle: ' + name);
    }
  }

  /**
   * 删除壳侧早先镜像进来的「普通目录」（package.json 不含 dsh.moduleFallback 标记）。
   * 已由 dsh 托管（代理包）或已是符号链接时不动，避免把 dsh 自己建好的入口删掉。
   */
  private static removeUnmanagedMirror(path: string, name: string): void {
    try {
      if (!fileIo.accessSync(path)) {
        return;
      }
      const manifest: string = path + '/package.json';
      if (fileIo.accessSync(manifest)) {
        try {
          if (fileIo.readTextSync(manifest).includes('moduleFallback')) {
            return;
          }
        } catch (e) {
          /* 读不到就按「未托管」处理 */
        }
      }
      fileIo.rmdirSync(path);
      DshmLogger.info(TAG, '已清理壳侧镜像目录，交还 dsh module-fallback 托管: ' + name);
    } catch (e) {
      DshmLogger.warn(TAG, '清理镜像目录失败（' + name + '）: ' + String(e));
    }
  }

  /** 目标 bundle 已存在且 name+version 与源一致（上下对照 package.json）。 */
  private static bundleMirrorCurrent(src: string, dst: string): boolean {
    if (!fileIo.accessSync(dst + '/package.json')) {
      return false;
    }
    try {
      const srcMeta: Record<string, Object> =
        JSON.parse(fileIo.readTextSync(src + '/package.json')) as Record<string, Object>;
      const dstMeta: Record<string, Object> =
        JSON.parse(fileIo.readTextSync(dst + '/package.json')) as Record<string, Object>;
      return srcMeta['name'] === dstMeta['name'] && srcMeta['version'] === dstMeta['version'];
    } catch (e) {
      return false;
    }
  }

  /** 递归复制目录（fileIo 无整目录拷贝 API，逐文件复制）。 */
  private static copyDirRecursive(src: string, dst: string): void {
    if (!fileIo.accessSync(dst)) {
      DshBootstrap.mkdirRecursive(dst);
    }
    const entries: Array<string> = fileIo.listFileSync(src);
    for (let i = 0; i < entries.length; i++) {
      const childSrc: string = src + '/' + entries[i];
      const childDst: string = dst + '/' + entries[i];
      try {
        // 同样用 lstatSync：符号链接不再当目录递归（避免跟随链接自我递归 /
        // 复制出链接目标的整棵树）。文件型链接按内容复制。
        const stat = fileIo.lstatSync(childSrc);
        if (stat.isSymbolicLink()) {
          fileIo.copyFileSync(childSrc, childDst);
        } else if (stat.isDirectory()) {
          DshBootstrap.copyDirRecursive(childSrc, childDst);
        } else {
          fileIo.copyFileSync(childSrc, childDst);
        }
      } catch (e) {
        DshmLogger.warn(TAG, '复制 ' + childSrc + ' 失败: ' + String(e));
      }
    }
  }

  /**
   * 哨兵校验：DSH 解压完成后，关键文件必须存在且非空（防偶发不完整复制）。
   *
   * 除关键文件外还要校验“目录里确实有文件”：rawfile 条目若被误判为目录，
   * 会生成同名空目录，此时单个文件哨兵可能恰好存在，但环境实际是残缺的
   * （历史事故：517 个空目录 + 26 个文件即通过校验）。
   */
  private static verifyDshSentinel(dshDir: string): boolean {
    const sentinels: string[] = [
      'node_modules/@deepseek-ai/dsh/lib/_fetch-shim.cjs',
      'node_modules/@deepseek-ai/dsh/package.json',
      'node_modules/@deepseek-ai/dsh-app-boot/package.json',
      'node_modules/dshm-terminal/package.json',
      'node_modules/dshm-ohos-settings/package.json'
    ];
    for (let i = 0; i < sentinels.length; i++) {
      const p: string = dshDir + '/' + sentinels[i];
      try {
        const s = fileIo.statSync(p);
        if (!s.isFile() || s.size <= 0) {
          DshmLogger.warn(TAG, '哨兵缺失/为空: ' + sentinels[i]);
          return false;
        }
      } catch (e) {
        DshmLogger.warn(TAG, '哨兵缺失: ' + sentinels[i] + ', ' + String(e));
        return false;
      }
    }
    // 配置编辑器 bundle（scripts/create-dshm-config-editor.mjs 产出）必须存在，
    // 否则新环境会被误判为「解压不完整」而被反复重解压（实测 dsh 0.1.5-rc.1：
    // 解压 26564 文件全部写入成功、contentFailed=0，却因这条哨兵 sentinel=false）。
    // 历史说明：该包旧名为 hdsh-config-editor，品牌统一为 DSHM 后改名 dshm-config-editor。
    if (!DshBootstrap.sentinelFileOk(dshDir, 'node_modules/dshm-config-editor/package.json')) {
      DshmLogger.warn(TAG, '哨兵缺失/为空: 配置编辑器 bundle（dshm-config-editor）');
      return false;
    }
    // 目录级校验：dsh 包的 lib/ 至少要有若干文件（主入口 + 垫片 + 分块）。
    try {
      const libEntries: Array<string> = fileIo.listFileSync(dshDir + '/node_modules/@deepseek-ai/dsh/lib');
      if (libEntries.length < 3) {
        DshmLogger.warn(TAG, '哨兵目录内容过少: @deepseek-ai/dsh/lib 仅 ' + libEntries.length + ' 项');
        return false;
      }
    } catch (e) {
      DshmLogger.warn(TAG, '哨兵目录不可读: @deepseek-ai/dsh/lib, ' + String(e));
      return false;
    }
    return true;
  }

  /** 递归复制 rawfile 目录到目标目录（保持相对结构）。 */
  private static copyRawfileRecursive(resMgr: resourceManager.ResourceManager, relPath: string, destDir: string): void {
    const entries: Array<string> = resMgr.getRawFileListSync(relPath);
    for (let i = 0; i < entries.length; i++) {
      const childRel: string = relPath + '/' + entries[i];
      const childDest: string = destDir + '/' + entries[i];
      // 目录判定不能依赖“是否抛异常”：HarmonyOS 对文件路径可能返回空数组而非
      // 抛错，此时按目录处理会把文件变成同名空目录（历史事故：517 个空目录）。
      // 只有在确实列出子项时才当目录；否则一律先按文件复制，失败再建目录。
      let children: Array<string> | null = null;
      try {
        children = resMgr.getRawFileListSync(childRel);
      } catch (e) {
        children = null;
        DshBootstrap.diagListThrew++;
        DshBootstrap.diagNote('listThrew: ' + childRel + ' :: ' + String(e));
      }
      if (children !== null && children.length > 0) {
        if (!fileIo.accessSync(childDest)) {
          fileIo.mkdirSync(childDest);
        }
        DshBootstrap.diagDirs++;
        DshBootstrap.copyRawfileRecursive(resMgr, childRel, childDest);
        continue;
      }
      if (children !== null) {
        DshBootstrap.diagListEmpty++;
      }
      try {
        const data: Uint8Array = resMgr.getRawFileContentSync(childRel);
        const file = fileIo.openSync(childDest,
          fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
        fileIo.writeSync(file.fd, data.buffer as ArrayBuffer);
        fileIo.closeSync(file);
        DshBootstrap.diagFiles++;
      } catch (e) {
        DshBootstrap.diagContentFailed++;
        DshBootstrap.diagNote('contentFailed: ' + childRel + ' :: ' + String(e));
        // 空目录：rawfile 里列出但无子项，也没有文件内容。
        try {
          if (!fileIo.accessSync(childDest)) {
            fileIo.mkdirSync(childDest);
          }
        } catch (mkdirError) {
          DshBootstrap.diagWriteFailed++;
          DshBootstrap.diagNote('mkdirFailed: ' + childDest + ' :: ' + String(mkdirError));
          DshmLogger.warn(TAG, '创建目录失败: ' + childDest + ', ' + String(mkdirError));
        }
      }
    }
  }

  /** 启动 native 子进程运行 DSH。返回子进程 pid。 */
  static async launchDsh(): Promise<number> {
    DshmLogger.info(TAG, '启动 libdsh_host 子进程');
    return childProcessManager.startNativeChildProcess('libdsh_host.so:Main', {});
  }

  /** 当前内置环境版本号（用于“关于版本”展示）。 */
  static envVersion(): string {
    return ENV_VERSION;
  }

  // ── 运行模式（Plan A 宿主 dsh / Plan B 内嵌运行时） ──────────────
  // ArkTS 写 <filesDir>/runtime-mode.txt（auto|host|embedded）供 native 读取；
  // native 启动后把实际采用值写回 <filesDir>/runtime-mode-active.txt。

  static runtimeModePath(context: common.UIAbilityContext): string {
    return context.filesDir + '/runtime-mode.txt';
  }

  static activeModePath(context: common.UIAbilityContext): string {
    return context.filesDir + '/runtime-mode-active.txt';
  }

  /** 用户选择的运行模式（缺省 auto）。 */
  static readRuntimeMode(context: common.UIAbilityContext): string {
    try {
      const p: string = DshBootstrap.runtimeModePath(context);
      if (!fileIo.accessSync(p)) {
        return 'auto';
      }
      const v: string = fileIo.readTextSync(p).trim();
      return v.length > 0 ? v : 'auto';
    } catch (e) {
      return 'auto';
    }
  }

  static writeRuntimeMode(context: common.UIAbilityContext, mode: string): void {
    try {
      const f = fileIo.openSync(DshBootstrap.runtimeModePath(context),
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      fileIo.writeSync(f.fd, mode + '\n');
      fileIo.closeSync(f);
      DshmLogger.info(TAG, '运行模式已设为 ' + mode);
    } catch (e) {
      DshmLogger.warn(TAG, '写运行模式失败: ' + String(e));
    }
  }

  /** native 侧实际采用的运行模式（含宿主 dsh 路径与版本）。 */
  static readActiveMode(context: common.UIAbilityContext): RuntimeModeInfo {
    const info: RuntimeModeInfo =
      { mode: 'embedded', dshPath: '', version: '', nodeVersion: '', home: '', dshHome: '' };
    try {
      const p: string = DshBootstrap.activeModePath(context);
      if (!fileIo.accessSync(p)) {
        return info;
      }
      const lines: string[] = fileIo.readTextSync(p).split('\n');
      for (let i = 0; i < lines.length; i++) {
        const t: string = lines[i].trim();
        if (t === 'host' || t === 'embedded') {
          info.mode = t;
        } else if (t.indexOf('dsh=') === 0) {
          info.dshPath = t.substring(4);
        } else if (t.indexOf('version=') === 0) {
          info.version = t.substring(8);
        } else if (t.indexOf('node=') === 0) {
          info.nodeVersion = t.substring(5);
        } else if (t.indexOf('dshHome=') === 0) {
          info.dshHome = t.substring(8);
        } else if (t.indexOf('home=') === 0) {
          info.home = t.substring(5);
        }
      }
    } catch (e) {
      DshmLogger.warn(TAG, '读运行模式失败: ' + String(e));
    }
    return info;
  }

  /**
   * 当前模式对应的会话库（DSH_HOME）绝对路径。
   *
   * 与 dsh_host.cpp 的 DshHomeForMode 保持同一套规则（两处必须一致）：
   *   内嵌 -> <filesDir>/home/.dsh
   *   宿主 -> <filesDir>/home-host/.dsh
   * 两种模式的会话/设置/凭据各自独立：切到哪个模式就自动用哪个库。
   */
  static dshHomeForMode(context: common.UIAbilityContext, hostMode: boolean): string {
    return context.filesDir + (hostMode ? '/home-host/.dsh' : '/home/.dsh');
  }

  /**
   * 请求重启宿主 dsh。
   * 宿主 dsh 没有 /dshm-admin/* 端点，用文件信号通知 native 守候进程：
   * 它轮询 <filesDir>/restart-request，看到即结束子进程并重新 exec。
   */
  static requestHostRestart(context: common.UIAbilityContext): void {
    try {
      const f = fileIo.openSync(context.filesDir + '/restart-request',
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      fileIo.writeSync(f.fd, '1\n');
      fileIo.closeSync(f);
      DshmLogger.info(TAG, '已请求重启宿主 dsh');
    } catch (e) {
      DshmLogger.warn(TAG, '写重启请求失败: ' + String(e));
    }
  }

  /**
   * 停掉当前 dsh 实例，并**确定性等待它退出**（重启 / 切换模式 / 退出应用的统一入口）。
   *
   * 两种模式的通道不同，但都落一个「已停」标记，绝不靠 http 探测 loopback 判断
   * 端口是否释放（该探测不可靠，会让新旧实例抢 3080，见 bug-log 2026-09-11）：
   *   - embedded：`restart-request` → 进程内适配层 `process.exit(0)` →
   *     libdsh_host 在 node::Start 返回后写 `<filesDir>/node-exited`；
   *   - host：`restart-request` → native 守候进程 SIGTERM/SIGKILL 宿主 dsh 子进程后
   *     **自身退出**并写 `<filesDir>/host-stopped`（2026-09-13 起不再原地重 fork）。
   *
   * 返回 true 时旧实例的监听套接字必然已关闭，新实例可安全绑定 3080。
   *
   * @param mode 当前**生效**的模式（切换模式时要传旧模式，而不是即将切到的模式）
   */
  static async stopDsh(context: common.UIAbilityContext, mode: string,
    timeoutMs: number): Promise<boolean> {
    let stopped: boolean = false;
    if (mode === 'host') {
      const marker: string = context.filesDir + '/host-stopped';
      try {
        if (fileIo.accessSync(marker)) {
          fileIo.unlinkSync(marker);
        }
      } catch (e) {
        DshmLogger.warn(TAG, '清理 host-stopped 失败: ' + String(e));
      }
      DshBootstrap.requestHostRestart(context);
      stopped = await DshBootstrap.waitForStopMarker(context, 'host-stopped', timeoutMs);
    } else {
      stopped = await DshBootstrap.requestEmbeddedRestart(context, timeoutMs);
    }
    if (!stopped) {
      // 超时说明没有活着的 native 守候进程在消费信号。**必须回收信号文件**：
      // 留着它，等会儿 launchDsh() 起的新进程会在第一轮轮询里命中它，把刚起来的
      // dsh 立刻杀掉（现象：重启后服务一直起不来）。
      DshBootstrap.clearStopSignals(context);
    }
    return stopped;
  }

  /** 清掉停机信号文件（重启/停止请求）。 */
  private static clearStopSignals(context: common.UIAbilityContext): void {
    const names: string[] = ['restart-request', 'stop-request', 'kill-request'];
    for (let i = 0; i < names.length; i++) {
      const p: string = context.filesDir + '/' + names[i];
      try {
        if (fileIo.accessSync(p)) {
          fileIo.unlinkSync(p);
          DshmLogger.warn(TAG, '停机超时：已回收残留信号 ' + names[i]);
        }
      } catch (e) {
        DshmLogger.warn(TAG, '回收信号 ' + names[i] + ' 失败: ' + String(e));
      }
    }
  }

  /** 请求退出整个应用前，先停掉 dsh（之后由调用方 terminateSelf）。 */
  static async stopDshForExit(context: common.UIAbilityContext, mode: string,
    timeoutMs: number): Promise<boolean> {
    if (mode === 'host') {
      const stopped: string = context.filesDir + '/host-stopped';
      try {
        if (fileIo.accessSync(stopped)) {
          fileIo.unlinkSync(stopped);
        }
      } catch (e) {
        DshmLogger.warn(TAG, '清理 host-stopped 失败: ' + String(e));
      }
      try {
        const f = fileIo.openSync(context.filesDir + '/stop-request',
          fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
        fileIo.writeSync(f.fd, '1\n');
        fileIo.closeSync(f);
      } catch (e) {
        DshmLogger.warn(TAG, '写停止请求失败: ' + String(e));
        return false;
      }
      return await DshBootstrap.waitForStopMarker(context, 'host-stopped', timeoutMs);
    }
    return await DshBootstrap.requestEmbeddedRestart(context, timeoutMs);
  }

  /** 轮询某个「已停」标记文件出现（出现即消费掉，避免下次误判）。 */
  private static async waitForStopMarker(context: common.UIAbilityContext, fileName: string,
    timeoutMs: number): Promise<boolean> {
    const path: string = context.filesDir + '/' + fileName;
    const deadline: number = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fileIo.accessSync(path)) {
        try {
          fileIo.unlinkSync(path);
        } catch (e) {
          DshmLogger.warn(TAG, '清理 ' + fileName + ' 失败: ' + String(e));
        }
        DshmLogger.info(TAG, '旧实例已退出（' + fileName + '）');
        return true;
      }
      await DshBootstrap.sleepMs(200);
    }
    DshmLogger.error(TAG, '等待 ' + fileName + ' 超时（' + timeoutMs + 'ms）');
    return false;
  }

  /**
   * 统计当前 node 日志里 `dsh web:` 出现的次数。
   * 宿主模式下守候进程与 dsh 共用同一个日志文件（子进程继承 freopen 的 fd），
   * 重启只是往同一文件追加，因此"就绪判定"要看标记数量是否增加，而不是是否存在。
   */
  static countWebReadyMarkers(context: common.UIAbilityContext): number {
    try {
      const dir: string = context.filesDir + '/log';
      if (!fileIo.accessSync(dir)) {
        return 0;
      }
      const names: string[] = fileIo.listFileSync(dir);
      let newest: string = '';
      for (let i = 0; i < names.length; i++) {
        if (names[i].indexOf('node-') === 0 && names[i].endsWith('.log')) {
          if (newest.length === 0 || names[i] > newest) {
            newest = names[i];
          }
        }
      }
      if (newest.length === 0) {
        return 0;
      }
      const text: string = fileIo.readTextSync(dir + '/' + newest);
      let count: number = 0;
      let from: number = 0;
      for (;;) {
        const at: number = text.indexOf('dsh web:', from);
        if (at < 0) {
          break;
        }
        count++;
        from = at + 8;
      }
      return count;
    } catch (e) {
      return 0;
    }
  }

  /**
   * 请求内嵌运行时停止，并**确定性等待旧 node 退出**。
   *
   * 通道（2026-09-13 改为 native 接管）：写 `<filesDir>/kill-request` →
   * **native 父进程**（独立于 node，不被停机对象拖累）SIGTERM/SIGKILL 掉 node 子进程
   * → 写 `<filesDir>/node-exited` → 本函数轮询到该标记。
   *
   * 为什么不再依赖 JS 侧插件：旧实现是「写 restart-request → dsh 进程内的 dshm-terminal
   * 插件轮询到就 process.exit(0)」，等于把停机能力放在**要被停掉的那个进程**里。插件没加载、
   * 事件循环被占住时旧 node 停不下来（实测 30s 超时后 restartDsh 直接放弃，模式切不过去）。
   * 现在 native 侧直接用文件信号杀子进程，且子进程被 SIGKILL 时由父进程兜底写标记。
   *
   * 此时 node 的监听套接字已关闭、3080 必然可复用，**不再依赖 ArkTS 侧 http 探测 loopback**
   * （该探测不可靠，据其判断"端口已释放"会让新旧 node 抢端口，见 bug-log 2026-09-11）。
   * @returns 旧 node 是否已在超时内退出
   */
  static async requestEmbeddedRestart(context: common.UIAbilityContext,
    timeoutMs: number): Promise<boolean> {
    const exited: string = context.filesDir + '/node-exited';
    try {
      // 先清陈旧标记（上一轮留下的会让本次误判为"已退出"）。
      if (fileIo.accessSync(exited)) {
        fileIo.unlinkSync(exited);
      }
      const f = fileIo.openSync(context.filesDir + '/kill-request',
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      fileIo.writeSync(f.fd, '1\n');
      fileIo.closeSync(f);
    } catch (e) {
      DshmLogger.error(TAG, '写停机信号失败: ' + String(e));
      return false;
    }
    const deadline: number = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fileIo.accessSync(exited)) {
        try {
          fileIo.unlinkSync(exited);
        } catch (e) {
          DshmLogger.warn(TAG, '清理 node-exited 失败: ' + String(e));
        }
        DshmLogger.info(TAG, '旧 node 已退出（node-exited 标记）');
        return true;
      }
      await DshBootstrap.sleepMs(200);
    }
    DshmLogger.error(TAG, '等待 node-exited 超时（' + timeoutMs + 'ms）');
    return false;
  }

  /**
   * 等待日志出现 `dsh web:` 就绪标记。
   * 用文件读取而非 http 探测判定就绪（后者在鸿蒙上不可靠）。
   */
  static async waitForWebMarker(context: common.UIAbilityContext, timeoutMs: number): Promise<boolean> {
    const deadline: number = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (DshBootstrap.countWebReadyMarkers(context) > 0) {
        return true;
      }
      await DshBootstrap.sleepMs(1000);
    }
    return false;
  }

  private static sleepMs(ms: number): Promise<void> {
    return new Promise<void>((resolve: () => void) => {
      setTimeout(resolve, ms);
    });
  }

  /**
   * 强制从安装包重新解压运行环境（故障恢复入口）。
   *
   * 使用场景：更新失败/回滚后环境处于"文件数看着对、但服务端返回的资源不完整"
   * 的坏状态（实测表现为 ArkWeb 一直 NetworkTransactionTimeout、界面白屏）；
   * 这种状态靠普通重启无法自愈，必须重解压。
   * 会话、工作区与 API Key 都存在 filesDir/home 下，不受影响。
   */
  static async forceReinstallEnv(context: common.UIAbilityContext): Promise<boolean> {
    const versionPath: string = context.filesDir + '/' + DSH_SUBDIR + '/' + VERSION_FILE;
    try {
      if (fileIo.accessSync(versionPath)) {
        fileIo.unlinkSync(versionPath);
      }
      await DshBootstrap.ensureDshDir(context);
      DshmLogger.info(TAG, '运行环境已从安装包重新解压');
      return true;
    } catch (e) {
      DshmLogger.error(TAG, '重新解压运行环境失败: ' + String(e));
      return false;
    }
  }

  /** 启动前仅清理上一轮 node 诊断日志与陈旧 boot-state，避免超时诊断/旧 token 混入历史进程。 */
  static clearNodeLogs(context: common.UIAbilityContext): void {
    // 陈旧 boot-state.json 必须先删：其 pid/url 属于上一轮 node，留着会让
    // readBootState 在新 node 就绪前返回旧 token（ArkWeb 加载后 401）。
    try {
      const stale: string = context.filesDir + '/boot-state.json';
      if (fileIo.accessSync(stale)) {
        fileIo.unlinkSync(stale);
        DshmLogger.info(TAG, '已清除上一轮 boot-state.json');
      }
    } catch (e) {
      /* 不阻断 */
    }
    const logDir: string = context.filesDir + '/log';
    DshBootstrap.removeDirRecursive(logDir);
    if (fileIo.accessSync(logDir)) {
      try {
        fileIo.rmdirSync(logDir);
      } catch (e) {
        DshmLogger.warn(TAG, '删除旧 node 日志目录失败: ' + String(e));
        return;
      }
    }
    try {
      fileIo.mkdirSync(logDir);
      DshmLogger.info(TAG, '已清除上一轮 node 诊断日志');
    } catch (e) {
      DshmLogger.warn(TAG, '创建 node 日志目录失败: ' + String(e));
    }
  }

  /**
   * 诊断：回读 filesDir/log/ 下的 node 子进程日志并打到 hilog。
   * libdsh_host 将 node stdout/stderr 重定向到 <filesDir>/log/node-*.log，
   * 但应用沙箱对 hdc shell 不可见，只能由应用自身读取后输出。
   */
  static async dumpNodeLogs(context: common.UIAbilityContext): Promise<void> {
    const logDir: string = context.filesDir + '/log';
    let entries: Array<string> = [];
    try {
      entries = fileIo.listFileSync(logDir);
    } catch (e) {
      DshmLogger.error(TAG, 'log 目录不可读: ' + String(e));
      return;
    }
    for (let i = 0; i < entries.length; i++) {
      const p: string = logDir + '/' + entries[i];
      try {
        const content: string = fileIo.readTextSync(p);
        DshmLogger.error('NodeLog', entries[i] + '\n' + content);
      } catch (e) {
        DshmLogger.error(TAG, '读取 ' + entries[i] + ' 失败: ' + String(e));
      }
    }
  }

  /**
   * 按关键字回显 Node 日志中匹配的行（M0.5 host bridge 验证用）。
   * selfcheck/probe 行含 "SHELL="、"probe "、"SELFTEST"、"exit=" 等锚点，
   * 只捞这些行打 hilog，避免整份 node 日志刷屏。
   */
  static async echoNodeLogMarks(context: common.UIAbilityContext): Promise<void> {
    const logDir: string = context.filesDir + '/log';
    let entries: Array<string> = [];
    try {
      entries = fileIo.listFileSync(logDir);
    } catch (e) {
      DshmLogger.warn(TAG, 'echoNodeLogMarks: log 目录不可读 ' + String(e));
      return;
    }
    let latest: string = '';
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].startsWith('node-') && entries[i].endsWith('.log')) {
        latest = entries[i];
      }
    }
    if (latest.length === 0) return;
    let content: string = '';
    try {
      content = fileIo.readTextSync(logDir + '/' + latest);
    } catch (e) {
      DshmLogger.warn(TAG, 'echoNodeLogMarks: 读取 ' + latest + ' 失败 ' + String(e));
      return;
    }
    const anchors: string[] = ['SHELL=', 'probe ', 'EXEC_OK', 'missing/noexec', 'SELFTEST_OK', 'selfcheck'];
    const lines: string[] = content.split('\n');
    let hits: number = 0;
    for (let i = 0; i < lines.length; i++) {
      for (let a = 0; a < anchors.length; a++) {
        if (lines[i].indexOf(anchors[a]) >= 0) {
          DshmLogger.info('NodeProbe', latest + ':' + lines[i]);
          hits++;
          break;
        }
      }
      if (hits > 80) break;
    }
  }

  /** 读取最近 Node 子进程日志的末尾，供启动失败界面显示可操作的根因。 */
  static readNodeLogTail(context: common.UIAbilityContext): string {
    const logDir: string = context.filesDir + '/log';
    let entries: Array<string> = [];
    try {
      entries = fileIo.listFileSync(logDir);
    } catch (e) {
      return '';
    }
    let latest: string = '';
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].startsWith('node-') && entries[i].endsWith('.log')) {
        latest = entries[i];
      }
    }
    if (latest.length === 0) return '';
    try {
      const content: string = fileIo.readTextSync(logDir + '/' + latest);
      const maxLength: number = 1200;
      return content.length > maxLength ? content.slice(content.length - maxLength) : content;
    } catch (e) {
      return '';
    }
  }

  /**
   * 诊断：列出 DSH 源目录与 profiles fallback 目录中 pi-ai 相关路径，
   * 用于定位 .manifest.json 缺失（rawfile 隐藏文件解压丢失或 cpSync 复制问题）。
   */
  static async dumpFallbackDiag(context: common.UIAbilityContext): Promise<void> {
    const paths: string[] = [
      context.filesDir + '/dsh/node_modules/@earendil-works/pi-ai/dist/providers/data',
      context.filesDir + '/home/.dsh/profiles/node_modules/@earendil-works/pi-ai/dist/providers/data',
      context.filesDir + '/home/.dsh/profiles/node_modules/@earendil-works/pi-ai/dist/providers'
    ];
    for (let i = 0; i < paths.length; i++) {
      let names: Array<string> = [];
      try {
        names = fileIo.listFileSync(paths[i]);
      } catch (e) {
        DshmLogger.error('FallbackDiag', paths[i] + ' => 不可读: ' + String(e));
        continue;
      }
      DshmLogger.error('FallbackDiag', paths[i] + ' => [' + names.join(',') + ']');
    }
  }

  /** 诊断：输出当前 Web profile 的插件清单，用于定位某个第三方包的启动失败。 */
  static async dumpWebProfileManifest(context: common.UIAbilityContext): Promise<void> {
    const manifestPath: string = context.filesDir + '/home/.dsh/profiles/web/package.json';
    try {
      const content: string = fileIo.readTextSync(manifestPath);
      DshmLogger.error('ProfileDiag', 'web profile manifest: ' + content);
    } catch (e) {
      DshmLogger.error('ProfileDiag', 'web profile manifest 不可读: ' + String(e));
    }
  }

  /**
   * 轮询 DSH web server 就绪。
   * 就绪信号以 node 子进程日志(<filesDir>/log/node-*.log)中出现的
   * "dsh web:" 标记为准 —— libdsh_host 把 node stdout/stderr 重定向到该文件，
   * server 完成监听后才打印这一行。ArkTS @ohos.net.http 直连 127.0.0.1 在设备
   * 上实测请求无法送达(1080 无连接),故 http 探测仅作兜底。
   */
  static async waitForServer(context: common.UIAbilityContext, timeoutMs: number): Promise<boolean> {
    const logDir: string = context.filesDir + '/log';
    const deadline: number = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (DshBootstrap.logNodeReady(logDir)) {
        return true;
      }
      if (await DshBootstrap.probeServerHttp()) {
        return true;
      }
      await new Promise<void>((resolve: () => void) => {
        setTimeout(resolve, 1000);
      });
    }
    return false;
  }

  /** 主探测：扫 log 目录下 node-*.log，出现带 URL 的 "dsh web: http://" 即 server 就绪。 */
  private static logNodeReady(logDir: string): boolean {
    let entries: Array<string> = [];
    try {
      entries = fileIo.listFileSync(logDir);
    } catch (e) {
      return false;
    }
    for (let i = 0; i < entries.length; i++) {
      if (!entries[i].startsWith('node-') || !entries[i].endsWith('.log')) {
        continue;
      }
      try {
        const content: string = fileIo.readTextSync(logDir + '/' + entries[i]);
        if (content.includes('dsh web: http://')) {
          return true;
        }
      } catch (e) {
        /* node 正在追加写日志时读可能失败，重试即可 */
      }
    }
    return false;
  }

  /** 兜底探测：ArkTS http 探测（设备上常不可达，仅作兜底）。 */
  private static async probeServerHttp(): Promise<boolean> {
    const request = http.createHttp();
    try {
      const resp = await request.request(SERVER_URL, {
        method: http.RequestMethod.GET,
        connectTimeout: 1000,
        readTimeout: 1000
      });
      return resp.responseCode < 500;
    } catch (e) {
      return false;
    } finally {
      request.destroy();
    }
  }

  /**
   * 读取 node 预加载脚本（_fetch-shim.cjs）在 dsh 就绪时写入的
   * 结构化启动状态（阶段0 A1，借鉴上游 DesktopHostProcess 的类型化 ready 握手）。
   *
   * 返回 null 的情形：文件不存在（旧环境/未就绪/剖析模式）、URL 无 token、
   * 或写文件的 node 进程已死（陈旧残留——重启场景 clearNodeLogs 会先清掉，
   * 这里再按 PID 活性兜底）。调用方拿到非 null 即可直接加载 URL，不必刮日志。
   */
  static readBootState(context: common.UIAbilityContext): DshBootState | null {
    const p: string = context.filesDir + '/boot-state.json';
    try {
      if (!fileIo.accessSync(p)) {
        return null;
      }
      const j: DshBootState = JSON.parse(fileIo.readTextSync(p)) as DshBootState;
      if (typeof j.url !== 'string' || !j.url.startsWith('http://') || !j.url.includes('token=')) {
        return null;
      }
      if (!DshBootstrap.pidAlive(j.pid)) {
        DshmLogger.warn(TAG, 'boot-state.json 的写入进程 ' + j.pid + ' 已退出，视为陈旧');
        return null;
      }
      return j;
    } catch (e) {
      return null;
    }
  }

  /**
   * 解析 dsh web server 的公开地址（含会话 token）。
   * 新版 dsh web 服务启用了 token 鉴权：无 token 访问 3080 根路径返回 401；
   * libdsh_host 启动时把 "dsh --token" 生成的完整 URL 打印到 node 日志
   * （dsh web: http://127.0.0.1:3080/?token=<random>）。ArkWeb 必须加载
   * 这个带 token 的 URL，才能跟随 303 → Set-Cookie 建立会话。
   * 日志里没有 token 时（旧环境/无鉴权），回退到裸 SERVER_URL。
   */
  static readWebUrl(context: common.UIAbilityContext): string {
    const logDir: string = context.filesDir + '/log';
    let entries: Array<string> = [];
    try {
      entries = fileIo.listFileSync(logDir);
      DshmLogger.info(TAG, 'readWebUrl: logDir=' + logDir + ' entries=' + entries.length);
    } catch (e) {
      DshmLogger.error(TAG, 'readWebUrl list fail: ' + (e instanceof Error ? e.message : String(e)));
      return SERVER_URL;
    }
    // 遍历全部 node-*.log（可按 mtime 排序），取含 token 的最新 URL；容忍 LAN 后缀。
    const candidates: Array<string> = [];
    for (let i = 0; i < entries.length; i++) {
      if (!entries[i].startsWith('node-') || !entries[i].endsWith('.log')) {
        continue;
      }
      try {
        const content: string = fileIo.readTextSync(logDir + '/' + entries[i]);
        DshmLogger.info(TAG, 'readWebUrl: ' + entries[i] + ' len=' + content.length +
          ' hasMark=' + (content.includes('dsh web: http://') ? 'yes' : 'no') +
          ' hasToken=' + (content.includes('token=') ? 'yes' : 'no'));
        const marker: string = 'dsh web: http://';
        let idx: number = content.indexOf(marker);
        while (idx >= 0) {
          const lineEnd: number = content.indexOf('\n', idx);
          let url: string = (lineEnd < 0 ?
            content.slice(idx + marker.length) : content.slice(idx + marker.length, lineEnd)).trim();
          // marker 即 "dsh web: http://"，需补回 http:// 前缀
          url = 'http://' + url;
          // 去掉行尾的 (LAN: ...) 后缀
          const lan: number = url.indexOf(' (LAN: ');
          if (lan >= 0) {
            url = url.substring(0, lan);
          }
          if (url.startsWith('http://')) {
            candidates.push(url);
          }
          idx = content.indexOf(marker, lineEnd < 0 ? idx + 1 : lineEnd + 1);
        }
      } catch (e) {
        /* node 正在追加写日志时读可能失败，下次重试 */
      }
    }
    if (candidates.length > 0) {
      // 最新（token 数量大或最后出现）者优先：优先带 token= 的 URL
      for (let i = candidates.length - 1; i >= 0; i--) {
        if (candidates[i].includes('token=')) {
          return candidates[i];
        }
      }
      return candidates[candidates.length - 1];
    }
    return SERVER_URL;
  }
}
