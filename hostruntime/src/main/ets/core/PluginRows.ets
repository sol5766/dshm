/**
 * 端侧「插件」页维护的**用户行**（E91）。
 *
 * ───────────────────────── 它解决什么 ─────────────────────────
 * 目标里有"插件管理"。而端侧有一条硬边界：上游的安装通道 `dsh plugin add` 是
 * `spawnSync("pnpm", …)`（`dsh/lib/plugin-D42…js`），鸿蒙不允许应用创建进程 ⇒ **安装/卸载
 * 插件永远做不到**。但"**启停已经随包发版的行**"是纯文件操作，可以做——这就是本模块。
 *
 * ───────────────────── 为什么要有"用户行"这份独立文件 ─────────────────────
 * dsh 的 profile 分层里，"用户层"就是 `<profile 目录>/cordis.patch.yml`
 * （`dsh-app-boot/lib/index.js:861`）。而入口脚本**每次启动**都会用核心树里的种子覆盖
 * 那个文件（否则核心升级带来的 profile 变更就进不来），所以直接写它会丢。
 * 于是拆成两件事：
 *   · `cordis.patch.yml`：**每次启动重新拼装** = 核心种子 + 本文件里的用户行；
 *   · `.dshm-plugin-rows.yml`（本文件）：**只放用户行**，谁都不覆盖它。
 * ⇒ 启停在重启后仍然成立，且核心升级照常流入。"恢复默认"因此是一次**删除**。
 *
 * ─────────────────────────── 行 id 是哪一个 ───────────────────────────
 * 用 **profile 行 id**（如 `ui-deliverables`），不是 Loader 报出来的 entryId
 * （如 `include:ui-deliverables`）——patch 行是按前者匹配的。本机实测（可复跑）：
 * `node tools/check-plugin-toggle.mjs` → `enabled=true` 翻成 `false`、`RESULT: PASS`。
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { OpResult } from './CoreStore';

const DOMAIN: number = 0x0000;
const TAG: string = 'DSHM-PluginRows';

/** 用户行文件名（相对于 profile 目录）。入口脚本按同一名字读取。 */
export const USER_ROWS_FILENAME: string = '.dshm-plugin-rows.yml';

/** 一行用户覆盖：只表达"这个行 id 是启用还是禁用"。 */
export interface UserPluginRow {
  id: string;
  disabled: boolean;
}

/** 解析结果：**忽略的行要报出来**，不能静默丢内容。 */
export interface UserPluginRowsParse {
  rows: UserPluginRow[];
  /** 无法识别的非空行数（>0 时界面应如实提示） */
  ignored: number;
}

/** 用户行文件路径（profile 目录下）。 */
export function userRowsPath(profileDir: string): string {
  return `${profileDir}/${USER_ROWS_FILENAME}`;
}

/**
 * 序列化成**我们自己**的 YAML 片段。
 *
 * 只写两行一个条目，字段名与 profile 行一致（`id` / `disabled`），这样它被拼进
 * `cordis.patch.yml` 之后就是一份普通的 patch 层，人也能读、能改。
 */
export function serializeUserRows(rows: UserPluginRow[]): string {
  const out: string[] = [
    '# 端侧「插件」页维护的用户行：只写「行 id + disabled」。',
    '# 本文件由应用写入；「恢复默认」会删除它（下次启动就不再拼上这段）。',
    '# 入口脚本会把这段追加到 profile 的 cordis.patch.yml 末尾（后写覆盖先写）。',
  ];
  for (const row of rows) {
    out.push(`- id: ${row.id}`);
    out.push(`  disabled: ${row.disabled ? 'true' : 'false'}`);
  }
  out.push('');
  return out.join('\n');
}

/** 解析我们自己的片段。容错，但把无法识别的行数如实回报。 */
export function parseUserRows(text: string): UserPluginRowsParse {
  const rows: UserPluginRow[] = [];
  let ignored: number = 0;
  let current: UserPluginRow | undefined = undefined;
  for (const rawLine of text.split('\n')) {
    const line: string = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    if (line.startsWith('- id:')) {
      const id: string = line.substring('- id:'.length).trim();
      if (id.length === 0) {
        ignored++;
        current = undefined;
      } else {
        current = { id: id, disabled: true };
        rows.push(current);
      }
      continue;
    }
    if (line.startsWith('disabled:') && current !== undefined) {
      const value: string = line.substring('disabled:'.length).trim().toLowerCase();
      current.disabled = value !== 'false';
      continue;
    }
    ignored++;
  }
  return { rows: rows, ignored: ignored };
}

/** 读用户行（文件不存在 = 没有用户覆盖，返回空数组而不是失败）。 */
export function readUserRows(profileDir: string): UserPluginRow[] {
  const path: string = userRowsPath(profileDir);
  try {
    if (!fs.accessSync(path)) {
      return [];
    }
    return parseUserRows(fs.readTextSync(path)).rows;
  } catch (e) {
    const err = e as BusinessError;
    hilog.warn(DOMAIN, TAG, '读用户插件行失败：%{public}s', err.message);
    return [];
  }
}

/** 写用户行（空数组 = 写一个空文件，等价于"没有覆盖"）。 */
export function writeUserRows(profileDir: string, rows: UserPluginRow[]): OpResult {
  const path: string = userRowsPath(profileDir);
  try {
    const f: fs.File = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    try {
      fs.writeSync(f.fd, serializeUserRows(rows));
    } finally {
      fs.closeSync(f);
    }
    return { ok: true, message: `已保存 ${rows.length} 条插件启停` };
  } catch (e) {
    const err = e as BusinessError;
    return { ok: false, message: `写用户插件行失败：${err.code} ${err.message}` };
  }
}

/** 恢复默认：删除用户行文件（幂等）。 */
export function clearUserRows(profileDir: string): OpResult {
  const path: string = userRowsPath(profileDir);
  try {
    if (fs.accessSync(path)) {
      fs.unlinkSync(path);
    }
    return { ok: true, message: '已恢复默认（用户启停设置已清除）' };
  } catch (e) {
    const err = e as BusinessError;
    return { ok: false, message: `清除用户插件行失败：${err.code} ${err.message}` };
  }
}
