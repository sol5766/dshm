// One profile writer envelope, reentrant only with the current unguessable token.
// Queue workers carry the token explicitly; unrelated uninstall requests wait FIFO.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
const tails = new Map();
const active = new Map();

function currentToken(profile) {
  const item = context.getStore();
  return item?.profile === path.resolve(profile) ? item.token : '';
}

async function withProfileWriter(profile, operation, supplied = '') {
  profile = path.resolve(profile);
  const token = supplied || currentToken(profile);
  if (token && active.get(profile) === token) return operation();
  if (supplied && active.get(profile) !== supplied) throw new Error('Profile writer ownership expired');
  const previous = tails.get(profile) || Promise.resolve();
  let release;
  const tail = new Promise(resolve => { release = resolve; });
  tails.set(profile, tail);
  await previous;
  const lock = path.join(profile, '.dshm-writer-lock');
  let owns = false;
  let failure;
  try {
    // Never steal a stale/foreign lock: failed/crashed owners require explicit recovery.
    // This protects independent CLI processes as well as this process's FIFO.
    fs.mkdirSync(lock);
    owns = true;
    const identity = crypto.randomUUID();
    active.set(profile, identity);
    return await context.run({ profile, token: identity }, operation);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      if (owns) {
        active.delete(profile);
        fs.rmdirSync(lock);
      }
    } catch (cleanupError) {
      if (failure) failure.message += '; writer lock cleanup failed: ' + cleanupError.message;
      else throw cleanupError;
    } finally {
      release();
      if (tails.get(profile) === tail) tails.delete(profile);
    }
  }
}

function assertQueueOwnership(profile, token) {
  const owner = active.get(path.resolve(profile));
  if (owner && owner !== token) throw new Error('Profile update in progress; uninstall/install was not applied, retry after it finishes');
}

module.exports = { withProfileWriter, currentToken, assertQueueOwnership };
