#!/usr/bin/env node
/**
 * AGC CLI 接线 —— 本仓调用华为 AppGallery Connect 的**唯一入口**。
 *
 * 【为什么不直接手敲 `.dsh/skills/.../connect-api-cli.js`】
 * 那个 CLI 有一个反直觉的坑，实测钉住（2026-10-25）：
 *
 *   · 它用 `dotenv` 从**当前工作目录**读 `.env`（`config({path: '.env'})` 语义）；
 *   · AGC 凭证/模式（`AGC_AUTH_MODE` 等）**只**从那个 `.env` 或已导出的环境变量来；
 *   · token 缓存却在 `$HOME/.connect-api-cli-token.json`（与 cwd 无关）。
 *
 * 于是：
 *   - 在仓库根跑 → 读到 `.env` → 用缓存 token → **成功**；
 *   - 在 `/tmp` 跑 → 读不到 `.env` → 直接报
 *     `Missing AGC credentials. Please set AGC_CLIENT_ID and AGC_CLIENT_SECRET...`
 *     —— 明明 token 还在、也没过期。（实测复现，见 docs/257）
 *
 * 本封装做三件事，让"从哪个目录跑都一样"：
 *   1) 显式 `cwd = 仓库根`（CLI 就会读到仓库根的 `.env`）；
 *   2) 若环境里已有 `AGC_AUTH_MODE` 等变量则原样透传，不覆盖；
 *   3) 统一输出契约（把 stdout 当 JSON 解析后摘关键字段），失败给可行动的话。
 *
 * 【红线】
 *   · 本脚本**不写任何凭证**、不生成 `.env`、不打印 token。
 *   · 只读子命令（`app-id` / `profiles` / `certs` / `status`）可随时跑；
 *     写操作（上传 / 发布 / 建证书 / 改 profile）必须由用户显式发起 —— 见 `--help`。
 *
 * 【用法】
 *   node tools/agc.mjs status                      # 登录态
 *   node tools/agc.mjs app-id                      # 本仓 bundleName 的 App ID
 *   node tools/agc.mjs profiles                    # 本应用的 profile 列表（含 ACL 数）
 *   node tools/agc.mjs certs                       # 证书列表
 *   node tools/agc.mjs raw <子命令...>              # 原样透传（调试用，仍固定 cwd）
 *
 * 【退出码】0 成功；1 业务失败（含 403）；2 用法错；3 环境不具备（缺 CLI / 缺 Node）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, '.dsh', 'skills', 'hmos-connect-api-cli-skill', 'scripts', 'connect-api-cli.js');

const C = process.env.NO_COLOR ? {} : { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', gray: '\x1b[90m', reset: '\x1b[0m' };
const ok = (m) => console.log(`${C.green ?? ''}${m}${C.reset ?? ''}`);
const bad = (m) => console.error(`${C.red ?? ''}${m}${C.reset ?? ''}`);
const info = (m) => console.log(`${C.gray ?? ''}${m}${C.reset ?? ''}`);

/** 从 AppScope/app.json5 读 bundleName（配置是唯一事实源，不写死包名）。 */
function bundleName() {
  try {
    const text = readFileSync(join(ROOT, 'AppScope', 'app.json5'), 'utf8');
    return /"bundleName"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? '';
  } catch {
    return '';
  }
}

if (!existsSync(CLI)) {
  bad(`找不到 AGC CLI：${CLI}`);
  console.error('   .dsh/skills/hmos-connect-api-cli-skill/ 应随仓库一起在。见 docs/256 / docs/257。');
  process.exit(3);
}

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';

/** 跑 CLI：cwd 固定仓库根（这是本封装存在的理由），返回 {code, out, err}。 */
function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** 把 CLI 的 stdout 当 JSON 解析；失败返回 null 并把原文留在 err 里。 */
function runJson(args) {
  const r = run(args);
  if (r.code !== 0) return { ...r, json: null };
  try {
    return { ...r, json: JSON.parse(r.out) };
  } catch {
    return { ...r, json: null };
  }
}

/**
 * 统一的失败说明。`Missing AGC credentials` 与 `403` 是两个完全不同的原因，
 * 混在一起说会把人带偏（2026-10-25 实际踩过：以为是 token 过期，其实不是）。
 */
function explainFailure(r) {
  const text = `${r.out}\n${r.err}`;
  if (/Missing AGC credentials/.test(text)) {
    bad('缺 AGC 凭证：CLI 按 cwd 读 .env，本封装已固定 cwd=仓库根，说明仓库根没有 .env 或里面没有 AGC_AUTH_MODE。');
    console.error('   修法：确认仓库根 .env 含 `AGC_AUTH_MODE=oauth`（该文件已在 .gitignore，绝不入库）。');
    return;
  }
  if (/\b403\b/.test(text)) {
    bad('403：token 有效，但该 API 客户端对此应用/团队无权限。');
    console.error('   —— 不是过期、不是重试能解决的。去 AGC 控制台给 API 客户端补权限，或换有权限的账号重新 auth login。');
    console.error('   已实测：本机 token 新鲜时，`publish app-id` 与 `provision cert-list` 能通，而 `project list` 恒 403。');
    return;
  }
  if (/\b401\b/.test(text)) {
    bad('401：凭证/登录态无效。先 `auth logout` 再 `auth login`（交互式，需浏览器）。');
    return;
  }
  bad('AGC 调用失败：');
  console.error((r.err || r.out).trim().split('\n').slice(0, 6).join('\n'));
}

switch (cmd) {
  case 'status': {
    const r = run(['auth', 'status']);
    if (r.code !== 0) { explainFailure(r); process.exit(1); }
    const text = r.out.trim();
    console.log(text);
    // `Expires in: 0m 0s` 曾让我误判成"过期"；这里顺便读缓存文件给出权威到期时刻。
    const cache = join(process.env.HOME ?? '', '.connect-api-cli-token.json');
    if (existsSync(cache)) {
      try {
        const t = JSON.parse(readFileSync(cache, 'utf8'));
        if (typeof t.expiresAt === 'number') {
          const left = Math.round((t.expiresAt - Date.now()) / 1000);
          const when = new Date(t.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
          if (left > 0) ok(`token 实际有效至 ${when}（还剩 ${Math.round(left / 60)} 分钟）`);
          else bad(`token 已于 ${when} 过期（差 ${Math.abs(Math.round(left / 60))} 分钟）⇒ 需 auth login`);
        }
      } catch { /* 缓存读不了不影响主流程 */ }
    }
    ok('登录态可用（是否真有权限取决于具体 API，见 403 说明）');
    process.exit(0);
  }

  case 'app-id': {
    const pkg = bundleName();
    if (pkg === '') { bad('读不到 AppScope/app.json5 的 bundleName'); process.exit(2); }
    info(`bundleName: ${pkg}`);
    const r = runJson(['publish', 'app-id', '-p', pkg]);
    if (r.json === null) { explainFailure(r); process.exit(1); }
    const ids = r.json.appids ?? [];
    if (ids.length === 0) {
      bad('AGC 返回空 appids —— 该包名在 AGC 上不存在，或 API 客户端看不到它。');
      process.exit(1);
    }
    for (const it of ids) ok(`App ID: ${it.value}  （${it.key}）`);
    process.exit(0);
  }

  case 'profiles': {
    const pkg = bundleName();
    const ai = runJson(['publish', 'app-id', '-p', pkg]);
    if (ai.json === null) { explainFailure(ai); process.exit(1); }
    const appId = ai.json.appids?.[0]?.value;
    if (!appId) { bad('取不到 App ID，无法列 profile'); process.exit(1); }
    const r = runJson(['provision', 'profile-list', '-a', appId]);
    if (r.json === null) { explainFailure(r); process.exit(1); }
    // 字段名是 provisionList / provisionName（不是 profileList —— 会让汇总静默变空）
    const list = r.json.provisionList ?? [];
    console.log(`# App ${appId} 的 profile（共 ${list.length} 条）`);
    const TYPE = { 1: 'debug', 2: 'release', 6: 'release(指定设备)' };
    for (const p of list) {
      const acl = (p.aclPermissionList ?? []).length;
      const dev = (p.deviceList ?? []).length;
      const exp = p.expireTime ? new Date(p.expireTime).toLocaleDateString('zh-CN') : '-';
      const line = `  ${String(p.provisionName).padEnd(50)} ${(TYPE[p.provisionType] ?? p.provisionType).padEnd(16)} ACL=${acl}  设备=${dev}  到期=${exp}`;
      if (acl === 0) { bad(`${line}   ← 0 条 ACL：装到设备会被 PERMISSION_ACL_RULE 拒装`); }
      else console.log(line);
    }
    process.exit(0);
  }

  case 'certs': {
    const r = runJson(['provision', 'cert-list']);
    if (r.json === null) { explainFailure(r); process.exit(1); }
    const list = r.json.certList ?? [];
    console.log(`# 证书（共 ${list.length} 张）`);
    for (const c of list) {
      const exp = c.expireTime ? new Date(c.expireTime).toLocaleDateString('zh-CN') : '-';
      console.log(`  ${String(c.name ?? c.certName ?? '?').padEnd(42)} 到期=${exp}`);
    }
    process.exit(0);
  }

  case 'raw': {
    const args = argv.slice(1);
    if (args.length === 0) { bad('用法：node tools/agc.mjs raw <connect-api-cli 子命令...>'); process.exit(2); }
    const r = run(args);
    process.stdout.write(r.out);
    process.stderr.write(r.err);
    process.exit(r.code);
  }

  default: {
    console.log(`AGC CLI 接线（本仓唯一入口）

用法：
  node tools/agc.mjs status      登录态（含缓存 token 的真实到期时刻）
  node tools/agc.mjs app-id      用 AppScope/app.json5 的 bundleName 查 App ID
  node tools/agc.mjs profiles    本应用的 profile 列表（标出 0 ACL 的危险条目）
  node tools/agc.mjs certs       证书列表
  node tools/agc.mjs raw ...     原样透传（仍固定 cwd=仓库根）

为什么要有这个封装：底层 CLI 按 cwd 读 .env，换个目录就报
"Missing AGC credentials"，而 token 缓存其实还在 $HOME。详见 docs/257。

红线：不写凭证、不打印 token；写操作（上传/发布/建证书）必须显式发起。`);
    process.exit(cmd === 'help' ? 0 : 2);
  }
}
