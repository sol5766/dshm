#!/usr/bin/env node
/**
 * 门禁：手持档长时任务的**生命期接线**（entry / phone 两个壳层都要接）。
 *
 * 【为什么要有这条（2026-10-29，docs/291 复核）】`KeepAlive` 里写着三件正确的事：
 *   ① 系统取消（非用户取消）⇒ 退避续期；
 *   ② 回前台 ⇒ 清掉 `backgroundWanted` 与续期定时器；
 *   ③ 晚到的 acquire 必须能被作废。
 * 但它们**全部依赖调用方接线**：续期的判据是 `backgroundWanted && refs > 0`，
 * 而 `backgroundWanted` 只由 `noteBackground()` 置位。phone 此前一次都没调用它 ⇒
 * 续期分支永远走 "renew 跳过" —— "熄屏就断"在 phone 上根本不会自愈；
 * entry 则漏了晚到 acquire 的代次校验 ⇒ 快速切回前台会残留长时任务与通知。
 *
 * 这类缺陷**不报编译错、不崩**，只在真机上以"后台任务莫名结束 / 通知不消失"出现，
 * 而共享的 `KeepAlive` 自身代码看起来完全正确 —— 必须逐壳层钉住接线。
 *
 * 【判据】
 *   entry 与 phone 的 EntryAbility 都必须：
 *     A. `onBackground` 路径最终调到 `this.keepAlive.noteBackground(<判据>)`
 *        （必须带**非字面量 false** 的参数：恒 false 等于没接）；
 *     B. `onForeground` 里调到 `noteBackground(false)`（撤掉本周期意图 + 清续期）；
 *     C. acquire 的 `.then` 里有代次/前后台二次校验，且失效时 `release()`；
 *     D. `releaseHandheldKeepAlive` 里**先**代次自增、**再**判断 held（顺序反了会吞掉作废信号）。
 *
 * 对照臂（--self-test）：删掉 phone 的 noteBackground / 去掉 entry 的代次校验 /
 * 把代次自增挪到 return 之后 ⇒ 必须判红。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SHELLS = {
  entry: 'entry/src/main/ets/entryability/EntryAbility.ets',
  phone: 'phone/src/main/ets/entryability/EntryAbility.ets',
};

/** 去注释（注释里写着正确接线、代码已删，是本仓反复踩的坑）。 */
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 取某个方法/函数体（从 marker 起按大括号配平）。 */
function bodyAfter(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) return '';
  const open = text.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

export function judge(shellName, raw) {
  const s = stripComments(raw);
  const problems = [];
  const bg = bodyAfter(s, 'onBackground(');
  const fg = bodyAfter(s, 'onForeground(');
  const release = bodyAfter(s, 'private releaseHandheldKeepAlive(');

  if (bg.length === 0) problems.push('找不到 onBackground()');
  if (fg.length === 0) problems.push('找不到 onForeground()');
  if (release.length === 0) problems.push('找不到 releaseHandheldKeepAlive()');

  // ── A：后台周期必须把"想保活"告诉 KeepAlive ────────────────────────────
  // 见 noteBackground 出现在文件任意位置亦可（可能抽到 helper 里），但必须不是恒 false
  const noteBgCalls = [...s.matchAll(/noteBackground\(([^)]*)\)/g)].map((m) => m[1].trim());
  const liveCalls = noteBgCalls.filter((arg) => arg.length > 0 && arg !== 'false');
  if (liveCalls.length === 0) {
    problems.push('全程没有以**非 false** 参数调用 noteBackground()（系统取消后的续期判据永远是假）');
  }

  // ── B：回前台撤掉意图 ─────────────────────────────────────────────────
  if (!/noteBackground\(\s*false\s*\)/.test(fg)) {
    problems.push('onForeground() 里没有 noteBackground(false)（回前台不撤本周期意图、续期链会跟到前台）');
  }

  // ── C：晚到 acquire 的代次/前后台二次校验 + release ────────────────────
  /*
   * 取真实调用（`keepAlive.acquire()` 或 `keepAlive.acquireTaskKeeping()` 后接 `.then(`；注释里的提及不算），
   * 再按箭头函数体的窗口检查。窗口用定长切片而不是按大括号配平：`.then((x) => { … })`
   * 的第一个 `{` 属于箭头函数体，配平函数会把它当成函数体起点，容易数错。
   */
  const acquireScope = shellName === 'entry'
    ? bodyAfter(s, 'private maybeAcquireHandheldKeepAlive(): void') : s;
  const acquireScopeOffset = s.indexOf(acquireScope);
  const realAcquires = [...acquireScope.matchAll(/keepAlive\.(?:acquire|acquireTaskKeeping)\(\)\s*\.then\(/g)];
  if (realAcquires.length === 0) {
    problems.push('找不到 keepAlive acquire/acquireTaskKeeping 的 .then 接线');
  } else {
    for (const m of realAcquires) {
      const sourceAt = acquireScopeOffset + m.index;
      const windowText = stripComments(s.slice(sourceAt, sourceAt + 1200));
      /*
       * 判据要看的是**比较**本身，而不是"窗口里出现过这个词"：
       * 失效分支的日志参数里也写着 generation / keepAliveGeneration，
       * 只看词会让"判据改成 if (false)、日志照打"的变异体假绿（本轮踩过）。
       */
      const hasGenCheck = /!==\s*this\.keepAliveGeneration/.test(windowText)
        || /this\.keepAliveGeneration\s*!==/.test(windowText);
      const hasFgCheck = /!this\.appBackgrounded/.test(windowText)
        || /this\.appBackgrounded\s*===/.test(windowText);
      const hasRelease = /keepAlive\.release\(/.test(windowText);
      const line = s.slice(0, sourceAt).split('\n').length;
      if (!hasGenCheck && !hasFgCheck) {
        problems.push(`L${line} 晚到 acquire 的 .then 里既无代次、也无前后台校验（快速切回前台会残留任务/通知）`);
      }
      if (!hasRelease) {
        problems.push(`L${line} 晚到 acquire 失效时没有 release()（作废了却不回收）`);
      }
    }
  }

  // ── D：先自增代次、再判断 held ────────────────────────────────────────
  const inc = release.indexOf('keepAliveGeneration++');
  const heldGuard = release.indexOf('if (!this.handheldKeepAliveHeld)');
  if (inc < 0) {
    problems.push('releaseHandheldKeepAlive() 里没有 keepAliveGeneration++');
  } else if (heldGuard >= 0 && inc > heldGuard) {
    problems.push('代次自增在 held 判断之后（提前 return 会吞掉作废信号）');
  }

  // ── E：熄屏 / 定时任务也必须进保活判据（2026-11-08 熄屏任务被冻结） ──
  if (shellName === 'entry') {
    const acquireBody = bodyAfter(s, 'private maybeAcquireHandheldKeepAlive(): void');
    const screenBody = bodyAfter(s, 'private setupScreenWatcher(): void');
    if (!/workloadSchedules\(\)/.test(acquireBody)) {
      problems.push('maybeAcquireHandheldKeepAlive() 没读 workloadSchedules()（等待定时触发的任务仍会被判空闲）');
    }
    if (!/schedules\s*>\s*0/.test(acquireBody)) {
      problems.push('busy 判据没有纳入 `schedules > 0`（有活跃定时任务也不申请保活）');
    }
    if (!/maybeAcquireBeforeScreenOff\(\)/.test(screenBody)) {
      problems.push('setupScreenWatcher() 熄屏分支没有调用 maybeAcquireBeforeScreenOff()（前台直接锁屏时不会申请保活）');
    }
    /* Host 的 HOME_DIR = <filesDir>/dsh/home；少一级就读不到 workload.json。 */
    const wlBody = bodyAfter(s, 'private workloadRefs(): number');
    if (!/dsh\/home\/workload\.json/.test(wlBody)) {
      problems.push('workloadRefs() 读的不是 `<filesDir>/dsh/home/workload.json`（路径差一级 ⇒ refs 恒为 0）');
    }
    if (/\$\{this\.context\.filesDir\}\/workload\.json/.test(wlBody)) {
      problems.push('workloadRefs() 仍读 `<filesDir>/workload.json`（Host 从未写这个位置）');
    }
    if (!/screenOffed\s*=\s*true/.test(screenBody) || !/!this\.screenOffed/.test(s)) {
      problems.push('熄屏申请的长时任务没有 `screenOffed` 保护（会被"回前台"晚到检查立刻回收）');
    }
    if (!/noteScreenState\(off,\s*true\)/.test(screenBody)) {
      problems.push('entry 熄屏校准没有传 `skipIfPending=true`（会与 onBackground 的申请并发）');
    }
  } else if (/noteScreenState\(off,\s*true\)/.test(s)) {
    /* 手机后台任务本来就正常：不启用 entry 的新并发保护，保持原行为。 */
    problems.push('phone 的 noteScreenState 不应带 skipIfPending（手机会话链保持原行为）');
  }
  void shellName;
  return problems;
}

const selfTest = process.argv.includes('--self-test');
const texts = {};
const problems = [];
for (const [name, rel] of Object.entries(SHELLS)) {
  const raw = readFileSync(join(ROOT, rel), 'utf8');
  texts[name] = raw;
  for (const p of judge(name, raw)) problems.push(`[${name}] ${p}`);
}

if (!selfTest) {
  if (problems.length > 0) {
    console.error(`❌ 手持档保活接线不完整（${problems.length} 处）：`);
    for (const p of problems) console.error(`   · ${p}`);
    process.exit(1);
  }
  console.log('✅ 通过：entry / phone 都接了 noteBackground、回前台撤意图、晚到 acquire 代次校验与回收。');
  process.exit(0);
}

console.log('--self-test：变异体必须判红 --');
let ok = problems.length === 0;
console.log(`  基线：${problems.length} 处问题（应为 0）`);
for (const p of problems) console.log(`     · ${p}`);

const arms = [
  ['phone 去掉唯一一处非 false 的 noteBackground', 'phone', (src) => src
    .replace(/this\.keepAlive\.noteBackground\(running === true\);/, '')],
  ['entry 去掉晚到 acquire 的代次/前台校验', 'entry', (src) => {
    // 先把判据替换成 `if (false)`，再把**副作用里**的代次/前后台读取一并去掉，
    // 模拟"有人把这段校验删了"（只换成 false 时，函数体仍读 generation，属假绿）
    return src
      .replace('if ((!this.appBackgrounded && !this.screenOffed) || generation !== this.keepAliveGeneration) {', 'if (false) {')
      .replace('          generation, this.keepAliveGeneration);', '          0, 0);');
  }],
  ['代次自增挪到 held 判断之后', 'entry', (src) => {
    const marker = 'private releaseHandheldKeepAlive(): void {';
    const at = src.indexOf(marker);
    if (at < 0) return src;
    const head = src.slice(0, at + marker.length);
    const tail = src.slice(at + marker.length);
    const incAt = tail.indexOf('this.keepAliveGeneration++;');
    if (incAt < 0) return src;
    const withoutInc = tail.slice(0, incAt) + tail.slice(incAt + 'this.keepAliveGeneration++;'.length);
    // 放到 `if (!this.handheldKeepAliveHeld) { return; }` 之后
    const guard = 'if (!this.handheldKeepAliveHeld) {\n      return;\n    }';
    const gAt = withoutInc.indexOf(guard);
    if (gAt < 0) return src;
    return head + withoutInc.slice(0, gAt + guard.length)
      + '\n    this.keepAliveGeneration++;' + withoutInc.slice(gAt + guard.length);
  }],
  ['entry 的 busy 判据丢掉活跃定时任务', 'entry', (src) => src
    .replace('|| refs > 0 || schedules > 0;', '|| refs > 0;')],
  ['entry 熄屏分支不再补申请保活', 'entry', (src) => src
    .replace(/if \(off\) \{\n          this\.screenOffed = true;\n          this\.maybeAcquireBeforeScreenOff\(\);/, 'if (off) {\n          this.screenOffed = true;')],
  ['workload 路径少一级 dsh/home（refs 恒 0）', 'entry', (src) => src
    .replace("`${this.context.filesDir}/dsh/home/workload.json`", "`${this.context.filesDir}/workload.json`")],
  ['熄屏保活被回前台晚到检查误回收', 'entry', (src) => src
    .replace('(!this.appBackgrounded && !this.screenOffed)', '(!this.appBackgrounded)')],
];
for (const [label, shell, mutate] of arms) {
  const mutated = mutate(texts[shell]);
  const changed = mutated !== texts[shell];
  const reds = changed ? judge(shell, mutated) : [];
  const red = changed && reds.length > 0;
  if (!red) ok = false;
  console.log(`  ${red ? '✅' : '❌'} ${label} ⇒ ${changed ? `判红（${reds.length} 处）` : '变异未生效'}`);
}
console.log(ok ? '\n✅ 自检通过。' : '\n❌ 自检失败（门禁没牙）。');
process.exit(ok ? 0 : 3);
