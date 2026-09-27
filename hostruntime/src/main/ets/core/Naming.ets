/**
 * 核心分发容器与版本目录的命名规则（纯字符串逻辑，无 IO）。
 *
 * 约定由 hostcore/core-recipe.json 与 tools/pack-core.mjs 定义：
 *   容器名   dsh-core-<version>-openharmony-arm64.zip
 *   顶层目录 dsh-core-<version>/
 *   树内元数据 <top>/dshm-core.json
 *
 * 为什么单独一层：版本号**会变成目录名**，而它来自一个文件名。
 * 所以"这个名字能不能安全地当目录名用"必须是一个显式的、可单测的判据，
 * 而不是散落在各处的字符串拼接。
 */

export const ARCHIVE_PREFIX: string = 'dsh-core-';
export const ARCHIVE_SUFFIX: string = '-openharmony-arm64.zip';
export const TREE_INFO_FILE: string = 'dshm-core.json';

/** 版本号长度上限（防止异常文件名撑爆目录名）。 */
const MAX_VERSION_LEN: number = 64;

/**
 * 版本号是否可安全用作目录名。
 * 拒绝：空、过长、含路径分隔符、含 `..`、含首尾空白、含控制字符、含 Windows/Unix 保留字符。
 */
export function isSafeVersion(version: string): boolean {
  if (version.length === 0 || version.length > MAX_VERSION_LEN) {
    return false;
  }
  if (version !== version.trim()) {
    return false;
  }
  if (version.includes('/') || version.includes('\\') || version.includes('..')) {
    return false;
  }
  for (let i = 0; i < version.length; i++) {
    const c: number = version.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      return false;
    }
  }
  const reserved: string[] = [':', '*', '?', '"', '<', '>', '|'];
  for (const r of reserved) {
    if (version.includes(r)) {
      return false;
    }
  }
  return true;
}

/** 从容器文件名解析版本号；不是本项目的容器名则返回空串。 */
export function parseArchiveName(fileName: string): string {
  if (!fileName.startsWith(ARCHIVE_PREFIX) || !fileName.endsWith(ARCHIVE_SUFFIX)) {
    return '';
  }
  const version: string = fileName.substring(ARCHIVE_PREFIX.length, fileName.length - ARCHIVE_SUFFIX.length);
  return isSafeVersion(version) ? version : '';
}

/** 容器内的顶层目录名。 */
export function topDirOf(version: string): string {
  return `${ARCHIVE_PREFIX}${version}`;
}

/** 容器文件名。 */
export function archiveNameOf(version: string): string {
  return `${ARCHIVE_PREFIX}${version}${ARCHIVE_SUFFIX}`;
}

/**
 * **确定性**比较两个核心版本号的大小（返回值同 `Array.sort` 约定：<0 / 0 / >0）。
 *
 * 【为什么必须自己写，而不是用 `localeCompare` 或字符串比较】
 * 核心版本号形如 `0.1.7-rc.2`，**纯字典序是错的**：
 *   · `'0.1.7-rc.10' < '0.1.7-rc.2'`（字典序把 `10` 排在 `2` 前面）；
 *   · `'0.1.10' < '0.1.7'` 同理；
 *   · 而且 `rc` / `alpha` / 无后缀（正式版）之间还有**阶段顺序**（alpha < rc < release）。
 * 这条比较是"多版本并存时选谁启动"的**唯一判据**，错了就会启动旧树
 * （2026-09-25 真机实测：装了 rc.2 却仍跑 rc.1，见下）。
 *
 * 【规则】主版本按数值逐段比 → 相同则比阶段（release > rc > alpha）→
 * 相同则比阶段序号（数值）→ 仍相同则回退到字符串比较（保证全序、结果稳定）。
 * 无法解析的段落一律当 0（**不抛错**：版本号来自目录名，宁可给出一个确定次序）。
 */
export function compareVersions(a: string, b: string): number {
  const splitOf = (v: string): string[] => v.split(/[.\-+]/).filter((s: string): boolean => s.length > 0);
  /**
   * 阶段优先级：数值越大越"新"。
   * 【为什么 alpha 与 beta 要分开】标准预发布顺序是
   * `alpha < beta < rc < release`（semver 的早期版本链也这么排）。
   * 最初我把 alpha 与 beta 合成一档，结果 `beta.1` 与 `alpha.9` 会退化成"比序号"，
   * 得到 `beta.1 < alpha.9`（错）——**单测当场抓到**（见 Naming 的 14 项比较用例）。
   * dsh 实际只用到 alpha/rc，但比较函数是"启动哪棵树"的判据，排序错会启动错的版本，
   * 故按标准排全。
   */
  const stageRank = (s: string): number => {
    const l: string = s.toLowerCase();
    if (l === 'release' || l === 'final' || l === 'stable') {
      return 4;
    }
    if (l === 'rc') {
      return 3;
    }
    if (l === 'beta') {
      return 2;
    }
    if (l === 'alpha') {
      return 1;
    }
    return 0; // 纯数字段：不是阶段
  };
  const pa: string[] = splitOf(a);
  const pb: string[] = splitOf(b);
  const n: number = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    /*
     * 【一方已无段落时怎么判（这里踩过一次）】
     * `0.1.7` 与 `0.1.7-rc.1` 比到第 4 段时，前者没有段落。**不能默认"有段落的更新"**
     * ——那会把 rc 排在正式版之后（错）。正确语义：
     *   · 缺失一方 ⇒ 视为「正式版」（StageRelease），比任何预发布阶段都高；
     *   · 于是 `0.1.7` > `0.1.7-rc.1`，而 `0.1.7-rc.1` > `0.1.7-rc.0.1`（同为 rc 比序号）。
     * 这正是 semver 的规则（预发布版低于同号正式版）。
     */
    const sa: string = i < pa.length ? pa[i] : '';
    const sb: string = i < pb.length ? pb[i] : '';
    if (sa.length === 0 && sb.length === 0) {
      continue;
    }
    if (sa.length === 0) {
      // b 还有段落：只有当那段是**预发布标记**（alpha/beta/rc）时 a 才更大；
      // 否则 b 是更长的正式号（如 0.1.7.1 > 0.1.7）⇒ b 更大。
      return stageRank(sb) > 0 ? 1 : -1;
    }
    if (sb.length === 0) {
      return stageRank(sa) > 0 ? -1 : 1;
    }
    const na: number = parseInt(sa, 10);
    const nb: number = parseInt(sb, 10);
    const aNum: boolean = !isNaN(na) && String(na) === sa;
    const bNum: boolean = !isNaN(nb) && String(nb) === sb;
    if (aNum && bNum) {
      if (na !== nb) {
        return na < nb ? -1 : 1;
      }
      continue;
    }
    // 有一方是阶段标记（或非纯数字）：先比阶段优先级（release > rc > beta > alpha）。
    const ra: number = stageRank(sa);
    const rb: number = stageRank(sb);
    if (ra !== rb) {
      return ra < rb ? -1 : 1;
    }
    // 同为同一阶段（如两边都是 `rc`）：阶段序号是**下一段**，留给下一轮循环比。
    // 两边都不是已知阶段（自定义标签）：退到字符串比较，保证全序与确定性。
    if (ra === 0 && sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 从一组已安装版本里挑出**应当启动**的那个：最新的一个。
 *
 * 【为什么必须有这个函数（2026-09-25 真机实证）】
 * `DshHost.start()` 原先写的是：
 *     `target = state.current 有效 ? state.current : installed[0]`
 * 而 `listInstalled()` 直接返回 `fs.listFileSync()` 的**目录枚举顺序**
 * ——**顺序未定义**。于是"没写 state.current 时"启动哪一棵树是**碰运气**：
 * 真机上是装了 rc.2、也解包成功了，却仍启动 rc.1（枚举恰好把它排前面）。
 * 这解释了此前"升级后必须手工删掉旧树才生效"的操作（批次十一记为
 * "删旧树即切换"）——那不是设计，是**掩盖了这个未定义行为**。
 * ⇒ 未指定 current 时的语义应当是明确的：**用最新的那棵**。
 *
 * @param installed 已安装版本（顺序任意，本函数不依赖它）
 * @returns 最新版本；`installed` 为空时返回空串
 */
export function newestVersion(installed: string[]): string {
  if (installed.length === 0) {
    return '';
  }
  let best: string = installed[0];
  for (let i = 1; i < installed.length; i++) {
    if (compareVersions(installed[i], best) > 0) {
      best = installed[i];
    }
  }
  return best;
}
