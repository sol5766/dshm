/**
 * HAR 模块对外入口（模块根级 Index.ets）。
 *
 * 说明：HarmonyOS HAR 依赖 oh-package.json5 的 main 指向模块根下的入口文件，
 * 因此这里只做「转发导出」；真正的实现位于 src/main/ets/。
 * 上层只应通过本入口导入，不得深层导入 src/main/ets/*。
 */

export * from './src/main/ets/Index';
