/**
 * 「在文件夹显示」（open-in-app 的 reveal 菜单项）移动端可用性补丁。
 *
 * ── 问题（2026-11-26，内测组）──────────────────────────────────────────────
 * `@deepseek-ai/dsh-client-ui-open-in-app` 的 context menu 用
 *   disabled: !desktop
 * 其中 desktop = paths.desktop === true。`paths.desktop` 来自 Host 的
 * `session.canOpenWorkspacePath()`，Host 侧实现是
 * `@deepseek-ai/dsh-native-command` 的 `canOpenNativePath()`：
 *   · macOS / Windows 恒 true；
 *   · Linux 必须 DISPLAY / WAYLAND_DISPLAY（WSL 除外）；
 *   · 其它 platform 直接 false。
 * 鸿蒙宿主 `process.platform === 'openharmony'` 且没有 DISPLAY ⇒ desktop=false
 * ⇒ 手机/平板（以及没有桌面的 2in1 场景）右键文件时「在文件夹显示」恒禁用。
 * 而两个壳的 `__DSHM_BRIDGES__.openFileLocation(path)` 其实都已在（走
 * `picker.DocumentViewPicker.defaultFilePathUri`，与 Office 预览面板同一个桥）。
 *
 * ── 修法 ─────────────────────────────────────────────────────────────────
 * 只改**客户端**：desktop 仍按 Host 事实（PC 走原生 reveal 不变），但菜单的
 * disabled 条件改成 `!desktop && !bridge`；点击时若 desktop=false 且有
 * `openFileLocation` 桥，就走桥，不再请求 Host 的 `revealNativePath`（它在
 * openharmony 上结构性不可达）。
 *
 * 这样：
 *   · PC / 2in1（desktop=true）→ 原行为，`revealNativePath`（Finder/Explorer/xdg-open）；
 *   · 手机 / 平板（desktop=false，bridge=true）→ 系统文件管理器定位到该文件；
 *   · 未来既无桌面也无桥的宿主 → 仍然禁用（不回退成假入口）。
 *
 * ── 纪律 ─────────────────────────────────────────────────────────────────
 * 与 `post-startup-imports.mjs` 同一套：锚点缺失 / 数量不符即 die；原始与补丁后
 * 的 sha256 都钉死，上游漂移会立刻报错，绝不静默跳过。补丁只碰客户端 bundle，
 * 不进入启动路径（不增加任何开机 require）。
 */
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RELATIVE = 'dsh-client-ui-open-in-app/lib/client.js';
const ORIGINAL = '5096cbbea51c6d0eaa2c5e0fa93495162a27c3b441af302950d830de66e94e3a';
const PATCHED = 'b7d2046546c9872358b27d726ed958f1dd1d1351f27b1975604059379e9528e9';

function hash(source) {
  return createHash('sha256').update(source).digest('hex');
}

function edit(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) {
    throw new Error('Expected exactly one open-in-app reveal patch anchor: ' + anchor.slice(0, 100));
  }
  return source.replace(anchor, () => replacement);
}

/**
 * 把 `lib/client.js` 的 reveal 菜单从"只看 Host desktop"改成"Host desktop 或
 * 壳层 openFileLocation 桥"。锚点全部是编译产物里的逐字样串。
 */
export function openInAppRevealSource(source) {
  let out = edit(source, 'function registerContextMenus(ctx,paths,t,directories,report){',
    'function registerContextMenus(ctx,paths,t,directories,report){'
    + 'const __dshmRevealBridge=()=>{try{const b=globalThis.__DSHM_BRIDGES__;return b!==null&&typeof b==="object"&&typeof b.openFileLocation==="function"}catch(_e){return false}};'
    + 'const __dshmRevealBridgeRun=p=>{try{const b=globalThis.__DSHM_BRIDGES__;return b.openFileLocation(p)==="ok"?{kind:"revealed"}:{kind:"failed",failure:"revealError"}}catch(_e){return {kind:"failed",failure:"revealError"}}};');
  // directory 菜单（右键文件夹）
  out = edit(out, 'disabled:paths.desktop.getSnapshot()!==true,run:()=>open(absolutePath,`reveal`)',
    'disabled:paths.desktop.getSnapshot()!==true&&!__dshmRevealBridge(),run:()=>paths.desktop.getSnapshot()===true?open(absolutePath,`reveal`):report(__dshmRevealBridgeRun(absolutePath))');
  // file 菜单（右键文件）——主诉求
  out = edit(out, 'const desktop=paths.desktop.getSnapshot()===true&&available;',
    'const desktop=paths.desktop.getSnapshot()===true&&available;const revealable=available&&(desktop||__dshmRevealBridge());');
  out = edit(out, 'disabled:!desktop,...absolutePath===void 0?{}:{run:()=>open(absolutePath,`reveal`)}',
    'disabled:!revealable,...absolutePath===void 0?{}:{run:()=>desktop?open(absolutePath,`reveal`):report(__dshmRevealBridgeRun(absolutePath))}');
  // image 菜单
  out = edit(out, 'const local=path!==void 0&&sessionId!==void 0&&paths.desktop.getSnapshot()===true?await resolvePath(sessionId,path,signal):void 0;',
    'const local=path!==void 0&&sessionId!==void 0&&(paths.desktop.getSnapshot()===true||__dshmRevealBridge())?await resolvePath(sessionId,path,signal):void 0;');
  out = edit(out, 'disabled:local===void 0,...local!==void 0?{run:()=>open(local,`reveal`)}:{}',
    'disabled:local===void 0,...local!==void 0?{run:()=>paths.desktop.getSnapshot()===true?open(local,`reveal`):report(__dshmRevealBridgeRun(local))}:{}');
  // workspace 菜单（右键工作区根）
  out = edit(out, 'const manager=directories.apps.getSnapshot()?.find(id=>[`finder`,`explorer`,`filemanager`].includes(id));return[{id:`reveal`,icon:{key:`open-in-app.reveal`},label:fileManager(),disabled:manager===void 0,failureLabel:t(`path.revealError`),...manager===void 0?{}:{run:async()=>{const outcome=await directories.launch(manager,path);report(outcome.kind===`failed`?{kind:`failed`,failure:`revealError`}:outcome)}}}]',
    'const manager=directories.apps.getSnapshot()?.find(id=>[`finder`,`explorer`,`filemanager`].includes(id));return[{id:`reveal`,icon:{key:`open-in-app.reveal`},label:fileManager(),disabled:manager===void 0&&!__dshmRevealBridge(),failureLabel:t(`path.revealError`),...manager===void 0?{...(__dshmRevealBridge()?{run:()=>report(__dshmRevealBridgeRun(path))}:{})}:{run:async()=>{const outcome=await directories.launch(manager,path);report(outcome.kind===`failed`?{kind:`failed`,failure:`revealError`}:outcome)}}}]');
  return out;
}

/**
 * 在 pack-core 的 STAGE 上应用补丁；上游漂移 / 产出不符即抛错。
 * @param stage 已物化的核心树根目录
 */
export function patchOpenInAppReveal(stage) {
  const file = join(stage, 'node_modules', '@deepseek-ai', RELATIVE);
  const source = readFileSync(file, 'utf8');
  const digest = hash(source);
  if (digest === PATCHED) return;
  if (digest !== ORIGINAL) {
    throw new Error('Review upstream open-in-app reveal behavior: ' + RELATIVE);
  }
  const candidate = openInAppRevealSource(source);
  if (hash(candidate) !== PATCHED) {
    throw new Error('Open-in-app reveal patch output changed: ' + RELATIVE);
  }
  const temporary = file + '.dshm-' + process.pid + '.tmp';
  writeFileSync(temporary, candidate);
  renameSync(temporary, file);
}
