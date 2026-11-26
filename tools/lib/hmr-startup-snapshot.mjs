import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function replaceOnce(source, from, to) {
  if (source.split(from).length !== 2) {
    throw new Error('Review startup HMR snapshot anchor: ' + from.trim().slice(0, 75));
  }
  return source.replace(from, () => to);
}

const appEdits = [
  ['function readProfileManifest(binName, dir) {', 'function readProfileManifest(binName, dir, capture) {'],
  ["\treturn parsed;\n}\n/**\n* Write a profile's manifest",
    "\tcapture?.(raw);\n\treturn parsed;\n}\n/**\n* Write a profile's manifest"],
  ['function loadOverlayPatches(binName, file) {', 'function loadOverlayPatches(binName, file, capture) {'],
  ['\treturn parsePatchList(binName, file, content, "overlay");',
    '\tconst patches = parsePatchList(binName, file, content, "overlay");\n\tcapture?.(content);\n\treturn patches;'],
  ['function loadOptionalPatches(binName, file) {', 'function loadOptionalPatches(binName, file, capture) {'],
  ['\treturn parsePatchList(binName, file, content, "patches");',
    '\tconst patches = parsePatchList(binName, file, content, "patches");\n\tcapture?.(content);\n\treturn patches;'],
  ['\tconst bundles = dropRetiredBundles(dir, readProfileManifest(binName, dir)).dsh?.profile?.bundles ?? [];', [
    '\t// DSHM_HMR_STARTUP_SNAPSHOT: keep the exact inputs used by the first composition.',
    '\tconst snapshot = options.userLayer !== false && process.env.DSHM_WORKBENCH_STARTUP === "1"',
    '\t\t&& process.env.DSHM_HMR_STARTUP_SNAPSHOT !== "0" && basename(dir) === "ondevice"',
    '\t\t? { manifest: undefined, profilePatch: null } : undefined;',
    '\tconst captureManifest = snapshot && ((text) => { snapshot.manifest = text; });',
    '\tconst bundles = dropRetiredBundles(dir, readProfileManifest(binName, dir, captureManifest)).dsh?.profile?.bundles ?? [];',
  ].join('\n')],
  ['\tconst patches = options.userLayer !== false && existsSync(patchPath) ? loadOverlayPatches(binName, patchPath) : [];',
    '\tconst capturePatch = snapshot && ((text) => { snapshot.profilePatch = text; });\n'
      + '\tconst patches = options.userLayer !== false && existsSync(patchPath)\n'
      + '\t\t? loadOverlayPatches(binName, patchPath, capturePatch) : [];'],
  ['\t\tpatches,\n\t\tskippedBundles\n\t};', '\t\tpatches,\n\t\tskippedBundles,\n\t\tdshmStartupSnapshot: snapshot\n\t};'],
  ['function readProfilePatches(binName, context, initialProfile) {',
    'function readProfilePatches(binName, context, initialProfile) {\n'
    + '\tconst snapshot = context.overlayPaths.length === 0 ? initialProfile?.dshmStartupSnapshot : undefined;\n'
    + '\tlet homePatch = null;\n'
    + '\tconst captureHomePatch = snapshot && ((text) => { homePatch = text; });'],
  ['...loadOptionalPatches(binName, join(context.home, "cordis.patch.yml")) ?? [],',
    '...loadOptionalPatches(binName, join(context.home, "cordis.patch.yml"), captureHomePatch) ?? [],'],
  ['\tif (telemetryPatch !== void 0) patches.push(telemetryPatch);\n\treturn patches;',
    '\tif (telemetryPatch !== void 0) patches.push(telemetryPatch);\n'
    + '\tif (snapshot) context.dshmStartupSnapshot = { ...snapshot, homePatch };\n\treturn patches;'],
];

function canReuseStartupConfig(snapshot, manifest, patchTexts, bundles, startedBundles, profileDir, resolution) {
  const core = process.env.DSHM_CORE_DIR;
  return snapshot !== undefined && typeof snapshot.manifest === 'string' &&
    snapshot.manifest === manifest && snapshot.profilePatch === patchTexts[0] &&
    snapshot.homePatch === patchTexts[1] && bundles === startedBundles &&
    typeof core === 'string' && core.startsWith('/') && !core.endsWith('/') &&
    resolution?.localPackageNames?.length === 0 && resolution.linkedRoots?.length === 0 &&
    !existsSync(join(profileDir, 'node_modules')) && !existsSync(join(dirname(profileDir), 'node_modules')) &&
    resolution.entries?.length > 0 && resolution.entries.every(row =>
      row.scope === 'installation' && row.packageDir?.startsWith(core + '/'));
}

const hmrEdits = [
  ['const registrations = /* @__PURE__ */ new WeakMap();',
    'const registrations = /* @__PURE__ */ new WeakMap();\n' + canReuseStartupConfig.toString()],
  ['async function watchConfig(ctx, filename, options, refresh, inTransaction = () => false) {',
    'async function watchConfig(ctx, filename, options, refresh, inTransaction = () => false, trackInitial = false) {'],
  ['\tconst state = { dirty: false };',
    '\tconst state = { dirty: false, initialOnly: true };\n\tlet pending = true;'],
  ['\tconst onChange = (path) => {', '\tconst onChange = (path, firstScan) => {'],
  ['\t\tstate.dirty = true;\n\t\tif (running) return;',
    '\t\tstate.dirty = true;\n\t\tstate.initialOnly &&= firstScan === true;\n\t\tif (running) return;'],
  ['\t\t\t\t\tawait refresh();', [
    '\t\t\t\t\tconst initialOnly = state.initialOnly;',
    '\t\t\t\t\tstate.initialOnly = true;',
    '\t\t\t\t\tif (trackInitial) await refresh(initialOnly);',
    '\t\t\t\t\telse await refresh();',
  ].join('\n')],
  ['\twatcher.on("add", onChange);', '\twatcher.on("add", (path) => onChange(path, pending));'],
  ['\tconst ready = Promise.withResolvers();\n\tlet pending = true;\n\tlet disposed = false;',
    '\tconst ready = Promise.withResolvers();\n\tlet disposed = false;'],
  ['\t\tasync watchConfig(filename, refresh) {', '\t\tasync watchConfig(filename, refresh, trackInitial = false) {'],
  ['this.config, () => this.runReload(refresh), () => this.executing.getStore() === true));',
    'this.config, (initial) => this.runReload(() => trackInitial ? refresh(initial) : refresh()),\n'
    + '\t\t\t\t\t() => this.executing.getStore() === true, trackInitial));'],
  ['\t\t\t\tconst refresh = async (manifestOnly) => {\n\t\t\t\t\tconst bundles = JSON.stringify(readProfileManifest("dsh", profile.dir).dsh?.profile?.bundles ?? []);',
    '\t\t\t\tlet startupSnapshot = profile.dshmStartupSnapshot;\n'
    + '\t\t\t\tconst refresh = async (manifestOnly, initial) => {\n'
    + '\t\t\t\t\tconst snapshot = initial ? startupSnapshot : undefined;\n'
    + '\t\t\t\t\tlet manifestText;\n'
    + '\t\t\t\t\tconst captureManifest = snapshot && ((text) => { manifestText = text; });\n'
    + '\t\t\t\t\tconst bundles = JSON.stringify(readProfileManifest("dsh", profile.dir, captureManifest).dsh?.profile?.bundles ?? []);'],
  ['\t\t\t\t\tconst inputs = JSON.stringify([bundles, ...patchFiles.map((filename) => {',
    '\t\t\t\t\tconst patchTexts = patchFiles.map((filename) => {'],
  ['\t\t\t\t\t})]);\n\t\t\t\t\tif (inputs === lastInputs) return;', [
    '\t\t\t\t\t});',
    '\t\t\t\t\tconst inputs = JSON.stringify([bundles, ...patchTexts]);',
    '\t\t\t\t\tif (inputs === lastInputs) return;',
    '\t\t\t\t\tif (snapshot && canReuseStartupConfig(snapshot, manifestText, patchTexts, bundles, lastBundles,',
    '\t\t\t\t\t\tprofile.dir, this.ownerContext.get("pluginPackages")?.resolution)) return;',
    '\t\t\t\t\tstartupSnapshot = undefined;',
  ].join('\n')],
  ['await this.watchConfig(filename, () => refresh(false));',
    'await this.watchConfig(filename, (initial) => refresh(false, initial), true);'],
  ['await this.watchConfig(manifestPath, () => refresh(true));',
    'await this.watchConfig(manifestPath, (initial) => refresh(true, initial), true);'],
];

export function startupSnapshotSource(source, kind, enabled = true) {
  const edits = kind === 'app' ? appEdits : hmrEdits;
  const marker = kind === 'app' ? 'DSHM_HMR_STARTUP_SNAPSHOT' : 'function canReuseStartupConfig(';
  let upstream = source;
  if (source.includes(marker)) {
    for (const [from, to] of edits.slice().reverse()) upstream = replaceOnce(upstream, to, from);
  }
  const patched = edits.reduce((text, [from, to]) => replaceOnce(text, from, to), upstream);
  return enabled ? patched : upstream;
}

export function patchHmrStartupSnapshot(stage) {
  for (const [kind, name] of [['app', 'dsh-app-boot'], ['hmr', 'dsh-hmr']]) {
    const file = join(stage, 'node_modules', '@deepseek-ai', name, 'lib', 'index.js');
    const original = readFileSync(file, 'utf8');
    const patched = startupSnapshotSource(original, kind);
    if (original === patched) continue;
    const temp = file + '.dshm-' + process.pid + '.tmp';
    writeFileSync(temp, patched);
    renameSync(temp, file);
  }
}
