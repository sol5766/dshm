'use strict';
/*
 * dshm-user-rows.js —— 用户插件行的「装得上才拼」守卫 + 启动失败自愈
 * （D27 真机死锁事故，2026-09-23，批次备注十一）
 *
 * 【事故回放】web UI 装了 dshmarket 后，用户行被 composeUserRows 每次启动拼进
 * cordis.patch.yml；而设备上 node_modules/dshmarket/lib/index.js 缺失（PC 同代码
 * 同 tarball 复现落位完整，设备侧缺失原因未明）⇒ dsh loader import 抛错 ⇒
 * BOOT_ERR：Host fatal、无 HTTP、python 桥也没了；files/dsh/home 是 700，
 * hdc 不可写 ⇒ 没有任何外部恢复通道，只能重装 HAP 自救。
 *
 * 【两层防线】
 *   1. 预检（prefilterUserRows / composeUserRows）：拼行前逐条验证
 *      node_modules/<id>/package.json 存在且入口文件在。坏行不拼、diag 留取证
 *      （diag 落 dshm-host.log，append 跨重启保留；log 落 node-output.log，
 *      每次启动截断——取证必须走 diag）。行本身不删：仍在
 *      .dshm-plugin-rows.yml 里，包修好（重装）后下次启动自动恢复。
 *   2. 自愈（writeBootFailMarker / quarantineAfterBootFailure）：fail() 时往
 *      $DSH_HOME 写启动失败标记；下次启动在拼行之前发现标记 ⇒ 把整个用户行
 *      文件**改名**隔离（.quarantine-<ts>，保数据不删）再清标记。兜住
 *      「文件都在但 import 崩」这类预检拦不住的死锁。宁可误隔离（用户行被
 *      隔离后插件全下线，但 Host 活着、UI 可用），不可让 Host 起不来。
 *
 * 【入口判据为什么是"exports 优先，候选任一缺失即判坏"】
 *   · Node 语义：package.json 有 exports 时 require/import 都走 exports，
 *     main 被忽略；无 exports 才看 main（默认 index.js）。事故里的
 *     dshmarket 两者同指 lib/index.js，判据与 Node 语义一致。
 *   · 「任一候选缺失即判坏」是防崩优先：极端包（main 与 exports 指向不同
 *     文件且只有一个存在）无法确定 cordis loader 用哪个，两个都在才放行。
 *     误杀的代价是插件不加载（diag 有日志、用户可感知），漏放的代价是
 *     整个应用死锁——两害相权取其轻。
 */

const fs = require('node:fs');
const path = require('node:path');

const USER_ROWS_FILENAME = '.dshm-plugin-rows.yml';

/**
 * 把改名前（HDSH 时代）的状态文件改名为新名。
 *
 * 【为什么需要】2026-09-27 做了 HDSH → DSHM 全局改名，端侧若干**状态文件**
 * 随之改名（`.hdsm-plugin-rows.yml` 这类）。但这些文件躺在用户数据目录里，
 * 改名后新代码只读新名 ⇒ **升级安装的老用户**会读不到自己的插件启停设置，
 * 表现为"设置被重置"。本机实测未发生（那台设备改名前后一直在用，
 * 宿主首次读不到新名时新建了），但"改名后升级"这条路径**未经验证**，
 * 所以做一次防御性迁移：新名不存在、旧名存在 ⇒ rename。
 *
 * 【为什么用 rename 而不是复制】同目录同一文件系统，rename 是原子的；
 * 且旧名留着会让"下次启动又读到旧名"的困惑长期存在。
 *
 * 【为什么静默容错】迁移失败不该阻断启动：读不到新名时的既有行为
 * （视为"没有用户行"）仍然成立，不会比迁移前更糟。
 *
 * @param dir profile 目录
 * @param newName 新文件名
 * @returns 是否发生了迁移
 */
function migrateLegacyRowsName(dir, newName) {
  const legacy = newName.replace('.dshm-', '.hdsh-');
  if (legacy === newName) return false;
  const next = path.join(dir, newName);
  const prev = path.join(dir, legacy);
  try {
    if (fs.existsSync(next) || !fs.existsSync(prev)) return false;
    fs.renameSync(prev, next);
    return true;
  } catch (e) {
    return false;
  }
}

const USER_ROWS_BEGIN = '# >>> dshm-user-rows（端侧「插件」页写入，勿手工编辑）';
const USER_ROWS_END = '# <<< dshm-user-rows';

/**
 * 市场配置托管块（P0，2026-09-26）。
 *
 * 【为什么要有这个通道】`dsh-skin-market` 解析 profile 的顺序是
 * `config.profile → argv(--profile) → 'web'`，而本应用内嵌启动的 argv **不带
 * --profile**（真机 `/proc/<pid>/cmdline` 实证），于是它以 **`web`** 操作
 * （`GET /dsh-skin-market/logs` 自报 `profile: web`）——但它实际跑在 `ondevice`
 * profile 里，读写的 `cordis.patch.yml`/`node_modules` 全是 ondevice 的。
 * 后果就是装完读不到 manifest、行写进了另一个 profile。
 *
 * 【为什么必须放托管文件而不是直接写进 seed patch】profile 的
 * `cordis.patch.yml` **每次启动都被种子覆盖**（`ensureProfile` 把 core 树里的
 * profiles/<name>/cordis.patch.yml 复制到 HOME），只有 `.dshm-*` 这类种子没有的
 * 文件能跨重启存活。因此市场配置走这里，再由 composeUserRows 拼进 patch。
 *
 * 【为什么必须先确认包已安装】该行为是**引用第三方包**的 patch 行：包不在
 * `node_modules` 时留着它就是"坏引用"，profile 直接起不来（与用户行同一个坑）。
 * 所以只在 `node_modules/dsh-skin-market` 存在时才写，包一没就清掉。
 */
const MARKET_ROWS_FILENAME = '.dshm-market-rows.yml';
/** 市场包名（同时是 patch 行的 id）。 */
const SKIN_MARKET_PACKAGE = 'dsh-skin-market';
const BOOT_FAIL_MARKER = '.dshm-boot-failed';

/**
 * 解析包的入口候选（相对包根的路径，不带 ./ 前缀，已去重）。
 * exports 优先（Node 语义），无 exports 回退 main（默认 index.js）。
 *
 * 【2026-09-26 修复 P0-1】`exports` 存在但**没有根候选**时返回空数组，而不是回退
 * `index.js`。
 *
 * 为什么：`@codemirror/legacy-modes@6.5.4` 是**子路径专用包**，`exports` 只有
 * `"./mode/*"` 与 `"./package.json"`，既没有 `"."` 也没有 `main`（npm 语义下它就是
 * 这样，合法且完整）。旧代码在"有 exports 但取不到根候选"时回退 `index.js`，于是把
 * 这个完好依赖判成"入口文件缺失：…/index.js" ⇒ dsh-better-sidebar 整单安装被回滚
 * （真机实证：拉取该 tgz 315 文件、根目录确实只有 mode/*.cjs 与 package.json）。
 * 空数组的语义是"本包按设计没有根入口"——由 userRowLoadable 据此放行。
 */
function entryCandidates(pkg) {
  const out = [];
  const push = (rel) => {
    if (typeof rel !== 'string' || rel.length === 0) {
      return;
    }
    const norm = rel.startsWith('./') ? rel.slice(2) : rel;
    if (!out.includes(norm)) {
      out.push(norm);
    }
  };
  const exp = pkg.exports;
  if (typeof exp === 'string') {
    push(exp);
    /*
     * 【为什么这里必须 return（2026-09-26 门禁转红暴露）】`exports` 是**字符串**时，
     * 它自己就是根入口，Node 语义下 `main` 被完全忽略。原实现 push 完不返回，
     * 会继续落到下面的 main 分支——没有 main 时再落到 `else push('index.js')`。
     * 于是 `{exports:'./b.js'}` 得到 `['b.js','index.js']`：凭空多出一个候选。
     *
     * 【为什么多一个候选有害】`userRowLoadable` 的口径是"任一候选可解析即通过"，
     * 多出的 `index.js` 貌似更宽松；但 `sanitizeDependencies` 的 bundle 判据是
     * "所有候选都必须存在"，同一个数组在那里会**误杀**合法包
     * （`b.js` 在、`index.js` 不在 ⇒ 报"入口文件缺失"）。两处判据本就该看到同一个
     * 语义正确的候选集，而不是各自猜。也正因如此，脚本分支与下面的对象分支必须
     * 一致地"取到根候选就返回"——对象分支早就有 return，只有字符串分支漏了。
     */
    return out;
  } else if (exp !== null && typeof exp === 'object' && !Array.isArray(exp)) {
    const dot = exp['.'];
    if (typeof dot === 'string') {
      push(dot);
    } else if (dot !== null && typeof dot === 'object' && !Array.isArray(dot)) {
      // 一层条件（node/import/require/default）+ 再容一层嵌套
      // （{ require: { default: './x.js' } } 是常见写法）
      for (const key of ['node', 'node-addons', 'import', 'require', 'default']) {
        const v = dot[key];
        if (typeof v === 'string') {
          push(v);
        } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          for (const sub of ['node', 'import', 'require', 'default']) {
            if (typeof v[sub] === 'string') {
              push(v[sub]);
            }
          }
        }
      }
    }
    // exports 存在但无根候选（子路径专用包）⇒ 空数组，不掺 main/index.js。
    return out;
  }
  if (typeof pkg.main === 'string' && pkg.main.length > 0) {
    push(pkg.main);
  } else if (typeof pkg.types === 'string' && pkg.types.length > 0) {
    /*
     * 纯类型包（@types/*）：**按设计没有运行期根入口**，放行。
     *
     * 【报告 9 缺陷 3：误杀导致整单回滚】@types/trusted-types@2.0.7 的 manifest 是
     *   "main": "" + "types": "index.d.ts"
     * 磁盘上只有 index.d.ts。原实现走 else 分支 push('index.js') ⇒ 必然不存在
     * ⇒ 判"半残" ⇒ 整个安装事务回滚（.dsh-market/log.ndjson 记 exit=1）。
     *
     * 【语义与既有约定一致】`entryCandidates` 对"子路径专用包"（exports 存在但
     * 无根候选）本来就返回空数组，由 `userRowLoadable` 见空候选即放行。
     * 这里对纯类型包沿用同一套语义。
     *
     * 【typings 是 types 的历史别名】老包用 typings，一并认。
     */
    return out;
  } else if (typeof pkg.typings === 'string' && pkg.typings.length > 0) {
    return out;
  } else {
    push('index.js');
  }
  return out;
}

/**
 * 判定一个用户行指向的包当前是否可加载。
 * 返回 '' 表示可加载；否则返回人话原因（进 diag 取证日志）。
 *
 * 【2026-09-26 修复 P0-1 的两条语义】
 *   ① `candidates.length === 0` ⇒ **直接通过**。空候选的语义是"子路径专用包"
 *      （`exports` 只有 `./mode/*` 之类，天然没有根入口）——它不是半残包，见
 *      entryCandidates 注释里 @codemirror/legacy-modes 的实证。
 *   ② 由"**所有**候选都必须存在"改为"**任一**候选可解析即通过"，与 Node 的 require
 *      解析语义一致：候选是"回退链"而非"全部条件"。旧写法让靠扩展名/目录 index
 *      回退的包（ms、dshmarket 这类 main 不写扩展名的）也处于脆弱状态——任一候选
 *      缺失即被误判。真机证据：dsh-better-sidebar 整单被一个依赖的候选链拖垮回滚。
 */
function userRowLoadable(profileDir, id) {
  const pkgDir = path.join(profileDir, 'node_modules', id);
  const pkgPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return `node_modules/${id}/package.json 不存在`;
  }
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    return `node_modules/${id}/package.json 解析失败：${e.message}`;
  }
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
    return `node_modules/${id}/package.json 不是 JSON 对象`;
  }
  const candidates = entryCandidates(pkg);
  if (candidates.length === 0) {
    return ''; // 子路径专用包：设计上就没有根入口（见 entryCandidates 注释）
  }
  for (const rel of candidates) {
    if (entryFileResolves(pkgDir, rel)) {
      return ''; // 任一候选可解析即通过（Node require 的回退语义）
    }
  }
  return `入口文件缺失：node_modules/${id}/${candidates[0]}（候选 ${candidates.join('、')}）`;
}

function entryFileResolves(pkgDir, rel) {
  // Node 的 require 解析：候选是文件路径时先试精确，再补 .js/.json/.node；
  // 候选是目录时试 index(+扩展)。很多包 main 写 "index"（无 .js），或 main
  // 指向目录（如 "lib/main" 目录内的 index.js）——不按 Node 语义解析会把这些
  // 完整包误判成半残（真机实证：dshmarket、ms 这类 main 缺扩展名的包装完即
  // 被拒 → "没有新装任何包" / "落位校验失败"）。此函数与 Node require 的
  // CJS main 解析一致。
  const direct = path.join(pkgDir, rel.replace(/\/+$/, ''));
  try {
    const st = fs.statSync(direct, { throwIfNoEntry: false });
    if (st !== undefined) {
      if (st.isFile()) {
        return true;
      }
      if (st.isDirectory()) {
        for (const e of ['', '.js', '.json', '.node']) {
          if (fs.existsSync(path.join(direct, 'index' + e))) {
            return true;
          }
        }
        return false;
      }
    }
  } catch (e) {
    // 落到扩展名尝试
  }
  for (const e of ['.js', '.json', '.node']) {
    if (fs.existsSync(direct + e)) {
      return true;
    }
  }
  return false;
}

/**
 * 逐块预检用户行文本。块 = `- id: X` 行 + 其缩进续行（如 `  disabled: true`）；
 * 空行 / 注释行是块边界（原样保留在 keptText 里）。
 * 返回 { keptText, dropped: [{ id, reason }] }。
 *
 * 【预检只针对启用行】禁用行无条件保留：禁用不触发任何加载，没有 BOOT_ERR 风险；
 * 且核心自带行的 id 是 bundle cordis.yml 里的行 id（如 ui-deliverables），不是
 * node_modules 包名——在 profile/node_modules 下必然查无，对它预检等于把
 * 「插件页关掉核心行」整个功能废掉（真机实证：启停写进行文件后全部不生效）。
 * 启用行的 id 对安装插件而言就是 profile/node_modules 下的包名，预检路径成立（D27 本意）。
 */
function prefilterUserRows(rowsText, profileDir) {
  const lines = rowsText.split('\n');
  const kept = [];
  const dropped = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = /^-\s+id:\s*([^\s#]+)/.exec(line);
    if (m === null) {
      kept.push(line);
      i += 1;
      continue;
    }
    let rawId = m[1];
    // 兼容已加单/双引号的 id（兼容 composeUserRows 补引号回写后的行）。
    if ((rawId.startsWith("'") && rawId.endsWith("'"))
      || (rawId.startsWith('"') && rawId.endsWith('"'))) {
      rawId = rawId.slice(1, -1);
    }
    let j = i + 1;
    const block = [line];
    while (j < lines.length) {
      const nxt = lines[j];
      if (nxt.trim().length === 0 || /^-\s+id:/.test(nxt) || nxt.trim().startsWith('#')) {
        break;
      }
      block.push(nxt);
      j += 1;
    }
    const id = rawId;
    const disabled = block.some((b) => /^\s+disabled:\s*true\b/.test(b));
    const reason = disabled ? '' : userRowLoadable(profileDir, id);
    if (reason.length === 0) {
      for (const b of block) {
        kept.push(b);
      }
    } else {
      dropped.push({ id, reason });
    }
    i = j;
  }
  return { keptText: kept.join('\n').trim(), dropped };
}

/**
 * YAML 标量是否需要 / 如何加引号。cordis.patch.yml 由核心 YAML 解析，未加引号的
 * `- id: @scope/name` 会 "bad indentation of a mapping entry" 让 profile 整个起不来
 * （真机实证 2026-09-24：@liustack/modlens 行直接把 DSHM 卡在启动画面）。
 * @为保留指示符，: 在键值外可能触发映射；这些都必须单引号（内部单引号加倍）。
 */
function yamlQuote(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return value;
  }
  const needs = /^[@`*&!%#~|]/.test(value)
    || /[#]:\s/.test(value)
    || value !== value.trim()
    || /[@#]/.test(value);
  if (needs) {
    return "'" + value.replace(/'/g, "''") + "'";
  }
  return value;
}

/**
 * 生成市场配置托管文件（P0，2026-09-26）。包在 ⇒ 写；包不在 ⇒ 删。
 *
 * 内容形如：
 *   - id: dsh-skin-market
 *     config:
 *       profile: <profileName>
 * 这正好补上"市场按 argv 找不到 --profile、兜底成 web"的缺口（见 MARKET_ROWS_FILENAME
 * 注释）。`profileName` 取自宿主的实际 profile（PROFILE），不硬编码。
 * @returns 该文件当前是否应当参与拼接（包存在）
 */
function ensureMarketRows(profileDir, profileName, io) {
  const opts = io || {};
  const iLog = typeof opts.log === 'function' ? opts.log : () => {};
  const rowsPath = path.join(profileDir, MARKET_ROWS_FILENAME);
  const pkgDir = path.join(profileDir, 'node_modules', SKIN_MARKET_PACKAGE);
  const installed = fs.existsSync(path.join(pkgDir, 'package.json'));
  if (!installed) {
    // 包不在：清掉托管行，避免留下"引用不存在包"的坏行（会让 profile 起不来）。
    try {
      if (fs.existsSync(rowsPath)) {
        fs.rmSync(rowsPath, { force: true });
        iLog(`市场配置：${SKIN_MARKET_PACKAGE} 未安装，已移除 ${MARKET_ROWS_FILENAME}`);
      }
    } catch (e) {
      iLog(`市场配置：清理 ${MARKET_ROWS_FILENAME} 失败（忽略）：${e.message}`);
    }
    return false;
  }
  const body = [
    `- id: ${SKIN_MARKET_PACKAGE}`,
    '  config:',
    `    profile: ${yamlQuote(String(profileName))}`,
    '',
  ].join('\n');
  try {
    let cur = '';
    try {
      cur = fs.readFileSync(rowsPath, 'utf8');
    } catch (e) {
      cur = '';
    }
    if (cur !== body) {
      fs.writeFileSync(rowsPath, body, 'utf8');
      iLog(`市场配置：已固化 ${SKIN_MARKET_PACKAGE} profile=${profileName}（${MARKET_ROWS_FILENAME}）`);
    }
  } catch (e) {
    iLog(`市场配置：写 ${MARKET_ROWS_FILENAME} 失败（忽略）：${e.message}`);
    return false;
  }
  return true;
}

/**
 * 从"上一版 patch 原文"里挑出**种子没有的顶层条目**，供拼装时保留（报告 9 缺陷 4）。
 *
 * 【为什么需要】dsh 0.1.7 的设置页把模型/提供方写进 profile 的 cordis.patch.yml，
 * 而 ensureProfile 每次启动用核心种子整文件覆盖它 ⇒ 配置重启即丢。
 *
 * 【解析口径（刻意保守）】YAML 这里只需认"顶层条目边界"，不需要完整解析：
 *   · 顶层条目以 **行首无缩进的 `- `** 开始（`- id: foo`）
 *   · 缩进行（含 `  name:`、`  config:` …）属于**上一个**顶层条目
 *   · 注释行与空行归到最近的条目（或前置块）
 * 于是"条目"= 从某行首 `- ` 到下一个行首 `- ` 之前。
 *
 * 【判定"种子没有"】用条目的**主键**比对：优先取 `- id:` 的值，没有则取
 * `- name:` 的值。种子里出现过的键即视为"种子条目"，不重复保留。
 *
 * 【去掉我们自己的托管块】原文里可能含上一次写入的 USER_ROWS_BEGIN..END 段，
 * 那是托管内容（每次由 marketText/keptText 重新生成），必须排除，否则会重复累积。
 *
 * @param seedText  本次要写入的种子全文
 * @param prevText  覆盖**之前**的 patch 原文
 * @returns 需要追加的条目文本（可能为空串）
 */
function carryForeignTopLevelEntries(seedText, prevText) {
  if (typeof prevText !== 'string' || prevText.length === 0) {
    return '';
  }
  // 排除托管块（我们自己的用户行段）
  const withoutManaged = (t) => {
    const b = t.indexOf(USER_ROWS_BEGIN);
    if (b === -1) {
      return t;
    }
    const e = t.indexOf(USER_ROWS_END, b);
    return t.slice(0, b) + (e === -1 ? '' : t.slice(e + USER_ROWS_END.length));
  };
  const keyOf = (entry) => {
    const m = /^-\s*id:\s*(.+)$/m.exec(entry) || /^-\s*name:\s*(.+)$/m.exec(entry);
    if (m === null) {
      return '';
    }
    return m[1].trim().replace(/^['"]|['"]$/g, '');
  };
  const splitEntries = (t) => {
    const lines = t.split('\n');
    const out = [];
    let cur = null;
    for (const line of lines) {
      if (/^-\s/.test(line)) {           // 行首（无缩进）的 "- " ⇒ 新条目
        if (cur !== null) {
          out.push(cur);
        }
        cur = [line];
      } else if (cur !== null) {
        cur.push(line);
      }
      // cur === null：文件头的注释块，丢弃
    }
    if (cur !== null) {
      out.push(cur);
    }
    return out.map((ls) => ls.join('\n').replace(/\s+$/, ''));
  };

  const seedKeys = new Set(splitEntries(withoutManaged(seedText)).map(keyOf).filter((k) => k.length > 0));
  const kept = [];
  for (const entry of splitEntries(withoutManaged(prevText))) {
    const key = keyOf(entry);
    // 无主键的条目（纯注释块等）不主动保留——避免把垃圾带进来
    if (key.length === 0) {
      continue;
    }
    if (seedKeys.has(key)) {
      continue;                            // 种子已定义：以种子为准（升级要能流入）
    }
    /*
     * 【D1（2026-10-03）市场行不由 carry 供给】
     *
     * 市场行（`- id: dsh-skin-market`）的唯一供给方是托管文件
     * `.dshm-market-rows.yml`（见 ensureMarketRows）。但它同时也会**物理出现**在上一版
     * patch 里 —— 只要托管块标记（`# >>> dshm-user-rows` / `# <<< dshm-user-rows`）从
     * patch 中丢失，`withoutManaged()` 就排除不掉托管块，市场行于是被 carry 原样保留。
     * 而 composeUserRows 随后**又**把托管行追加一次 ⇒ 每启动净增 1 份，无限累积。
     *
     * 标记为什么会丢：上游「设置 → 插件」切开关（`dsh-plugin-manager` 的
     * writePluginEnabled）与「设置」页保存配置（`dsh-config-editor` 的 edit）都是
     * "YAML 解析 → 改条目 → 整体序列化写回"，注释不在 YAML 数据模型里，于是被吞掉。
     * 真机实测轨迹：09-29 清理至 1 份 → 09-30 约 15 份 → 10-02 实测 58 份（5208 B，
     * 正常应 2130 B），58 份内容完全一致。
     *
     * 修法：carry 阶段**直接丢弃**市场行。市场行的供给只走托管通道，因此无论标记在不在、
     * 上游写入者怎么重写注释，份数都恒定。这也让本函数对"标记丢失"这个上游行为免疫。
     */
    if (key === SKIN_MARKET_PACKAGE) {
      continue;
    }
    kept.push(entry);
  }
  return kept.join('\n');
}

/**
 * 把用户行拼到 profile 的 patch 文件末尾（E91 原逻辑）+ 预处理（D27 新增）。
 * io 注入 log/diag（与 dshm-installer.installSpec 的注入模式一致）：
 *   · log  → node-output.log（每次启动截断，流程性信息）
 *   · diag → dshm-host.log（append 跨重启，取证信息必须走这里）
 *
 * opts.prevPatchText：**覆盖前**的 patch 原文（缺陷 4 用；不传则退化为旧行为）
 */
function composeUserRows(profileDir, io) {
  const opts = io || {};
  const iLog = typeof opts.log === 'function' ? opts.log : () => {};
  const iDiag = typeof opts.diag === 'function' ? opts.diag : () => {};
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  // 改名前（HDSH 时代）的状态文件先迁到新名，否则升级用户会读不到自己的插件行
  if (migrateLegacyRowsName(profileDir, USER_ROWS_FILENAME)) {
    iLog(`用户插件行：已从旧名 ${USER_ROWS_FILENAME.replace('.dshm-', '.hdsh-')} 迁移`);
  }
  const rowsPath = path.join(profileDir, USER_ROWS_FILENAME);
  // ── 市场配置托管行（P0）：包在才写，包不在自动清（见 ensureMarketRows）──
  const profileName = typeof opts.profile === 'string' && opts.profile.length > 0 ? opts.profile : 'ondevice';
  const hasMarket = ensureMarketRows(profileDir, profileName, opts);
  let rows = '';
  try {
    rows = fs.readFileSync(rowsPath, 'utf8').trim();
  } catch (e) {
    rows = ''; // 用户行文件可能不存在（全新安装）：只有市场行也要拼
  }
  /*
   * 【这里不能提前 return（缺陷 4 的第二处）】原判定是
   *     if (rows.length === 0 && !hasMarket) return;
   * 但那会漏掉**只写了设置、没装插件**的情形——恰恰是缺陷 4 的主场景：
   * 用户在「设置 → 模型」配好提供方，既没有 .dshm-plugin-rows.yml，
   * 也没有市场行 ⇒ 直接 return ⇒ 种子覆盖后的配置无人捞回。
   * 所以提前返回的条件里必须加上"也没有非种子条目要保留"。
   */
  const prevPatchText = typeof opts.prevPatchText === 'string' ? opts.prevPatchText : '';
  let pendingCarried = '';
  try {
    const seedRaw = fs.readFileSync(patchPath, 'utf8');
    pendingCarried = carryForeignTopLevelEntries(seedRaw, prevPatchText);
  } catch (e) {
    pendingCarried = '';
  }
  if (rows.length === 0 && !hasMarket && pendingCarried.length === 0) {
    return;
  }
  let seed = '';
  try {
    seed = fs.readFileSync(patchPath, 'utf8');
  } catch (e) {
    iLog('读 profile patch 失败（忽略用户行）：' + e.message);
    return;
  }

  const { keptText, dropped } = rows.length > 0
    ? prefilterUserRows(rows, profileDir)
    : { keptText: '', dropped: [] };
  if (dropped.length > 0) {
    const list = dropped.map((d) => `  - ${d.id}：${d.reason}`).join('\n');
    iDiag(`【用户插件行预检】${dropped.length} 行的包不完整，本次启动跳过（防 BOOT_ERR 死锁）：\n${list}\n（行仍保留在 ${USER_ROWS_FILENAME}，重装对应插件后下次启动自动恢复）`);
  }
  // 市场行也要过同一预检（包已被 ensureMarketRows 确认存在，这里主要防"半残目录"）。
  let marketText = '';
  if (hasMarket) {
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(profileDir, MARKET_ROWS_FILENAME), 'utf8').trim();
    } catch (e) {
      raw = '';
    }
    if (raw.length > 0) {
      const mk = prefilterUserRows(raw, profileDir);
      if (mk.keptText.length > 0) {
        marketText = mk.keptText;
      } else {
        iLog(`市场配置行未通过预检（${mk.dropped.length} 行），本次不拼接`);
      }
    }
  }
  if (keptText.length === 0 && marketText.length === 0 && pendingCarried.length === 0) {
    iLog(`用户插件行全部未通过预检（${dropped.length} 行），本次不拼接`);
    return;
  }
  // 把 `- id: @scope/name` 这类需要引号的 id 加上单引号再拼进 patch（防 cordis.patch.yml
  // YAML 解析崩 → profile 整体起不来。真机实证 2026-09-24：@liustack/modlens 未加引号
  // 的行直接把 DSHM 卡在启动画面）。
  const sanitize = (t) => t
    .split('\n')
    .map((l) => {
      const rm = /^(-+\s+id:\s*)(.+)$/.exec(l);
      if (rm === null || /^\s*['"]/.test(rm[2])) {
        return l;
      }
      return rm[1] + yamlQuote(rm[2]);
    })
    .join('\n');
  const sanitized = sanitize(keptText);
  // 市场行排在用户行**之前**：它是本机托管的配置，用户行（含同名包的自定义行）在后、
  // 按"后写覆盖先写"的既有约定取得更高优先级——保持用户意图最后生效。
  const bodyParts = [marketText, sanitized].filter((s) => s.length > 0);
  // pendingCarried 已在上方（提前返回判定处）算好：那里读的是**覆盖后的种子**，
  // 与这里的 seed 同一个文件，所以直接复用，不再重复解析。
  const carried = pendingCarried;
  /*
   * 【拼装顺序（后写覆盖先写）】
   *   种子 → carried（种子没有的、设置页写的配置）→ 托管块（市场行 + 用户插件行）
   * 这样托管行优先级最高（用户显式装的插件最后生效），
   * 而设置页写的配置排在种子之后、不会被种子压掉。
   */
  const composed = `${seed.replace(/\s*$/, '')}\n\n${carried}${carried.length > 0 ? '\n' : ''}`
    + `${USER_ROWS_BEGIN}\n${bodyParts.join('\n')}\n${USER_ROWS_END}\n`;
  fs.writeFileSync(patchPath, composed, 'utf8');
  // 同步回写 .dshm-plugin-rows.yml，后续启动不再依赖本次运行时变换。
  try {
    if (sanitized !== keptText) {
      fs.writeFileSync(rowsPath, sanitized + '\n', 'utf8');
    }
  } catch (e) {
    iLog('回写用户插件行（补引号）失败（忽略）：' + e.message);
  }
  iLog(`已应用用户插件行：${rowsPath}${dropped.length > 0 ? `（跳过 ${dropped.length} 行坏行）` : ''}`
    + `${marketText.length > 0 ? `；含市场配置 profile=${profileName}` : ''}`
    + `${carried.length > 0 ? `；保留非种子条目 ${carried.split('\n').filter((l) => /^-\s/.test(l)).length} 个` : ''}`);
}

/**
 * 启动失败时写标记（main.js 的 fail() 调）。写不进也不能反过来把 fail 路径搞崩。
 */
function writeBootFailMarker(homeDir, stage, reason) {
  if (typeof homeDir !== 'string' || homeDir.length === 0) {
    return;
  }
  try {
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(path.join(homeDir, BOOT_FAIL_MARKER),
      `${new Date().toISOString()} stage=${stage} reason=${reason}\n`, 'utf8');
  } catch (e) {
    // 磁盘满/权限：自愈缺位，但 BOOT_ERR 本身已进日志
  }
}

/**
 * 清理 profile package.json 里"包不完整"的依赖行（D27 根因的第二落点）。
 *
 * 【为什么连 package.json 也要管】真机取证（批次备注十一）：dsh-app-boot 的
 * resolveModuleFallbackEntries 把 profile package.json 的 dependencies /
 * peerDependencies 逐个变成 loader 可见的 import 入口（0.1.6 树 lib/index.js:579-604，
 * 注释原文 "package.json (out-of-tree plugin dependencies …)"）。旧版
 * dshm-installer.mergeDependencies 曾把整棵依赖树写进来，其中 dshmarket 的
 * lib/index.js 在设备上缺失 ⇒ BOOT_ERR。cordis.patch.yml 每次启动被核心种子
 * 覆盖、用户行有预检，**唯独 package.json 刻意不覆盖**（保用户装的插件）⇒
 * 脏行必须在这里逐条预检后移除。种子 package.json 的 dependencies 是空对象
 * ⇒ 全量预检只会命中用户装的包，不会误伤核心 bundle 行（它们走
 * dsh.profile.bundles，不走 dependencies）。
 */
function sanitizeDependencies(profileDir, io) {
  const opts = io || {};
  const iLog = typeof opts.log === 'function' ? opts.log : () => {};
  const iDiag = typeof opts.diag === 'function' ? opts.diag : () => {};
  const seedBundles = Array.isArray(opts.seedBundles) ? opts.seedBundles : [];
  // 【anchorDirs】resolveBundleDir 先查核心树（installAnchor）再查 profile/node_modules
  // （0.1.6 树 dsh-app-boot lib/index.js:899-904）——OPTIONAL_BUNDLES 这类核心树
  // 可选 bundle 必须从 anchorDirs 判，只查 profile 侧会误杀（真机实证：第四轮）。
  const anchorDirs = Array.isArray(opts.anchorDirs) ? opts.anchorDirs : [];
  const pkgPath = path.join(profileDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { removed: [] };
  }
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    // 解析失败不在这里动文件：ensureProfile 的种子合并分支会给出自己的结论
    iLog('读 profile package.json 失败（跳过依赖预检）：' + e.message);
    return { removed: [] };
  }
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
    return { removed: [] };
  }
  const removed = [];
  let changed = false;
  for (const field of ['dependencies', 'peerDependencies']) {
    const deps = pkg[field];
    if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) {
      continue;
    }
    for (const key of Object.keys(deps)) {
      const reason = userRowLoadable(profileDir, key);
      if (reason.length === 0) {
        continue;
      }
      delete deps[key];
      changed = true;
      removed.push({ id: key, reason, field });
    }
  }
  if (changed) {
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    const list = removed.map((r) => `  - ${r.id}（${r.field}）：${r.reason}`).join('\n');
    iDiag(`【依赖预检】profile package.json 里 ${removed.length} 行的包不完整，已移除（防 BOOT_ERR 死锁）：\n${list}\n（对应包文件仍在 node_modules，未删除；重装可恢复）`);
    iLog(`依赖预检：移除 ${removed.length} 行坏依赖`);
  }
  /*
   * 【第四落点：dsh.profile.bundles】loadProfileDirectory（0.1.6 树 dsh-app-boot
   * lib/index.js:917-920）把 bundles 逐个 resolveBundleDir + 读 dsh.bundle.patch，
   * 任一失败启动即抛。旧版安装把用户包（dshmarket）写进了 bundles，而
   * ensureProfile 的 merge 刻意保留现有 bundles——真机实证（批次备注十一第四轮）：
   * 半残目录隔离后错误提前为 "cannot resolve profile bundle dshmarket"。
   * 判据与 loadProfileDirectory 同语义：node_modules 里可解析 + dsh.bundle.patch
   * 是字符串 + patch 文件存在；种子 bundles（核心树里的）走白名单无条件保留。
   */
  const removedBundles = [];
  const bundles = pkg !== null && typeof pkg === 'object' && !Array.isArray(pkg)
    && pkg.dsh !== null && typeof pkg.dsh === 'object' && !Array.isArray(pkg.dsh)
    && pkg.dsh.profile !== null && typeof pkg.dsh.profile === 'object' && !Array.isArray(pkg.dsh.profile)
    && Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : null;
  if (bundles !== null) {
    const keptBundles = [];
    for (const name of bundles) {
      if (typeof name !== 'string' || seedBundles.includes(name)) {
        keptBundles.push(name);
        continue;
      }
      let reason = '';
      const anchors = [path.join(profileDir, 'node_modules'), ...anchorDirs];
      let resolvedDir = '';
      for (const anchor of anchors) {
        const candidate = path.join(anchor, name);
        if (fs.existsSync(path.join(candidate, 'package.json'))) {
          resolvedDir = candidate;
          break;
        }
      }
      if (resolvedDir === '') {
        reason = `node_modules/${name} 不存在（核心树与 profile 均未找到）`;
      } else {
        try {
          const manifest = JSON.parse(fs.readFileSync(path.join(resolvedDir, 'package.json'), 'utf8'));
          const declared = manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
            && manifest.dsh !== null && typeof manifest.dsh === 'object' && !Array.isArray(manifest.dsh)
            && manifest.dsh.bundle !== null && typeof manifest.dsh.bundle === 'object' && !Array.isArray(manifest.dsh.bundle)
            && typeof manifest.dsh.bundle.patch === 'string' ? manifest.dsh.bundle.patch : '';
          if (declared.length === 0) {
            reason = `${name}/package.json 未声明 dsh.bundle.patch`;
          } else if (!fs.existsSync(path.join(resolvedDir, declared))) {
            reason = `${name}/${declared} 不存在`;
          } else {
            // 【补入口判据（2026-09-24）】半残包（package.json 在、入口缺）此前能通过
            // bundle 预检（只查 package.json + dsh.bundle.patch），随后被半残包隔离改名
            // ⇒ bundles 悬空引用，setBundleEnabled 恒报 cannot resolve profile bundle
            // （真机实证 2026-09-24 02:45 批次：预检放行 + 隔离改名发生在同一次启动）。
            // 与 brokenPackageNames 同判据（entryCandidates 逐一存在性）；按 resolvedDir
            // 判而非 profileDir——bundle 可解析在核心树（anchorDirs），只查 profile 会误杀。
            const candidates = entryCandidates(manifest);
            /*
             * 【判据必须与 userRowLoadable 一致：任一候选可解析即通过】
             * 候选是 Node require 的**回退链**，不是"全部条件"。此前这里用
             * `candidates.find(rel => !exists)` = 要求**所有**候选都存在，与
             * `userRowLoadable`（见其注释 ②）的口径相反：同一个包在一处被放行、
             * 另一处被判坏。这种不一致本身就是缺陷——`dshm-installer.js` 顶部
             * 明确写着"两边判据不一致就是'装完即被拒拼/隔离'的配方"。
             *
             * 真机可复现的形态：`main: 'index'`（无扩展名，靠 require 补 .js/目录
             * index 回退）或 `main` 指向多个候选链的包，在 bundle 预检里被误杀。
             */
            if (candidates.length > 0 && !candidates.some((rel) => entryFileResolves(resolvedDir, rel))) {
              reason = `入口文件缺失：${name}/${candidates[0]}（候选 ${candidates.join('、')}）`;
            }
          }
        } catch (e) {
          reason = `${name}/package.json 解析失败：${e.message}`;
        }
      }
      if (reason.length === 0) {
        keptBundles.push(name);
      } else {
        removedBundles.push({ id: name, reason });
      }
    }
    if (removedBundles.length > 0) {
      pkg.dsh.profile.bundles = keptBundles;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      const list = removedBundles.map((r) => `  - ${r.id}：${r.reason}`).join('\n');
      iDiag(`【bundle 预检】dsh.profile.bundles 里 ${removedBundles.length} 行不可解析，已移除（防启动抛错）：\n${list}\n（种子 bundle 不受影响；重装可恢复）`);
      iLog(`bundle 预检：移除 ${removedBundles.length} 行坏 bundle`);
    }
  }
  return { removed, removedBundles };
}

/**
 * 扫 profile 的 node_modules 顶层，找出"半残包"名单：
 * package.json 在但入口文件缺失（userRowLoadable 判坏）的目录名。
 * 名单是 rows/dependencies/home patch 三处预检共用的磁盘事实来源。
 * 已隔离的目录（名字含 .dshm-broken-）跳过——幂等，不叠加改名。
 */
function brokenPackageNames(profileDir) {
  const nmDir = path.join(profileDir, 'node_modules');
  const names = [];
  if (!fs.existsSync(nmDir)) {
    return names;
  }
  const visit = (dir, scope) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch (e) {
      return names;
    }
    for (const entry of entries) {
      if (entry.includes('.dshm-broken-')) {
        continue;
      }
      const full = path.join(dir, entry);
      let stat = null;
      try {
        stat = fs.statSync(full);
      } catch (e) {
        continue;
      }
      if (!stat.isDirectory()) {
        continue;
      }
      if (scope === '' && entry.startsWith('@')) {
        visit(full, `${entry}/`);
        continue;
      }
      if (fs.existsSync(path.join(full, 'package.json')) && userRowLoadable(profileDir, scope + entry).length > 0) {
        names.push(scope + entry);
      }
    }
    return names;
  };
  visit(nmDir, '');
  return names;
}

/**
 * home 层 cordis.patch.yml 的预检（第三层防线）。
 * 【为什么】readProfilePatches（0.1.6 树 dsh-app-boot lib/index.js:1010）每次启动
 * 都把 $DSH_HOME/cordis.patch.yml 读进 patch 栈；它不在 profile 目录里，种子覆盖
 * 与依赖预检都够不着。真机实证（批次备注十一第三轮）：rows 隔离 + dependencies
 * 清空后 BOOT_ERR 原样复现，home 层是唯一在场的源。
 * 判坏两路（任一命中即整体改名隔离，原样保留可手工恢复）：
 *   1. 文本包含半残包名（名单来自 node_modules 扫描，防已知坏包）；
 *   2. name 字段提取值判坏（防"行在、node_modules 里根本没有"的幽灵行）。
 * 所有 fs 操作 catch 不抛：预检失败不许挡启动，真有坏行时 BOOT_ERR →
 * 下次启动自愈兜底（quarantine 会无条件隔离 home 层）。
 */
function sanitizeHomePatch(profileDir, homeDir, io) {
  const opts = io || {};
  const iLog = typeof opts.log === 'function' ? opts.log : () => {};
  const iDiag = typeof opts.diag === 'function' ? opts.diag : () => {};
  if (typeof homeDir !== 'string' || homeDir.length === 0) {
    return { quarantined: false };
  }
  const homePatch = path.join(homeDir, 'cordis.patch.yml');
  if (!fs.existsSync(homePatch)) {
    return { quarantined: false };
  }
  let text = '';
  try {
    text = fs.readFileSync(homePatch, 'utf8');
  } catch (e) {
    iLog('读 home 层 patch 失败（跳过预检）：' + e.message);
    return { quarantined: false };
  }
  // 路 1：文本包含半残包名
  const broken = brokenPackageNames(profileDir);
  const hitByName = broken.filter((name) => text.includes(name));
  // 路 2：name 字段提取（YAML 裸标量或引号形态，含 @scope/pkg）
  const hitFromRows = [];
  const re = /^\s*name:\s*(?:['"]([^'"\n]+)['"]|(\S+))\s*$/gm;
  let m = re.exec(text);
  while (m !== null) {
    const name = m[1] !== undefined ? m[1] : m[2];
    if (userRowLoadable(profileDir, name).length > 0 && !hitFromRows.includes(name)) {
      hitFromRows.push(name);
    }
    m = re.exec(text);
  }
  const hits = [...hitByName];
  for (const n of hitFromRows) {
    if (!hits.includes(n)) {
      hits.push(n);
    }
  }
  if (hits.length === 0) {
    return { quarantined: false };
  }
  try {
    const quarantinePath = `${homePatch}.quarantine-${Date.now()}`;
    fs.renameSync(homePatch, quarantinePath);
    iDiag(`【home 层预检】$DSH_HOME/cordis.patch.yml 引用了不可加载的插件（${hits.join('、')}），已整体隔离为 ${path.basename(quarantinePath)}（原样保留，可手工恢复）。\n原因：home 层 patch 每次启动都会被 readProfilePatches 读进 loader 的 patch 栈，坏行会让插件树加载失败（BOOT_ERR 死锁）。`);
    iLog(`home 层预检：隔离 cordis.patch.yml（坏引用 ${hits.join('、')}）`);
  } catch (e) {
    iLog('home 层 patch 隔离失败（继续启动，自愈兜底）：' + e.message);
    return { quarantined: false };
  }
  return { quarantined: true, hits };
}

/**
 * 半残包目录改名隔离（卫生措施）。
 * 【为什么】行清干净后目录只是残留，但任何未来机制再引用它都会回到同一死锁；
 * 目录本身是"已装坏"的取证现场——改名隔离比留着或删除都稳。
 * 返回 { quarantined: [名字] }。
 */
function quarantineBrokenPackages(profileDir, io) {
  const opts = io || {};
  const iLog = typeof opts.log === 'function' ? opts.log : () => {};
  const iDiag = typeof opts.diag === 'function' ? opts.diag : () => {};
  const broken = brokenPackageNames(profileDir);
  const done = [];
  for (const name of broken) {
    const dir = path.join(profileDir, 'node_modules', name);
    try {
      const quarantineDir = `${dir}.dshm-broken-${Date.now()}`;
      fs.renameSync(dir, quarantineDir);
      done.push(name);
    } catch (e) {
      iLog(`半残包目录隔离失败（${name}）：` + e.message);
    }
  }
  if (done.length > 0) {
    iDiag(`【半残包隔离】node_modules 里 ${done.length} 个包目录不完整（package.json 在但入口缺失），已改名隔离：${done.join('、')}（均加 .dshm-broken-<时间戳> 后缀，原样保留可取证/恢复；重装可恢复）`);
    iLog(`半残包隔离：${done.length} 个目录改名`);
  }
  return { quarantined: done };
}

/**
 * 清理历史隔离残留（卫生措施，2026-09-26 报告 2 §清理清单）。
 *
 * 【为什么要有它】`.dshm-broken-*` / `*.quarantine-*` 是**保数据的隔离命名**——
 * 每次安装失败/启动失败都可能新产生一批。它们不会被自动回收，长期堆积既占空间，
 * 也让"哪些是真现场、哪些是陈年残留"变得不可辨。这里在每次启动做一次**限量**
 * 回收：只删"改名时间超过 KEEP_MS"的残留（默认 7 天），近期保留以便取证。
 * 【为什么是年龄而不是"全删"】取证窗口：用户报告问题到我们拿到日志通常几小时内，
 * 7 天足够宽松；而一旦超过，现场价值<占用成本。
 * 【为什么只限量扫两层】隔离物只出现在 `profile/node_modules/*` 与 `profile/*`；
 * 深递归会在大目录拖慢启动（与 recoverOrphanLocks 同一顾虑）。
 * @returns 删除的条目数
 */
function cleanupQuarantineResidue(profileDir, homeDir, io) {
  const opts = io || {};
  const iLog = typeof opts.log === 'function' ? opts.log : () => {};
  const KEEP_MS = 7 * 24 * 3600 * 1000;
  const MARKERS = ['.dshm-broken-', '.quarantine-'];
  const roots = [];
  if (typeof profileDir === 'string' && profileDir.length > 0) {
    roots.push(path.join(profileDir, 'node_modules'), profileDir);
  }
  if (typeof homeDir === 'string' && homeDir.length > 0) {
    // home 层 patch 的隔离物直接落在 home 根（见 quarantineAfterBootFailure）。
    roots.push(path.join(homeDir, 'profiles'), homeDir);
  }
  const now = Date.now();
  let removed = 0;
  const seen = new Set();
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (e) {
      continue; // 目录不存在/不可读：正常
    }
    for (const entry of entries) {
      if (!MARKERS.some((m) => entry.name.includes(m))) {
        continue;
      }
      const full = path.join(root, entry.name);
      if (seen.has(full)) {
        continue;
      }
      seen.add(full);
      // 从名字里解析时间戳（-<ms>）；解析不出就看 mtime（更保守：以较**新**的为准）。
      const m = /-(\d{10,})$/.exec(entry.name);
      let stamp = m === null ? 0 : Number.parseInt(m[1], 10);
      if (!Number.isFinite(stamp) || stamp <= 0) {
        try { stamp = fs.statSync(full).mtimeMs; } catch (e) { continue; }
      }
      if (now - stamp < KEEP_MS) {
        continue; // 仍在取证窗口内：保留
      }
      try {
        fs.rmSync(full, { recursive: true, force: true });
        removed += 1;
      } catch (e) {
        // 删不动就留着（hmfs 上可能的 EACCES）：不影响启动
      }
    }
  }
  if (removed > 0) {
    iLog(`隔离残留清理：已回收 ${removed} 项超过 7 天的 .dshm-broken-*/.quarantine-*`);
  }
  return removed;
}

/**
 * 启动早期自愈：上次启动失败（标记在）⇒ 隔离用户行文件 + 清空 dependencies
 * 并清标记。改名/备份而非删除：quarantine 副本保留全部现场（取证 + 可手工恢复）。
 *
 * 【为什么要连 dependencies 一起清】"回到纯种子"才叫自愈——脏 dependencies
 * （loader 的 include 源）不清掉，光隔离 rows 文件救不了 package.json 引发的
 * 死锁（真机实证：批次十一第一次修复只隔离了 rows，BOOT_ERR 原样复现）。
 *
 * 【为什么要连 home 层一起隔离】home 层 patch（$DSH_HOME/cordis.patch.yml）同样
 * 每次 startup 进 patch 栈（dsh-app-boot readProfilePatches:1010），且不在 profile
 * 目录里、种子够不着——真机实证（批次十一第三轮）：rows+dependencies 清干净后
 * BOOT_ERR 仍复现。自愈语义=回到纯种子：home 层无条件隔离，不逐行判定。
 */
function quarantineAfterBootFailure(profileDir, homeDir, io) {
  const opts = io || {};
  const iDiag = typeof opts.diag === 'function' ? opts.diag : () => {};
  if (typeof homeDir !== 'string' || homeDir.length === 0) {
    return;
  }
  const markerPath = path.join(homeDir, BOOT_FAIL_MARKER);
  if (!fs.existsSync(markerPath)) {
    return;
  }
  let detail = '';
  try {
    detail = fs.readFileSync(markerPath, 'utf8').trim();
  } catch (e) {
    // 详情读不到也继续隔离：标记存在本身就说明上次没起来
  }
  const acts = [];
  const rowsPath = path.join(profileDir, USER_ROWS_FILENAME);
  try {
    if (fs.existsSync(rowsPath)) {
      const quarantinePath = `${rowsPath}.quarantine-${Date.now()}`;
      fs.renameSync(rowsPath, quarantinePath);
      acts.push(`已把用户插件行隔离为 ${path.basename(quarantinePath)}（原样保留，可手工恢复）`);
    }
  } catch (e) {
    acts.push(`隔离用户插件行失败：${e.message}`);
  }
  try {
    const pkgPath = path.join(profileDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const backup = `${pkgPath}.quarantine-${Date.now()}`;
      fs.copyFileSync(pkgPath, backup);
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      let cleared = 0;
      for (const field of ['dependencies', 'peerDependencies']) {
        const deps = pkg[field];
        if (deps !== null && typeof deps === 'object' && !Array.isArray(deps)) {
          cleared += Object.keys(deps).length;
          pkg[field] = {};
        }
      }
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      acts.push(`package.json 的 dependencies/peerDependencies 已清空（共 ${cleared} 行，原文件备份为 ${path.basename(backup)}）`);
    }
  } catch (e) {
    acts.push(`清空 package.json 依赖失败：${e.message}`);
  }
  try {
    const homePatch = path.join(homeDir, 'cordis.patch.yml');
    if (fs.existsSync(homePatch)) {
      const quarantinePath = `${homePatch}.quarantine-${Date.now()}`;
      fs.renameSync(homePatch, quarantinePath);
      acts.push(`home 层 patch 已隔离为 ${path.basename(quarantinePath)}（原样保留，可手工恢复）`);
    }
  } catch (e) {
    acts.push(`隔离 home 层 patch 失败：${e.message}`);
  }
  try {
    const broken = quarantineBrokenPackages(profileDir, opts);
    if (broken.quarantined.length > 0) {
      acts.push(`半残包目录已改名隔离：${broken.quarantined.join('、')}`);
    }
  } catch (e) {
    acts.push(`隔离半残包目录失败：${e.message}`);
  }
  try {
    fs.rmSync(markerPath, { force: true });
  } catch (e) {
    // 删不掉：下次启动会再走一遍（幂等，备份/隔离副本带时间戳不叠加）
  }
  const note = acts.length > 0 ? acts.join('；') : 'profile 下没有用户插件行，无需隔离';
  iDiag(`【启动自愈】上次启动失败（${detail}）。${note}。本次以纯种子 profile 启动。`);
}

module.exports = {
  USER_ROWS_FILENAME,
  migrateLegacyRowsName,
  USER_ROWS_BEGIN,
  USER_ROWS_END,
  MARKET_ROWS_FILENAME,
  SKIN_MARKET_PACKAGE,
  ensureMarketRows,
  BOOT_FAIL_MARKER,
  entryCandidates,
  entryFileResolves,
  userRowLoadable,
  prefilterUserRows,
  composeUserRows,
  sanitizeDependencies,
  sanitizeHomePatch,
  quarantineBrokenPackages,
  cleanupQuarantineResidue,
  writeBootFailMarker,
  quarantineAfterBootFailure,
  // 缺陷 4 的保留逻辑：导出供回归用例直接验证（防以后被静默改坏）
  carryForeignTopLevelEntries,
};
