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
// 【2026-10-03 新增 'ash'】它是本机 bash 垫片的**首行解释器**，也是"探针静默失效"
// 的主角：清单里没有它 ⇒ 有人删掉探针本门禁也发现不了。
for (const label of ['python3.12', "'git'", 'git-core/git', 'git-remote-http', "'rg'", "'ash'"]) {
  ok(c.includes(`label: ${label.startsWith("'") ? label : `'${label}'`}`), `目标 ${label} 在清单`);
}
ok(/async function ensureExecutables\(\)/.test(c), 'ensureExecutables 定义');
/*
 * 【门禁修复：从"存在性锚点"改成"可观测性锚点"】原第 28 条断言的**是"早退守卫存在"**：
 *   ok(/if \(!pythonReady\(\) \|\| !gitReady\(\)\) \{[\s\S]{0,80}return;/.test(c), 'ensureExecutables 锚点守卫')
 * 于是"探针永不执行"这件事反而**满足**门禁（`ash` 探针在真机上静默失效，
 * 报告里只写"未激发"，门禁却仍 PASS ⇒ 门禁替缺陷背书）。
 * 现口径：**未执行 ⇒ 不算通过**。判据改成三条，任一条不成立即 FAIL：
 *   ① 早退守卫**必须不存在**（否则整批探针在工具链未就绪时一行都不跑）；
 *   ② "缺件"也要进汇总（不能靠 continue 静默跳过 ⇒ 未激发无法伪装成"跑过了"）；
 *   ③ 汇总 diag **无条件**执行（它是"探针真的跑过"的唯一机器可读信号）。
 * 这条改动让门禁从"存在性锚点"变成"可观测性锚点"：PR 里删掉探针调用 ⇒ 本门禁 FAIL。
 * 【正则必须是"代码锚点"而不是"字面量锚点"】`main.js` 的函数头注里逐字引用了旧守卫
 * 做反例，若用裸字面量匹配，那句注释自己就会把本门禁判 FAIL。故要求它出现在**行首**
 * （`\n\s*if (…) {` 换行 `return;`）——注释行前面有 `*` 与反引号，不满足。
 */
ok(!/\n\s*if \(!pythonReady\(\) \|\| !gitReady\(\)\) \{\s*\n\s*return;/.test(c),
  '早退守卫已删除（未执行不再算通过）');
ok(/summary\.push\(`\$\{t\.label\}=缺`\)/.test(c), '缺件如实进汇总（不是静默跳过）');
ok(/diag\(`exec 探测：\$\{summary\.join\('，'\)\}`\)/.test(c), '汇总 diag 无条件执行（未执行 ⇒ 无此行 ⇒ FAIL）');
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
/*
 * 【2026-10-07 收窄：从「裸短语计数」改成「完整文案断言」】原判据是短语 `execve 被拒` 恰好
 * 出现 2 次 —— 这是个**脆锚点**：任何一处解释性 diag 用了同样的措辞就会误判 FAIL（本轮
 * 工具链解包回退里加的一条就把它踩红了），而它真正想守的东西（「两条用户可见的降级文案
 * 都在」）反而没被断言到。现口径：断言**完整句子**恰好出现 2 次（helper 与 rg 各一条）——
 * 少一条仍 FAIL，别处出现同义措辞不再误伤。
 */
ok((c.match(/该设备系统策略禁止运行第三方原生二进制（execve 被拒），暂不可用/g) || []).length === 2,
  '降级文案字面量（helper+rg 各一条完整句）');
ok(/unavailable\('git'\)/.test(c), 'git wrapper 调降级 helper（python3/pip3 已由 Phase 2 桥回退接管）');
ok(/unavailable\('python3'\)/.test(c) === false && /pythonBridgeShimLines\(\s*'pip3'/.test(c), 'python3/pip3 wrapper 走桥回退而非死路 126');
ok(/尚未就位（首次启动解包中）/.test(c), '解包中缺失与策略拒绝文案分离');
ok(/exit 126'/.test(c), '降级退出码保持 126 语义');
console.log(`OK：${n} 项断言全过`);
