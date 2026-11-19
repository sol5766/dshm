#!/usr/bin/env node
/**
 * 门禁：task-state 兼容副本必须先判目录可写（2026-11-11，2in1 真机）。
 *
 * 【为什么要有这条】2in1 上 `files/` 根目录对宿主进程只读，兼容副本
 * （`files/task-state.json`）每个 turn 都 EACCES 并往 dshm-host.log 刷一条。
 * 主链路是 `dsh/home/task-state.json`，兼容副本只是给旧客户端/排查脚本的镜像 ——
 * 不可写就应整轮跳过（且只记一次），不能每个 turn 重试 + 刷日志。
 *
 * 用法：node tools/check-task-state-compat.mjs [--self-test]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const FILE = 'hostcore/app/main.js';

export function judge(text) {
  const problems = [];
  const start = text.indexOf("      const taskStateFile = path.join(HOME_DIR, 'task-state.json');");
  const end = text.indexOf('\n      /*\n       * 启动基线', start);
  const block = start < 0 || end < 0 ? '' : text.slice(start, end);
  if (!block) return ['找不到 writeTaskState 实现'];
  for (const code of [null, 'EACCES', 'EPERM', 'EROFS']) {
    const writes = new Map();
    let attempts = 0;
    let probes = 0;
    const logs = [];
    const context = {
      path, HOME_DIR: '/files/dsh/home', SANDBOX_HOME: '/files', DSH_BASE: '',
      diag: message => logs.push(message),
      fs: {
        constants: { W_OK: 2 },
        accessSync: target => {
          probes++;
          assert.equal(target, '/files');
        },
        lstatSync: () => ({ isSymbolicLink: () => false }),
        writeFileSync: (target, body) => {
          assert.ok(path.isAbsolute(target));
          if (target === '/files/task-state.json') {
            attempts++;
            if (code) throw Object.assign(new Error(code), { code });
          }
          writes.set(target, JSON.parse(body));
        },
      },
    };
    try {
      vm.createContext(context);
      vm.runInContext(block + '\nthis.write = writeTaskState;', context);
      for (const state of ['running', 'done', 'error', 'done']) {
        context.write({ active: state === 'running', state });
        const main = writes.get('/files/dsh/home/task-state.json');
        assert.equal(main.state, state);
        assert.equal(main.active, state === 'running');
        if (!code) assert.deepEqual(writes.get('/files/task-state.json'), main);
      }
      assert.equal(attempts, code ? 1 : 4);
      assert.ok(probes <= 1);
      assert.ok(logs.length <= 1);
    } catch (error) {
      problems.push((code || 'writable') + ': ' + error.message);
    }
  }
  return problems;
}

const selfTest = process.argv.includes('--self-test');
const raw = readFileSync(FILE, 'utf8');
const base = judge(raw);

if (!selfTest) {
  if (base.length > 0) {
    console.error(`❌ task-state 兼容副本判据不完整（${base.length} 处）：`);
    for (const p of base) console.error(`   · ${p}`);
    process.exit(1);
  }
  console.log('PASS: absolute compatibility path, actual permission failure cached, primary state preserved');
  process.exit(0);
}

console.log('--self-test：变异体必须判红 --');
let failures = 0;
if (base.length !== 0) {
  failures += 1;
  console.error(`基线应为 0 处，实际 ${base.length}`);
}
const arms = [
  ['相对路径回归', (t) => t.replace("path.join(SANDBOX_HOME, 'task-state.json')", "path.join(DSH_BASE, '..', 'task-state.json')")],
  ['写拒绝后不缓存', (t) => t.replace("if (e2 && ['EACCES', 'EPERM', 'EROFS'].includes(e2.code)) compatWritableCache = false;", '')],
  ['跳过兼容写入', (t) => t.replace('if (compatWritable()) {', 'if (false) {')],
  ['丢失主状态', (t) => t.replace("fs.writeFileSync(taskStateFile, JSON.stringify(payload, null, 2) + '\\n', 'utf8');", '')],
];
for (const [name, mutate] of arms) {
  const mutated = mutate(raw);
  if (mutated === raw) {
    failures += 1;
    console.error(`  ✗ ${name}：变异未生效（锚点漂了）`);
    continue;
  }
  const problems = judge(mutated);
  if (problems.length === 0) {
    failures += 1;
    console.error(`  ✗ ${name}：判据没判红`);
  } else {
    console.log(`  ✓ ${name} ⇒ 判红（${problems.length} 处：${problems[0]}）`);
  }
}
console.log(failures === 0 ? '✅ 自检通过' : `❌ 自检失败（${failures}）`);
process.exit(failures === 0 ? 0 : 1);
