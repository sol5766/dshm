import { application, common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';

/**
 * 三端共享核心 HSP 的稳定模块名。
 *
 * 产品 HAP 只提供入口与设备差异；入口脚本、核心容器、工具链、Node 与原生库
 * 都从这一个 HSP 读取，避免三个 HAP 各复制一份 300MB+ 的公共核心。
 */
export const DSH_CORE_MODULE_NAME: string = 'hostruntime';

/**
 * 主入口模块名（`entry`，平板壳）。PC / 2in1 走独立的 `pc` 壳，桌面形态的 Host
 * 数据根统一重定向到它的沙箱（见 resolveHostDataDir）。
 */
export const MAIN_ENTRY_MODULE_NAME: string = 'entry';

export interface HostModulePaths {
  resourceDir: string;
  nativeLibsDir: string;
  vmDataDir: string;
}

const hostModuleInflight: Map<string, Promise<HostModulePaths>> = new Map<string, Promise<HostModulePaths>>();
const hostModuleResolved: Map<string, HostModulePaths> = new Map<string, HostModulePaths>();

function copyHostModulePaths(paths: HostModulePaths): HostModulePaths {
  const copy: HostModulePaths = {
    resourceDir: paths.resourceDir,
    nativeLibsDir: paths.nativeLibsDir,
    vmDataDir: paths.vmDataDir,
  };
  return copy;
}

/**
 * Host 的**数据根**（`files`）：桌面形态（PC / 2in1）统一落在主入口模块 `entry` 的沙箱里。
 *
 * 【为什么需要重定向（2026-11-07 真机）】`pc` 壳自己的 `haps/pc/files` 不在系统的可加载
 * 命名空间里，`node-pty` 的 `pty.node` 从那里 `dlopen` 会被拒（`errno=2`，见 docs/397）；
 * 而 `haps/entry/files`（平板壳）可加载。桌面形态本就应该"一份数据 + 一份核心"（PC 用户
 * 升级后仍能看到原有会话/插件），因此把非主模块的 `files` 重定向到 `haps/entry/files`；
 * 手机/平板保持各自沙箱。
 *
 * 目录不存在（全新 PC 上从未启动过 entry）时回退自己的 `files`，不硬造别的模块目录。
 * `.node` 原生库另有入口脚本到共享 HSP `libs/<abi>` 的重定向兜底（`DSHM_NATIVE_LIBS`），
 * 所以即使回退到 `haps/pc/files`，pty/koffi/sharp 也能加载。
 *
 * @param ownFilesDir 本 HAP 的 `context.filesDir`
 * @param desktop 是否桌面形态（`!isHandheldForm()`）
 */
export function resolveHostDataDir(ownFilesDir: string, desktop: boolean): string {
  const dir: string = ownFilesDir.trim();
  if (!desktop || dir.length === 0) {
    return dir;
  }
  const marker: string = '/haps/';
  const at: number = dir.indexOf(marker);
  if (at < 0) {
    return dir;
  }
  const rest: string = dir.substring(at + marker.length);
  const slash: number = rest.indexOf('/');
  if (slash < 0) {
    return dir;
  }
  const moduleName: string = rest.substring(0, slash);
  if (moduleName.length === 0 || moduleName === MAIN_ENTRY_MODULE_NAME) {
    return dir;
  }
  const shared: string = dir.substring(0, at) + marker + MAIN_ENTRY_MODULE_NAME + rest.substring(slash);
  try {
    if (fs.accessSync(shared)) {
      return shared;
    }
  } catch (e) {
    return dir;
  }
  return dir;
}

/**
 * 从产品 HAP 的上下文解析公共核心 HSP 的资源目录和原生库目录。
 *
 * HSP 的 `resourceDir`/`bundleCodeDir` 属于 HSP 本身，不能用宿主 HAP 的
 * `UIAbilityContext.resourceDir` 代替。调用方只在启动 Host、安装内置核心时解析一次。
 */
export async function resolveHostModulePaths(context: common.Context): Promise<HostModulePaths> {
  let key: string = '';
  try {
    const name: string = context.applicationInfo?.name ?? '';
    const resourceDir: string = context.resourceDir ?? '';
    const bundleCodeDir: string = context.bundleCodeDir ?? '';
    if (name.length > 0 && (resourceDir.length > 0 || bundleCodeDir.length > 0)) {
      key = JSON.stringify([name, resourceDir, bundleCodeDir]);
    }
  } catch (e) {
    key = '';
  }
  if (key.length > 0) {
    const resolved: HostModulePaths | undefined = hostModuleResolved.get(key);
    if (resolved !== undefined) {
      return copyHostModulePaths(resolved);
    }
    const inflight: Promise<HostModulePaths> | undefined = hostModuleInflight.get(key);
    if (inflight !== undefined) {
      return copyHostModulePaths(await inflight);
    }
  }
  const task: Promise<HostModulePaths> = application.createModuleContext(context, DSH_CORE_MODULE_NAME)
    .then((moduleContext: common.Context): HostModulePaths => {
      const paths: HostModulePaths = {
        resourceDir: moduleContext.resourceDir,
        nativeLibsDir: `${moduleContext.bundleCodeDir}/libs/arm64`,
        vmDataDir: `${moduleContext.resourceDir}/vm`,
      };
      return paths;
    });
  if (key.length > 0) {
    hostModuleInflight.set(key, task);
  }
  try {
    const paths: HostModulePaths = await task;
    if (key.length > 0) {
      hostModuleResolved.set(key, paths);
    }
    return copyHostModulePaths(paths);
  } finally {
    if (key.length > 0) {
      hostModuleInflight.delete(key);
    }
  }
}
