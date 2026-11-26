import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const originalSpecialProperty = `const RESERVED_WORDS = ["prototype", "then"];
function isSpecialProperty(prop) {
	return typeof prop === "symbol" || RESERVED_WORDS.includes(prop) || parseInt(prop).toString() === prop || prop.startsWith("_");
}`;
const fastSpecialProperty = `const defaultEventResolve = EventsService.prototype._resolve;
const defaultEventWaterfall = EventsService.prototype.waterfall;
function isSpecialProperty(prop) {
	if (typeof prop === "symbol" || prop === "then" || prop === "prototype" || prop === "NaN") return true;
	const first = prop.charCodeAt(0);
	// Ordinary names cannot be the canonical spelling of an integer.
	return first === 95 || ((first === 45 || (first >= 48 && first <= 57)) && parseInt(prop).toString() === prop);
}`;

const serviceRead = '\t\t\tif (Reflect.has(target, prop)) return getTraceable(ctx, Reflect.get(target, prop, ctx));';
// A successful read with the stock dispatcher and no observers needs no error or waterfall.
const fastServiceRead = `${serviceRead}
			const def = target.reflect.props[prop];
			if (def?.type !== "accessor") {
				const site = ctx[symbols.shadow] ?? ctx;
				if (!site.fiber.runtime) return ctx.reflect.get(prop, false);
				const events = ctx.events;
				if (events?.[symbols.original] === target.events && !target.events._hooks["internal/get"]?.length &&
					events._resolve === defaultEventResolve && events.waterfall === defaultEventWaterfall) {
					const key = site[symbols.isolate][prop];
					let fiber = site.fiber;
					while (true) {
						let impl = fiber.committed?.[prop];
						for (const provision of fiber.provisions) if (provision.name === prop && provision.ctx[symbols.isolate][prop] === key) impl = provision;
						if (impl) return getTraceable(ctx, impl.value);
						if (prop in fiber.inject || !fiber.runtime || fiber.parent[symbols.isolate][prop] !== key) break;
						fiber = fiber.parent.fiber;
					}
				}
			}`;

const edits = [[originalSpecialProperty, fastSpecialProperty], [serviceRead, fastServiceRead]];

export function cordisStartupSource(source, enabled = true) {
  const patched = source.includes('const defaultEventResolve = EventsService.prototype._resolve;');
  for (const edit of edits) {
    const current = edit[Number(patched)];
    if (source.split(current).length !== 2) throw new Error('Review Cordis startup anchor');
    if (patched !== enabled) source = source.replace(current, () => edit[Number(enabled)]);
  }
  return source;
}

export function patchCordisStartup(stage) {
  const file = join(stage, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js');
  const before = readFileSync(file, 'utf8');
  const after = cordisStartupSource(before);
  if (after === before) return;
  const temporary = file + '.dshm-' + process.pid + '.tmp';
  writeFileSync(temporary, after);
  renameSync(temporary, file);
}
