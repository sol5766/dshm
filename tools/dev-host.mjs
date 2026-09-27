/**
 * 由**本项目自己**启动 dsh 核心，并让设备上的应用自动连上它（无需手填地址与令牌）。
 *
 * ───────────────────────── 它解决什么 ─────────────────────────
 *   dsh 是 Host/Client 分离的：客户端必须知道一个地址和一个令牌。开发时这些信息
 *   每次重启核心都会变，手工往手机里粘贴一遍是纯粹的浪费，而且容易粘错。
 *   本脚本把「起核心 → 取地址与令牌 → 启动应用并把两者带进去」合成**一条命令**。
 *
 * ───────────────────────── 为什么由本项目持有核心进程 ─────────────────────────
 *   官方桌面端就是这么做的（它把 dsh 核心作为子进程拉起）。
 *   本项目沿用同一立场：**核心跑在开发机上、由本仓库的脚本负责拉起与回收**，
 *   客户端只是连到它。这与「客户端内置 Node 运行时」是两件事——
 *   后者被 D1 §6.4 明确否决（依赖设备上的 Node/终端/包管理器）。
 *
 * ───────────────────────── 模拟器为什么要改地址 ─────────────────────────
 *   模拟器里的 `127.0.0.1` 是**模拟器自己**，开发机的 loopback 要经 QEMU slirp 网关
 *   `10.0.2.2` 才够得到。因此：
 *     - 监听仍绑 `127.0.0.1`（**绝不绑 0.0.0.0**，D1 §6.4 红线）；
 *     - 用 `--trusted-host 10.0.2.2:<port>` 把这条权威**显式**加进 Host 的信任栅栏
 *       ——这是上游提供的正规开关，不是伪造 `Host` 头；
 *     - 传给客户端的地址是 `http://10.0.2.2:<port>`。
 *   真机（USB/局域网）用 `--host-url` 显式覆盖。
 *
 * 用法：
 *   node tools/dev-host.mjs                 # 起核心 + 启动模拟器上的应用
 *   node tools/dev-host.mjs --dsh <path>    # 指定 dsh 入口（默认用 .research 里的隔离副本）
 *   node tools/dev-host.mjs --port 3115
 *   node tools/dev-host.mjs --no-launch     # 只起核心并打印地址与令牌
 *   node tools/dev-host.mjs --stop          # 停止本项目起的核心
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};

const PORT = Number(arg('--port', '3115'));
/**
 * 用哪个 `DSH_HOME`（= 用哪份 dsh 配置与会话）。
 *
 * 【默认用**用户自己的**那份，而不是一个空目录】这是「能真正执行任务」的前提：
 * 模型凭据与 provider 配置都在 `DSH_HOME` 里，空目录里没有它们，
 * 于是 `session/prompt` 会被**接受**（`{accepted:true}`）但 Agent 无法产出任何回复——
 * 实测：空 home 下 `session/page` 在 75 秒内始终 0 条记录。
 * 这个失败特别有欺骗性：投递成功了、没有报错、只是永远没有回答。
 *
 * 这与 D1 §6.4 的红线不冲突：那条说的是**客户端**不得写 `$DSH_HOME` 的包状态。
 * 这里写它的是 **Host 自己**（`dsh web`），与用户手工在终端里跑 dsh 完全同一条路径。
 * 想要一份干净环境时用 `--isolated`。
 */
const HOME = arg('--home',
  args.includes('--isolated')
    ? join(ROOT, '.research', 'dev-host-home')
    : (process.env.DSH_HOME ?? join(homedir(), '.dsh')));
const STATE = join(ROOT, '.research', 'dev-host.json');
const BUNDLE = arg('--bundle', 'com.dshm.dshclient');
const ABILITY = arg('--ability', 'EntryAbility');
const NO_LAUNCH = args.includes('--no-launch');
const HDC = arg('--hdc', 'C:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe');

/** 找一个可用的 dsh 入口：优先隔离副本（不碰用户已装的那份），其次本机安装。 */
function findDsh() {
  const explicit = arg('--dsh', '');
  if (explicit.length > 0) {
    return explicit;
  }
  const candidates = [
    join(ROOT, '.research', 'upstream-0.1.5rc2', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    join(ROOT, '.research', 'upstream-0.1.5', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    'C:\\Users\\aotian\\AppData\\Roaming\\io.github.hairyf.deepseek-harness-desktop\\dependencies\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      return c;
    }
  }
  return '';
}

/** `--stop`：按我们记下的 pid 停掉自己起的核心（**绝不做按名字杀进程**）。 */
if (args.includes('--stop')) {
  if (!existsSync(STATE)) {
    console.log('没有本项目起的核心记录（.research/dev-host.json 不存在）');
    process.exit(0);
  }
  const state = JSON.parse(readFileSync(STATE, 'utf8'));
  try {
    process.kill(state.pid);
    console.log(`已请求停止 pid=${state.pid}（端口 ${state.port}）`);
  } catch (e) {
    console.log(`pid=${state.pid} 已不存在（${e.code}）`);
  }
  rmSync(STATE, { force: true });
  process.exit(0);
}

/** `--relaunch`：核心已在跑，只把设备上的应用重新拉起（复用已记录的地址与令牌）。 */
if (args.includes('--relaunch')) {
  const TOKEN_FILE = join(ROOT, '.research', 'dev-host-token.txt');
  if (!existsSync(STATE) || !existsSync(TOKEN_FILE)) {
    console.error('缺少 .research/dev-host.json 或 dev-host-token.txt；请先正常运行一次 dev-host.mjs');
    process.exit(2);
  }
  const state = JSON.parse(readFileSync(STATE, 'utf8'));
  const tok = readFileSync(TOKEN_FILE, 'utf8').trim();
  console.log(`复用核心 pid=${state.pid} 地址=${state.url}`);
  try {
    execFileSync(HDC, ['shell', 'aa', 'force-stop', BUNDLE], { stdio: 'ignore' });
  } catch (e) {
    // 同上：本来没跑也无所谓
  }
  const relaunch = spawn(HDC, [
    'shell', 'aa', 'start', '-a', ABILITY, '-b', BUNDLE,
    '--ps', 'dshHost', state.url, '--ps', 'dshToken', tok
  ], { stdio: 'inherit' });
  relaunch.on('exit', (code) => process.exit(code ?? 1));
} else {
  main();
}

function main() {
const dsh = findDsh();
if (dsh.length === 0) {
  console.error('找不到 dsh 入口。用 --dsh <path/to/dsh/lib/bin.js> 指定，或先在 .research 下安装：');
  console.error('  npm install --prefix .research/upstream-0.1.5rc2 @deepseek-ai/dsh@0.1.5-rc.2');
  process.exit(2);
}
mkdirSync(HOME, { recursive: true });

/**
 * 设备侧要用的地址。
 *
 * 三条候选路径，按可靠性从高到低（`--rport` 会自己建立反连，仍是零手填）：
 *   1. `--rport <devicePort>`：`hdc rport` 把设备侧端口反连到开发机的 loopback。
 *      这是**权限与信任模型最干净**的一条：客户端请求的 `Host` 头就是它自己连的
 *      `127.0.0.1:<devicePort>`，我们把这条权威显式加进信任栅栏即可（无需伪造任何头）。
 *   2. `--host-url http://10.0.2.2:<port>`：模拟器的 slirp 网关。**实测不稳定**
 *      （同一配置有时通、有时 `code=2300028` 超时），因此不是默认值。
 *   3. 真机/隧道：用 `--host-url` 显式给（如 hostkit 隧道地址）。
 */
const RPORT = arg('--rport', '');
const HOST_URL = arg('--host-url', RPORT.length > 0 ? `http://127.0.0.1:${RPORT}` : `http://10.0.2.2:${PORT}`);
/** 需要被信任的权威：核心自己的监听权威 + 客户端实际请求的那个权威 */
const trustedHosts = [`127.0.0.1:${PORT}`];
const clientAuthority = new URL(HOST_URL).host;
if (!trustedHosts.includes(clientAuthority)) {
  trustedHosts.push(clientAuthority);
}

console.log(`dsh 入口    : ${dsh}`);
console.log(`DSH_HOME    : ${HOME}`);
console.log(`监听        : 127.0.0.1:${PORT}（不绑 0.0.0.0）`);
console.log(`信任的权威  : ${trustedHosts.join('、')}`);
console.log(`客户端地址  : ${HOST_URL}${RPORT.length > 0 ? `（经 hdc rport ${RPORT}→${PORT}）` : ''}\n`);

if (RPORT.length > 0) {
  // 先清掉可能残留的同端口映射：`hdc rport` 对已占用的端口只打印
  // `[Fail]TCP Port listen failed` 而**不返回非零码**，不检查就会拿着一个
  // "看起来建好了、实际指向旧进程"的地址去启动应用，症状是应用连不上而日志毫无线索。
  try {
    execFileSync(HDC, ['fport', 'rm', `tcp:${RPORT}`, `tcp:${PORT}`], { stdio: 'ignore' });
  } catch (e) {
    // 本来就没有这条映射
  }
  try {
    execFileSync(HDC, ['rport', `tcp:${RPORT}`, `tcp:${PORT}`], { stdio: 'inherit' });
  } catch (e) {
    console.error(`建立 rport 失败：${e.message}`);
    process.exit(2);
  }
  // 校验映射真的在（而不是只有一句 [Fail]）
  const listing = execFileSync(HDC, ['fport', 'ls'], { encoding: 'utf8' });
  if (!listing.includes(`tcp:${RPORT}`)) {
    console.error(`rport ${RPORT} 未生效。换一个端口重试（hdc 的反连端口有时会被残留占用）：`);
    console.error(`  node tools/dev-host.mjs --port ${PORT} --rport ${Number(RPORT) + 1}`);
    process.exit(2);
  }
  console.log(`rport 已生效：${RPORT} → ${PORT}`);
}

const trustedArgs = [];
for (const h of trustedHosts) {
  trustedArgs.push('--trusted-host', h);
}

/**
 * 把模型 API 密钥交给核心（若本机有的话）。
 *
 * 【为什么需要这一步】上游在缺密钥时的报错是明确的：
 *   `llm-deepseek: no API key for provider route "deepseek-official";
 *    store DEEPSEEK_API_KEY through the credentials service …, or export DEEPSEEK_API_KEY`
 * 也就是说"能执行任务"的最后一块是**凭据**。而 Windows 上有一个坑：
 * 机器/用户级环境变量可能是在**当前 shell 启动之后**才设置的——
 * 于是 `process.env` 里没有它，但注册表里有（实测正是如此）。
 * 因此这里两级读取：先看当前进程环境，再问注册表。
 *
 * 【纪律】值**只在内存里传递**，既不打印也不落盘（只打印"已注入/未找到"）。
 * 应用侧的正规入口是「凭据页」调 `credentials/set`；这里只是让开发工作流开箱可用。
 */
function resolveApiKey() {
  if (process.env.DEEPSEEK_API_KEY) {
    return process.env.DEEPSEEK_API_KEY;
  }
  if (process.platform !== 'win32') {
    return '';
  }
  for (const scope of ['User', 'Machine']) {
    try {
      const out = execFileSync('powershell', [
        '-NoProfile', '-Command',
        `[Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','${scope}')`
      ], { encoding: 'utf8' }).trim();
      if (out.length > 0) {
        return out;
      }
    } catch (e) {
      // 读不到就继续；密钥缺失不是致命错误，核心会以明确的错误消息回报
    }
  }
  return '';
}

const apiKey = resolveApiKey();
const childEnv = { ...process.env, DSH_HOME: HOME };
if (apiKey.length > 0) {
  childEnv.DEEPSEEK_API_KEY = apiKey;
}
console.log(apiKey.length > 0
  ? `模型密钥    : 已注入（长度 ${apiKey.length}，值不打印）`
  : '模型密钥    : **未找到**（DEEPSEEK_API_KEY 不在环境/注册表里）——Agent 能起但会在模型调用处失败');

const child = spawn(process.execPath, [
  dsh, 'web', '--no-open', '--port', String(PORT), '--host', '127.0.0.1',
  ...trustedArgs
], {
  env: childEnv,
  stdio: ['ignore', 'pipe', 'inherit']
});

/**
 * 从核心的 stdout 里抓那一行 `dsh web: http://…/?token=…`。
 *
 * 【为什么要用正则抓而不是自己拼】令牌是**核心生成的**，客户端无从推断；
 * 抓它的打印行是唯一不猜的做法。抓不到就明确失败，而不是拿空令牌去连
 * （那会得到 401，文案会把用户引向「令牌无效」，与真实原因不符）。
 */
const tokenRe = /(https?:\/\/[^\s]*[?&]token=([A-Za-z0-9_\-]+))/;
let token = '';

child.stdout.on('data', async (chunk) => {
  const text = chunk.toString('utf8');
  process.stdout.write(text);
  if (token.length > 0) {
    return;
  }
  const m = tokenRe.exec(text);
  if (m === null) {
    return;
  }
  token = m[2];
  // 令牌同时留一份在文件里（仅本机、仅开发用）：没有它就无法"只重启应用"，
  // 每次都要连核心一起重启。这不是凭据管理，是开发期的便利记录——
  // 真正的令牌存储由应用侧的加密存储负责（HostStore + SecretStore）。
  writeFileSync(join(ROOT, '.research', 'dev-host-token.txt'), token, { mode: 0o600 });
  writeFileSync(STATE, JSON.stringify({
    pid: child.pid, port: PORT, url: HOST_URL, startedAt: Date.now()
  }, null, 2), 'utf8');
  console.log(`\n令牌已取得（长度 ${token.length}）。核心 pid=${child.pid}，记录在 .research/dev-host.json`);
  console.log(`停止：node tools/dev-host.mjs --stop\n`);

  if (NO_LAUNCH) {
    console.log(`客户端命令：hdc shell aa start -a ${ABILITY} -b ${BUNDLE} --ps dshHost ${HOST_URL} --ps dshToken ${token}`);
    return;
  }
  launchApp(token);
});

/** 用启动参数把地址与令牌交给应用（**无需在界面上手填**）。 */
function launchApp(tok) {
  /**
   * 【必须先 force-stop】启动参数只在**冷启动**时被完整消费：
   * 应用还活着时 `aa start` 走 `onNewWant`，那只更新 AppStorage 里的值，
   * 而页面的「自动连接」逻辑有**只跑一次**的守卫（避免重复认证）——
   * 结果就是「换了地址重启，界面还连着上一个 Host」。
   * 实测踩到过：新地址是 `127.0.0.1:3128`，界面仍显示 `10.0.2.2:3115`。
   */
  try {
    execFileSync(HDC, ['shell', 'aa', 'force-stop', BUNDLE], { stdio: 'ignore' });
  } catch (e) {
    // force-stop 失败不致命（可能本来就没在跑），继续启动
  }
  const start = spawn(HDC, [
    'shell', 'aa', 'start', '-a', ABILITY, '-b', BUNDLE,
    '--ps', 'dshHost', HOST_URL, '--ps', 'dshToken', tok
  ], { stdio: 'inherit' });
  start.on('exit', (code) => {
    console.log(code === 0
      ? '\n已启动应用并把 Host 通过启动参数带入（应用会自动连接，无需手填）。'
      : `\n启动应用失败（hdc 退出码 ${code}）。可手动执行 --no-launch 打印的那条命令。`);
  });
}

child.on('exit', (code) => {
  console.log(`\n核心进程退出（code=${code}）`);
});

// 让本脚本常驻（核心生命周期与它绑定：Ctrl+C 即回收）
process.on('SIGINT', () => {
  console.log('\n收到中断，停止核心…');
  child.kill();
  process.exit(0);
});
}
