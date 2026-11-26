import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const collect = 'function collectInstallationScopePackages(installAnchor, skippedBundles) {';
const boundary = 'async function createRuntimeResolution(options) {';
const carrier = 'return isPackagedExecutable() ? realpathSync(path) : realpathSync.native(path);';
const original = 'const manifestPath = join(realModuleDirectory(dir), "package.json");';
const optimized = 'const manifestPath = join(canonicalInstallationDir(dir), "package.json");';
const helper = `
	// DSHM sets process.pkg for the proxy layout, but its installed core uses real files.
	const core = process.env.DSHM_CORE_DIR;
	const physical = process.env.DSHM_PLATFORM === "ohos" && isPackagedExecutable() && process.pkg
		&& !process.pkg.entrypoint && typeof realpathSync.native === "function" && core
		&& installAnchor === join(core, "node_modules", "@deepseek-ai", "dsh", "package.json");
	const corePrefix = physical ? core + sep : "";
	function canonicalInstallationDir(dir) {
		if (physical && dir.startsWith(corePrefix)) {
			try {
				if (realpathSync.native(dir) === dir) return dir;
			} catch { /* Use the carrier's original resolution and error handling. */ }
		}
		return realModuleDirectory(dir);
	}`;

const compileEdits = [
  [
    'function prefixes(path) {\n\tconst configured = resolve(path) + sep;\n\tconst canonical = canonicalPath(path) + sep;',
    'function prefixes(path, realDir) {\n\tconst configured = resolve(path) + sep;\n\tconst canonical = (realDir ?? canonicalPath(path)) + sep;'
  ],
  [
    'function compileResolution(resolution) {\n\treturn {\n\t\tentries: new Map(resolution.entries.map((entry) => [entry.name, {\n\t\t\t...entry,\n\t\t\trealDir: canonicalPath(entry.packageDir)\n\t\t}])),',
    'function compileResolution(resolution) {\n\tconst compiledEntries = resolution.entries.map((entry) => ({ ...entry, realDir: canonicalPath(entry.packageDir) }));\n\treturn {\n\t\tentries: new Map(compiledEntries.map((entry) => [entry.name, entry])),'
  ],
  [
    'new Set(resolution.entries.filter((entry) => entry.scope === "installation").flatMap((entry) => prefixes(entry.packageDir)))',
    'new Set(compiledEntries.filter((entry) => entry.scope === "installation").flatMap((entry) => prefixes(entry.packageDir, entry.realDir)))'
  ]
];

function compileSource(source, revert) {
  const before = compileEdits.every(([a, b]) => source.split(a).length === 2 && !source.includes(b));
  const after = compileEdits.every(([a, b]) => source.split(b).length === 2 && !source.includes(a));
  if (!before && !after) throw new Error('Unexpected dsh-app-boot resolution compiler');
  if (revert ? before : after) return source;
  for (const [a, b] of compileEdits) source = revert ? source.replace(b, a) : source.replace(a, b);
  return source;
}

function optimizeDirectories(input) {
  const source = compileSource(input, false);
  const start = source.indexOf(collect);
  const end = source.indexOf(boundary, start);
  if (start < 0 || end < 0 || source.lastIndexOf(collect) !== start || !source.includes(carrier)) {
    throw new Error('dsh-app-boot installation scope or carrier changed');
  }
  const block = source.slice(start, end);
  if (block.includes('canonicalInstallationDir')) {
    if (block.startsWith(collect + helper) && block.split(optimized).length === 2 && !block.includes(original)) return source;
    throw new Error('Incomplete installation directory optimization');
  }
  if (block.split(original).length !== 2) throw new Error('Installation manifest canonicalization changed');
  const patched = block.replace(collect, collect + helper).replace(original, optimized);
  return source.slice(0, start) + patched + source.slice(end);
}

const lookup = `function packageDirFromAnchor(anchor, packageName) {
	/* v8 ignore next */
	for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
		const candidate = join(searchPath, packageName);
		if (existsSync(join(candidate, "package.json"))) return candidate;
	}
}`;
const directLookup = String.raw`function packageDirFromAnchor(anchor, packageName, dshmFastManifestPaths = false) {
	const plainName = dshmFastManifestPaths && /^(?:@[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)?[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(packageName);
	for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
		// On POSIX concatenation is identical to both joins for these already normalized inputs.
		// Probe every directory in Node's order on each traversal, including negative lookups.
		if (plainName && typeof searchPath === "string" && searchPath.startsWith("/") &&
			!searchPath.endsWith("/") && !/\/\.{0,2}(?:\/|$)/.test(searchPath)) {
			const candidate = searchPath + "/" + packageName;
			if (existsSync(candidate + "/package.json")) return candidate;
			continue;
		}
		const candidate = join(searchPath, packageName);
		if (existsSync(join(candidate, "package.json"))) return candidate;
	}
}`;
const corePrefix = 'const corePrefix = physical ? core + sep : "";';
const oldCall = 'if (links.has(dep)) continue;\n\t\tconst dir = packageDirFromAnchor(next.anchor, dep);';
const pathEdits = [
  [lookup, directLookup],
  [corePrefix, corePrefix + '\n\tconst dshmFastManifestPaths = physical && sep === "/" && process.env.DSHM_INSTALLATION_MANIFEST_PATH_FAST === "1";'],
  [oldCall, oldCall.replace('next.anchor, dep)', 'next.anchor, dep, dshmFastManifestPaths)')],
];

function manifestPathSource(source, enable) {
  if (!enable && !source.includes('dshmFastManifestPaths')) return source;
  for (const [before, after] of pathEdits) {
    const from = enable ? before : after;
    if (source.split(from).length !== 2) throw new Error('Review installation manifest lookup: ' + from.slice(0, 55));
    source = source.replace(from, () => enable ? after : before);
  }
  return source;
}

const rowCache = 'const dshmVerifiedInstallationRows = new WeakSet();';
const fastPaths = corePrefix + '\n\tconst dshmFastManifestPaths = physical && sep === "/" && process.env.DSHM_INSTALLATION_MANIFEST_PATH_FAST === "1";';
const verifiedDir = 'if (realpathSync.native(dir) === dir) return dir;';
const queueLoop = `\tfor (let next = queue.shift(); next !== void 0; next = queue.shift())
 /* v8 ignore next -- a real app manifest always declares dependencies */
\tfor (const dep of profileDependencyNames(next.manifest)) {
\t\tif (links.has(dep)) continue;
\t\tconst dir = packageDirFromAnchor(next.anchor, dep, dshmFastManifestPaths);`;
const queued = '\t\t\tmanifest\n\t\t});\n\t}\n\treturn {\n\t\tpackageNames: new Set(links.keys()),';
const installationRows = `entries: Object.freeze([...[...packageDirs].map(([name, packageDir]) => Object.freeze({
\t\t\tname,
\t\t\tpackageDir,
\t\t\tversion: versions.get(name),
\t\t\tdeclarer: declarers.get(name),
\t\t\tscope: "installation"
\t\t})),`;
const scopeReuseEdits = [
  [collect, rowCache + '\n' + collect],
  [fastPaths, fastPaths + `
\tconst installationSearchDirs = new Map();
\tconst verifiedInstallDirs = new Set();
\tfunction installationSearchDirExists(directory) {
\t\tif (!directory.startsWith(corePrefix)) return true;
\t\tlet present = installationSearchDirs.get(directory);
\t\tif (present === void 0) {
\t\t\tpresent = existsSync(directory);
\t\t\tinstallationSearchDirs.set(directory, present);
\t\t}
\t\treturn present;
\t}`],
  [verifiedDir, `if (realpathSync.native(dir) === dir) {
\t\t\t\t\tif (dshmFastManifestPaths) verifiedInstallDirs.add(dir);
\t\t\t\t\treturn dir;
\t\t\t\t}`],
  [queueLoop, String.raw`\tfor (let next = queue.shift(); next !== void 0; next = queue.shift()) {
\t\tlet searchPaths;
\t\tfor (const dep of profileDependencyNames(next.manifest)) {
\t\t\tif (links.has(dep)) continue;
\t\t\tconst plain = dshmFastManifestPaths && /^(?:@[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)?[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(dep) && !isBuiltin(dep);
\t\t\tif (plain && searchPaths === void 0) {
\t\t\t\tsearchPaths = (createRequire(next.anchor).resolve.paths(dep) ?? []).filter(installationSearchDirExists);
\t\t\t}
\t\t\tconst dir = packageDirFromAnchor(next.anchor, dep, dshmFastManifestPaths, plain ? searchPaths : void 0);`.replaceAll('\\t', '\t')],
  [queued, queued.replace('\n\treturn {', '\n\t}\n\treturn {')],
  ['\t\tdeclarers,\n\t\tversions\n\t};', '\t\tdeclarers,\n\t\tversions,\n\t\tverifiedInstallDirs\n\t};'],
  ['const { packageNames, packageDirs, declarers, versions } = collectInstallationScopePackages',
   'const { packageNames, packageDirs, declarers, versions, verifiedInstallDirs } = collectInstallationScopePackages'],
  [installationRows, `entries: Object.freeze([...[...packageDirs].map(([name, packageDir]) => {
\t\t\tconst entry = Object.freeze({
\t\t\t\tname, packageDir, version: versions.get(name),
\t\t\t\tdeclarer: declarers.get(name), scope: "installation"
\t\t\t});
\t\t\tif (verifiedInstallDirs.has(packageDir)) dshmVerifiedInstallationRows.add(entry);
\t\t\treturn entry;
\t\t}),`],
  ['function packageDirFromAnchor(anchor, packageName, dshmFastManifestPaths = false) {',
   'function packageDirFromAnchor(anchor, packageName, dshmFastManifestPaths = false, searchPaths) {'],
  ['for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {',
   'for (const searchPath of searchPaths ?? createRequire(anchor).resolve.paths(packageName) ?? []) {'],
  ['realDir: canonicalPath(entry.packageDir)',
   'realDir: dshmVerifiedInstallationRows.has(entry) ? entry.packageDir : canonicalPath(entry.packageDir)']
];

// Reuse only the resolution computed during the synchronous installation walk.
// The lookup still reads every candidate package in Node's search order and
// recomposition gets a fresh table. Profile and worker entries fall back.
function installationScopeReuse(source, enabled) {
  const installed = source.includes(rowCache);
  if (!installed && !enabled) return source;
  for (const [before, after] of installed ? scopeReuseEdits.toReversed() : scopeReuseEdits) {
    const anchor = installed ? after : before;
    if (source.split(anchor).length !== 2) throw new Error('Review installation scope reuse: ' + anchor.slice(0, 60));
    if (installed !== enabled) source = source.replace(anchor, () => enabled ? after : before);
  }
  return source;
}

export function optimizeInstallationScope(input, manifestPaths = true) {
  const directories = optimizeDirectories(manifestPathSource(installationScopeReuse(input, false), false));
  return manifestPaths ? installationScopeReuse(manifestPathSource(directories, true), true) : directories;
}

// Reconstruct the upstream arm for the device-independent comparison gate.
export function originalInstallationScope(source) {
  const previous = manifestPathSource(installationScopeReuse(source, false), false);
  const before = compileSource(previous, true).replace(collect + helper, collect).replace(optimized, original);
  if (previous !== before && optimizeDirectories(before) !== previous) throw new Error('Incomplete runtime scope patch');
  return before;
}

function skipEmptyEsmRelocation(source) {
  const original = 'const relocate = (result, parent) => {\n\t\t\tif (!result.url.startsWith("file:")) return result;';
  // Check the live table for each result. HMR may add or remove moves after startup.
  const optimized = original.replace('if (!result.url', 'if (router.moved.targets.size === 0 || !result.url');
  if (!source.includes('moved = new MovedDirectories();') ||
      !source.includes('targets = /* @__PURE__ */ new Map();')) {
    throw new Error('Review dsh-app-boot ESM relocation table');
  }
  if (source.split(optimized).length === 2 && !source.includes(original)) return source;
  if (source.split(original).length !== 2 || source.includes(optimized)) {
    throw new Error('Review dsh-app-boot ESM relocation anchor');
  }
  return source.replace(original, optimized);
}

export function patchRuntimeScopeStartup(coreDir) {
  const file = join(coreDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
  const source = readFileSync(file, 'utf8');
  const patched = skipEmptyEsmRelocation(optimizeInstallationScope(source));
  if (source !== patched) {
    const tmp = file + '.dshm-' + process.pid + '.tmp';
    writeFileSync(tmp, patched);
    renameSync(tmp, file);
  }
}
