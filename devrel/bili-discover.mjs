#!/usr/bin/env node
/*
 * B 站鸿蒙生态 · 选题与 UP 主发现器（**只读**）
 *
 * ── 它做什么 ─────────────────────────────────────────────────────────
 * 用 B 站**公开只读接口**搜出鸿蒙生态相关视频，按「与 DSHM 的相关度」
 * 而不是「播放量」排序，输出两份东西：
 *   ① 值得你亲自去认真留言的视频清单（带命中词，不是黑箱打分）
 *   ② 值得谈合作/测评的 UP 主聚合清单
 *
 * ── 它**不**做什么（刻意写死，不是没实现）────────────────────────────
 * 本文件不含任何写接口：不发评论、不发私信、不点赞、不投币、不关注，
 * 也不需要你的登录 Cookie。`--self-test` 会在源码里扫描并断言这一点，
 * 防止日后被人"顺手"加上自动化投放——那才是会把账号搭进去的东西。
 *
 * 为什么坚持只读：批量在同质视频下投放同一链接，在 B 站属于链接刷屏，
 * 风控结果是删评 → 限流 → 禁言 → 封号，而用来宣发的正是项目官方号。
 * 曝光收益极低、账号与项目声誉代价不可逆，风险收益完全不对称。
 * 这个工具把力气花在"该去哪几个地方认真说话"上。
 *
 * ── 为什么放在 devrel/ 而不是 tools/ ─────────────────────────────────
 * tools/ 下全是本项目的**构建与回归门禁**（AGENTS.md 的「必跑回归门禁」表），
 * 每加一个文件都会被当成项目质量的一部分。本工具与鸿蒙端构建、功能对等
 * 毫无关系，放进去会稀释门禁链的语义。devrel/ 是宣发侧工具，独立存在。
 *
 * ── 接口事实（2026-09 实测，见本文件末尾「口径」一节）────────────────
 *   · /x/frontend/finger/spi           匿名 buvid3，无需登录
 *   · /x/web-interface/nav             未登录也返回 wbi_img（code -101 但 data 有）
 *   · /x/web-interface/wbi/search/type 需 wbi 签名；**不需要**登录
 *   · /x/web-interface/view            无需登录，拿精确的赞/币/藏/分享/评论数
 *
 * 用法：
 *   node devrel/bili-discover.mjs                    # 默认词表，出报告
 *   node devrel/bili-discover.mjs --keywords 鸿蒙开发,ArkTS
 *   node devrel/bili-discover.mjs --pages 3 --enrich-top 40
 *   node devrel/bili-discover.mjs --fresh            # 按最新发布排序（找新视频用）
 *   node devrel/bili-discover.mjs --order click      # totalrank|click|pubdate|danmaku
 *   node devrel/bili-discover.mjs --json-only        # 只要 candidates.json
 *   node devrel/bili-discover.mjs --self-test        # 离线自检（负测试）
 *   node devrel/bili-discover.mjs --help
 *
 * 注意：默认综合排序捞到的大多是**陈年爆款**，给三年前的视频留言几乎没人看。
 *       想找"现在值得说话的地方"，加 --fresh。
 *
 * 退出码：0 成功 / 1 失败 / 2 用法错误。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const SELF_PATH = fileURLToPath(import.meta.url);

/* ══════════════════════════════════════════════════════════════════
 * ① 词表：打分口径的**全部**依据都在这里，改这里就能改排序
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 正相关词表。w = 权重；命中位置决定折扣（标题 1.0 / 标签 0.7 / 简介 0.4，取最高一处）。
 *
 * 权重不是拍脑袋：它编码的是「这个视频的观众里有多少人在写鸿蒙代码」。
 *   CORE  3.0 —— 观众几乎必然是鸿蒙开发者
 *   DEV   2.5 —— 开发者内容，但可能不做鸿蒙
 *   TOOL  2.0 —— 桌面端/工具链，DSHM 的直接同类场景
 *   ECO   1.5 —— 生态/社区话题，观众相关但偏泛
 */
const POSITIVE = [
  // CORE
  { label: '鸿蒙', w: 3.0, re: /鸿蒙|harmony\s?os|hongmeng/i },
  { label: 'ArkTS', w: 3.0, re: /arkts|ark\s?ts/i },
  { label: 'ArkUI', w: 3.0, re: /arkui|ark\s?ui/i },
  { label: 'OpenHarmony', w: 3.0, re: /openharmony|ohos/i },
  { label: 'DevEco', w: 3.0, re: /deveco/i },
  { label: '元服务', w: 3.0, re: /元服务/i },
  { label: 'HAP/HAR包', w: 2.5, re: /\bhap\b|\bhar\b|hap包|har包/i },
  // DEV
  { label: '开发', w: 2.5, re: /开发|编程|写代码|code/i },
  { label: '源码/开源', w: 2.5, re: /源码|开源|open\s?source|\bpr\b|仓库|github|gitee/i },
  { label: '教程/实战', w: 2.5, re: /教程|实战|入门|从零|手把手|系列课|训练营/i },
  { label: 'SDK/API', w: 2.5, re: /\bsdk\b|\bapi\b|接口|框架|组件库|插件/i },
  { label: '构建/移植', w: 2.0, re: /编译|构建|打包|调试|移植|适配|交叉编译|签名/i },
  { label: '上架/性能', w: 1.5, re: /上架|应用市场|性能优化|内存泄漏|启动优化/i },
  // TOOL —— DSHM 的直接同类场景
  { label: '桌面端', w: 2.0, re: /桌面端|desktop|pc\s?端|2in1|二合一/i },
  { label: '工具链/CLI', w: 2.0, re: /工具链|命令行|\bcli\b|终端|shell|node|electron|typescript/i },
  { label: '端侧/AI', w: 2.0, re: /端侧|本地推理|大模型|llm|agent|语音识别|asr/i },
  // ECO
  { label: '生态', w: 1.5, re: /生态|开发者|共建|社区|技术分享/i },
];

/**
 * 负相关词表：消费电子/资讯向内容。
 * 观众是"想买手机的人"，不是"想写代码的人"——投推广到这里等于噪音。
 */
const NEGATIVE = [
  { label: '开箱/评测', w: -3.0, re: /开箱|评测|测评|上手体验|体验报告|值不值得买/i },
  { label: '发布会/资讯', w: -3.0, re: /发布会|春季沟通会|预热|爆料|传闻|销量|份额/i },
  { label: '车机/座舱', w: -3.0, re: /车机|智能座舱|汽车|问界|智界|享界|尊界/i },
  { label: '参数/硬件', w: -2.5, re: /影像|拍照|续航|快充|电池|跑分|屏幕素质|镜头|芯片参数|散热/i },
  { label: '消费数码', w: -1.5, re: /数码|手机|平板|手表|耳机|折叠屏|家电|门店/i },
];

/** 低于此相关度视为噪音，不进候选。 */
const MIN_RELEVANCE = 5.0;

/* ══════════════════════════════════════════════════════════════════
 * ② wbi 签名（B 站网关要求；纯算法，不涉及登录态）
 * ══════════════════════════════════════════════════════════════════ */

/** 官方混淆表：对 imgKey+subKey 拼成的 64 字符串做重排，取前 32 位当密钥。 */
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

const md5 = (s) => createHash('md5').update(s).digest('hex');

export function mixinKey(raw) {
  return MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32);
}

/** 网关要求剔除这四个字符，否则 w_rid 校验不过。 */
const sanitize = (s) => String(s).replace(/[!'()*]/g, '');

export function signQuery(params, key, wts) {
  const p = { ...params, wts };
  const q = Object.keys(p)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(sanitize(p[k]))}`)
    .join('&');
  return { query: q, w_rid: md5(q + key) };
}

/* ══════════════════════════════════════════════════════════════════
 * ③ 打分：**可解释**是硬要求，输出里会带上命中词
 * ══════════════════════════════════════════════════════════════════ */

const FIELD_WEIGHT = { title: 1.0, tag: 0.7, desc: 0.4 };

/**
 * 相关度打分。
 * 每个词只看它命中的**最好**那个字段（不叠加），避免"简介里堆关键词"刷分。
 * 返回值带 hits，报告里直接展示——分数不对时你能一眼看出是哪个词的锅。
 */
export function scoreRelevance({ title = '', tag = '', desc = '' }) {
  const fields = { title, tag, desc };
  const hits = [];
  let score = 0;

  for (const term of POSITIVE) {
    let best = 0;
    let where = null;
    for (const [name, text] of Object.entries(fields)) {
      if (text && term.re.test(text) && FIELD_WEIGHT[name] > best) {
        best = FIELD_WEIGHT[name];
        where = name;
      }
    }
    if (best > 0) {
      score += term.w * best;
      hits.push({ label: term.label, w: term.w, at: where, sign: '+' });
    }
  }

  for (const term of NEGATIVE) {
    let best = 0;
    let where = null;
    for (const [name, text] of Object.entries(fields)) {
      if (text && term.re.test(text) && FIELD_WEIGHT[name] > best) {
        best = FIELD_WEIGHT[name];
        where = name;
      }
    }
    if (best > 0) {
      score += term.w * best;
      hits.push({ label: term.label, w: term.w, at: where, sign: '−' });
    }
  }

  return { relevance: Math.max(0, score), hits };
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** 播放量对数归一：1e2 → ≈0，1e5 → ≈0.86，1e6 → 1（封顶）。 */
export function reachOf(play) {
  return clamp01((Math.log10(Math.max(0, play) + 10) - 2) / 3.5);
}

/** 时间衰减：半衰期约 166 天（240 天到 0.37）。 */
export function freshnessOf(ageDays) {
  return Math.exp(-Math.max(0, ageDays) / 240);
}

/**
 * 综合优先级。刻意**不让播放量主导**：
 * 相关度是主项，播放量只做 0.3–1.0 的调制，新鲜度做 0.45–1.0 的调制。
 * 所以一个 5000 播放的 ArkTS 实战教程会稳定压过 80 万播放的手机评测。
 */
export function priorityOf(rec) {
  const relNorm = Math.min(1, rec.relevance / 18);
  return 100 * relNorm * (0.3 + 0.7 * reachOf(rec.play)) * (0.45 + 0.55 * freshnessOf(rec.ageDays));
}

/* ══════════════════════════════════════════════════════════════════
 * ④ 网络层：低速率 + 退避，公开只读接口
 * ══════════════════════════════════════════════════════════════════ */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let requestCount = 0;

async function getJson(url, cookie, { tries = 4 } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    requestCount++;
    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: cookie },
      });
    } catch (err) {
      if (attempt === tries) throw new Error(`网络失败 ${url}：${err.message}`);
      await sleep(2000 * attempt);
      continue;
    }
    // 412 = 风控拦截；-412/-509 在 body 里。都要退避，不能硬刷。
    if (res.status === 412) {
      if (attempt === tries) throw new Error(`被风控拦截（HTTP 412），已退避 ${tries} 次仍失败`);
      await sleep(6000 * attempt);
      continue;
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      if (attempt === tries) throw new Error(`响应不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
      await sleep(2000 * attempt);
      continue;
    }
    const code = json?.code ?? json?.data?.code;
    if (code === -412 || code === -509 || code === -799) {
      if (attempt === tries) throw new Error(`接口限流 code=${code}，已退避 ${tries} 次仍失败`);
      await sleep(6000 * attempt);
      continue;
    }
    return json;
  }
  throw new Error('unreachable');
}

/** 匿名会话：buvid3 是匿名访问凭证，与账号无关。 */
async function anonymousSession() {
  const json = await getJson('https://api.bilibili.com/x/frontend/finger/spi', '');
  const buvid3 = json?.data?.b_3;
  if (!buvid3) throw new Error('拿不到 buvid3，接口可能已变更');
  return `buvid3=${buvid3}; b_nut=${Math.floor(Date.now() / 1000)}`;
}

/** 未登录时 nav 返回 code -101，但 wbi_img 仍在 data 里——这是能匿名签名的关键。 */
async function wbiKeys(cookie) {
  const json = await getJson('https://api.bilibili.com/x/web-interface/nav', cookie);
  const img = json?.data?.wbi_img?.img_url;
  const sub = json?.data?.wbi_img?.sub_url;
  if (!img || !sub) throw new Error('拿不到 wbi_img（接口可能已变更，或被要求登录）');
  const raw = img.split('/').pop().split('.')[0] + sub.split('/').pop().split('.')[0];
  if (raw.length !== 64) throw new Error(`wbi 原始密钥长度异常：${raw.length}`);
  return mixinKey(raw);
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/* ══════════════════════════════════════════════════════════════════
 * ⑤ 采集
 * ══════════════════════════════════════════════════════════════════ */

async function searchOnce(keyword, page, pageSize, key, cookie, order) {
  const { query, w_rid } = signQuery(
    { search_type: 'video', keyword, page, page_size: pageSize, order },
    key,
    Math.floor(Date.now() / 1000),
  );
  const url = `https://api.bilibili.com/x/web-interface/wbi/search/type?${query}&w_rid=${w_rid}`;
  const json = await getJson(url, cookie);
  if (json?.code !== 0) {
    throw new Error(`搜索失败 keyword=${keyword} page=${page} order=${order} `
      + `code=${json?.code} msg=${json?.message}`);
  }
  const list = json?.data?.result ?? [];
  return {
    list: list.filter((r) => r.type === 'video' && r.bvid),
    numResults: Number(json?.data?.numResults) || 0,
    numPages: Number(json?.data?.numPages) || 0,
  };
}

/**
 * 首页为空的重试。
 *
 * 【为什么必须有】实测：同一次运行里 `ArkTS` 首页返回 0 条，而紧接着手工重跑
 * 同一个词得到 `numResults=1000`。也就是说接口会在限流时**返回 200 且结果为空**
 * ——不报错、不改 code。若按"空就是没找到"处理，报告会**静默漏掉一整个关键词**，
 * 而且看不出漏了（统计表里那一行的 0 看起来像"这个词确实没内容"）。
 * 这类"看起来正常的错"正是最该拦的，所以首页为空时退避重试并显式告警。
 */
async function searchFirstPage(keyword, pageSize, key, cookie, order, gap) {
  const first = await searchOnce(keyword, 1, pageSize, key, cookie, order);
  if (first.list.length > 0) return { ...first, retryExhausted: false };
  await sleep(gap * 3);
  const retry = await searchOnce(keyword, 1, pageSize, key, cookie, order);
  if (retry.list.length > 0) {
    console.log(`  ⓘ ${keyword}（order=${order}）首页首次为空，退避重试后拿到 ${retry.list.length} 条`);
    return { ...retry, retryExhausted: false };
  }
  console.log(`  ⚠ ${keyword}（order=${order}）首页两次均为空`
    + `（接口自报 numResults=${retry.numResults}）——本关键词结果可能不完整`);
  return { ...retry, retryExhausted: true };
}

/**
 * B 站的 `duration` 是 `MM:SS` 且**分钟位可以超过 60**（实测 `999:12`、`3039:37`），
 * 不是 `HH:MM`。已用 `/x/web-interface/view` 的秒数交叉验证：
 *   607s → `10:7`、59952s → `999:12`、23141s → `385:41`。
 * 直接原样输出会让 `10:7` 被误读成"10 小时 7 分"，所以这里换成可读形式。
 */
export function formatDuration(mmss) {
  const s = String(mmss ?? '').trim();
  const m = /^(\d+):(\d{1,2})$/.exec(s);
  if (!m) return s || '—';
  const totalMin = Number(m[1]);
  const sec = Number(m[2]);
  if (sec > 59) return s;
  if (totalMin < 60) return `${totalMin}:${String(sec).padStart(2, '0')}`;
  const h = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  return `${h}h${String(mm).padStart(2, '0')}m`;
}

function toRecord(raw, keyword) {
  const title = decodeEntities(raw.title);
  const tag = String(raw.tag ?? '').replace(/,/g, ' ');
  const desc = decodeEntities(raw.description);
  const play = Number(raw.play) || 0;
  const pubdate = Number(raw.pubdate) || 0;
  const ageDays = pubdate ? (Date.now() / 1000 - pubdate) / 86400 : Number.POSITIVE_INFINITY;
  const { relevance, hits } = scoreRelevance({ title, tag, desc });
  return {
    bvid: raw.bvid,
    aid: raw.aid,
    url: `https://www.bilibili.com/video/${raw.bvid}`,
    title,
    author: raw.author ?? '',
    mid: raw.mid ?? 0,
    play,
    favorites: Number(raw.favorites) || 0,
    pubdate,
    ageDays,
    duration: String(raw.duration ?? ''),
    tag,
    foundBy: keyword,
    relevance,
    hits,
    ageDaysForScore: Number.isFinite(ageDays) ? ageDays : 3650,
  };
}

/** 逐条补精确互动数（赞/币/藏/分享/评论），用于判断"评论区是否活跃"。 */
async function enrich(rec, key, cookie) {
  const { query, w_rid } = signQuery({ bvid: rec.bvid }, key, Math.floor(Date.now() / 1000));
  const json = await getJson(
    `https://api.bilibili.com/x/web-interface/view?${query}&w_rid=${w_rid}`,
    cookie,
  );
  const st = json?.data?.stat;
  if (!st) return { ok: false };
  return {
    ok: true,
    like: st.like ?? 0,
    coin: st.coin ?? 0,
    favorite: st.favorite ?? 0,
    share: st.share ?? 0,
    reply: st.reply ?? 0,
    danmaku: st.danmaku ?? 0,
    view: st.view ?? rec.play,
  };
}

/* ══════════════════════════════════════════════════════════════════
 * ⑥ 聚合与渲染
 * ══════════════════════════════════════════════════════════════════ */

const dayStr = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : '?');
const num = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n ?? 0));

function aggregateAuthors(recs) {
  const byMid = new Map();
  for (const r of recs) {
    if (!r.mid) continue;
    if (!byMid.has(r.mid)) {
      byMid.set(r.mid, { mid: r.mid, author: r.author, count: 0, totalPlay: 0, maxRel: 0, latest: 0, samples: [] });
    }
    const a = byMid.get(r.mid);
    a.count++;
    a.totalPlay += r.play;
    a.maxRel = Math.max(a.maxRel, r.relevance);
    a.latest = Math.max(a.latest, r.pubdate);
    if (a.samples.length < 3) a.samples.push(r);
  }
  return [...byMid.values()].sort(
    (x, y) => (y.count * 2 + y.maxRel / 3) - (x.count * 2 + x.maxRel / 3),
  );
}

function renderMarkdown({ keywordStats, top, authors, selfRec, selfRecs, opts, generatedAt }) {
  const L = [];
  L.push('# B 站鸿蒙生态 · 选题与 UP 主发现报告');
  L.push('');
  L.push(`生成时间：${generatedAt}  ·  工具：\`devrel/bili-discover.mjs\`（只读）`);
  L.push('');
  L.push('> 本报告用于**人工挑选**值得认真留言/谈合作的视频。'
    + '不含任何自动投放能力，也不使用你的登录态。');
  L.push('');

  L.push('## 一、采集概况');
  L.push('');
  L.push('| 关键词 | 抓取条数 | 进入候选 | 备注 |');
  L.push('|---|---:|---:|---|');
  for (const s of keywordStats) {
    const note = s.anomalies?.length ? `⚠ ${s.anomalies.join('；')}` : '';
    L.push(`| ${s.keyword} | ${s.fetched} | ${s.kept} | ${note} |`);
  }
  L.push('');
  L.push(`- 接口请求数：${requestCount}（含退避重试）`);
  L.push(`- 相关度阈值：${MIN_RELEVANCE}；候选视频 ${top.length} 条`);
  L.push(`- 去重后原始条数：${opts.dedupedCount}`);
  L.push(`- 搜索排序：\`${opts.order}\``
    + (opts.order === 'pubdate' ? '（最新发布，适合找"现在值得说话的地方"）'
      : '（非最新发布，捞到的可能多为陈年爆款，想找新视频加 --fresh）'));
  if (selfRec) {
    const list = selfRecs ?? [selfRec];
    // 逐条列出：过滤是按 mid 剔除全部，只写一条会让人以为"还有漏网的自己人"
    L.push(`- 已识别**你自己的 ${list.length} 个视频**并从候选中剔除（mid ${selfRec.mid}）：`);
    for (const s of list) L.push(`  - \`${s.bvid}\` ${s.title.slice(0, 50)}`);
  }
  if (keywordStats.some((s) => s.anomalies?.length)) {
    L.push('');
    L.push('> ⚠ 上表有"备注"的关键词结果**可能不完整**：接口在限流时会返回 200 + 空列表'
      + '（不报错），本工具已退避重试一次并把异常记在这里，避免那个 0 被误读成"确实没内容"。');
  }
  L.push('');

  L.push('## 二、优先留言清单（按相关度 × 触达 × 新鲜度）');
  L.push('');
  L.push('| # | 优先级 | 相关度 | 播放 | 收藏 | 发布 | 时长 | 标题 | UP主 | 命中词 |');
  L.push('|---:|---:|---:|---:|---:|---|---:|---|---|---|');
  top.slice(0, 60).forEach((r, i) => {
    const hits = r.hits.filter((h) => h.sign === '+').map((h) => h.label).join(' ');
    const neg = r.hits.filter((h) => h.sign === '−').map((h) => h.label);
    const hitStr = neg.length ? `${hits}（−${neg.join('/')}）` : hits;
    L.push(`| ${i + 1} | ${r.priority.toFixed(1)} | ${r.relevance.toFixed(1)} | ${num(r.play)} `
      + `| ${num(r.favorites)} | ${dayStr(r.pubdate)} | ${formatDuration(r.duration)} `
      + `| [${r.title.replace(/\|/g, '\\|').slice(0, 60)}](${r.url}) | ${r.author} | ${hitStr} |`);
  });
  L.push('');

  const withReply = top.filter((r) => r.stats?.ok);
  if (withReply.length) {
    L.push('### 互动明细（已补精确数据，评论数高 = 评论区活跃 = 值得留言）');
    L.push('');
    L.push('| 标题 | 评论 | 点赞 | 投币 | 收藏 | 分享 |');
    L.push('|---|---:|---:|---:|---:|---:|');
    for (const r of withReply) {
      L.push(`| [${r.title.replace(/\|/g, '\\|').slice(0, 50)}](${r.url}) `
        + `| ${num(r.stats.reply)} | ${num(r.stats.like)} | ${num(r.stats.coin)} `
        + `| ${num(r.stats.favorite)} | ${num(r.stats.share)} |`);
    }
    L.push('');
  }

  L.push('## 三、值得关注的 UP 主');
  L.push('');
  L.push('按"相关视频条数 + 最高相关度"排序，不是按粉丝量。这些人本身就是鸿蒙开发者，'
    + '合作/测评邀约的成功率远高于在陌生视频下留言。');
  L.push('');
  L.push('| # | UP主 | 相关视频 | 合计播放 | 最高相关度 | 最近更新 | 代表作 |');
  L.push('|---:|---|---:|---:|---:|---|---|');
  authors.slice(0, 25).forEach((a, i) => {
    const s = a.samples[0];
    L.push(`| ${i + 1} | ${a.author} | ${a.count} | ${num(a.totalPlay)} | ${a.maxRel.toFixed(1)} `
      + `| ${dayStr(a.latest)} | [${s.title.replace(/\|/g, '\\|').slice(0, 46)}](${s.url}) |`);
  });
  L.push('');

  L.push('## 四、口径与方法（全部可复核）');
  L.push('');
  L.push('**相关度**：词表命中打分，每个词取它命中的最好字段（标题 1.0 / 标签 0.7 / 简介 0.4），'
    + '不叠加，避免简介堆词刷分。正词表分四档（CORE 3.0 / DEV 2.5 / TOOL 2.0 / ECO 1.5），'
    + '负词表压制消费电子向内容。阈值 ' + MIN_RELEVANCE + '。');
  L.push('');
  L.push('**优先级** = `100 × min(1, 相关度/18) × (0.3 + 0.7×触达) × (0.45 + 0.55×新鲜度)`');
  L.push('');
  L.push('- 触达 = `clamp01((log10(播放+10) − 2) / 3.5)` —— 播放量取对数并封顶，**防止大流量压制相关性**');
  L.push('- 新鲜度 = `exp(−天数/240)` —— 半衰期约 166 天');
  L.push('');
  L.push('所以一个 5000 播放的 ArkTS 实战教程会稳定排在 80 万播放的手机评测前面：'
    + '后者负词表几乎把相关度清零，优先级随之趋零。');
  L.push('');
  L.push('**只读保证**：不发送评论/私信/点赞/投币/关注，不读写你的 Cookie 与登录态，'
    + '不写入任何 B 站侧数据。`--self-test` 会扫描本文件源码并断言这一点。');
  L.push('');
  L.push('**限速**：请求间固定间隔 + 抖动，遇 HTTP 412 或 code -412/-509 指数退避，'
    + `最多重试 ${4} 次后如实失败，不硬刷。`);
  L.push('');
  return L.join('\n');
}

/* ══════════════════════════════════════════════════════════════════
 * ⑦ 自检：注入式负测试（未被负测试验证的门禁等于没有门禁）
 * ══════════════════════════════════════════════════════════════════ */

function selfTest() {
  const results = [];
  const t = (name, ok, detail = '') => results.push({ name, ok, detail });

  /* ① wbi 混淆表：长度与置换性质 */
  const fakeRaw = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
  const mk = mixinKey(fakeRaw);
  t('wbi 密钥长度为 32', mk.length === 32, `实际 ${mk.length}`);
  t('wbi 密钥逐位来自原始密钥',
    [...mk].every((c) => fakeRaw.includes(c)), '出现了原始密钥之外的字符');
  t('wbi 表是 64 个下标的一个排列',
    MIXIN_TAB.length === 64 && new Set(MIXIN_TAB).size === 64,
    `长度 ${MIXIN_TAB.length}，去重后 ${new Set(MIXIN_TAB).size}`);

  /* ② 签名确定性：同输入同输出（否则重试会随机失败） */
  const s1 = signQuery({ a: 'x', b: 'y!' }, 'KEY', 1700000000);
  const s2 = signQuery({ b: 'y!', a: 'x' }, 'KEY', 1700000000);
  t('签名对参数顺序不敏感', s1.w_rid === s2.w_rid, `${s1.w_rid} vs ${s2.w_rid}`);
  t('签名剔除 ! 等禁用字符', !s1.query.includes('!'), s1.query);
  t('签名随时间变化（wts 参与）',
    signQuery({ a: 'x' }, 'KEY', 1700000000).w_rid !== signQuery({ a: 'x' }, 'KEY', 1700000001).w_rid);

  /* ③ 排序逻辑：这是本工具唯一有"判断"的部分，必须被负测试压住 */
  const devVideo = scoreRelevance({
    title: '鸿蒙 ArkTS 实战：从零开发一个开源桌面应用（附源码）',
    tag: '鸿蒙,ArkTS,开源,教程,开发',
    desc: '手把手带你写一个跨端应用',
  });
  const consumerVideo = scoreRelevance({
    title: '华为鸿蒙手机开箱评测：影像、屏幕、价格全解析',
    tag: '数码,手机,评测,开箱',
    desc: '值不值得买？看完你就知道了',
  });
  const offTopic = scoreRelevance({
    title: '今天做了个番茄炒蛋，好好吃',
    tag: '美食,日常',
    desc: '简单家常菜',
  });

  t('开发向视频相关度高于阈值', devVideo.relevance > MIN_RELEVANCE,
    `实际 ${devVideo.relevance.toFixed(1)}`);
  t('消费电子向视频相关度低于阈值', consumerVideo.relevance < MIN_RELEVANCE,
    `实际 ${consumerVideo.relevance.toFixed(1)} — 负词表没压住`);
  t('无关视频相关度为 0', offTopic.relevance === 0, `实际 ${offTopic.relevance}`);

  const mkRec = (relevance, play, ageDays) => ({ relevance, play, ageDays });
  const pDev = priorityOf(mkRec(devVideo.relevance, 5000, 30));
  const pConsumer = priorityOf(mkRec(consumerVideo.relevance, 800000, 10));
  t('低播开发视频优先级压过高播评测视频', pDev > pConsumer,
    `开发 ${pDev.toFixed(1)} vs 评测 ${pConsumer.toFixed(1)} —— 播放量又主导了排序`);

  /* ④ 触达/新鲜度边界（NaN 与越界会让排序静默错乱） */
  t('触达对 0 播放有定义且为下界', reachOf(0) === 0, `实际 ${reachOf(0)}`);
  t('触达封顶在 1', reachOf(1e9) === 1, `实际 ${reachOf(1e9)}`);
  t('新鲜度对 0 天为 1', freshnessOf(0) === 1);
  t('新鲜度单调递减', freshnessOf(10) > freshnessOf(400));
  t('超大 ageDays 不产生 NaN', Number.isFinite(priorityOf(mkRec(9, 100, 3650))));

  /* ⑤ 渲染器容错：真实接口会缺字段，缺字段不能让报告崩掉 */
  let renderOk = true;
  let renderErr = '';
  try {
    const rec = {
      bvid: 'BV1xx411c7mD', url: 'https://www.bilibili.com/video/BV1xx411c7mD',
      title: '带|竖线|的标题', author: '', mid: 0, play: 0, favorites: 0, pubdate: 0,
      ageDays: Infinity, ageDaysForScore: 3650, duration: '', tag: '',
      foundBy: 'k', relevance: 9, hits: [{ label: '鸿蒙', w: 3, at: 'title', sign: '+' }],
      priority: 3.2, stats: { ok: false },
    };
    const md = renderMarkdown({
      keywordStats: [{ keyword: 'k', fetched: 1, kept: 1 }],
      top: [rec], authors: [], selfRec: null,
      opts: { dedupedCount: 1, order: 'totalrank' }, generatedAt: '2026-01-01T00:00:00Z',
    });
    renderOk = md.includes('BV1xx411c7mD') && md.includes('\\|') && !md.includes('undefined');
  } catch (e) {
    renderOk = false;
    renderErr = e.message;
  }
  t('渲染器容忍缺字段与竖线标题', renderOk, renderErr || '报告里出现了 undefined');

  /* ⑤-a 报告必须如实标注采集异常（否则那个 0 会被读成"确实没内容"） */
  let anomalyOk = false;
  try {
    const md2 = renderMarkdown({
      keywordStats: [{ keyword: 'k', fetched: 0, kept: 0, anomalies: ['首页两次均空（疑似限流）'] }],
      top: [], authors: [], selfRec: null,
      opts: { dedupedCount: 0, order: 'totalrank' }, generatedAt: '2026-01-01T00:00:00Z',
    });
    anomalyOk = md2.includes('疑似限流');
  } catch { anomalyOk = false; }
  t('空结果异常被写进报告', anomalyOk, '报告未标注限流异常');

  /* ⑤-a2 自有视频是复数：过滤按 mid 剔除**全部**，报告须逐条列出。
     只写一条会让人以为还有漏网的自己人（实测一轮就有 2 个）。 */
  let selfOk = false;
  try {
    const md3 = renderMarkdown({
      keywordStats: [], top: [], authors: [], generatedAt: '2026-01-01T00:00:00Z',
      opts: { dedupedCount: 0, order: 'totalrank' },
      selfRec: { mid: 42, bvid: 'BV1aaa', title: '第一个' },
      selfRecs: [{ mid: 42, bvid: 'BV1aaa', title: '第一个' },
        { mid: 42, bvid: 'BV1bbb', title: '第二个' }],
    });
    // 断言对齐渲染器的实际文案（此处曾写成 `你的 N 个视频`，而模板是
    // `你自己的 N 个视频`——`你自己的` 里不含子串 `你的`，断言假失败）
    selfOk = md3.includes('你自己的 2 个视频') && md3.includes('BV1aaa') && md3.includes('BV1bbb');
  } catch { selfOk = false; }
  t('自有视频多于一个时全部列出', selfOk, '报告只列了部分自有视频');

  /* ⑤-b 时长格式化：B 站 MM:SS 的分钟位可超 60，且会出现空串 */
  t('时长 MM:SS 补零', formatDuration('4:7') === '4:07', formatDuration('4:7'));
  t('时长超 60 分钟换算成小时', formatDuration('999:12') === '16h39m', formatDuration('999:12'));
  t('时长空串不炸', formatDuration('') === '—', formatDuration(''));
  t('时长非法值原样返回', formatDuration('abc') === 'abc', formatDuration('abc'));

  /* ⑤-c 空结果告警是本工具的关键防线：接口限流时返回 200 + 空列表，
     若当成"没找到"，报告会静默漏掉一整个关键词且看不出来。 */
  t('排序取值覆盖官方四种', ORDER_VALUES.length === 4
    && ORDER_VALUES.includes('pubdate'), ORDER_VALUES.join(','));

  /* ⑥ 安全断言：源码里不许出现写接口（本工具的立身之本） */
  const src = readFileSync(SELF_PATH, 'utf8');
  const FORBIDDEN = [
    ['发评论', '/x/v2/reply/' + 'add'],
    ['删评论', '/x/v2/reply/' + 'del'],
    ['发私信', '/x/web-interface/msg/' + 'send'],
    ['点赞', '/x/web-interface/archive/' + 'like'],
    ['投币', '/x/web-interface/coin/' + 'add'],
    ['关注', '/x/relation/' + 'modify'],
    ['转发动态', '/x/dynamic/feed/' + 'create'],
  ];
  for (const [what, needle] of FORBIDDEN) {
    t(`源码不含${what}接口`, !src.includes(needle), `发现 ${needle}`);
  }
  const postNeedle = 'method: ' + "'" + 'PO' + 'ST' + "'";
  t('源码不发起任何 POST 请求', !src.includes(postNeedle), '存在 POST 调用');

  /* 输出 */
  console.log('# B 站发现工具 · 自检（注入式负测试）\n');
  let failed = 0;
  for (const r of results) {
    if (r.ok) console.log(`  ok  ${r.name}`);
    else { failed++; console.log(`  ✗   ${r.name}  —— ${r.detail}`); }
  }
  console.log('');
  if (failed === 0) {
    console.log(`✓✓ 自检通过（${results.length} 项）`);
    process.exit(0);
  }
  console.log(`★ 自检失败 ${failed} 项 —— 排序或安全断言不可信，不得据此挑选目标`);
  process.exit(1);
}

/* ══════════════════════════════════════════════════════════════════
 * ⑧ 主流程
 * ══════════════════════════════════════════════════════════════════ */

const DEFAULT_KEYWORDS = [
  '鸿蒙开发', 'ArkTS', 'HarmonyOS NEXT', '鸿蒙 开源',
  'OpenHarmony', '鸿蒙 实战', '鸿蒙 应用开发', '鸿蒙 桌面端',
];

/** 你自己的 mid：用于把自己从候选里剔除，避免"给自己的视频留言"这种低级错。 */
const SELF_MID = 283707120;

/**
 * 搜索排序方式。实测 4 个取值都生效（返回的首条互不相同）：
 *   totalrank 综合排序 · click 最多播放 · pubdate 最新发布 · danmaku 最多弹幕
 * 默认综合排序，捞到的大多是陈年爆款；只想看新视频时用 --fresh（= pubdate）。
 * 「最新发布」对宣发更重要：给一条三年前的爆款留言，几乎不会有人看到。
 */
const ORDER_VALUES = ['totalrank', 'click', 'pubdate', 'danmaku'];

function parseArgs(argv) {
  const o = {
    keywords: DEFAULT_KEYWORDS,
    pages: 2,
    pageSize: 40,
    enrichTop: 25,
    gap: 1500,
    order: 'totalrank',
    out: join(ROOT, 'devrel', 'out'),
    jsonOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) { console.error(`缺少参数值：${a}`); process.exit(2); }
      return v;
    };
    if (a === '--self-test') { selfTest(); }
    else if (a === '--help' || a === '-h') {
      console.log(readFileSync(SELF_PATH, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
      process.exit(0);
    }
    else if (a === '--keywords') o.keywords = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--pages') o.pages = Math.max(1, Math.min(10, Number(next())));
    else if (a === '--page-size') o.pageSize = Math.max(10, Math.min(50, Number(next())));
    else if (a === '--enrich-top') o.enrichTop = Math.max(0, Number(next()));
    else if (a === '--order') {
      const v = next();
      if (!ORDER_VALUES.includes(v)) {
        console.error(`--order 只支持 ${ORDER_VALUES.join(' | ')}（收到 ${v}）`);
        process.exit(2);
      }
      o.order = v;
    }
    // 「最近发布」排序：只关心新视频时用它，否则默认按综合排序，捞到的多为陈年爆款
    else if (a === '--fresh') o.order = 'pubdate';
    else if (a === '--gap') o.gap = Math.max(300, Number(next()));
    else if (a === '--out') o.out = next();
    else if (a === '--json-only') o.jsonOnly = true;
    else { console.error(`未知参数：${a}（用 --help 看用法）`); process.exit(2); }
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = new Date();

  console.log(`# 采集（${opts.keywords.length} 个关键词 × ${opts.pages} 页）\n`);
  const cookie = await anonymousSession();
  const key = await wbiKeys(cookie);
  console.log(`  匿名会话就绪；wbi 密钥 ${key.slice(0, 8)}…（未使用任何登录态）`);

  const byBvid = new Map();
  const keywordStats = [];
  for (const kw of opts.keywords) {
    let fetched = 0;
    const anomalies = [];
    for (let p = 1; p <= opts.pages; p++) {
      await sleep(opts.gap + Math.random() * 600);
      let list;
      try {
        // 首页走带空结果退避重试的版本；实测接口会在限流时返回 200 + 空列表
        const res = p === 1
          ? await searchFirstPage(kw, opts.pageSize, key, cookie, opts.order, opts.gap)
          : await searchOnce(kw, p, opts.pageSize, key, cookie, opts.order);
        list = res.list;
        // 首页两次都空 ⇒ 大概率是限流而非"真没内容"，必须记进报告，
        // 否则统计表里的 0 会被读成"这个词确实没视频"
        if (p === 1 && list.length === 0) {
          anomalies.push(res.retryExhausted ? '首页两次均空（疑似限流）' : '首页为空');
        }
      } catch (e) {
        console.log(`  ⚠ ${kw} p${p}：${e.message}（跳过该页，不中断）`);
        anomalies.push(`p${p} 请求失败`);
        break;
      }
      fetched += list.length;
      for (const raw of list) {
        const rec = toRecord(raw, kw);
        const prev = byBvid.get(rec.bvid);
        // 同一视频被多关键词命中时保留信息更全的那条
        if (!prev || rec.relevance > prev.relevance) byBvid.set(rec.bvid, rec);
      }
      console.log(`  ${kw} p${p}：${list.length} 条（累计去重 ${byBvid.size}）`);
    }
    keywordStats.push({ keyword: kw, fetched, kept: 0, anomalies });
  }

  const dedupedCount = byBvid.size;
  const all = [...byBvid.values()];
  // 注意是复数：同 mid 下可能有多个视频，过滤是按 mid 剔除**全部**，
  // 只报第一条会让人以为只剔了一个（实测本轮就有 2 个）。
  const selfRecs = all.filter((r) => r.mid === SELF_MID);
  const selfRec = selfRecs[0] ?? null;

  console.log(`\n# 打分（阈值 ${MIN_RELEVANCE}）\n`);
  for (const r of all) {
    r.ageDaysForScore = Number.isFinite(r.ageDays) ? r.ageDays : 3650;
  }
  const candidates = all
    .filter((r) => r.mid !== SELF_MID)
    .filter((r) => r.relevance >= MIN_RELEVANCE)
    .map((r) => ({ ...r, priority: priorityOf(r) }))
    .sort((a, b) => b.priority - a.priority);

  for (const s of keywordStats) {
    s.kept = candidates.filter((c) => c.foundBy === s.keyword).length;
  }
  console.log(`  去重后 ${dedupedCount} 条 → 相关度达标 ${candidates.length} 条`);
  if (selfRec) console.log(`  已剔除你自己的 ${selfRecs.length} 个视频（mid ${SELF_MID}）`);

  if (opts.enrichTop > 0) {
    const n = Math.min(opts.enrichTop, candidates.length);
    console.log(`\n# 补精确互动数据（前 ${n} 条，逐条限速）\n`);
    for (let i = 0; i < n; i++) {
      await sleep(opts.gap + Math.random() * 600);
      try {
        candidates[i].stats = await enrich(candidates[i], key, cookie);
        const s = candidates[i].stats;
        if (s.ok) console.log(`  ${i + 1}/${n} ${candidates[i].bvid} 评论 ${s.reply} 赞 ${s.like}`);
      } catch (e) {
        candidates[i].stats = { ok: false };
        console.log(`  ⚠ ${i + 1}/${n} ${candidates[i].bvid}：${e.message}`);
      }
    }
  }

  const authors = aggregateAuthors(candidates);
  const generatedAt = new Date().toISOString();
  const markdown = renderMarkdown({
    keywordStats, top: candidates, authors, selfRec, selfRecs,
    opts: { dedupedCount, order: opts.order }, generatedAt,
  });

  const stamp = started.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = join(opts.out, `bili-${stamp}`);
  mkdirSync(dir, { recursive: true });

  const payload = {
    generatedAt,
    options: { ...opts, keywords: opts.keywords },
    requestCount,
    dedupedCount,
    minRelevance: MIN_RELEVANCE,
    self: selfRec ? {
      mid: selfRec.mid,
      count: selfRecs.length,
      videos: selfRecs.map((s) => ({ bvid: s.bvid, title: s.title })),
    } : null,
    keywordStats,
    candidates,
    authors,
  };
  writeFileSync(join(dir, 'candidates.json'), JSON.stringify(payload, null, 2), 'utf8');
  if (!opts.jsonOnly) writeFileSync(join(dir, 'report.md'), markdown, 'utf8');

  console.log(`\n✓ 写入 ${dir}`);
  console.log(`  candidates.json（${candidates.length} 条候选，${authors.length} 位 UP 主）`);
  if (!opts.jsonOnly) console.log('  report.md');
  console.log(`  共 ${requestCount} 次请求`);
  console.log('\n提示：本工具只负责"该去哪说话"，发言请你自己来。'
    + '\n      报告里优先级最高的 3–5 条，值得先看一遍视频再写针对性留言；'
    + '同一段文案复制到多个视频下，等于把账号交给风控。');
}

main().catch((e) => {
  console.error(`\n★ 失败：${e.message}`);
  process.exit(1);
});
