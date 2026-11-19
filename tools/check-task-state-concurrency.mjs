import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const source = readFileSync(new URL('../hostcore/app/main.js', import.meta.url), 'utf8');

function harness(text, previous = null) {
  const start = text.indexOf("      const taskStateFile = path.join(HOME_DIR, 'task-state.json');");
  const end = text.indexOf('\n    }', text.indexOf("void refreshBalance('turn-end')", start));
  assert.ok(start >= 0 && end > start, 'production handler boundaries');
  const writes = [];
  let now = 1700000000000;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const logs = [];
  const context = {
    path, HOME_DIR: '/files/dsh/home', SANDBOX_HOME: '/files', Date: Clock,
    titles: new Map(), current: {}, records: [], MAX_RECORDS: 20000,
    titleOf: (session, sid) => context.titles.get(sid) || session.header?.title || '',
    scheduleWrite: () => {}, refreshBalance: async () => {}, stage: () => {},
    diag: message => logs.push(message),
    ctx: { on: (name, handler, options) => {
      assert.equal(name, 'session/event');
      assert.equal(options.global, true);
      context.event = handler;
    } },
    fs: {
      constants: { W_OK: 2 }, accessSync: () => {},
      lstatSync: () => ({ isSymbolicLink: () => false }),
      readFileSync: () => {
        if (previous === null) throw new Error('ENOENT');
        return JSON.stringify(previous);
      },
      writeFileSync: (target, body) => {
        assert.ok(path.isAbsolute(target));
        if (target === '/files/dsh/home/task-state.json') writes.push(JSON.parse(body));
        else assert.deepEqual(JSON.parse(body), writes.at(-1));
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(text.slice(start, end) + '\nthis.running = () => taskActive;' +
    '\nthis.retained = () => ({ open: tasks.size, active: activeTasks.size, closed: closedTasks.size,' +
    ' running: [...tasks.values()].filter(task => task.active).length });' +
    '\nthis.closedKeys = () => [...closedTasks];', context);
  return {
    writes, logs, running: context.running, retained: context.retained, closedKeys: context.closedKeys,
    last: () => writes.at(-1),
    emit: (sid, type, turn, kind = 'completed') => {
      now += 1000;
      context.event({ header: { id: sid, title: 'title-' + sid } }, {
        type, time: now, data: type === 'session/title' ? { title: 'renamed-' + sid }
          : { turn, step: 1, reason: { kind } },
      });
      assert.ok(!logs.some(message => message.includes('事件处理异常')), logs.join('\n'));
      return writes.at(-1);
    },
  };
}

export function judge(text) {
  const problems = [];
  const check = (name, run) => {
    try { run(); } catch (error) { problems.push(name + ': ' + error.message); }
  };
  check('cross-session completion identity and running work', () => {
    const h = harness(text);
    const a = h.emit('A', 'turn/start', 1);
    h.emit('B', 'turn/start', 8);
    const end = h.emit('A', 'turn/end', 1);
    assert.equal(end.taskId, 'A#1');
    assert.equal(end.sessionId, 'A');
    assert.equal(end.title, 'title-A');
    assert.equal(end.turn, 1);
    assert.equal(end.startedAt, a.startedAt);
    assert.equal(end.durationMs, 2000);
    assert.equal(end.active, false, 'legacy consumer must see completion');
    assert.equal(end.state, 'done');
    assert.equal(end.seq, 1);
    assert.equal(end.anyActive, true);
    assert.equal(h.running(), true);
    const b = h.emit('B', 'turn/end', 8, 'error');
    assert.equal(b.taskId, 'B#8');
    assert.equal(b.state, 'error');
    assert.equal(b.seq, 2);
    assert.equal(b.anyActive, false);
    assert.equal(h.running(), false);
  });
  check('same-session replacement and late events', () => {
    const h = harness(text);
    const a = h.emit('A', 'turn/start', 1);
    h.emit('A', 'turn/start', 2);
    assert.equal(h.retained().running, 1);
    const runningCount = h.writes.length;
    h.emit('A', 'step/end', 1);
    assert.equal(h.writes.length, runningCount);
    const end = h.emit('A', 'turn/end', 1, 'aborted');
    assert.equal(end.taskId, 'A#1');
    assert.equal(end.startedAt, a.startedAt);
    assert.equal(end.anyActive, true);
    const count = h.writes.length;
    h.emit('A', 'turn/end', 1);
    h.emit('A', 'turn/start', 1);
    h.emit('A', 'step/end', 1);
    assert.equal(h.writes.length, count, 'closed turn must not reopen or notify twice');
    const last = h.emit('A', 'turn/end', 2);
    assert.equal(last.taskId, 'A#2');
    assert.equal(last.seq, 2);
    assert.equal(last.anyActive, false);
  });
  check('success failure cancellation and duplicate starts', () => {
    const h = harness(text);
    let seq = 0;
    for (const kind of ['completed', 'error', 'aborted', 'interrupted', 'blocked', 'max-tokens']) {
      const turn = ++seq;
      const start = h.emit('A', 'turn/start', turn);
      const count = h.writes.length;
      h.emit('A', 'turn/start', turn);
      assert.equal(h.writes.length, count);
      const end = h.emit('A', 'turn/end', turn, kind);
      assert.equal(end.startedAt, start.startedAt);
      assert.equal(end.durationMs, 2000);
      assert.equal(end.seq, seq);
      assert.equal(end.active, false);
      assert.equal(end.anyActive, false);
      assert.equal(end.state, kind === 'error' ? 'error' : 'done');
      assert.equal(h.running(), false);
    }
  });
  check('step fallback uses its own session and turn', () => {
    const h = harness(text);
    h.emit('A', 'turn/start', 4);
    const b = h.emit('B', 'step/start', 9);
    assert.equal(b.taskId, 'B#9');
    assert.equal(b.title, 'title-B');
    h.emit('A', 'turn/end', 4);
    assert.equal(h.running(), true);
    const end = h.emit('B', 'turn/end', 9);
    assert.equal(end.startedAt, b.startedAt);
    assert.equal(end.anyActive, false);
  });
  check('replacement closes without an old end and reverse session order', () => {
    const h = harness(text);
    h.emit('A', 'turn/start', 1);
    h.emit('A', 'turn/start', 2);
    assert.equal(h.emit('A', 'turn/end', 2).anyActive, false);
    assert.equal(h.running(), false);
    assert.equal(h.emit('A', 'turn/end', 1).taskId, 'A#1');
    h.emit('A', 'turn/start', 3);
    h.emit('B', 'turn/start', 1);
    assert.equal(h.emit('B', 'turn/end', 1).anyActive, true);
    assert.equal(h.emit('A', 'turn/end', 3).anyActive, false);
  });
  check('end without observed start and duplicate end', () => {
    const h = harness(text);
    h.emit('B', 'turn/start', 7);
    const end = h.emit('A', 'turn/end', 3);
    assert.equal(end.taskId, 'A#3');
    assert.equal(end.startedAt, '');
    assert.equal(end.durationMs, 0);
    assert.equal(end.anyActive, true);
    const count = h.writes.length;
    h.emit('A', 'turn/end', 3);
    assert.equal(h.writes.length, count);
  });
  check('startup reconcile and sequence continuity', () => {
    for (const previous of [
      { active: true, state: 'running' },
      { active: false, state: 'done', anyActive: true },
    ]) {
      const h = harness(text, { ...previous, taskId: 'A#5', sessionId: 'A', turn: 5,
        title: 'old', startedAt: '2020-01-01T00:00:00.000Z', seq: 12 });
      assert.equal(h.last().active, false);
      assert.equal(h.last().anyActive, false);
      assert.equal(h.last().state, 'done');
      assert.equal(h.last().taskId, 'A#5');
      assert.equal(h.last().seq, 12);
      assert.equal(h.running(), false);
      h.emit('B', 'turn/start', 1);
      assert.equal(h.emit('B', 'turn/end', 1).seq, 13);
    }
    assert.equal(harness(text).last().state, 'idle');
  });
  check('2000 completed turns retain at most 1024 compact closed keys', () => {
    const h = harness(text);
    for (let turn = 1; turn <= 2000; turn++) {
      h.emit('A', 'turn/start', turn);
      h.emit('A', 'turn/end', turn);
      assert.equal(h.retained().open, 0);
      assert.equal(h.retained().active, 0);
      assert.ok(h.retained().closed <= 1024);
    }
    assert.equal(h.retained().closed, 1024);
    assert.equal(h.last().seq, 2000);
    assert.ok(h.closedKeys().every(key => typeof key === 'string'));
    const count = h.writes.length;
    h.emit('A', 'turn/end', 2000);
    h.emit('A', 'turn/start', 2000);
    h.emit('A', 'step/end', 2000);
    assert.equal(h.writes.length, count);
    assert.equal(h.running(), false);
    const evicted = h.emit('A', 'turn/end', 1);
    assert.equal(evicted.seq, 2001, 'evicted duplicate is treated as an unobserved end');
    assert.equal(evicted.taskId, 'A#1');
    assert.equal(evicted.startedAt, '');
    assert.equal(evicted.durationMs, 0);
    assert.equal(evicted.anyActive, false);
    assert.equal(h.retained().open, 0);
    assert.equal(h.retained().closed, 1024);
    h.emit('A', 'turn/end', 1);
    assert.equal(h.last().seq, 2001);
  });
  check('replaced pending survives closed cache eviction and late end preserves active turn', () => {
    const h = harness(text);
    const first = h.emit('A', 'turn/start', 1);
    h.emit('A', 'turn/start', 2);
    for (let turn = 1; turn <= 1100; turn++) {
      h.emit('B', 'turn/start', turn);
      h.emit('B', 'turn/end', turn);
    }
    assert.equal(h.retained().open, 2);
    assert.equal(h.retained().active, 1);
    assert.equal(h.retained().closed, 1024);
    const end = h.emit('A', 'turn/end', 1, 'aborted');
    assert.equal(end.startedAt, first.startedAt);
    assert.equal(end.durationMs, 2202000);
    assert.equal(end.anyActive, true);
    assert.equal(h.retained().open, 1);
    assert.equal(h.retained().active, 1);
    assert.equal(end.seq, 1101);
    const count = h.writes.length;
    h.emit('A', 'turn/end', 1);
    assert.equal(h.writes.length, count);
    assert.equal(h.emit('A', 'turn/end', 2).anyActive, false);
    assert.equal(h.retained().open, 0);
    assert.equal(h.retained().active, 0);
  });
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = judge(source);
  for (const problem of problems) console.error('FAIL ' + problem);
  if (process.argv.includes('--self-test')) {
    const mutations = [
      ['cross-session identity', t => t.replace('taskId: task.id, sessionId: sid, title: task.title,', "taskId: 'B#8', sessionId: sid, title: task.title,")],
      ['lose running work', t => t.replace('taskActive = activeTasks.size > 0;', 'taskActive = false;')],
      ['suppress completion', t => t.replace('writeTaskState({ active: false, taskId: task.id', 'writeTaskState({ active: taskActive, taskId: task.id')],
      ['duplicate close', t => t.replace('if (closedTasks.has(key)) return;', 'if (false) return;')],
      ['replacement left active', t => t.replace('if (previous) previous.active = false;', '')],
      ['reset start time', t => t.replace('if (task || closedTasks.has(key)) return;', 'if (false) return;')],
      ['unbounded closed history', t => t.replace('if (closedTasks.size > CLOSED_TASK_LIMIT) closedTasks.delete(closedTasks.values().next().value);', '')],
      ['finished left open', t => t.replace('tasks.delete(key);', '')],
      ['discard replaced pending', t => t.replace('if (previous) previous.active = false;', 'if (previous) { previous.active = false; tasks.delete(JSON.stringify([previous.sessionId, previous.turn])); }')],
      ['late end clears current active', t => t.replace('if (activeTasks.get(sid) === task) activeTasks.delete(sid);', 'activeTasks.delete(sid);')],
      ['cancel left open', t => t.replace("const failed = reasonKind === 'error';", "if (reasonKind === 'aborted') return; const failed = reasonKind === 'error';")],
      ['no reconcile', t => t.replace("prev.active === true || prev.state === 'running' || prev.anyActive === true", 'false')],
      ['reset sequence', t => t.replace('taskSeq = prev.seq;', 'taskSeq = 0;')],
    ];
    for (const [name, mutate] of mutations) {
      const changed = mutate(source);
      if (changed === source || judge(changed).length === 0) {
        const problem = 'ineffective mutant: ' + name;
        problems.push(problem);
        console.error('FAIL ' + problem);
      }
      else console.log('REJECT ' + name);
    }
  }
  if (problems.length) process.exitCode = 1;
  else console.log('PASS production task-state event sequences');
}
