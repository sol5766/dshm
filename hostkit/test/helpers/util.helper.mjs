/**
 * Test-only helpers.
 *
 * Kept out of `src/` on purpose: nothing here may ever be imported by shipping code, because it
 * creates real files under the OS temp directory and binds real sockets.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Create a unique temp directory and register a `node:test` cleanup that removes it.
 * @param {import('node:test').TestContext} t
 * @param {string} [prefix]
 * @returns {string}
 */
export function tempDir(t, prefix = 'hostkit-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
  return dir;
}

/**
 * Collect envelopes from a client tunnel until `predicate` is satisfied (or the timeout fires).
 * @template T
 * @param {import('node:events').EventEmitter} emitter
 * @param {(envelope: object) => T|undefined} predicate
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
export function waitForEnvelope(emitter, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off('envelope', onEnvelope);
      reject(new Error('timed out waiting for envelope'));
    }, timeoutMs);
    const onEnvelope = (envelope) => {
      let result;
      try {
        result = predicate(envelope);
      } catch (error) {
        clearTimeout(timer);
        emitter.off('envelope', onEnvelope);
        reject(error);
        return;
      }
      if (result === undefined) return;
      clearTimeout(timer);
      emitter.off('envelope', onEnvelope);
      resolve(result);
    };
    emitter.on('envelope', onEnvelope);
  });
}

/**
 * Await a single event and return its arguments as an array.
 *
 * Note the event *payload* is intentionally not passed to a predicate here: `WsConnection` emits
 * `message` as `(payload, isBinary)`, and a predicate that happens to return `undefined` would silently
 * never resolve. Callers that need to filter should keep their own listener.
 * @param {import('node:events').EventEmitter} emitter
 * @param {string} event
 * @param {number} [timeoutMs]
 * @returns {Promise<unknown[]>}
 */
export function waitForEvent(emitter, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, onEvent);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    const onEvent = (...args) => {
      clearTimeout(timer);
      emitter.off(event, onEvent);
      resolve(args);
    };
    emitter.on(event, onEvent);
  });
}

/** @param {number} ms @returns {Promise<void>} */
export function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
