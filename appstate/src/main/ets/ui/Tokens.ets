/**
 * 设计令牌（D3 §8）—— **实现已移到 `platform/ui/Tokens.ets`**。
 *
 * ── 为什么要挪（2026-10-30，docs/320）──────────────────────────────────
 * 「设置 → 云同步」的原生面板住在 **platform** 里（PC/平板壳与手机壳共用一份），
 * 而 platform **不能依赖 appstate**（`appstate/oh-package.json5` 里 appstate → platform，
 * 反向就是环，编译器会直接 `Cannot find module 'appstate'`）。
 * 令牌是**零依赖的纯数字常量**，放在最底层（platform）才两边都能用；
 * 若复制一份到 platform，就会变成"两份令牌逐渐漂移"——所以是**搬家**，不是复制。
 *
 * 本文件只做**再导出**，`import { Sp } from 'appstate'` 与 `.../ui/Tokens` 的既有调用点
 * **一行都不用改**；令牌的唯一来源是 `platform/src/main/ets/ui/Tokens.ets`。
 */
export { Border, Breakpoint, Dur, Fs, Lh, Radius, SemanticColor, Sp, Sz } from 'platform';
