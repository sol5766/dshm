/**
 * 插件清单同步（docs/310）：把「装了哪些插件」变成可跨端同步的资产。
 *
 * ── 为什么插件可以同步而核心树不行 ────────────────────────────────────
 * `profiles/ondevice/node_modules` 是**装好的产物**（143 MB），每端架构不同，
 * 传过去必坏。但**装了什么**（`package.json` 的 `dependencies` + `dsh.profile.bundles`）
 * 只有几 KB，而且**原样交给本端的安装器就能重装** —— 安装器本来就支持
 * `github:owner/repo#ref` 与 npm 版本两种 spec。
 *
 * 所以策略是：**同步清单，不产物；到端后走既有安装队列自动重装。**
 *
 * ── 与既有安装通道的关系（不另造轮子）─────────────────────────────────
 * 本模块**只产 spec 列表**，不直接执行安装。真正安装仍走：
 *   `$DSH_HOME/install-queue/*.req`（spec 文本）→ `dshm-installer.js` 的 `installSpec()`
 * 这样插件安装的**全部既有约束（完整性校验、失败回执、并发控制）继续生效**。
 *
 * ── 三条纪律 ──────────────────────────────────────────────────────────
 * 1. **只读** `package.json`，不碰 `node_modules`。
 * 2. **保留顺序**：`bundles` 的顺序影响 patch 应用顺序（见 `cordis.patch.yml` 头注），
 *    同步后必须按原顺序写回。
 * 3. **不装基础 bundle**：`@deepseek-ai/dsh-base` 这类是随核心树附带的，
 *    不是用户装的，同步它们只会制造噪音。
 *
 * @module sync/PluginManifest
 */
import { fileIo as fs } from '@kit.CoreFileKit';

/**
 * 一个用户插件的安装规格。
 */
export interface PluginSpec {
  /** 包名（keys of `dependencies`） */
  name: string;
  /** 安装 spec 原文：`github:o/r#ref` 或 npm 版本号 */
  spec: string;
}

/** 插件清单（跨端同步的最小载荷）。 */
export interface PluginManifest {
  /** 清单格式版本（改形状必须 +1） */
  schema: number;
  /** 用户插件，**保持 bundles 中的相对顺序** */
  plugins: PluginSpec[];
  /** 读取时遇到的问题（要能解释，不静默丢弃） */
  skipped: string[];
}

/** 清单 schema 号。 */
export const PLUGIN_MANIFEST_SCHEMA: number = 1;

/**
 * 随核心树附带的基础 bundle —— **不是用户装的**，不参与同步。
 *
 * 【为什么按前缀判断】`@deepseek-ai/*` 全部是上游自带（base / web-app / 子代理等），
 * 它们的版本跟随**核心树版本**走，由 `core-recipe.json` 管理。
 * 若把它们写进同步清单，换端时会被当成"用户插件"去装，与核心树自带的版本冲突。
 */
const BUNDLED_PREFIX: string = '@deepseek-ai/';

/** 判断一个包名是否属于"随核心树附带"的部分。 */
export function isBundledPackage(name: string): boolean {
  const n: string = String(name === undefined || name === null ? '' : name);
  return n.startsWith(BUNDLED_PREFIX);
}

/** 从 `dependencies` 里挑出的 spec 形态判断（只是分类，不改写内容）。 */
export function specKind(spec: string): string {
  const s: string = String(spec === undefined || spec === null ? '' : spec);
  if (s.startsWith('github:') || s.startsWith('git+') || s.startsWith('git@')) {
    return 'git';
  }
  if (s.startsWith('file:') || s.startsWith('link:')) {
    return 'local';
  }
  if (s.startsWith('npm:') || s.startsWith('workspace:')) {
    return 'alias';
  }
  return 'npm';
}

/**
 * 从 profile 的 `package.json` 文本解析出插件清单。
 *
 * 【为什么吃文本而不是路径】本模块要保持可测：传入 JSON 文本就能纯函数式验证，
 * 不需要真机文件系统。读文件是调用方的事。
 *
 * @param packageJsonText `profiles/ondevice/package.json` 的内容
 * @returns 清单；解析失败时 `plugins` 为空且 `skipped` 带原因
 */
export function parsePluginManifest(packageJsonText: string): PluginManifest {
  const out: PluginManifest = { schema: PLUGIN_MANIFEST_SCHEMA, plugins: [], skipped: [] };
  const text: string = String(packageJsonText === undefined || packageJsonText === null ? '' : packageJsonText);
  if (text.trim().length === 0) {
    out.skipped.push('package.json 为空');
    return out;
  }
  let root: Record<string, Object> | null = null;
  try {
    root = JSON.parse(text) as Record<string, Object>;
  } catch (e) {
    out.skipped.push('package.json 不是合法 JSON');
    return out;
  }
  if (root === null) {
    out.skipped.push('package.json 解析为空');
    return out;
  }

  const deps: Record<string, string> = (root['dependencies'] ?? {}) as Record<string, string>;

  /*
   * 【顺序从哪来】`dependencies` 在 JSON 里的键顺序就是 pnpm 的写入顺序，
   * 而 `dsh.profile.bundles` 才是**真正决定 patch 应用顺序**的列表。
   * 因此以 bundles 为准排序，bundles 里没有的（理论上不该发生）追加在后面。
   */
  const bundles: string[] = [];
  const dsh: Record<string, Object> | null = (root['dsh'] ?? null) as Record<string, Object> | null;
  if (dsh !== null) {
    const profile: Record<string, Object> | null = (dsh['profile'] ?? null) as Record<string, Object> | null;
    if (profile !== null) {
      const raw: Object | undefined = profile['bundles'];
      if (raw !== undefined && raw !== null) {
        const arr: Object[] = raw as Object[];
        for (let i: number = 0; i < arr.length; i++) {
          const name: string = String(arr[i]);
          if (!isBundledPackage(name)) {
            bundles.push(name);
          }
        }
      }
    }
  }

  const seen: Set<string> = new Set<string>();
  /* ① 先按 bundles 顺序取 */
  for (let i: number = 0; i < bundles.length; i++) {
    const name: string = bundles[i];
    const spec: string | undefined = deps[name];
    if (spec === undefined) {
      out.skipped.push(`${name} 在 bundles 里但 dependencies 里没有（跳过）`);
      continue;
    }
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    out.plugins.push({ name: name, spec: String(spec) });
  }
  /* ② 再补 dependencies 里剩下的用户包（保持其原顺序） */
  const depNames: string[] = Object.keys(deps);
  for (let i: number = 0; i < depNames.length; i++) {
    const name: string = depNames[i];
    if (seen.has(name) || isBundledPackage(name)) {
      continue;
    }
    seen.add(name);
    out.plugins.push({ name: name, spec: String(deps[name]) });
  }
  return out;
}

/**
 * 读端侧的插件清单。
 *
 * @param profileDir `$DSH_HOME/profiles/ondevice`
 */
export function readPluginManifest(profileDir: string): PluginManifest {
  const dir: string = String(profileDir === undefined || profileDir === null ? '' : profileDir).trim();
  if (dir.length === 0) {
    return { schema: PLUGIN_MANIFEST_SCHEMA, plugins: [], skipped: ['profileDir 为空'] };
  }
  const path: string = `${dir}/package.json`;
  try {
    if (!fs.accessSync(path)) {
      return { schema: PLUGIN_MANIFEST_SCHEMA, plugins: [], skipped: [`找不到 ${path}`] };
    }
    const text: string = fs.readTextSync(path);
    return parsePluginManifest(text);
  } catch (e) {
    return { schema: PLUGIN_MANIFEST_SCHEMA, plugins: [], skipped: [`读取 ${path} 失败`] };
  }
}

/**
 * 把清单转成"待安装"的 JSON 载荷（云端存储用）。
 *
 * 【为什么只存 name + spec】安装只需要这两个字段。存 `node_modules` 路径、
 * 解析后的版本号都不必要，而且会随端变化 —— 清单要的是**可重放的意图**。
 */
export function toInstallPayload(manifest: PluginManifest): string {
  const rows: string[] = [];
  for (let i: number = 0; i < manifest.plugins.length; i++) {
    const p: PluginSpec = manifest.plugins[i];
    rows.push(`{"name":${JSON.stringify(p.name)},"spec":${JSON.stringify(p.spec)}}`);
  }
  return `{"schema":${PLUGIN_MANIFEST_SCHEMA},"plugins":[${rows.join(',')}]}`;
}

/**
 * 判断本端缺哪些插件（用于"自动安装"与"批量安装"两种模式）。
 *
 * @param remote 云端清单
 * @param localDir 本端 profile 目录
 * @returns 本端**没有**的插件（按远端顺序）
 */
export function missingPlugins(remote: PluginManifest, localDir: string): PluginSpec[] {
  const local: PluginManifest = readPluginManifest(localDir);
  const have: Set<string> = new Set<string>();
  for (let i: number = 0; i < local.plugins.length; i++) {
    have.add(local.plugins[i].name);
  }
  const out: PluginSpec[] = [];
  for (let i: number = 0; i < remote.plugins.length; i++) {
    const p: PluginSpec = remote.plugins[i];
    if (!have.has(p.name)) {
      out.push(p);
    }
  }
  return out;
}
