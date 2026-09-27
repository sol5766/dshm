// 断言：exec 探测链（probeExec/ensureExecutables/rg wrapper）+ Phase 5 拆除语义锁
// 【Phase 5 拆除后口径】E1-E19 实验矩阵与"重写修复"循环已整体删除（结论定案：
// execve 由签名域拒绝，重写 inode 救不回）；ensureExecutables 只探测+记录。
import { readFileSync } from 'node:fs';
const c = readFileSync(new URL('../hostcore/app/main.js', import.meta.url), 'utf8');
let n = 0;
function ok(cond, msg) { n++; if (!cond) { console.error(`FAIL ${n}: ${msg}`); process.exit(1); } }

// ── probeExec：探测分类（保留原样）────────────────────────────────────────
ok(/function probeExec\(p, args, env\)/.test(c), 'probeExec 定义');
ok(c.includes("e.code === 'EACCES' ? 'denied' : `fail(${e && e.code})`"), 'denied 只映射 EACCES，fail 带 errno');
ok(/Error loading shared librar\|error while loading shared librar/.test(c), 'so-fail 正则覆盖 musl+glibc');
ok(/setTimeout\(\(\) => \{[\s\S]{0,200}SIGKILL/.test(c), '探测超时 kill 存在');

// ── Phase 5 拆除语义锁：实验代码与修复循环已整体移除 ──────────────────────
for (const gone of ['function execDiagnostics', 'function rewriteFile', 'function rewriteSoTree',
  'function realCopy', 'let execDiagDone', 'soDirs', 'bb-probe', 'exec 修复']) {
  ok(!c.includes(gone), `已拆除：${gone} 不复存在`);
}
ok(!/hmfs 的执行许可与"文件创建者"绑定[\s\S]{0,200}修复=Node 重写/.test(c), '根因注释保留但不再指向重写修复');

// ── 探测清单与状态记录 ────────────────────────────────────────────────────
ok(/function execProbeTargets\(\)/.test(c), 'execProbeTargets 定义');
for (const label of ['python3.12', "'git'", 'git-core/git', 'git-remote-http', "'rg'"]) {
  ok(c.includes(`label: ${label.startsWith("'") ? label : `'${label}'`}`), `目标 ${label} 在清单`);
}
ok(/async function ensureExecutables\(\)/.test(c), 'ensureExecutables 定义');
ok(/if \(!pythonReady\(\) \|\| !gitReady\(\)\) \{[\s\S]{0,80}return;/.test(c), 'ensureExecutables 锚点守卫');
ok(/summary\.push\(`\$\{t\.label\}=\$\{r\}`\)/.test(c), '探测结果进汇总（只记录不修复）');
ok(/E1-E19 实验定案/.test(c), 'ensureExecutables 注释交代拆除依据');

// ── rg wrapper 与垫片降级（保留原样）─────────────────────────────────────
ok(/function ensureRipgrepWrapper\(binDir\)/.test(c), 'ensureRipgrepWrapper 定义');
ok(/ripgrep-linux-arm64', 'bin', 'rg'/.test(c), 'rg 真身路径拼接');
ok(/ensureRipgrepWrapper\(binDir\);/.test(c), '顶层块调用 rg wrapper');
ok((c.match(/ensureExecutables\(\)\.catch/g) || []).length === 2, 'ensureExecutables 两处挂载（稳态+解包收尾）');
ok(/if \(pyOk && gitOk\) \{[\s\S]{0,140}setImmediate/.test(c), '解包收尾仅在锚点齐备时触发探测');
ok(/hmfs 的执行许可与"文件创建者"绑定/.test(c), '根因证据注释在位');
ok((c.match(/\( exec "\$/g) || []).length === 4, 'wrapper 子 shell 探测（python/pip3/git/rg）');
ok((c.match(/execve 被拒/g) || []).length === 2, '降级文案字面量（helper+rg）');
ok(/unavailable\('git'\)/.test(c), 'git wrapper 调降级 helper（python3/pip3 已由 Phase 2 桥回退接管）');
ok(/unavailable\('python3'\)/.test(c) === false && /pythonBridgeShimLines\(\s*'pip3'/.test(c), 'python3/pip3 wrapper 走桥回退而非死路 126');
ok(/尚未就位（首次启动解包中）/.test(c), '解包中缺失与策略拒绝文案分离');
ok(/exit 126'/.test(c), '降级退出码保持 126 语义');
console.log(`OK：${n} 项断言全过`);
