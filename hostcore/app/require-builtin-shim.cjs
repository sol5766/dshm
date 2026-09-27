'use strict';
/*
 * `node-addon-require-builtin` 的端侧纯 JS 实现（配合 `--expose-internals`）。
 *
 * 【为什么需要】@deepseek-ai 0.1.6-alpha.2 的 host preparation 必经 internalModules()：
 *   · dsh-app-boot/lib/index.js:452（installProfileResolution → profile link 解析路由）
 *   · dsh-app-boot/lib/worker/profile-resolution-bootstrap.js:15（worker 侧同一逻辑）
 *   · cordis-plugin-loader/lib/index.js:15（插件加载兜底链）
 * 都要经这个 Node-API addon 拿 Node internal 模块（internal/modules/esm/loader 等）。
 * 它的平台包只有 darwin / linux-gnu / win32（optionalDependencies），openharmony
 * 不在其列，真机报：
 *   dsh: host preparation failed: No usable native binding found for
 *   node-addon-require-builtin-openharmony-arm64 (auto)
 *
 * 【为什么敢用纯 JS 顶替】该 addon 的全部职责就是把 `require("internal/…")` 开放给
 * 上层。官方桌面端在 Electron 侧本来就开着 `--expose-internals`
 * （apps/desktop/src/host-process.ts 的 spawn 参数），internal 模块可直接 require。
 * 端侧同样带 `--expose-internals`（RuntimePort.buildHostArgv）后，`require(moduleId)`
 * 即等价实现——拿到的是**同一个** internal 模块对象，app-boot 后续对它做的
 * monkey-patch（installProfileResolution 替换 esm.resolveSync 等）不受影响。
 *
 * 【接口对齐】官方主包导出 requireBuiltin / isAllowedInternalId / getBindingInfo
 * （+ default）。树内只有 requireBuiltin 被实际调用（另两个在 @deepseek-ai 下无使用
 * 方，已核对），后两者提供如实描述自身的桩实现。
 *
 * 【加载方式】main.js 的 installRequireBuiltinShim() 拦截 `Module._load` 把本包名
 * 指到这里；本文件随 place-host-app.mjs 进 HAP resfile。
 */
function requireBuiltin(moduleId) {
  // --expose-internals 下 internal/… 前缀可直接 require（无需 node: 前缀，
  // 与 internal loader 自身的用法一致）。
  return require(moduleId);
}

function isAllowedInternalId() {
  // 端侧无 allowlist：--expose-internals 下所有 internal/… 一视同仁。
  return true;
}

function getBindingInfo() {
  return {
    platform: process.platform,
    arch: process.arch,
    mode: 'js-shim (--expose-internals)',
  };
}

module.exports = { requireBuiltin, isAllowedInternalId, getBindingInfo };
module.exports.default = module.exports;
