#!/usr/bin/env node
/*
 * 把 Host 入口脚本放进应用内置资源（`entry/src/main/resources/resfile/resources/app/`）。
 *
 * 【为什么入口归 entry 自己所有】此前它靠 `web_engine` 那个 HAR 的 resfile 合并进 HAP
 * （`tools/electron-runtime/place-host-app.ps1` 把 main.js 拷进 web_engine）。阶段一的
 * Electron 链已整体移除（D6 E49），`entry` 也不再依赖 `web_engine` —— 结果就是入口脚本
 * **从 HAP 里消失**（实测：HAP 内不再有 `resources/resfile/resources/app/`），
 * 表现为 Host 永远起不来。所以入口改由 `entry` 自己携带，并用本脚本同步。
 *
 * 【为什么是"拷贝"而不是软链/引用】鸿蒙侧通过 `resourceDir + /resources/app/main.js`
 * 直接按真实路径读取（resfile 安装后会解压到沙箱，可按真实路径只读访问），所以
 * HAP 里必须有这几份真实文件。
 *
 * 产物目录已 gitignore（生成物：字节不进库、方法进库）。
 * 用法：node tools/place-host-app.mjs
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(ROOT, 'hostcore', 'app');
const DEST = join(ROOT, 'entry', 'src', 'main', 'resources', 'resfile', 'resources', 'app');

// 入口脚本依赖的文件，缺一份都会让端侧功能静默变哑：
//   · main.js       —— 入口本身
//   · fetch-shim.js —— 被 main.js `require('./fetch-shim.js')`（jitless 下垫 fetch，见 D6 E52）
//   · undici-shim.mjs / undici-loader.mjs
//       被 main.js `register()` 的解析钩子指向。**漏掉这两个不会报错**，只会让
//       `import("undici")` 落回原生 undici，而它在 jitless 下必然抛
//       `WebAssembly is not defined` ⇒ 表现为"web_fetch 打不开任何网页"（矩阵 §3.2）。
//   · require-builtin-shim.cjs
//       被 main.js `installRequireBuiltinShim()` 拦截 `Module._load` 指向。**漏掉它
//       Host 直接起不来**：0.1.6-alpha.2 的 host preparation 要经
//       node-addon-require-builtin 访问 internal 模块，真机没有 openharmony 平台包
//       ⇒ `No usable native binding found for …openharmony-arm64 (auto)`。
//   · dshm-installer.js
//       被 main.js 安装队列段 `require('./dshm-installer.js')`（D26 插件安装器）。
//       【2026-09-23 缺口教训】它曾靠 9/21 手工拷贝进 resfile、不在本清单——
//       源头修改后 build 仍打旧文件，**全程零报错**，装机后表现为"修复不生效"。
//   · dshm-skills.js
//       被 main.js 的 ensureBundledSkills `require('./dshm-skills.js')`（P0-1 修复：
//       skill 同步按内容 sha256 判等）。漏掉它 ⇒ 端侧 require 抛 MODULE_NOT_FOUND，
//       被那个 try/catch 吞成一行 diag ⇒ **内置技能再也不更新**，与 P0-1 原来的
//       症状（改了推不下去）一模一样，等于修复白做。同样必须进清单。
//   · jitless-env.cjs —— jitless 运行期补齐层（**单份实现**：主线程与 worker 共用，
//       原先内联在 main.js 的五段挂载点都指向它）。漏掉它 ⇒ main.js 第 281 行起
//       每一处 `jitlessEnv.*` 全抛 MODULE_NOT_FOUND。
//   · internal-undici-shim.cjs
//       被 jitless-env.cjs 的 `installInternalUndiciShim()` **在 BuiltinModule 层**接管
//       （预置 `BuiltinModule.map` 里 `internal/deps/undici/undici` 的 exports/loaded）。
//       漏掉它 ⇒ 安装函数自己 require 时就抛 MODULE_NOT_FOUND（被调用点吞成一行 diag），
//       而 Node 内部那条路径照旧炸（`internal/worker/io.js` 每投递一条 MessagePort 消息
//       都会 require 它）⇒ 插件激活失败、`/bootstrap` 恒 404 —— **与完全不修一模一样**
//       （2026-10-05 真机形态）。
//   · worker-bootstrap.cjs —— worker 线程的 `--require` preload（由
//       `jitlessEnv.wrapWorkerThreads()` 注入）。**漏掉它不会报错**，只会让每个 worker
//       退回"没有补齐"的状态：`import("node-addon-require-builtin")` 又变成真 addon、
//       worker 里的 `globalThis.fetch` 又是原生 undici ⇒ 插件自建 worker 激活失败
//       （真机形态：开发者工具启用 experimental-inspector 报
//       `dsh: warning: 1 entry did not activate … WebAssembly is not defined`）。
const FILES = ['main.js', 'jitless-env.cjs', 'worker-bootstrap.cjs', 'fetch-shim.js', 'undici-shim.mjs', 'undici-loader.mjs', 'require-builtin-shim.cjs', 'internal-undici-shim.cjs', 'dshm-installer.js', 'dshm-user-rows.js', 'dshm-skills.js', 'dshm-compat.js'];

mkdirSync(DEST, { recursive: true });

const missing = FILES.filter((name) => !existsSync(join(SRC_DIR, name)));
if (missing.length > 0) {
  console.error(`place-host-app: 源文件缺失：${missing.join('、')}（在 ${SRC_DIR}）`);
  process.exit(1);
}

for (const name of FILES) {
  copyFileSync(join(SRC_DIR, name), join(DEST, name));
  console.log(`placed   : ${name}`);
}

// package.json 刻意**不带** "type" 字段 ⇒ CommonJS（main.js 里用 require/__dirname）
const pkg = {
  name: 'dshm-host',
  version: '1.0.0',
  private: true,
  description: 'DSHM 端侧 Host 入口（在 libnode.so.127 里运行；不属于任何 npm 包发布物）',
  main: 'main.js',
};
writeFileSync(join(DEST, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log(`placed   : package.json`);
console.log(`dest     : ${DEST}`);
