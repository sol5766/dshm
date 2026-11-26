import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const upstreamCall = 'this.files.observe(this.profileModules(profileRoots(profile.dir)));';
const candidateCall = `const dshmObserveStamp = globalThis.__dshmHmrObserveStartupStage;
						dshmObserveStamp?.("BOOT_49_HMR_OBSERVE_START");
						const dshmInitialUrls = this.dshmInitialProfileModules(profileRoots(profile.dir));
						dshmObserveStamp?.("BOOT_49_HMR_OBSERVE_ENUMERATED");
						this.files.observe(dshmInitialUrls);
						dshmObserveStamp?.("BOOT_49_HMR_OBSERVE_END");`;
const methodAnchor = '\t\tprofileModules(roots) {';

// On POSIX this restricted spelling is already its own decoded, normalized
// pathname. Other spellings retain Node's conversion and any validation errors.
function dshmDefinitelyOutsideRoots(filename, roots) {
  if (!filename.startsWith('/') || /[^A-Za-z0-9_@+.\/-]/.test(filename) ||
      filename.includes('//') || /\/\.{1,2}(?:\/|$)/.test(filename)) return false;
  return !roots.some(root => filename.startsWith(root));
}

const candidateMethod = `		dshmInitialProfileModules(roots) {
			if (sep !== "/" || process.env.DSHM_HMR_OBSERVE_FAST !== "1") return this.profileModules(roots);
			const urls = this.esmUrls();
			for (const filename of Object.keys(commonJsCache())) {
				if (!dshmDefinitelyOutsideRoots(filename, roots)) urls.push(pathToFileURL(filename).href);
			}
			return urls.filter((url) => {
				if (!url.startsWith("file:")) return false;
				if (url.startsWith("file:///") && dshmDefinitelyOutsideRoots(url.slice(7), roots)) return false;
				const filename = fileURLToPath(url);
				return roots.some((root) => filename.startsWith(root));
			});
		}
`;
const helperAnchor = 'function commonJsCache() {';
const candidateHelper = dshmDefinitelyOutsideRoots.toString() + '\n';
const edits = [[upstreamCall, candidateCall], [methodAnchor, candidateMethod + methodAnchor],
  [helperAnchor, candidateHelper + helperAnchor]];

// Reconciliation enumerates the live cache afresh for each step. Share only
// the predicate with the initial observation, never its root set or URL list.
const initialGuard = 'if (sep !== "/" || process.env.DSHM_HMR_OBSERVE_FAST !== "1") return this.profileModules(roots);';
const sharedMethod = candidateMethod.replace(initialGuard, `return this.dshmFilteredProfileModules(roots, process.env.DSHM_HMR_OBSERVE_FAST);
		}
		dshmReconcileProfileModules(roots) {
			return this.dshmFilteredProfileModules(roots, process.env.DSHM_HMR_RECONCILE_FAST);
		}
		dshmFilteredProfileModules(roots, enabled) {
			if (sep !== "/" || enabled !== "1") return this.profileModules(roots);`);
const reconcileEdits = [[candidateMethod, sharedMethod], ...[
  'const urls = this.profileModules(dropped).filter((url) => {',
  '...this.files.compare(this.profileModules(roots))',
  'this.evict(this.profileModules(roots).filter((url) => {',
  'const urls = this.profileModules(recorded.roots);',
].map(call => [call, call.replace('this.profileModules', 'this.dshmReconcileProfileModules')])];

const upstream = [
  ['\t\tesmUrls() {', '\n\t\t/** The module job of the process entry point', 'af61d94c7af854f47b61755ecda9e408dd429fbf822de76deb5c2972dbc938ac'],
  [methodAnchor, '\n\t\t/** Static import edges', '66affde166ad97832b4c79c5ae4f88fe3da97f81e625b7f135259e80cbda7443'],
  [helperAnchor, '\n/** Every module job', '19196c94897ff95d6514b47074ec498e24042e7f8f5d4a9224f379da25d1d532'],
];

function replaceOnce(source, from, to) {
  if (source.split(from).length !== 2) throw new Error('Review HMR startup observation anchor: ' + from.slice(0, 65));
  return source.replace(from, () => to);
}

export function hmrObserveStartupSource(source, enabled = true) {
  let clean = source;
  if (clean.includes('dshmReconcileProfileModules') || clean.includes('dshmFilteredProfileModules')) {
    for (const [original, patched] of reconcileEdits) clean = replaceOnce(clean, patched, original);
  }
  if (clean.includes('dshmInitialProfileModules') || clean.includes('dshmDefinitelyOutsideRoots')) {
    for (const [original, patched] of edits) clean = replaceOnce(clean, patched, original);
  }
  for (const [begin, end, digest] of upstream) {
    const start = clean.indexOf(begin);
    const stop = clean.indexOf(end, start);
    if (start < 0 || stop < 0 || clean.indexOf(begin, start + begin.length) >= 0 ||
        createHash('sha256').update(clean.slice(start, stop)).digest('hex') !== digest) {
      throw new Error('Review HMR startup observation source: ' + begin.trim());
    }
  }
  if (clean.split(upstreamCall).length !== 2) throw new Error('Review HMR initial module observation call');
  const legacy = edits.reduce((text, [from, to]) => replaceOnce(text, from, to), clean);
  const candidate = reconcileEdits.reduce((text, [from, to]) => replaceOnce(text, from, to), legacy);
  return enabled ? candidate : clean;
}

export function patchHmrObserveStartup(stage, enabled = true) {
  const file = join(stage, 'node_modules', '@deepseek-ai', 'dsh-hmr', 'lib', 'index.js');
  const source = readFileSync(file, 'utf8');
  const next = hmrObserveStartupSource(source, enabled);
  if (source === next) return;
  const temporary = file + '.dshm-' + process.pid + '.tmp';
  writeFileSync(temporary, next);
  renameSync(temporary, file);
}
