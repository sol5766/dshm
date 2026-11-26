'use strict';

function create({ onError = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, companionFor } = {}) {
  const tasks = new Map();
  let ready = false;
  let idle = false;
  let stopped = false;
  let running = false;
  let pending = false;
  let timer = null;
  let quietTimer = null;

  function begin() {
    if (timer !== null) clearTimer(timer);
    if (quietTimer !== null) clearTimer(quietTimer);
    timer = null;
    quietTimer = null;
    if (stopped) return;
    idle = true;
    void drain();
  }

  async function runCompanion(task) {
    if (stopped || !idle || task.done) return;
    try {
      if (!task.available()) return;
      task.done = true;
      await task.run();
    } catch (error) {
      task.done = true;
      try { onError(error); } catch (_) {}
    }
  }

  async function drain() {
    if (!ready || !idle || stopped) return;
    if (running) { pending = true; return; }
    running = true;
    try {
      for (const [key, task] of tasks) {
        if (stopped || !idle) break;
        if (task.done) continue;
        try {
          if (!task.available()) continue;
          task.done = true;
          const companion = companionFor && tasks.get(companionFor(key));
          const concurrent = companion && runCompanion(companion);
          try {
            await task.run();
          } finally {
            if (concurrent) await concurrent;
          }
        } catch (error) {
          task.done = true;
          try { onError(error); } catch (_) {}
        }
      }
    } finally {
      running = false;
      if (pending) {
        pending = false;
        void drain();
      }
    }
  }

  return {
    get stopped() { return stopped; },
    discard(key) {
      const task = tasks.get(key);
      if (task) task.done = true;
    },
    activity() {
      if (!ready || stopped) return;
      idle = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
      if (quietTimer !== null) clearTimer(quietTimer);
      quietTimer = setTimer(begin, 1000);
      if (quietTimer && typeof quietTimer.unref === 'function') quietTimer.unref();
    },
    request(key, run, available = () => true) {
      if (stopped) return;
      if (!tasks.has(key)) tasks.set(key, { run, available, done: false });
      void drain();
    },
    markReady() {
      if (ready || stopped) return;
      ready = true;
      timer = setTimer(begin, 3000);
      if (timer && typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      if (quietTimer !== null) clearTimer(quietTimer);
      timer = null;
      quietTimer = null;
    },
  };
}

module.exports = { create };
