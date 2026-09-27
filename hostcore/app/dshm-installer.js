'use strict';
/**
 * DSHM 进程内插件安装器（D26 运行时安装通道，2026-09-21）。
 *
 * 【解决什么】端侧没有 pnpm/npm/git（E86 硬边界：上游 `dsh plugin add` =
 * spawnSync("pnpm")，第一步就 ENOENT），也没有独立 node 可执行文件跑它们
 * （Node 以 libnode.so 形式嵌入，D6 E15）⇒ web/CLI 的所有安装路径在端侧
 * 都是死路。本模块把「安装」拉回进程内：
 *   spec 解析 → HTTPS 拉 tarball → 纯 JS gunzip + ustar 解包 →
 *   profile node_modules 落位 → package.json merge → 用户插件行追加（E91）
 *
 * 【触发方式】不由本模块决定：hostcore/app/main.js 轮询
 * `$DSH_HOME/install-queue/*.req`（spec 文本文件），调 installSpec(spec)，
 * 结果写回同目录 `<id>.done` / `<id>.fail`（JSON）。写 .req 的一侧可以是
 * ArkUI 设置页（SettingsPlugins 的安装区块）或模型（skill：ohos-plugin-install）。
 *
 * 【spec 支持范围】与上游 dsh-plugin-manager 的 install-spec 三形态对齐：
 *   1. npm 包名（`<name>` / `<name>@<version>` / `@scope/name`）
 *   2. git URL（https://github.com/o/r(.git) / git@github.com:o/r.git）
 *   3. hosted repo URL（github.com/o/r，#branch 可选）
 * 其它 git host 不支持（如实报错，不猜）。
 *
 * 【为什么纯 JS 解 tar 而不 spawn busybox tar】busybox 副本虽有 tar 能力，
 * 但 spawn 在端侧始终带平台级不确定性（执行位/权限策略），而 tgz =
 * gzip(ustar)，node:zlib.gunzipSync + 512 字节头解析是零依赖的确定性路径。
 * 沙箱禁止 symlink（真机探针 13900012）：tar 里的 symlink 条目如实跳过并
 * 在结果里列出，不让安装静默残缺。
 *
 * 【依赖递归的边界】只递归 dependencies（devDependencies/peerDependencies
 * 不装，optionalDependencies 尽力装失败不阻断），深度 ≤3，同名单轮去重、
 * 已存在（node_modules 里有 package.json）跳过。版本选择用简化 semver
 * （^ ~ 精确 * latest >=），足够覆盖 dsh 插件生态的常规写法。
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const zlib = require('node:zlib');
// 与启动期预检（composeUserRows/sanitizeDependencies）同判据的入口检查——
// 两边判据不一致就是"装完即被拒拼/隔离"的配方（真机实证见 installSpecInner 落位校验注释）。
const { userRowLoadable } = require('./dshm-user-rows.js');

/** 默认 registry：npmmirror（大陆 CDN，完整 npm 镜像）；可在 <homeDir>/installer.json 覆盖。 */
const DEFAULT_REGISTRY = 'https://registry.npmmirror.com';
/** 依赖递归最大深度（顶层为 0）。 */
const MAX_DEPTH = 3;
/** 单包下载超时（ms）。 */
const FETCH_TIMEOUT_MS = 30000;

// ── 皮肤市场「展示名 → 真实安装 spec」映射 ───────────────────────────────
// 真机实证 2026-09-24：dsh-skin-market 的目录里用 `@dsh-external/dsh-client-ui-skin-*`
// 当展示名，但真实发布到 npm 的包名是作者自己的 scope（如 @smalltailqwq/…），也有的是
// 独立 GitHub 仓库（如 Ewnscat-ya/dsh-client-ui-skin-denia）。展示名在 registry 上
// 查无此包 → 市场的"下载并检查安装包"（pnpm view）就 exit 1，其实与 dsh 版本无关。
// 这里把已知展示名映射到真实安装 spec（npm 真实包名 / github: 源），view 与 install
// 都在 resolveSpec 前先做改写，让市场里的皮肤能真正装上。未知 spec 原样透传。
const SKIN_ALIAS_MAP = {
  '@dsh-external/dsh-client-ui-skin-orca-link': '@smalltailqwq/dsh-client-ui-skin-orca-link',
  '@dsh-external/dsh-client-ui-skin-maid-atelier': '@smalltailqwq/dsh-client-ui-skin-maid-atelier',
  '@dsh-external/dsh-client-ui-skin-dusia': 'github:Ewnscat-ya/dsh-client-ui-skin-denia',
  '@dsh-external/dsh-client-ui-skin-denia': 'github:Ewnscat-ya/dsh-client-ui-skin-denia',
};

/** 把展示名改写为真实安装 spec；无匹配则原样返回。 */
function dshmSkinAlias(spec) {
  const s = (spec || '').trim();
  return typeof s === 'string' ? (Object.prototype.hasOwnProperty.call(SKIN_ALIAS_MAP, s) ? SKIN_ALIAS_MAP[s] : s) : s;
}

// ── HTTP（node:https，手动跟随重定向）──────────────────────────────────

function httpGet(urlStr, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlStr, {
      headers: { 'user-agent': 'dshm-installer/1 (+dsh-host)' },
      timeout: FETCH_TIMEOUT_MS,
    }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error('重定向次数过多：' + urlStr));
          return;
        }
        let next = '';
        try {
          next = new URL(res.headers.location, urlStr).toString();
        } catch (e) {
          reject(new Error('重定向地址非法：' + res.headers.location));
          return;
        }
        httpGet(next, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (code !== 200) {
        res.resume();
        reject(new Error('HTTP ' + code + '：' + urlStr));
        return;
      }
      resolve(res);
    });
    req.on('timeout', () => {
      req.destroy(new Error('请求超时（' + FETCH_TIMEOUT_MS + 'ms）：' + urlStr));
    });
    req.on('error', reject);
  });
}

async function fetchBuffer(urlStr) {
  const res = await httpGet(urlStr, 5);
  const chunks = [];
  for await (const c of res) {
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function fetchJson(urlStr) {
  const buf = await fetchBuffer(urlStr);
  return JSON.parse(buf.toString('utf8'));
}

// ── ustar 解包（含 GNU longname；symlink 跳过并如实报告）──────────────

function readTarStr(buf, start, len) {
  const s = buf.subarray(start, start + len).toString('utf8');
  const nul = s.indexOf('\0');
  return nul >= 0 ? s.slice(0, nul) : s;
}

/**
 * 解 ustar/gnu tar 到 destDir。返回 { written: number, skipped: string[] }。
 * 【安全】条目路径先剥 npm tarball 的 `package/` 前缀，再逐段校验：
 * 任何 `..` 段或绝对路径直接抛错（tar-slip 防护），不静默跳过。
 */
function extractTar(tarBuf, destDir) {
  let off = 0;
  let longName = null;
  let written = 0;
  const skipped = [];
  while (off + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) {
      break; // 结束块
    }
    let name = longName !== null ? longName : readTarStr(header, 0, 100);
    longName = null;
    const prefix = readTarStr(header, 345, 155);
    if (prefix.length > 0 && longName === null && name.length < 100) {
      name = prefix + '/' + name;
    }
    const sizeField = readTarStr(header, 124, 12).trim();
    const size = sizeField.length > 0 ? (parseInt(sizeField, 8) || 0) : 0;
    const type = String.fromCharCode(header[156] || 0x30);
    off += 512;
    const padded = Math.ceil(size / 512) * 512;
    const dataEnd = off + size;
    if (type === 'L') { // GNU long name：内容是下一个条目的名字
      longName = readTarStr(tarBuf, off, size);
      off += padded;
      continue;
    }
    if (type === 'K') { // GNU long linkname：与文件落位无关
      off += padded;
      continue;
    }
    if (type === 'x' || type === 'g') { // pax 头：跳过（内容以键值对形式描述元数据）
      off += padded;
      continue;
    }
    // 剥 npm tarball 的 package/ 根前缀（0/1 层）
    let rel = name;
    if (rel === 'package' || rel === 'package/') {
      off += padded;
      continue; // 根目录条目本身
    }
    if (rel.startsWith('package/')) {
      rel = rel.slice('package/'.length);
    }
    rel = rel.replace(/\/+$/, '');
    if (rel.length === 0) {
      off += padded;
      continue;
    }
    const segs = rel.split('/');
    if (rel.startsWith('/') || rel.startsWith('\\') || segs.indexOf('..') >= 0) {
      throw new Error('tar 条目路径不安全，拒绝解包：' + name);
    }
    const target = path.join(destDir, ...segs);
    if (type === '5') {
      fs.mkdirSync(target, { recursive: true });
    } else if (type === '0' || type === '\0') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, tarBuf.subarray(off, dataEnd));
      written += 1;
    } else {
      // '1'/'2' = symlink/hardlink（沙箱禁 link，13900012）；其余罕见类型跳过
      skipped.push(name + '（type=' + type + '）');
    }
    off += padded;
  }
  return { written, skipped };
}

// ── 简化 semver（^ ~ 精确 * latest >= <）───────────────────────────────

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (m === null) {
    return null;
  }
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

/** 在 versions 键列表里选满足 range 的最高稳定版（跳过 prerelease）。 */
function pickVersion(range, versions, latest) {
  const clean = (range || '').trim();
  if (clean.length === 0 || clean === '*' || clean === 'latest' || clean === 'x') {
    return latest || versions[versions.length - 1] || null;
  }
  let m = /^([\^~]?)(\d+)(?:\.(\d+)?)?(?:\.(\d+)?)?$/.exec(clean);
  if (m !== null) {
    const kind = m[1];
    const maj = Number(m[2]);
    const min = m[3] !== undefined ? Number(m[3]) : null;
    const pat = m[4] !== undefined ? Number(m[4]) : null;
    let best = null;
    for (const v of versions) {
      const pv = parseVersion(v);
      if (pv === null) {
        continue;
      }
      if (kind === '^') {
        const upper = maj === 0 ? (min === 0 ? [0, 0, pat === null ? 0 : pat + 1] : [0, min === null ? 1 : min + 1, 0]) : [maj + 1, 0, 0];
        if (cmpVersion(pv, [maj, min === null ? 0 : min, pat === null ? 0 : pat]) >= 0 && cmpVersion(pv, upper) < 0) {
          if (best === null || cmpVersion(pv, best) > 0) {
            best = pv;
          }
        }
      } else if (kind === '~') {
        const upper = [maj, (min === null ? 0 : min) + 1, 0];
        if (cmpVersion(pv, [maj, min === null ? 0 : min, pat === null ? 0 : pat]) >= 0 && cmpVersion(pv, upper) < 0) {
          if (best === null || cmpVersion(pv, best) > 0) {
            best = pv;
          }
        }
      } else {
        // 精确或省略通配：1 / 1.2 / 1.2.3
        if (pv[0] === maj && (min === null || pv[1] === min) && (pat === null || pv[2] === pat)) {
          if (best === null || cmpVersion(pv, best) > 0) {
            best = pv;
          }
        }
      }
    }
    return best === null ? null : best.join('.');
  }
  m = /^>=(\d+\.\d+\.\d+)$/.exec(clean);
  if (m !== null) {
    const floor = parseVersion(m[1]);
    let best = null;
    for (const v of versions) {
      const pv = parseVersion(v);
      if (pv !== null && cmpVersion(pv, floor) >= 0 && (best === null || cmpVersion(pv, best) > 0)) {
        best = pv;
      }
    }
    return best === null ? null : best.join('.');
  }
  // 无法解析的范围：交回 latest（naive，但对 dsh 插件生态的常规写法覆盖足够）
  return latest || null;
}

// ── spec 解析（npm 包名 / GitHub 三形态）───────────────────────────────

/**
 * 解析 GitHub 形态的安装 spec，含 **monorepo 子目录**（`&path:`）。
 *
 * 【为什么要有 subpath（2026-09-25 报告 5 §2.1）】皮肤市场里有 36/302 个皮肤是
 * 「一个仓库放多个皮肤、每个皮肤各占一个子目录」（如
 * `Small-tailqwq/dsh-deep-whale` 下的 `maid-atelier/`、`orca-link/`）。市场给这类
 * 皮肤发的 spec 形如：
 *     github:Small-tailqwq/dsh-deep-whale#<commit>&path:/maid-atelier
 * 旧实现**先按 `#` 切分**，于是 `&path:/maid-atelier` 被当成 ref 的一部分 ⇒
 * codeload URL 变成 `…/tar.gz/<commit>&path:/maid-atelier` ⇒ **HTTP 404**（真机原文）。
 *
 * 【修正切分顺序】必须先切 `&path:`、再切 `#`，且**两种先后顺序都要兼容**
 * （市场数据里两种都出现过）。所以不靠"按位置切"，而是各自用正则从整串里**摘出来**：
 *   · `&path:<值>` 或 `?path=<值>`：取到第一个分隔符（`#`/`&`/`?`/空白）为止；
 *   · `#<ref>`：取 `#` 之后到下一个 `&`/`?` 为止。
 * 摘完之后剩下的才是 owner/repo 主体。
 *
 * @returns `{kind, owner, repo, ref, subpath}`；subpath 为空串表示"整仓库即包"。
 */
function parseGitHub(spec) {
  let s = (spec || '').trim();
  let branch = '';
  let subpath = '';
  /*
   * 先摘 path（两种拼法都认）。
   * `[^#&?\s]*` 而不是 `.*`：值到下一个分隔符为止——这样 `#commit&path:/x` 与
   * `&path:/x#commit` 两种顺序都能正确切出。
   */
  const pathMatch = /[&?]path[:=]([^#&?\s]*)/.exec(s);
  if (pathMatch !== null) {
    subpath = pathMatch[1].trim();
    s = s.slice(0, pathMatch.index) + s.slice(pathMatch.index + pathMatch[0].length);
  }
  // 再摘 ref（`#` 之后到下一个分隔符为止）。
  const hashAt = s.indexOf('#');
  if (hashAt >= 0) {
    const rest = s.slice(hashAt + 1);
    const stop = rest.search(/[&?\s]/);
    branch = (stop >= 0 ? rest.slice(0, stop) : rest).trim();
    s = s.slice(0, hashAt) + (stop >= 0 ? rest.slice(stop) : '');
  }
  s = s.trim();
  // 归一化 subpath：去掉前导 `/` 与 `./`，去掉尾部 `/`（后续按 join 用）。
  subpath = subpath.replace(/^\.?\//, '').replace(/\/+$/, '');
  // npm 的 github: 简写（github:owner/repo、github:owner/repo.git）——skin-market
  // 等插件市场传的就是这种。剥掉 github: 前缀后再按 owner/repo 走。
  if (/^github:/.test(s) && !/^github:\//.test(s)) {
    s = s.slice('github:'.length);
  }
  let m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#]+?)(?:\.git)?\/?$/.exec(s);
  if (m === null) {
    m = /^git@github\.com:([^/\s]+)\/([^/\s#]+?)(?:\.git)?$/.exec(s);
  }
  if (m === null) {
    // owner/repo 简写：非 @ 开头且恰好一段斜杠（@开头是 npm scope）
    m = /^([^@\s/]+)\/([^@\s/]+)$/.exec(s);
  }
  if (m === null) {
    return null;
  }
  return {
    kind: 'github',
    owner: m[1],
    repo: m[2],
    ref: branch.length > 0 ? branch : 'HEAD',
    subpath,
  };
}

function parseNpm(spec) {
  const s = (spec || '').trim();
  if (s.includes('://') || s.includes('@') && s.indexOf('@') === 0 && !/^@[^/\s]+\/[^@\s]+(@[^@\s]+)?$/.test(s)) {
    return null;
  }
  const m = /^((?:@[^/\s]+\/)?[^@\s/]+)(?:@([^@\s]+))?$/.exec(s);
  if (m === null) {
    return null;
  }
  return { kind: 'npm', name: m[1], range: m[2] || '' };
}

/** spec → { kind, tarballUrl, name?, version? }。npm 先查 registry，GitHub 直拼 codeload。 */
async function resolveSpec(spec, registry) {
  spec = dshmSkinAlias(spec); // 皮肤市场展示名 → 真实安装 spec
  const gh = parseGitHub(spec);
  if (gh !== null && spec.includes('/')) {
    return {
      kind: 'github',
      name: gh.owner + '--' + gh.repo, // GitHub 包名在落位时读 tarball 内 package.json 修正
      version: gh.ref,
      tarballUrl: 'https://codeload.github.com/' + gh.owner + '/' + gh.repo + '/tar.gz/' + gh.ref,
      // monorepo 子目录（`&path:`）：调用方据此在解包后进入该子目录取包（报告 5 §2.1）。
      subpath: gh.subpath,
    };
  }
  const np = parseNpm(spec);
  if (np === null) {
    throw new Error('无法识别的插件标识：' + spec + '（支持 npm 包名或 GitHub 仓库地址）');
  }
  // npm 元数据查询：优先给到的 registry（默认 npmmirror），查不到则回退官方 npmjs。
  // 皮肤/插件市场传的 `@dsh-external/dsh-client-ui-skin-*` 等 scoped 包部分只在官方
  // registry 发布、npmmirror 未同步（真机实证 2026-09-24：$\@scope 在 npmmirror 404）。
  // 让 npm 分录用双 registry 探测，安装源与 pnpm 默认一致（npmjs）。
  let meta = null;
  const fallbackRegistries = [registry].concat(registry.indexOf('registry.npmjs.org') === -1 ? ['https://registry.npmjs.org'] : []);
  for (const reg of fallbackRegistries) {
    try {
      const cand = await fetchJson(reg.replace(/\/+$/, '') + '/' + encodeURIComponent(np.name));
      if (cand && cand.versions && typeof cand.versions === 'object') {
        meta = cand;
        break;
      }
    } catch (e) {
      // 该 registry 404/网络失败：试下一个
    }
  }
  if (meta === null) {
    throw new Error('registry 元数据异常：' + np.name);
  }
  const all = Object.keys(meta.versions);
  const stable = all.filter((v) => !v.includes('-'));
  const distTags = meta['dist-tags'] || {};
  const version = pickVersion(np.range, stable.sort(cmpVersionByKey), distTags.latest);
  if (version === null) {
    throw new Error('registry 上找不到满足「' + np.range + '」的版本：' + np.name);
  }
  const vMeta = meta.versions[version];
  if (!vMeta || !vMeta.dist || !vMeta.dist.tarball) {
    throw new Error('版本缺 tarball 地址：' + np.name + '@' + version);
  }
  return { kind: 'npm', name: np.name, version, tarballUrl: vMeta.dist.tarball };
}

function cmpVersionByKey(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null) {
    return 1;
  }
  if (pb === null) {
    return -1;
  }
  return cmpVersion(pa, pb);
}

// ── profile 落位（node_modules / package.json / 用户行）───────────────

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

function ensureProfileDirs(profileDir) {
  fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true });
}

/**
 * merge profile package.json 的 dependencies（只增不改，保留其余字段）。
 *
 * 【2026-09-26 开发端落实 P1】依赖值优先写**请求 spec**，而不是一律 `^version`。
 *
 * 为什么：`dsh-skin-market` 的 `installedSpecMatches()` 会把 profile 里登记的依赖值
 * 与"用户审核过的来源"逐字比对。真机实测（0.1.7-rc.1）：端侧记 `^1.2.0`，而市场
 * 审的是 `github:owner/repo#<commit>` → `does not match the reviewed source/version`
 * → 安装被判"没装上"。
 *
 * 取值规则（与真 pnpm 语义对齐，同时满足市场的比对）：
 *   · 请求是 git/GitHub 形态（github:owner/repo[#ref]、git+https://…、owner/repo）
 *     ⇒ 原样记录该 spec——这正是市场审核比对的字符串；
 *   · 请求是 npm 形态且带显式范围（name@^1.2.3）⇒ 记录该范围；
 *   · 请求是纯包名（pnpm add foo）⇒ 记 `^<解析到的版本>`（pnpm 默认 save-prefix）。
 *
 * @param items 每项 `{ name, version, spec? }`；`spec` 存在时按上面的规则取用。
 */
function mergeDependencies(profileDir, installed) {
  const pkgPath = path.join(profileDir, 'package.json');
  const pkg = readJsonSafe(pkgPath) || {};
  pkg.dependencies = pkg.dependencies || {};
  for (const item of installed) {
    pkg.dependencies[item.name] = dependencyValueFor(item);
  }
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

/** 由请求 spec 推出要写进 dependencies 的值（见 mergeDependencies 注释的规则）。 */
function dependencyValueFor(item) {
  const raw = typeof item.spec === 'string' ? item.spec.trim() : '';
  const version = typeof item.version === 'string' ? item.version : '';
  if (raw.length === 0) {
    return '^' + version;
  }
  // git / GitHub 形态：原样记录（市场就是按这个字符串做来源比对）。
  if (parseGitHub(raw) !== null) {
    return raw;
  }
  if (/^(git\+|git:|https?:\/\/.*\.git)/i.test(raw)) {
    return raw;
  }
  // npm 形态：name@range ⇒ 记录 range；纯包名 ⇒ ^version。
  const at = raw.lastIndexOf('@');
  if (at > 0) {
    const range = raw.slice(at + 1);
    if (range.length > 0) {
      return range;
    }
  }
  return '^' + version;
}

/**
 * 顶层包装完之后该「登记到哪里」—— 由它的 `package.json.dsh` 形态决定。
 *
 * 【为什么需要这个判定】用户行是 `- id: <X>`，而 cordis 的 patch 语义是
 * **"按 id 更新已有条目"**（id 不存在时只告警跳过）。所以一行 `- id: <包名>` 只有在
 * "某个 bundle 的 patch 里恰好插入了**同名** entry"时才有意义，否则就是**孤儿行**。
 *
 * 【2026-09-25 真机证据（报告：billion-context 装了但不生效）】
 * 旧门控把 `dsh.bundle` 当成"真插件 ⇒ 值得写行"的**正**判据，方向正好相反：
 *   · `billion-context` 的 `dsh.bundle.patch = ./dsh.bundle.patch.yml`，
 *     该 patch 里 insert 的 entry id 是 **`bili-native`**（不是包名）；
 *   · 官方皮肤 `dsh-client-ui-skin-denia` 的 patch insert 的 id 是 **`ui-skin-denia`**。
 * ⇒ 对这两个包写 `- id: <包名>` **必然匹配不到任何条目**。后果有两层：
 *   ① 行是死的（挂载不了）；② 插件市场的 toggle 报 `no loader entry matched`，
 *   看起来像"插件坏了"。
 *
 * 【上游的权威口径】`dsh-plugin-manager` 的 `reconcile()`（`lib/index.js:241-250`）：
 * 对每个新装的 dependency，**声明了 `dsh.bundle` 的就 push 进 `dsh.profile.bundles`**
 * （并加载它的 patch）；**没声明的就 warn "installed as a plain dependency, not a
 * profile layer" 后跳过**。注意上游**根本没有"用户行"这个概念**——那是本项目的自有
 * 机制（因为我们的 `cordis.patch.yml` 每次启动被种子覆盖，需要一个旁路文件承载用户
 * 自己的 patch 行）。⇒ 装 bundle 型包时，**正确落点是 `dsh.profile.bundles`**。
 *
 * 【二分类】
 *   · `bundle` —— 声明了 `dsh.bundle`/`dsh.bundles` ⇒ **登记进 `dsh.profile.bundles`**，
 *                 **不写用户行**（它的 entry 由它自己的 patch 插入）。
 *   · `plain`  —— 其余（含纯库与无 `dsh` 字段者）⇒ **什么都不登记**（与上游 reconcile
 *                 一致："plain dependency, not a profile layer"）。
 *                 报告 3 那条"纯库不写行"的意图被**包含**而非推翻。
 *
 * 【为什么不再有"普通插件写用户行"这一支】报告建议里提到"普通插件 → 才写行"，但我在
 * 真实生态里**找不到这样的实例**：官方与社区插件（dshmarket / modlens /
 * dsh-better-sidebar / 各皮肤 / billion-context）**全部**声明 `dsh.bundle`。
 * 而"非 bundle 包"要能被 `- id: <包名>` 挂载，前提是**别处**已有同名 entry —— 那是
 * 无法从包自身推出的外部条件。故不实现该支（**宁可少写，不可写孤儿行**）。
 * 若将来真出现此类插件，判据应是"**该 id 在现有条目里真的存在**"，而不是"它有 dsh 字段"。
 *
 * @param pkg 顶层包的 `package.json` 解析结果
 * @returns {{kind: 'bundle'|'plain'}}
 */
function topPackageDisposition(pkg) {
  const dsh = pkg !== null && typeof pkg === 'object' && !Array.isArray(pkg) ? pkg.dsh : null;
  if (dsh !== null && typeof dsh === 'object' && !Array.isArray(dsh)
    && (dsh.bundle !== undefined || dsh.bundles !== undefined)) {
    return { kind: 'bundle' };
  }
  return { kind: 'plain' };
}

/**
 * 把包名登记进 profile 的 `dsh.profile.bundles`（幂等）。与上游 `reconcile()` 同落点。
 * @returns 是否真的写入（已存在返回 false）
 */
function appendProfileBundle(profileDir, name) {
  const pkgPath = path.join(profileDir, 'package.json');
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    return false;
  }
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
    return false;
  }
  pkg.dsh = pkg.dsh !== null && typeof pkg.dsh === 'object' && !Array.isArray(pkg.dsh) ? pkg.dsh : {};
  pkg.dsh.profile = pkg.dsh.profile !== null && typeof pkg.dsh.profile === 'object' && !Array.isArray(pkg.dsh.profile)
    ? pkg.dsh.profile : {};
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  if (bundles.includes(name)) {
    return false;
  }
  bundles.push(name);
  pkg.dsh.profile.bundles = bundles;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  return true;
}

/*
 * 【2026-09-25 删除 appendUserRow + yamlRowValue —— 删除本身就是这次的结论】
 *
 * 这两个函数原先负责"把包名写进 `.dshm-plugin-rows.yml` 作为 `- id: <包名>`"。
 * 报告（billion-context 装了但不生效 + 市场 toggle 报 no loader entry matched）让我
 * 把这条机制查到了底，结论是：**安装器写用户行这件事本身就是错的**。
 *
 * 证据链（三条，互相独立）：
 *   ① 用户行是 `- id: <X>`，而 cordis 的 patch 语义是**"按 id 更新已有条目"**
 *      （id 不存在时只告警跳过）⇒ 该行只在"确实存在 id 为 X 的条目"时才有意义。
 *   ② **没有 bundle 用自己做条目 id**。我在核心树里把 8 个声明 `dsh.bundle` 的包
 *      逐个查过：patch 插入的 entry id **恰好等于自己包名的，一个都没有**。
 *      生态里同样如此——`billion-context` 的 entry 是 `bili-native`、
 *      `dsh-client-ui-skin-denia` 的 entry 是 `ui-skin-denia`。
 *      ⇒ 给包写 `- id: <包名>` **必然是孤儿行**。
 *   ③ 上游 `dsh-plugin-manager` 的 `reconcile()`（`lib/index.js:241-250`）对
 *      "新装的依赖"只有两种处置：**声明 `dsh.bundle` ⇒ push 进 `dsh.profile.bundles`**；
 *      否则 warn "installed as a plain dependency, not a profile layer" 后跳过。
 *      **上游根本没有"用户行"这个概念**——那是本项目的自有机制（因为我们的
 *      `cordis.patch.yml` 每次启动被种子覆盖，需要一个旁路文件承载用户自己的 patch 行）。
 *
 * 所以正确落点是 `dsh.profile.bundles`（见 `appendProfileBundle`），而不是用户行。
 *
 * 【`.dshm-plugin-rows.yml` 仍然有用】它由**端侧「插件」页**维护（`CorePane.ets` /
 * `Index.ets` 里写 `- id` + `disabled`），语义是"**用户对已有条目**的启停覆盖"——
 * 即 id 来自**别处已存在的条目**，不是安装器凭空写的包名。两条路径的差别就在这一点上：
 * 前者引用已存在的条目，后者引用不存在的条目。
 *
 * 【若将来真要支持"普通插件写行"】判据必须是"**该 id 在现有条目里真的存在**"
 * （可在 boot 后拿 loader 的条目清单核对），**不能**退回到"它有 dsh 字段就写"——
 * 那正是这次修掉的错误。判据写在这里，免得下一个人重新发明。
 */

/** 读 <homeDir>/installer.json 的 registry 配置（缺省 npmmirror）。 */
function readRegistry(homeDir) {
  const cfg = readJsonSafe(path.join(homeDir, 'installer.json'));
  if (cfg && typeof cfg.registry === 'string' && cfg.registry.startsWith('https://')) {
    return cfg.registry;
  }
  return DEFAULT_REGISTRY;
}

// ── 安装主体 ───────────────────────────────────────────────────────────

/**
 * 安装一个插件 spec 到 profile。返回结果对象（不抛错：失败也走返回值，
 * 调用方（main.js 队列段）按 ok 字段写 .done/.fail）。
 * opts: { homeDir, profile, log? }
 */
async function installSpec(spec, opts) {
  try {
    return await installSpecInner(spec, opts);
  } catch (e) {
    // 契约：本函数不抛错，失败也走返回值（main.js 队列段按 ok 字段写 .done/.fail）
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function installSpecInner(spec, opts) {
  const homeDir = opts.homeDir;
  const profile = opts.profile || 'ondevice';
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  if (!homeDir || typeof spec !== 'string' || spec.trim().length === 0) {
    return { ok: false, error: '参数缺失（homeDir/spec）' };
  }
  const profileDir = (typeof opts.profileDir === 'string' && opts.profileDir.length > 0)
    ? opts.profileDir
    : path.join(homeDir, 'profiles', profile);
  const registry = readRegistry(homeDir);
  ensureProfileDirs(profileDir);
  const tmpRoot = path.join(homeDir, '.installer-tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });

  const installed = [];
  const seen = new Set();
  let topName = '';
  let topVersion = '';
  // 【登记门控（2026-09-25 报告）】顶层包的 manifest 本体，供循环后判定"登记到哪"。
  // 判据与落点见 topPackageDisposition 的注释（声明 dsh.bundle ⇒ 进 dsh.profile.bundles；
  // 否则什么都不登记）。旧写法用一个 `topHasBundle` 布尔并去写**用户行**，方向是反的。
  let topPkgForRow = null;
  let note = '重启应用后生效（bundle 型插件已登记，启动时随 profile 挂载）';
  const queue = [{ spec: spec.trim(), depth: 0 }];
  while (queue.length > 0) {
    const job = queue.shift();
    let resolved = null;
    try {
      resolved = await resolveSpec(job.spec, registry);
    } catch (e) {
      if (job.depth === 0) {
        throw e; // 顶层失败 = 整体失败
      }
      log('依赖解析失败（跳过）：' + job.spec + '：' + (e && e.message));
      continue; // 子依赖失败：如实记录、不阻断
    }
    if (seen.has(resolved.name)) {
      continue;
    }
    const dest = path.join(profileDir, 'node_modules', resolved.name);
    if (fs.existsSync(path.join(dest, 'package.json'))) {
      // 【残留自愈（2026-09-24）】市场安装失败"没有新装任何包"的根因：上次安装
      // 留下半残 node_modules/<name>（package.json 在但入口缺失，装完即含不入 UI）。
      // 既有逻辑见目录在就直接 seen+跳过 ⇒ topName 空、installed=[] ⇒ 返回"没有
      // 新装任何包"。这里改为：已存在但**可加载**才跳过（幂等）；存在但判坏（半残
      // 残留）→ 视为未装，走下方重新下载落位（清掉旧目录，装新的）。
      if (userRowLoadable(profileDir, resolved.name).length === 0) {
        seen.add(resolved.name);
        continue; // 已装且完整（幂等）
      }
      log('已装目录不完整（' + resolved.name + '），清除残留并重新安装…');
      fs.rmSync(dest, { recursive: true, force: true });
    }
    log('下载 ' + resolved.name + '@' + resolved.version + ' …');
    const tgz = await fetchBuffer(resolved.tarballUrl);
    const tar = zlib.gunzipSync(tgz);
    const tmp = path.join(tmpRoot, resolved.name.replace(/[\/@:]/g, '_') + '-' + Date.now());
    fs.rmSync(tmp, { recursive: true, force: true });
    const ext = extractTar(tar, tmp);
    // npm tarball 根是 package/；GitHub codeload 根是 <repo>-<ref>/
    let realRoot = tmp;
    const entries = fs.readdirSync(tmp);
    let soleDir = '';
    if (entries.length === 1) {
      const only = path.join(tmp, entries[0]);
      let isDir = false;
      try { isDir = fs.statSync(only).isDirectory(); } catch (e) { isDir = false; }
      if (isDir) {
        soleDir = only;
      }
      if (fs.existsSync(path.join(only, 'package.json'))) {
        realRoot = only;
      }
    }
    /*
     * 【monorepo 子目录包（报告 5 §2.1）】GitHub 侧还有一层：一个仓库里放多个包，
     * 每个包各占一个子目录（`…/dsh-deep-whale` 下的 `maid-atelier/`、`orca-link/`）。
     * 这类 tarball 的**根目录没有 package.json**（它属于整个 monorepo），真正的包在
     * `<仓库根>/<subpath>/`。
     *
     * 【必须用 soleDir 而不是 realRoot 作基准】codeload 的 tarball 恒有一层
     * `<repo>-<ref>/` 外壳，而该外壳**没有 package.json** ⇒ 上面那段不会把 realRoot
     * 推进去。若直接用 `realRoot + subpath` 就会拼到 `tmp/maid-atelier`（不存在）。
     * 真机实测（本机复现）：报 "试过 …\.installer-tmp\Small-tailqwq--dsh-deep-whale-…\maid-atelier"，
     * 而实际路径多一层 `dsh-deep-whale-HEAD/`。故基准取"唯一顶层目录"（若存在），
     * 否则退回 realRoot（兼容 npm tarball 那种直接是包根的形态）。
     *
     * 判据分两步，避免把"根目录确实缺 package.json 的坏包"误当成子目录包：
     *   ① 只有 spec 明确给了 `&path:` 时才进子目录；
     *   ② 进到那一层后仍要能读到 package.json，否则如实报错（附上试过的路径）。
     */
    const subpath = typeof resolved.subpath === 'string' ? resolved.subpath : '';
    if (subpath.length > 0) {
      const base = soleDir.length > 0 ? soleDir : realRoot;
      const sub = path.join(base, ...subpath.split('/').filter((seg) => seg.length > 0 && seg !== '.'));
      if (fs.existsSync(path.join(sub, 'package.json'))) {
        realRoot = sub;
        log(`已进入 monorepo 子目录：${subpath}`);
      } else {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw new Error(`spec 声明了子目录但该处没有 package.json：${subpath}`
          + `（tarball 根=${tmp}，试过 ${sub}）`);
      }
    }
    const pkgMeta = readJsonSafe(path.join(realRoot, 'package.json'));
    if (pkgMeta === null || typeof pkgMeta.name !== 'string') {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new Error('tarball 里没有可识别的 package.json：' + job.spec);
    }
    // GitHub spec 的包名以 tarball 内声明为准（修正占位名）
    const finalName = pkgMeta.name;
    const finalDest = path.join(profileDir, 'node_modules', finalName);
    if (seen.has(finalName)) {
      fs.rmSync(tmp, { recursive: true, force: true });
      continue;
    }
    fs.rmSync(finalDest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(finalDest), { recursive: true });
    fs.renameSync(realRoot, finalDest);
    // 【落位后校验（2026-09-24）】半残包是端侧反复出现的形态：package.json 在、
    // main 入口缺失（真机 4 轮安装全部如此；本机同代码装同一 registry 的同一版本
    // 却完整——端侧特有，成因未定，取证字段已并入 error）。半残包一旦落位，整条
    // 启用链全灭：用户行预检拒拼（启停失效）→ 半残包隔离改名 → bundles 悬空引用
    // → setBundleEnabled 恒报 cannot resolve profile bundle（用户侧即"装上了但
    // 启用报异常"）。落位即校验，与启动期 userRowLoadable 同判据；不完整直接
    // 回滚删除并整体报失败——宁可不装，不留半残。tgz 字节数与解包文件数进 error
    // （.fail JSON 持久化），下次复现可直接定位是下载截断还是解包丢文件。
    const loadableReason = userRowLoadable(profileDir, finalName);
    if (loadableReason.length > 0) {
      fs.rmSync(finalDest, { recursive: true, force: true });
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      throw new Error('落位校验失败（已回滚，不留半残包）：' + loadableReason
        + '；tgz=' + tgz.length + 'B，解包写入 ' + ext.written + ' 文件'
        + (ext.skipped.length > 0 ? '，跳过 ' + ext.skipped.length + ' 个 link 条目' : ''));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    seen.add(finalName);
    installed.push({
      name: finalName,
      version: String(pkgMeta.version || resolved.version),
      files: ext.written,
      skippedLinks: ext.skipped.length,
    });
    if (topName.length === 0) {
      topName = finalName;
      topVersion = String(pkgMeta.version || resolved.version);
      // 【为什么要留下 manifest 本体】登记落点（bundles 还是 plain）由**顶层包的
      // manifest** 决定，而判定发生在循环之后 ⇒ 这里把解析结果存下来，
      // 不要在循环末再读一次文件（那会多一次 I/O，也容易读到别的东西）。
      topPkgForRow = pkgMeta;
    }
    if (job.depth < MAX_DEPTH) {
      const deps = Object.assign({}, pkgMeta.dependencies || {}, pkgMeta.optionalDependencies || {});
      for (const depName of Object.keys(deps)) {
        queue.push({ spec: depName + '@' + deps[depName], depth: job.depth + 1 });
      }
    }
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (installed.length === 0) {
    // 之前 "没有新装任何包" 被 web/市场侧判成失败（ok:false + .fail），但真 pnpm add
    // 幂等：包早已装好 → 应视为成功（ok:true）。且【关键是】已有目录不一定登记进了
    // profile（用户插件行/package.json dependencies）——市场安装报"成功但 profile 无
    // 变化"正是这种：node_modules 在、行没写。所以幂等分支也要把顶层包的行 + 依赖补上。
    let topIdRaw = '';
    const gh = parseGitHub(spec.trim());
    const np = parseNpm(spec.trim());
    if (np !== null) {
      topIdRaw = np.name;
    } else if (gh !== null) {
      topIdRaw = gh.owner + '--' + gh.repo; // 与 resolveSpec 的 GitHub 占位名一致（落位后会按 tarball 内名修正，此处仅尽力）
    }
    if (topIdRaw.length > 0
      && fs.existsSync(path.join(profileDir, 'node_modules', topIdRaw, 'package.json'))) {
      let ver = '';
      const metaPkg = readJsonSafe(path.join(profileDir, 'node_modules', topIdRaw, 'package.json'));
      if (metaPkg && typeof metaPkg.version === 'string') {
        ver = metaPkg.version;
      }
      // 【登记门控（2026-09-25 报告）】幂等分支同样按"登记到哪"的判定走：从**已落位
      // manifest 现读一次**（不能复用 topPkgForRow——那条路径没被走到）。
      const disp2 = topPackageDisposition(metaPkg);
      mergeDependencies(profileDir, [{ name: topIdRaw, version: ver, spec: spec.trim() }]);
      if (disp2.kind === 'bundle') {
        const added2 = appendProfileBundle(profileDir, topIdRaw);
        log(added2
          ? 'bundle 型包已补登记进 dsh.profile.bundles：' + topIdRaw
          : 'bundle 型包已在 dsh.profile.bundles 中：' + topIdRaw);
      }
      return {
        ok: true,
        name: topIdRaw,
        version: ver,
        installed: [],
        note: disp2.kind === 'bundle'
          ? '包已存在，已确认登记进 profile（重启应用后挂载生效）'
          : '包已存在（幂等；plain dependency 不登记为 profile 层）',
      };
    }
    return { ok: true, name: topIdRaw, installed: [], note: '包已存在（幂等，无需重装）' };
  }
  // 只写顶层包一行（对齐真 pnpm add 行为）：上游 installBundle 靠 dependencies
  // 的 diff 确定"装了哪一个包"（dsh-plugin-manager index.js:921-924，新增 key
  // 数 ≠1 即 ManagementFailure("ambiguous-install")）。2026-09-23 真机实测：
  // dshmarket（带依赖树的 bundle）整棵写入 → diff 出 N 个 → web UI 报"无法从
  // 依赖变更中确定装了哪一个包"。真 pnpm add 也只写 spec 一行（依赖树进
  // lock/node_modules）；端侧 dependencies 字段的唯一读者就是该 diff——cordis
  // 挂载认 node_modules 落位 + patch 行，不认它。子包明细仍完整保留在返回值
  // installed 数组（.done JSON → UI 安装详情）。
  mergeDependencies(profileDir, [{ name: topName, version: topVersion, spec: spec.trim() }]);
  // 【登记门控（2026-09-25 报告：billion-context 装了不生效）】见 topPackageDisposition
  // 的完整证据：声明 dsh.bundle 的包落点是 **dsh.profile.bundles**（与上游 reconcile 一致），
  // **不写用户行**（它的 entry 由它自己的 patch 插入，行名对不上 ⇒ 孤儿行 + 市场 toggle 报错）。
  const disp = topPackageDisposition(topPkgForRow);
  if (disp.kind === 'bundle') {
    const added = appendProfileBundle(profileDir, topName);
    log(added
      ? 'bundle 型包已登记进 dsh.profile.bundles：' + topName + '（重启应用后挂载生效）'
      : 'bundle 型包已在 dsh.profile.bundles 中：' + topName);
  } else {
    log('顶层包未声明 dsh.bundle（plain dependency），只落 node_modules、不登记为 profile 层：' + topName);
  }
  return {
    ok: true,
    name: topName,
    version: topVersion,
    installed: installed,
    registry: registry,
    note: note,
  };
}

// ── 卸载 ──────────────────────────────────────────────────────────────
/**
 * 卸载一个插件 spec（web 插件页「卸载」通过 pnpm rm → 假壳少 .rem 请求 →
 * 本函数）。与 installSpec 同契约：{ ok, name, ... }，失败走返回值不抛。
 *
 * 删除量：node_modules/<name>、package.json 的 dependencies/peerDependencies
 * /dsh.profile.bundles 里的对应条目、.dshm-plugin-rows.yml 的 `- id: <name>` 块、
 * cordis.patch.yml 里对应的 name / - id: 行。幂等：本不存在也返回 ok。
 */
async function removeSpec(spec, opts) {
  try {
    return await removeSpecInner(spec, opts);
  } catch (e) {
    // 契约同 installSpec：不抛错，失败走返回值
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * 从 .dshm-plugin-rows.yml 文本里删掉 `- id: <name>` 这一块（含其缩进续行）。
 *
 * 【必须剥引号再比较（报告 7/8 的 &path: 残留行真根因）】`composeUserRows` 在下次
 * 启动时会把需要引号的 id 回写成**带引号**形式（`@scope/name` 是 YAML 保留指示符开头，
 * 不引会让 profile 起不来——见 dshm-user-rows.js 的 yamlQuote 注释），并且**回写到
 * 本文件**。于是文件里实际是：
 *     - id: '@dsh-external/dsh-client-ui-skin-maid-atelier'
 * 而本函数原先拿 `m[1] === name` 精确比较——`m[1]` 带上引号就**永远不等于**裸名
 * ⇒ 行删不掉。这也解释了报告里的现象：node_modules 与依赖都删干净了（那两处用的是
 * 裸名集合，不受引号影响），**唯独这一行留着**。
 * 修法：剥掉成对的单/双引号（与 dshm-user-rows.js 的 prefilterUserRows 同款处理）。
 */
function removeRowBlockById(rowsText, name) {
  const lines = rowsText.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = /^-\s+id:\s*([^\s#]+)/.exec(line);
    if (m !== null) {
      let rawId = m[1];
      if ((rawId.startsWith("'") && rawId.endsWith("'"))
        || (rawId.startsWith('"') && rawId.endsWith('"'))) {
        rawId = rawId.slice(1, -1);
      }
      if (rawId === name) {
        i += 1;
        while (i < lines.length && /^\s/.test(lines[i]) && lines[i].trim().length > 0) {
          i += 1;
        }
        continue;
      }
    }
    out.push(line);
    i += 1;
  }
  return out.join('\n');
}

/**
 * 与 removeRowBlockById 同款，但按**后缀**匹配 id（`&path:` 皮肤专用）。
 *
 * 【为什么需要后缀而不是相等】`&path:` 皮肤在 profile 里登记的是**子目录 manifest 的
 * 完整 name**（带 scope，如 `@dsh-external/dsh-client-ui-skin-maid-atelier`），而卸载时
 * 手上只有 spec 与子目录名 `maid-atelier`。scope 前缀只存在于仓库的 manifest 里——
 * 若那棵树已被删（正是"包与依赖都清了、行还在"的残局），就永远推不出完整名。
 * 但完整名一定**以子目录名结尾**，故用后缀判定。
 *
 * 【边界安全：必须带分隔符或完全相等】
 * 只用 `endsWith(suffix)` 会让子目录名 `link` 误删 `@x/orca-link` 吗？后缀是
 * `-link` 才算词边界——所以要求：要么完全相等，要么后缀前一个字符是 `-`、`/`、`@`
 * 之一（包名里可能出现的分隔符）。这样 `link` 不会匹配 `orca-link`，
 * 而 `maid-atelier` 能匹配 `…-maid-atelier`。宁可少删（可由报告的人工清理兜底），
 * 不可误删（误删会让用户的其他插件静默消失）。
 */
function removeRowBlockByIdSuffix(rowsText, suffix) {
  if (!suffix || suffix.length === 0) {
    return rowsText;
  }
  const lines = rowsText.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = /^-\s+id:\s*([^\s#]+)/.exec(line);
    if (m !== null) {
      let rawId = m[1];
      if ((rawId.startsWith("'") && rawId.endsWith("'"))
        || (rawId.startsWith('"') && rawId.endsWith('"'))) {
        rawId = rawId.slice(1, -1);
      }
      const isMatch = rawId === suffix || (rawId.endsWith(suffix)
        && ['-', '/', '@'].includes(rawId.charAt(rawId.length - suffix.length - 1)));
      if (isMatch) {
        i += 1;
        while (i < lines.length && /^\s/.test(lines[i]) && lines[i].trim().length > 0) {
          i += 1;
        }
        continue;
      }
    }
    out.push(line);
    i += 1;
  }
  return out.join('\n');
}

/** 从 spec 文本剥离范围/版本，还原成纯包名（@scope/name 或 name）。 */
function barePackageName(spec) {
  let s = String(spec || '').trim();
  const slash = s.indexOf('/');
  if (s.startsWith('@') && slash !== -1) {
    const verAt = s.indexOf('@', slash + 1);
    if (verAt !== -1) {
      s = s.slice(0, verAt);
    }
    return s;
  }
  const at = s.indexOf('@');
  if (at > 0) {
    s = s.slice(0, at);
  }
  return s;
}

async function removeSpecInner(spec, opts) {
  const homeDir = opts.homeDir;
  const profile = opts.profile || 'ondevice';
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  if (!homeDir || typeof spec !== 'string' || spec.trim().length === 0) {
    return { ok: false, error: '参数缺失（homeDir/spec）' };
  }
  const name = barePackageName(spec);
  if (!name) {
    return { ok: false, error: '无法识别包名：' + spec };
  }
  const profileDir = (typeof opts.profileDir === 'string' && opts.profileDir.length > 0)
    ? opts.profileDir
    : path.join(homeDir, 'profiles', profile);

  /*
   * 【`&path:` 皮肤卸载后用户行残留】——报告 7 §2 / 报告 8 §1
   *
   * 现象：卸载后包与依赖都删干净了（依赖: 0），`.dshm-plugin-rows.yml` 仍留着
   * `- id: '@dsh-external/dsh-client-ui-skin-maid-atelier'`。
   *
   * 【根因有两层，都要治】
   *   ① **名字来源不同**：安装时写进行的名字来自**子目录 manifest 的 `package.json.name`**
   *      （`&path:` 皮肤的真实包名），而卸载只拿 spec 解析出的一个名字
   *      （GitHub 占位名 `owner--repo`、或市场展示名）⇒ 不是同一个字符串。
   *   ② **引号**（真正的拦路虎，见 removeRowBlockById 注释）：`composeUserRows` 会把
   *      `@scope/name` 回写成带引号的 `- id: '@scope/name'` 并落盘，而比较用的是裸名
   *      ⇒ 永远匹配不上。**只修 ① 不修 ② 仍然删不掉**——这正是报告 7 修过、报告 8
   *      又复现的原因。
   *
   * 【修法】候选名集合（多路匹配）+ removeRowBlockById 剥引号比较：
   *   ① spec 解析出的名字（覆盖 npm 与无 subpath 的 GitHub 包）；
   *   ② **已装 manifest 的 `name`**：从 profile `dependencies` 里找出"值就是这个 spec"
   *      的条目名——这是最可靠的一路，因为安装时写进 dependencies 的正是它；
   *   ③ `&path:` 的子目录名兜底（manifest 已丢但行还在时）。
   */
  const candidates = new Set();
  // ① spec 解析出的名字：**只在它看起来像包名时才收**。GitHub 形态的 spec 整串是
  //    `github:owner/repo#ref&path:/x`，那个串不是包名，收进候选只会让日志噪声
  //    （实测：候选里出现整条 spec）。npm 形态（`name` / `@scope/name`）才收。
  if (parseGitHub(name) === null) {
    candidates.add(name);
  }
  // ② 从 profile dependencies 反查真实 name
  try {
    const pkgPath0 = path.join(profileDir, 'package.json');
    const pkg0 = readJsonSafe(pkgPath0);
    const deps0 = pkg0 && typeof pkg0 === 'object' && pkg0.dependencies && typeof pkg0.dependencies === 'object'
      ? pkg0.dependencies : {};
    const specTrim = spec.trim();
    for (const depName of Object.keys(deps0)) {
      const depSpec = String(deps0[depName]);
      // 依赖值就是安装时写的请求 spec（见 mergeDependencies 的 dependencyValueFor）：
      // 与本 spec 相同、或去掉 #ref 后主干相同，即认定是同一个包。
      const sameSpec = depSpec === specTrim
        || depSpec.split('#')[0] === specTrim.split('#')[0];
      if (sameSpec) {
        candidates.add(depName);
      }
    }
  } catch (e) {
    // 读不到就只靠 ①/③
  }
  /*
   * ③ `&path:` 子目录名 —— **按后缀匹配**，不是精确相等。
   *
   * 【为什么后缀】`&path:` 皮肤在 profile 里登记的真实包名是**子目录 manifest 的 name**，
   * 而它是带 scope 的完整名（如 `@dsh-external/dsh-client-ui-skin-maid-atelier`），
   * 光凭子目录名 `maid-atelier` **推不出** scope 前缀（那来自仓库里的 manifest，
   * 此刻可能已被删掉、依赖也已清空——报告实测的正是这种"包与依赖都不在了"的残局）。
   * 但它一定是"以子目录名结尾"的（`…-maid-atelier` / `…/maid-atelier` / `maid-atelier`）。
   * 故对**行 id** 用后缀匹配：能删掉孤儿行，又不会误伤别的包
   * （子目录名本身足够独特；且精确匹配仍走 ①/②）。
   */
  let suffixCandidates = [];
  try {
    const gh = parseGitHub(spec.trim());
    if (gh !== null && typeof gh.subpath === 'string' && gh.subpath.length > 0) {
      const seg = gh.subpath.split('/').filter((s) => s.length > 0 && s !== '.');
      if (seg.length > 0) {
        const base = seg[seg.length - 1];
        candidates.add(base);
        suffixCandidates.push(base);
      }
    }
  } catch (e) {
    // 解析失败不影响其余路径
  }
  /*
   * ④ GitHub 形态的兜底：`github:owner/repo[-#ref]`（无 `&path:`）在 profile 里登记的
   * 真实包名无从预知（是仓库里 manifest 的 name），候选 ② 只能靠 dependencies 反查；
   * 若那一步没命中（例如依赖已被手工清掉），至少还能按 `owner--repo` 占位名清一次。
   * 【为什么必须有这条】报告实测过"包与依赖都删了"的情形——依赖已不在 package.json，
   * ② 就查不到；此时若 names 为空，四次清理**一个都不执行**，卸载变成 no-op。
   */
  try {
    const gh0 = parseGitHub(spec.trim());
    if (gh0 !== null) {
      candidates.add(gh0.owner + '--' + gh0.repo);
    }
  } catch (e) {
    // 忽略
  }
  const names = Array.from(candidates);
  if (names.length === 0) {
    // 极端情况：连占位名都构造不出（spec 形态前所未见）。如实返回，不假装清干净。
    return { ok: false, error: '无法从 spec 推出任何候选包名：' + spec };
  }
  log('卸载候选项（spec 名 / 已装 manifest 名 / 子目录名 / GitHub 占位名）：' + names.join('、'));
  const removed = [];

  for (const name of names) {
    // 1) node_modules/<name>
    const nmDest = path.join(profileDir, 'node_modules', name);
    if (fs.existsSync(nmDest)) {
      fs.rmSync(nmDest, { recursive: true, force: true });
      removed.push('node_modules/' + name);
      log('已删除包目录：' + name);
    }
  }

  // 2) profile/package.json：dependencies / peerDependencies / dsh.profile.bundles
  const pkgPath = path.join(profileDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = readJsonSafe(pkgPath);
      let changed = false;
      if (pkg && typeof pkg === 'object' && !Array.isArray(pkg)) {
        for (const field of ['dependencies', 'peerDependencies']) {
          const deps = pkg[field];
          if (deps !== null && typeof deps === 'object' && !Array.isArray(deps)) {
            for (const n of names) {
              if (Object.prototype.hasOwnProperty.call(deps, n)) {
                delete deps[n];
                changed = true;
              }
            }
          }
        }
        const bundles = pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)
          ? pkg.dsh.profile.bundles : null;
        if (bundles !== null) {
          const kept = bundles.filter((b) => !names.includes(b));
          if (kept.length !== bundles.length) {
            pkg.dsh.profile.bundles = kept;
            changed = true;
          }
        }
      }
      if (changed) {
        fs.writeFileSync(pkgPath, JSON.stringify(pkg ?? {}, null, 2) + '\n', 'utf8');
        removed.push('package.json 依赖');
      }
    } catch (e) {
      log('更新 package.json 失败（忽略）：' + e.message);
    }
  }

  // 3) 用户插件行 .dshm-plugin-rows.yml —— 对每个候选名都删一次块
  const rowsPath = path.join(profileDir, '.dshm-plugin-rows.yml');
  if (fs.existsSync(rowsPath)) {
    try {
      let rows = fs.readFileSync(rowsPath, 'utf8');
      let hit = false;
      for (const n of names) {
        const next = removeRowBlockById(rows, n);
        if (next !== rows) {
          rows = next;
          hit = true;
        }
      }
      // `&path:` 皮肤：按**后缀**再扫一遍（见 suffixCandidates 注释——scope 前缀推不出来）
      for (const suffix of suffixCandidates) {
        const next = removeRowBlockByIdSuffix(rows, suffix);
        if (next !== rows) {
          rows = next;
          hit = true;
        }
      }
      if (hit) {
        fs.writeFileSync(rowsPath, rows, 'utf8');
        removed.push('用户插件行');
      }
    } catch (e) {
      log('更新用户插件行失败（忽略）：' + e.message);
    }
  }

  // 4) cordis.patch.yml 里对应的 name / - id: 行（同样对每个候选名）
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  if (fs.existsSync(patchPath)) {
    try {
      const patch = fs.readFileSync(patchPath, 'utf8');
      // 行首可能带缩进（patch 里 name/id 常在列表项内），故用正则而不是全串相等，
      // 同时统一剥掉可选引号——与 removeRowBlockById 的引号口径一致。
      const isTargetLine = (line) => {
        const m = /^\s*(?:name|- id):\s*([^\s#]+)\s*$/.exec(line);
        if (m === null) {
          return false;
        }
        let id = m[1];
        if ((id.startsWith("'") && id.endsWith("'")) || (id.startsWith('"') && id.endsWith('"'))) {
          id = id.slice(1, -1);
        }
        if (names.includes(id)) {
          return true;
        }
        for (const suffix of suffixCandidates) {
          if (id === suffix
            || (id.endsWith(suffix) && ['-', '/', '@'].includes(id.charAt(id.length - suffix.length - 1)))) {
            return true;
          }
        }
        return false;
      };
      const next = patch.split('\n').filter((l) => !isTargetLine(l)).join('\n');
      if (next !== patch) {
        fs.writeFileSync(patchPath, next, 'utf8');
        removed.push('cordis.patch.yml');
      }
    } catch (e) {
      log('更新 cordis.patch.yml 失败（忽略）：' + e.message);
    }
  }

  return {
    ok: true,
    name,
    removed,
    note: removed.length > 0 ? '已卸载（重启应用后正式生效）' : '该插件本不存在（幂等）',
  };
}

module.exports = { installSpec, removeSpec, extractTar, resolveSpec, readRegistry, DEFAULT_REGISTRY, dshmSkinAlias };
