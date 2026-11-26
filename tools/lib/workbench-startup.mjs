import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
export const frontendAsset = 'index-BtxxnGTn.js';
export const frontendFile = 'dsh-web-frontend/dist/assets/' + frontendAsset;
export const workbenchHtmlFile = 'dsh-web-frontend/dist/index.html';
const hostFile = 'dsh-client-modules/lib/index.js';

const upstreamHashes = {
  [frontendFile]: '8cd8eaa92c5606b35547a0117ea3414abf91daaa0e56aff7fb93bacf9fb49031',
  [hostFile]: '3ed7af393bfe4cbbd40458fe336462c5b2ebf0bbf78c761470f459297d11df24',
};

function replaceOne(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Review workbench anchor: ' + before.slice(0, 72));
  return source.replace(before, () => after);
}

// Use the version of the patched script to invalidate ArkWeb's cached response.
export function workbenchEntryHtml(source, shell) {
  const script = /src="\.\/assets\/index-BtxxnGTn\.js(?:\?dshm=[0-9a-f]{16})?"/g;
  if ([...source.matchAll(script)].length !== 1) throw new Error('Review the authenticated workbench entry URL');
  return source.replace(script, 'src="./assets/' + frontendAsset + '?dshm=' + digest(shell).slice(0, 16) + '"');
}

// Defer the audited 0.2.3 syntax warmup and demo tokenization. Rendering actual
// content still calls the original initializer and loads the same grammars.
const syntaxStart = 'function CF(){const e=DE({themes:[_F],langs:hF,engine:kF});for(const t of xF)';
const syntaxTimer = 'setTimeout(()=>{mo()},0).unref?.();';
const tabletWorkbench = [
  'const dshmLazyWorkbenchSyntax = globalThis.__DSHM_TABLET_WORKBENCH_STARTUP__ === true',
  '&& window === window.top && location.protocol === "http:" && location.hostname === "127.0.0.1"',
  '&& location.pathname === "/" && document.querySelector(\'meta[name="dshm-workbench-startup"]\')?.content === "1";',
].join(' ');
const syntaxEdits = [
  [syntaxStart, tabletWorkbench + syntaxStart.replace('for(const t of xF)', 'if(!dshmLazyWorkbenchSyntax)for(const t of xF)')],
  [syntaxTimer, 'if(!dshmLazyWorkbenchSyntax)' + syntaxTimer],
];
const comboSourceOriginal = `	const sourceUrl = SOURCE_URL_TRAILER.exec(source)?.[1];
	source = source.replace(SOURCE_URL_TRAILER, "").replace(SOURCE_MAP_TRAILER, "");`;
const comboSourceOptimized = String.raw`	let sourceUrl;
	const bundledMap = "\n//# sourceMappingURL=client.js.map";
	if (source.endsWith(bundledMap)) {
		const end = source.length - bundledMap.length;
		source = source.slice(0, source.charCodeAt(end - 1) === 13 ? end - 1 : end);
	} else {
		sourceUrl = SOURCE_URL_TRAILER.exec(source)?.[1];
		source = source.replace(SOURCE_URL_TRAILER, "").replace(SOURCE_MAP_TRAILER, "");
	}`;

export function workbenchSource(file, source, installed = true) {
  if (!Object.hasOwn(upstreamHashes, file)) throw new Error('Unknown workbench source: ' + file);
  const edits = file === frontendFile ? syntaxEdits : [[comboSourceOriginal, comboSourceOptimized]];
  let original = source;
  if (digest(original) !== upstreamHashes[file]) {
    for (const [before, after] of edits.toReversed()) original = replaceOne(original, after, before);
  }
  if (digest(original) !== upstreamHashes[file]) throw new Error('Review upstream workbench source: ' + file);
  let patched = original;
  for (const [before, after] of edits) patched = replaceOne(patched, before, after);
  if (source !== original && source !== patched) throw new Error('Incomplete workbench patch: ' + file);
  return installed ? patched : original;
}

export function patchWorkbenchStartup(stage) {
  const root = join(stage, 'node_modules', '@deepseek-ai');
  const targets = [hostFile, frontendFile].map(relative => {
    const file = join(root, relative);
    const before = readFileSync(file, 'utf8');
    return { file, before, after: workbenchSource(relative, before) };
  });
  const html = join(root, workbenchHtmlFile);
  const before = readFileSync(html, 'utf8');
  targets.push({ file: html, before, after: workbenchEntryHtml(before, targets[1].after) });
  for (const patch of targets) {
    if (patch.before === patch.after) continue;
    const temporary = patch.file + '.dshm-' + process.pid + '.tmp';
    writeFileSync(temporary, patch.after);
    renameSync(temporary, patch.file);
  }
}
