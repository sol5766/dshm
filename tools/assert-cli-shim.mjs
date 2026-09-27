// 临时断言：pnpm/npm/npx CLI 假壳（安装队列投递，D26/E86）
// 背景：假壳最初运行时读 $DSH_HOME 定位队列目录，但 bash 工具子进程环境由
// dsh-bash-local spawnSpec 白名单构造（ENV_OVERRIDES+spec.env+spec.dshEnv，
// 不 spread Host process.env），$DSH_HOME 恒空——2026-09-23 真机 `pnpm add`
// 实测报"缺少 DSH_HOME"（PATH 经 spec.dshEnv 到位，假壳找得到但队列路径
// 拿不到）。修复：队列路径生成时写死 ${HOME_DIR}/install-queue（与 python
// 垫片写死 HOME_DIR/PORT 同模式），Host 轮询目录同源（HOME_DIR 模块常量）。
// 用法：node tools/assert-cli-shim.mjs
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const main = read('../hostcore/app/main.js');
let n = 0;
function ok(cond, msg) { n++; if (!cond) { console.error(`FAIL ${n}: ${msg}`); process.exit(1); } }

// ── 队列路径写死（核心回归锁：2026-09-23 pnpm add 缺 DSH_HOME 修复）──
//
// 【为什么判据改成"逐个假壳各一次"而不是"总数 == 2"】
// 原判据写死 `=== 2`（当时只有 pnpm/npm 与 npx 两个假壳），后来加了第三个
// `DSH_SHIM_LINES`（dsh 的 plugin install），实际变成 3 —— 这条断言就**一直在红**。
// 它红得"有道理"（数字确实变了），但**判据错了**：真正要锁的是"**每个**假壳都写死
// 了队列路径"，而不是"全文件恰好出现 2 次"。写死 2 的代价是：每加一个假壳都要改
// 断言，而"改断言让它变绿"这件事本身就会让人放松警惕。
// 现在逐壳检查，**新加假壳若漏写队列路径会立刻红**（这才是这条锁的意图）。
const SHIMS = [
  ['pnpm/npm', 'const CLI_SHIM_LINES = ['],
  ['npx', 'const NPX_SHIM_LINES = ['],
  ['dsh', 'const DSH_SHIM_LINES = ['],
];
for (const [label, decl] of SHIMS) {
  const i = main.indexOf(decl);
  ok(i >= 0, `${label} 假壳定义（${decl}）`);
  const j = main.indexOf('\n];', i);
  const body = main.slice(i, j > i ? j : main.length);
  ok((body.match(/QDIR="\$\{HOME_DIR\}\/install-queue"/g) || []).length === 1,
    `${label} 假壳的队列路径**生成时写死**（\${HOME_DIR}/install-queue）`);
}
ok(!main.includes('DSH_HOME_DIR'), '假壳不再运行时读 $DSH_HOME（bash 子进程 env 白名单，恒空）');
ok(!main.includes('缺少 DSH_HOME 环境变量'), '误导文案已移除（PATH 到位而 DSH_HOME 不可见，两者是两回事）');
ok(main.includes("const installQueueDir = HOME_DIR.length > 0 ? path.join(HOME_DIR, 'install-queue') : ''"),
  'Host 轮询目录与假壳写死目录同源（HOME_DIR 模块常量）');

// ── pnpm/npm 假壳结构（CLI_SHIM_LINES）──
ok(main.includes('const CLI_SHIM_LINES = ['), 'CLI_SHIM_LINES 定义');
ok(main.includes('echo "10.0.0 (dshm install-queue shim)"'), '-v/--version/version 快速分支');
ok(main.includes('请给出包名或 GitHub 地址（端侧不支持无参 install）'), '无参 install 如实报错');
ok(main.includes('echo "$a" > "$QDIR/$base.req"'), 'add 投递：.req 逐包写入');
ok(main.includes('if [ -f "$QDIR/$base.done" ]; then') && main.includes('if [ -f "$QDIR/$base.fail" ]; then'),
  '同步等结果：.done/.fail 轮询（模型视角 pnpm add 直接返回）');
ok(main.includes('max_loop="$SHIM_WAIT_MAX"') && main.includes('max_loop=600'),
  '等待上限 env 可调 + 空回退 600（300s：2026-09-23 真机实测 GitHub 包全程 113s，旧值 180 循环=90s 不够，假壳超时先退致 .done 无人读回）');
// 同上：判据从"总数 == 2"改成"每个假壳各有一条"（加 dsh 假壳后总数变 3 而这条一直红）。
for (const [label, decl] of SHIMS) {
  const i = main.indexOf(decl);
  const j = main.indexOf('\n];', i);
  const body = main.slice(i, j > i ? j : main.length);
  ok((body.match(/仍在等待 Host 安装/g) || []).length >= 1,
    `${label} 假壳的等待循环有进度行（防工具层 idle 误杀，模型可见存活）`);
}
ok((main.match(/安装幂等/g) || []).length >= 1,
  '超时文案教模型幂等重跑确认（超时=仍在装，不是失败）');
ok((main.match(/重启应用后随 profile 挂载生效/g) || []).length >= 1,
  'done 读回附成功总结（含重启生效提示，不只 cat JSON）');
ok(main.includes('清理陈旧安装结果文件'),
  'Host 轮询顺带清理陈旧 .done/.fail（写入方退出后结果永无人读，2026-09-23 真机实证残留）');
// 【2026-09-25 更正：这两条测的是**已被取代**的文案】
// 原断言锁"端侧暂不支持卸载"与"端侧只支持 add/install <包名|GitHub地址>"
// ——那是 dsh 假壳**只有装通道**时的拒绝文案。后来补了卸载（`dsh plugin remove`
// 投递 `.rem` 队列，见 DSH_SHIM_LINES 的补卸载段），这两句话便从源码里消失了，
// 而断言没跟着改 ⇒ **一直在红**。现改为锁**当前契约**：
//   · remove 走卸载队列（`.rem` + 等结果），不再是一句拒绝；
//   · 未知子命令仍然如实报错（引导到支持的用法）。
ok(main.includes('$QDIR/$base.rem'), 'dsh 假壳：remove 走卸载队列（.rem 投递，非拒绝）');
ok(main.includes('端侧支持 plugin install'), '未知子命令如实报错（引导到支持的用法）');

// ── npx 假壳结构（NPX_SHIM_LINES）──
ok(main.includes('const NPX_SHIM_LINES = ['), 'NPX_SHIM_LINES 定义');
ok(main.includes('echo "10.9.0 (dshm install-queue shim)"'), 'npx -v 快速分支');
ok(main.includes('echo "$pkg" > "$QDIR/$base.req"'), 'npx 投递：.req 写入（与 pnpm add 同通道）');
ok(main.includes('端侧 npx 不做即时执行'), 'npx 装而不执行语义（沙箱无 .bin symlink）');

// ── 布置与守卫 ──
ok(main.includes('function ensureCliShims(binDir)'), 'ensureCliShims 定义');
// 同上：名字表加了 dsh 之后从三名变四名（与此前两处"写死 2"同源）。
// 判据改为**逐个断言四个名字都在那一行的列表里**，而不是匹配整行字面量。
for (const name of ['pnpm', 'npm', 'npx', 'dsh']) {
  ok(new RegExp(`\\['${name}',\\s*\\w+Script\\]`).test(main), `CLI 假壳布置含 ${name}`);
}
ok(/if \(!binDir \|\| binDir\.length === 0\) \{[\s\S]{0,150}return;[\s\S]{0,250}if \(HOME_DIR\.length === 0\) \{[\s\S]{0,150}return;/.test(main),
  '双守卫：busybox 未布置 / HOME_DIR 未解析均不布置假壳');

// ── 2026-09-25 报告：两处修复的回归锁 ──
//
// ① 重启通道：`execPath + ['-e', …]` 一律视为**重启意图**。
// 原判据只认脚本里含 `waitForParent`（dsh 自己的 RELAUNCH_HELPER），于是
// **插件市场那个重启按钮的助手被漏掉**（它的脚本文本里没有这个词）⇒ 重启被拒
// ⇒ 装了 bundle 型插件也不生效。现锁"判据是 args[0] === '-e'，不看脚本内容"。
ok(/const isRestartHelper = \(args\) =>[\s\S]{0,260}args\[0\] === '-e'/.test(main),
  '重启判据含 args[0] === \'-e\'（覆盖 dsh 与市场两种助手形态）');
ok(!main.includes("args[1].includes('waitForParent')"),
  '重启判据不再只看 waitForParent（那会漏掉市场助手）');
ok(main.includes('isRestartHelper(args) && typeof requestAppRestart'), '命中重启意图时转入整机冷启动通道');

// ② 安装器登记门控：bundle 型包 → `dsh.profile.bundles`；**不写孤儿用户行**。
// 证据：没有任何 bundle 用自己做条目 id（billion-context 是 `bili-native`、
// denia 是 `ui-skin-denia`）⇒ 写 `- id: <包名>` 必然匹配不到条目，市场 toggle
// 还会报 `no loader entry matched`。
const installer = read('../hostcore/app/dshm-installer.js');
ok(installer.includes('function topPackageDisposition(pkg)'), '登记落点判定函数存在');
ok(installer.includes('function appendProfileBundle(profileDir, name)'), 'bundle 登记函数存在');
ok(!installer.includes('function appendUserRow('),
  '安装器**不再**写用户行（appendUserRow 已删：那必然产生孤儿行）');
ok(/disp\.kind === 'bundle'[\s\S]{0,120}appendProfileBundle/.test(installer),
  'bundle 型包走 appendProfileBundle（与上游 reconcile 同落点）');

console.log(`OK：${n} 项断言全过`);
