// Canonical, idempotent lifecycle patch. Public install stays synchronous so the
// official control map is registered before any FIFO wait in change().
export function patchManagerLifecycle(input) {
  if (input.includes('DSHM_LIFECYCLE_CANONICAL_V2')) return input;
  let text = input;
  // Remove previous generated public writer envelopes, leaving official bodies.
  text = text.replace(/(async )?(updateBundle|installBundle|removeBundle|setBundleEnabled|setPluginEnabled)\(([^)]*)\) \{\s*\/\* DSHM_PROFILE_WRITER:[^*]*\*\/[\s\S]*?\n\s*\}\s*(async )?dshmWriter_\2\(\3\) \{/g,
    (_all, asyncPrefix, name, args) => `${asyncPrefix || ''}${name}(${args}) {`);
  text = text.replace(/async updateBundle\(name, version, options\) \{\s*\/\* DSHM_UPDATE_TRANSACTION:[\s\S]*?async dshmUpdateBundleInner\(name, version, options\) \{/,
    'async updateBundle(name, version, options) {');
  text = text.replace(/async change\(operation, request, reason, identity\) \{\s*\/\* DSHM_WRITER_CHANGE \*\/[\s\S]*?async dshmChangeInner\(operation, request, reason, identity\) \{/,
    'async change(operation, request, reason, identity) {');
  const update = 'async updateBundle(name, version, options) {';
  const change = 'async change(operation, request, reason, identity) {';
  if (!text.includes(update) || !text.includes(change)) throw new Error('manager lifecycle anchors missing');
  text = text.replace(update, `${update}
      /* DSHM_LIFECYCLE_CANONICAL_V2 */
      /* DSHM_PROFILE_WRITER:updateBundle */
      const transaction = () => {
        const run = () => this.dshmUpdateBundleInner(name, version, options);
        return typeof globalThis.__dshmUpdateTransaction === "function"
          ? globalThis.__dshmUpdateTransaction(this.profile.dir, name, "installed", version, run, {
            /* DSHM_LOCAL_RECONCILE */
            hasHmr: this.ownerContext.get("hmr") !== void 0,
            rowIds: () => { try { return this.bundleRows(name).map(row => row.id); } catch { return []; } },
            reconcile: ids => this.configure(() => this.publishAndReload(ids))
          }) : run();
      };
      return typeof globalThis.__dshmProfileWriter === "function"
        ? globalThis.__dshmProfileWriter(this.profile.dir, transaction) : transaction();
    }
    async dshmUpdateBundleInner(name, version, options) {`);
  // Cancellation control remains owned by the official installBundle. Do not
  // enter its operation after the official AbortController was cancelled.
  text = text.replace(change, `${change}
      /* DSHM_WRITER_CHANGE */
      const run = () => this.dshmChangeInner(operation, request, reason, identity);
      return typeof globalThis.__dshmProfileWriter === "function"
        ? globalThis.__dshmProfileWriter(this.profile.dir, run) : run();
    }
    async dshmChangeInner(operation, request, reason, identity) {`);
  return text;
}
