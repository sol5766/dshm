#!/usr/bin/env node
/**
 * 生成 `hostcore/plugins/dshm-cloud-sync/lib/client.js`（浏览器半边）。
 *
 * 【为什么要生成器（2026-10-30 真机教训，docs/319 §2）】
 * 上一版手写的 `lib/client.js` 用 CommonJS 的 `exports.apply = apply` 收尾，
 * 而 dsh 的客户端模块加载器是**浏览器侧 CJS 表**（`window.__ModuleLoader__.load({id, factory})`），
 * `factory(require)` 的返回值才是模块导出。手写时只要把 `exports.x =` 写错一步，
 * 插件就静默变成"没有 apply 的空模块"——不报错、不崩、设置里就是不出现。
 *
 * 本生成器把这件事变成**结构**：
 *   · 源码（`src/client.src.js`）是一段**普通 JS 函数体**（可读、可单测、可 lint）；
 *   · 外层包装（模块 id / factory / exports / inject）由这里统一写，不可能写错；
 *   · 生成后自检：包进 `__ModuleLoader__.load` 的材料化结果必须真的导出 `apply`。
 *
 * 用法：
 *   node tools/gen-cloud-sync-client.mjs            # 生成 lib/client.js
 *   node tools/gen-cloud-sync-client.mjs --check    # 只校验（lib/client.js 与源码是否同步）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = join(ROOT, 'hostcore', 'plugins', 'dshm-cloud-sync', 'src', 'client.src.js');
const OUT = join(ROOT, 'hostcore', 'plugins', 'dshm-cloud-sync', 'lib', 'client.js');

/** 外层包装：dsh 客户端模块加载器认这个形状（与官方 client 包逐字同构）。 */
function wrap(body) {
	return `window.__ModuleLoader__.load({
	id: "@deepseek-ai/dshm-cloud-sync",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react");

		/* ── 以下为 src/client.src.js 的逐字内容（由 tools/gen-cloud-sync-client.mjs 生成，勿手改）── */
${body}
		/* ── 生成内容结束 ── */

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
`;
}

/**
 * 材料化一次（在最小环境里跑 factory），证明导出面正确。
 *
 * 【为什么必须真跑】`exports.apply = apply` 这类错误在语法上完全合法；
 * 只有把 factory 执行一遍、看 `Object.keys(exports)`，才判得出来。
 */
function materialize(code) {
	const captured = [];
	globalThis.window = globalThis.window ?? {};
	globalThis.window.__ModuleLoader__ = { load: (m) => captured.push(m) };
	const noop = () => {};
	globalThis.document = {
		createElement: () => ({ dataset: {}, appendChild: noop, textContent: '' }),
		head: { appendChild: noop },
		querySelector: () => null
	};
	const ReactStub = {
		createElement: (type, props, ...children) => ({ type, props, children }),
		useState: (init) => [typeof init === 'function' ? init() : init, noop],
		useEffect: noop
	};
	// eslint-disable-next-line no-new-func
	new Function('window', 'document', 'React', code)(globalThis.window, globalThis.document, ReactStub);
	if (captured.length !== 1) {
		throw new Error(`模块没有注册到 __ModuleLoader__（命中 ${captured.length} 次）`);
	}
	const entry = captured[0];
	if (entry.id !== '@deepseek-ai/dshm-cloud-sync') {
		throw new Error(`模块 id 不符：${entry.id}`);
	}
	const exportsObj = entry.factory((id) => {
		if (id === 'react') return ReactStub;
		throw new Error(`未预期的 require：${id}`);
	});
	if (typeof exportsObj.apply !== 'function') {
		throw new Error('材料化后没有导出 apply（cordis 会拿不到它 ⇒ 插件永不构造）');
	}
	if (!Array.isArray(exportsObj.inject) || exportsObj.inject.length === 0) {
		throw new Error('材料化后 inject 不是非空数组');
	}
	return exportsObj;
}

const body = readFileSync(SRC, 'utf8');
const code = wrap(body);
materialize(code);

if (process.argv.includes('--check')) {
	if (!existsSync(OUT)) {
		console.error('❌ lib/client.js 不存在；先跑 node tools/gen-cloud-sync-client.mjs');
		process.exit(1);
	}
	if (readFileSync(OUT, 'utf8') !== code) {
		console.error('❌ lib/client.js 与 src/client.src.js 不同步；跑 node tools/gen-cloud-sync-client.mjs');
		process.exit(1);
	}
	console.log('✅ client.js 与源码同步，且材料化后导出 apply/inject。');
	process.exit(0);
}

writeFileSync(OUT, code, 'utf8');
console.log(`✅ 已生成 ${OUT.slice(ROOT.length + 1)}（${code.length} 字节），材料化自检通过。`);
