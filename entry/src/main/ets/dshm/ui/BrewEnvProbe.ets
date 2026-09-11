/**
 * Harmonybrew 运行环境检测。
 *
 * BrewDSH 的核心运行时来自 Harmonybrew（`brew install deepseek-harness` +
 * 原生 node），本类负责在 App 侧只读探测这些组件是否就绪，供「运行环境」
 * 面板展示与一键安装/更新入口决策。
 *
 * 探测路径均来自 Harmonybrew 官方约定的用户级安装根：
 *   `<用户目录>/.harmonybrew/`
 * 应用沙箱内可读该路径（需已授予全盘文件访问），故用 `fileIo.accessSync` 探测。
 */
import { fileIo } from '@kit.CoreFileKit';
import { DshmLogger } from '../utils/Logger';

const TAG: string = 'BrewEnvProbe';

/** Harmonybrew 用户级安装根（与 dsh_host.cpp 的 PATH 注入保持一致）。 */
export const HARMONYBREW_ROOT: string = '/storage/Users/currentUser/.harmonybrew';

/** 官方一键安装命令。 */
export const BREW_INSTALL_CMD: string =
  'zsh -c "$(curl -fsSL https://harmonybrew.atomgit.com/install.sh)"';

/** 安装 dsh 到 brew 环境。 */
export const BREW_INSTALL_DSH_CMD: string = 'brew install deepseek-harness';

/** 更新 brew 自身与 dsh。 */
export const BREW_UPGRADE_CMD: string = 'brew update && brew upgrade deepseek-harness';

/** 运行环境各组件状态。 */
export interface BrewEnvStatus {
  /** brew 可执行文件是否存在。 */
  brewInstalled: boolean;
  /** brew 自带的 node 是否存在（embedded 模式下 pnpm 依赖它）。 */
  nodeInstalled: boolean;
  /** brew 安装的 dsh 入口是否存在（宿主模式依赖它）。 */
  dshInstalled: boolean;
  /** 全盘文件访问是否已授予（未授予时上述探测全部为 false）。 */
  storageReadable: boolean;
}

/** 运行环境检测服务。 */
export class BrewEnvProbe {
  /** 检查单个路径是否存在。 */
  private static exists(path: string): boolean {
    try {
      return fileIo.accessSync(path);
    } catch (e) {
      return false;
    }
  }

  /** 探测运行环境。任一步骤抛错都收敛为「未就绪」，不会影响页面渲染。 */
  public static probe(): BrewEnvStatus {
    const storageReadable: boolean = BrewEnvProbe.exists('/storage/Users/currentUser');
    const status: BrewEnvStatus = {
      storageReadable: storageReadable,
      brewInstalled: BrewEnvProbe.exists(HARMONYBREW_ROOT + '/bin/brew'),
      nodeInstalled: BrewEnvProbe.exists(HARMONYBREW_ROOT + '/bin/node'),
      dshInstalled: BrewEnvProbe.exists(HARMONYBREW_ROOT + '/bin/dsh')
    };
    DshmLogger.info(TAG, '运行环境: brew=' + String(status.brewInstalled)
      + ' node=' + String(status.nodeInstalled)
      + ' dsh=' + String(status.dshInstalled)
      + ' storage=' + String(status.storageReadable));
    return status;
  }

  /** 汇总成一行状态文案（「运行环境」面板标题下使用）。 */
  public static describe(status: BrewEnvStatus): string {
    if (!status.storageReadable) {
      return '未授予全盘文件访问，无法探测 Harmonybrew 环境';
    }
    if (!status.brewInstalled) {
      return '未检测到 Harmonybrew —— 安装后可获得完整运行时（原生 node + JIT + python）';
    }
    if (!status.dshInstalled) {
      return 'Harmonybrew 已安装，但未安装 deepseek-harness';
    }
    return 'Harmonybrew + deepseek-harness 已就绪，功能完整';
  }
}
