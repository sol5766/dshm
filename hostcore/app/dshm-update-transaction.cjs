// Local lifecycle boundary around the official manager, not a replacement manager.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pending = new Set();

function packageName(name) {
  return /^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(name) && name !== '.' && name !== '..';
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

// DSHM writes top-level YAML sequence blocks. Preserve complete target blocks,
// including config/disabled fields; never restore an entire mutable user file.
function blocks(text) {
  return text.match(/^- [\s\S]*?(?=^- |$(?![\s\S]))/gm) || [];
}

function blockKey(block) {
  const id = /^(?:- |  )id:\s*(?:'([^']*)'|"([^"]*)"|([^\s#]+))/m.exec(block);
  const match = id || /^(?:- |  )name:\s*(?:'([^']*)'|"([^"]*)"|([^\s#]+))/m.exec(block);
  return match ? (match[1] || match[2] || match[3]) : '';
}

function captureRows(profile, identities) {
  return ['.dshm-plugin-rows.yml', 'cordis.patch.yml'].map(file => {
    const location = path.join(profile, file);
    const text = fs.existsSync(location) ? fs.readFileSync(location, 'utf8') : '';
    // Reject non-block/anchor/tag forms before any remove. No regex rewriting of
    // legal YAML whose reference graph cannot safely be preserved locally.
    if (/^[ \t]*[^#\n]*[&*][A-Za-z0-9_-]+/m.test(text) ||
      /^(?:\[|\{|---)|^-\s*(?:\{|&|!)/m.test(text)) {
      throw new Error('此配置含YAML引用/flow/tag结构，无法安全局部恢复；更新未开始，旧包保持不变：' + location);
    }
    const sequence = blocks(text);
    return { location, original: sequence, saved: sequence.filter(block => identities.has(blockKey(block))) };
  });
}

function restoreRows(rows, identities) {
  for (const item of rows) {
    const current = fs.existsSync(item.location) ? fs.readFileSync(item.location, 'utf8') : '';
    const all = blocks(current);
    let restored = current;
    for (const block of all) {
      if (identities.has(blockKey(block))) restored = restored.replace(block, '');
    }
    // Reinsert at the original neighbour, not at EOF (preserve ordering).
    for (const block of item.saved) {
      const index = item.original.indexOf(block);
      const currentBlocks = blocks(restored);
      const nextIdentity = item.original.slice(index + 1).map(blockKey).find(key =>
        key && !identities.has(key) && currentBlocks.some(candidate => blockKey(candidate) === key));
      const next = nextIdentity ? currentBlocks.find(candidate => blockKey(candidate) === nextIdentity) : undefined;
      if (next) restored = restored.replace(next, block + next);
      else restored += (restored.endsWith('\n') || !restored ? '' : '\n') + block;
    }
    if (restored !== current) {
      const tmp = item.location + '.restore-' + crypto.randomUUID();
      fs.writeFileSync(tmp, restored);
      fs.renameSync(tmp, item.location);
    }
  }
}

function restoreManifest(profile, before, name) {
  const file = path.join(profile, 'package.json');
  const current = readJson(file);
  for (const field of ['dependencies', 'peerDependencies']) {
    if (before[field] && Object.hasOwn(before[field], name)) {
      current[field] ||= {};
      current[field][name] = before[field][name];
    } else if (current[field]) {
      delete current[field][name];
    }
  }
  const oldBundles = before.dsh?.profile?.bundles;
  if (Array.isArray(oldBundles)) {
    current.dsh ||= {};
    current.dsh.profile ||= {};
    const bundles = Array.isArray(current.dsh.profile.bundles) ? current.dsh.profile.bundles : [];
    const kept = bundles.filter(x => x !== name);
    const at = oldBundles.indexOf(name);
    if (at >= 0) kept.splice(Math.min(at, kept.length), 0, name);
    current.dsh.profile.bundles = kept;
  }
  const tmp = file + '.dshm-restore-' + crypto.randomUUID();
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

async function withUpdateTransaction(profile, name, from, to, operation, lifecycle = {}) {
  if (!packageName(name)) throw new Error('Unsafe update package identity');
  profile = path.resolve(profile);
  const key = profile + '\0' + name;
  if (pending.has(key)) throw new Error('Package update already in progress');
  const dest = path.join(profile, 'node_modules', name);
  if (!fs.existsSync(dest)) return operation();
  const before = readJson(path.join(profile, 'package.json'));
  if (!Object.hasOwn(before.dependencies || {}, name)) return operation();
  const rowIds = typeof lifecycle.rowIds === 'function' ? lifecycle.rowIds() : lifecycle.rowIds;
  const identities = new Set([name, ...(rowIds || [])]);
  const rows = captureRows(profile, identities);
  const restoreConfiguration = async () => {
    restoreManifest(profile, before, name);
    restoreRows(rows, identities);
    const selected = (before.dsh?.profile?.bundles || []).includes(name);
    const runtime = typeof lifecycle.reconcile === 'function'
      ? await lifecycle.reconcile(selected ? [...(rowIds || [])] : [])
      : { restartReason: 'local-package-restored' };
    return lifecycle.hasHmr === false ? { ...runtime, restartReason: 'no-hmr' } : runtime;
  };
  const owned = fs.mkdtempSync(path.join(profile, '.dshm-update-'));
  const backup = path.join(owned, 'package');
  let prepared = false;
  let operationStarted = false;
  let recoveryAttempted = false;
  pending.add(key);
  try {
    fs.cpSync(dest, backup, { recursive: true, dereference: false });
    fs.writeFileSync(path.join(owned, 'transaction.json'), JSON.stringify({
      id: crypto.randomUUID(), profile, name, from, to,
      source: before.dependencies?.[name], state: 'prepared'
    }));
    prepared = true;
    // Official code still performs remove/install/enable and previous-source recovery.
    operationStarted = true;
    const result = await operation();
    // Official refusal is not permission to replace an untouched installation.
    if (result?.step === 'check' || result?.step === 'remove') {
      fs.rmSync(owned, { recursive: true, force: true });
      return result;
    }
    if (result?.result?.application !== 'failed' && result?.result?.application !== 'cancelled') {
      fs.rmSync(owned, { recursive: true, force: true });
      return result;
    }
    if (result.restore && result.restore.application !== 'failed' && result.restore.application !== 'cancelled') {
      const runtime = await restoreConfiguration();
      Object.assign(result.restore, runtime);
      if (runtime.restartReason) result.restore.application = 'restart-required';
      fs.rmSync(owned, { recursive: true, force: true });
      return result;
    }
    // Final recovery is local and cannot lose the first snapshot to a failed enable/remove.
    recoveryAttempted = true;
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // Keep complete backup until both package and configuration have recovered.
    fs.cpSync(backup, dest, { recursive: true, dereference: false });
    const runtime = await restoreConfiguration();
    const notice = runtime.restartReason
      ? '旧包及用户配置已本地恢复；需要重启应用完成恢复' : '旧包、用户配置及运行态已本地恢复';
    result.result.error ||= { code: 'operation-error', diagnostic: '' };
    result.result.error.diagnostic = (result.result.error.diagnostic || '') + '；' + notice;
    result.restore = { changed: true, application: runtime.restartReason ? 'restart-required' : 'applied',
      stage: 'install', target: name, ...runtime };
    result.localRestore = { application: 'restart-required', target: name, diagnostic: notice };
    fs.rmSync(owned, { recursive: true, force: true });
    return result;
  } catch (error) {
    // Preserve evidence/backup if recovery itself cannot safely finish.
    if (!prepared || !operationStarted) {
      // A partial copy is never a recovery source. Original dest was not touched.
      try { fs.rmSync(owned, { recursive: true, force: true }); } catch {}
    } else if (!recoveryAttempted && fs.existsSync(backup)) {
      try {
        fs.rmSync(dest, { recursive: true, force: true });
        fs.cpSync(backup, dest, { recursive: true, dereference: false });
        await restoreConfiguration();
        fs.rmSync(owned, { recursive: true, force: true });
      } catch (restoreError) {
        error.message += '; local restore pending at ' + owned + ': ' + restoreError.message;
      }
    }
    throw error;
  } finally {
    pending.delete(key);
  }
}

module.exports = { withUpdateTransaction };
