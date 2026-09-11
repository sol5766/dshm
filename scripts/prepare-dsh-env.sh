#!/bin/bash
# ============================================================
# DSHM: 准备 DSH 运行环境（rawfile/dsh）
# 将 @deepseek-ai/dsh、内置 dsh-market 及其依赖完整安装到临时目录，应用 OpenHarmony 适配，
# 再拷入 entry/src/main/resources/rawfile/dsh/ 随 HAP 分发。
#
# 用法: scripts/prepare-dsh-env.sh [dsh版本，默认 0.1.2-rc.1]
# 环境变量: DSH_MARKET_VERSION（默认 1.13.1）、DSH_MOBILE_NAV_REVISION（默认固定提交）
# 产物: entry/src/main/resources/rawfile/dsh/（gitignore 不提交，需重新构建 HAP）
# 注意: 原生模块（node-pty/sharp/koffi）在鸿蒙无预编译 binding，
#       安装后由 apply-dsh-ohos-adapt.sh stub；若 Windows 编译失败可加 --ignore-scripts。
# ============================================================
set -e
DSH_VERSION="${1:-0.1.2-rc.1}"
DSH_MARKET_VERSION="${DSH_MARKET_VERSION:-1.13.1}"
DSH_MOBILE_NAV_REVISION="${DSH_MOBILE_NAV_REVISION:-a96035f1b18162adefa5d322b24123159fb85855}"
DSHM_ADAPT_REVISION="20260910-56"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="entry/src/main/resources/rawfile/dsh"
READY_MARKER="$DEST/.dshm-env-ready"
READY_CONTENT="dsh=$DSH_VERSION;market=$DSH_MARKET_VERSION;mobile=$DSH_MOBILE_NAV_REVISION;adapt=$DSHM_ADAPT_REVISION"

if [ -f "$READY_MARKER" ] \
  && [ "$(cat "$READY_MARKER")" = "$READY_CONTENT" ] \
  && [ -f "$DEST/node_modules/@deepseek-ai/dsh/lib/bin.js" ] \
  && [ -f "$DEST/node_modules/dshmarket/lib/index.js" ] \
  && [ -f "$DEST/node_modules/dshmarket/lib/dsh-cli.js" ] \
  && [ -f "$DEST/node_modules/@dsh-external/dsh-mobile-nav/lib/client.js" ]; then
  echo "DSH 环境已就绪: $DEST"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "[1/4] 创建临时工程并安装 dsh@$DSH_VERSION (node_modules 较大，请耐心等待)..."
cd "$TMP"
npm init -y >/dev/null 2>&1
# 原生模块在 Windows 编译失败属预期：--ignore-scripts 跳过 postinstall，
# 需要的模块由 adapt 脚本 stub（dsh 核心为纯 JS，可正常运行）。
# IMPORTANT: 不能用 --legacy-peer-deps。rc.1.2 的 dsh 通过大量 peerDependency
# 引入 @deepseek-ai/cordis-plugin-* 与 dsh-* 子包；--legacy-peer-deps 会让 npm
# 跳过自动安装这些 peer，导致启动时报 ERR_MODULE_NOT_FOUND（如 cordis-plugin-group）。
# 干净安装（不传 --legacy-peer-deps）会装出完整 peer 树（~520 包），可正常启动。
npm install --no-audit --no-fund --ignore-scripts "@deepseek-ai/dsh@$DSH_VERSION"

# @dsh-external/dsh-mobile-nav 是 git 源包（npm registry 404），且与完整 dsh peer 树
# 在 npm 下无法共存（装它需 --legacy-peer-deps，只会在同一棵树剪掉其余 peer）。
# lean-web：不额外安装，web profile 仅用 dsh-base + dsh-web-app + 内置 dshm-config-editor。

# dshmarket：与完整 peer 树在 npm 下无法共存（其 peer @deepseek-ai/dsh-settings@^0.1.0-rc.7
# 与 rc.1.2 的 dsh-settings 冲突，装它必须 --legacy-peer-deps，而那只会在同一棵树里
# 剪掉其余 peer）。它不是启动必需（仅插件市场 UI），此处只告警不阻断。
echo "[1.5/4] 检查内置 dshmarket（非启动必需，缺失仅告警）..."
if [ -f node_modules/dshmarket/lib/index.js ] && [ -f node_modules/dshmarket/lib/dsh-cli.js ]; then
  echo "  dshmarket 已内置于 DSH 运行时"
else
  echo "  WARN: dshmarket 未内置于 DSH 运行时（插件市场需单独安装，不影响核心工具运行）"
fi

echo "[1.6/4] 检查内置 dsh-web-mobile（lean-web：非启动必需，缺失仅告警）..."
if [ -f node_modules/@dsh-external/dsh-mobile-nav/lib/client.js ]; then
  echo "  dsh-mobile-nav 已内置于 DSH 运行时"
else
  echo "  WARN: dsh-mobile-nav 未内置于 DSH 运行时（lean-web，核心工具不受影响）"
fi

echo "[2/4] 校验 dsh 主入口..."
[ -f node_modules/@deepseek-ai/dsh/lib/bin.js ] || { echo "错误: bin.js 不存在"; exit 1; }

# DSHM 鸿蒙适配：预装 typescript（run_code 类型剥离用）。必须在此处用 bash
# 的 tar 解压——apply-dsh-ohos-adapt.sh 内 Node execSync('tar') 在 Windows
# cmd PATH 找不到 Git Bash 的 tar（status 2）；这里预装后 apply 检查
# node_modules/typescript/lib/typescript.js 存在即跳过。
echo "[2.5/4] 预装 typescript（run_code 类型剥离）..."
mkdir -p node_modules/typescript
npm pack typescript@5.9.3 --pack-destination node_modules/typescript >/dev/null 2>&1
TS_TGZ="$(ls node_modules/typescript/typescript-*.tgz 2>/dev/null | head -1)"
if [ -n "$TS_TGZ" ]; then
  tar -xzf "$TS_TGZ" -C node_modules/typescript --strip-components=1
  rm -f "$TS_TGZ"
  echo "typescript 预装完成: $(ls node_modules/typescript/lib/typescript.js 2>/dev/null)"
else
  echo "警告: typescript 预装失败（npm pack 无产物），apply 阶段将尝试兜底"
fi

# DSHM 鸿蒙适配：预装 pnpm（dsh plugin 主进程桥接用）。同样用 bash tar
# 解压，避免 apply 脚本内 Node execSync('tar') 在 Windows cmd PATH 找不到。
echo "[2.6/4] 预装 pnpm（dsh plugin 主进程桥接）..."
mkdir -p node_modules/pnpm
npm pack pnpm@10.6.3 --pack-destination node_modules/pnpm >/dev/null 2>&1
PNPM_TGZ="$(ls node_modules/pnpm/pnpm-*.tgz 2>/dev/null | head -1)"
if [ -n "$PNPM_TGZ" ]; then
  tar -xzf "$PNPM_TGZ" -C node_modules/pnpm --strip-components=1
  rm -f "$PNPM_TGZ"
  echo "pnpm 预装完成: $(ls node_modules/pnpm/dist/pnpm.cjs 2>/dev/null)"
else
  echo "警告: pnpm 预装失败（npm pack 无产物），apply 阶段将尝试兜底"
fi

echo "[3/4] 应用 OpenHarmony 适配（stub 原生模块 + bundle patch）..."
bash "$SCRIPT_DIR/apply-dsh-ohos-adapt.sh" "$TMP"

echo "[3.1/4] 注入 --jitless fetch/WebAssembly shim（必须在 npm 环境重建后重放）..."
# dsh 核心在 --jitless 下首次触碰 undici（fetch）即崩（WebAssembly 未定义），
# 由 scripts/_fetch-shim.cjs 预加载垫片规避。该文件不是 npm 分发件，需随
# 环境重建重新放置到 @deepseek-ai/dsh/lib/ 下。
if [ -f "$SCRIPT_DIR/_fetch-shim.cjs" ]; then
  mkdir -p "$TMP/node_modules/@deepseek-ai/dsh/lib"
  cp "$SCRIPT_DIR/_fetch-shim.cjs" "$TMP/node_modules/@deepseek-ai/dsh/lib/_fetch-shim.cjs"
  echo "fetch-shim 注入完成"
else
  echo "警告: scripts/_fetch-shim.cjs 缺失，--jitless 环境可能无法使用 fetch/undici"
fi

echo "[4/4] 拷入 rawfile/dsh..."
# 使用 Node 的结构化复制 API；其镜像行为可删除旧市场包，且不依赖 Git Bash
# 与 cmd.exe 对带空格 Windows 路径的转义规则。
node - "$TMP/node_modules" "$REPO_ROOT/$DEST/node_modules" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const source = process.argv[2];
const destination = process.argv[3];
fs.rmSync(destination, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.cpSync(source, destination, { recursive: true, force: true, dereference: true });
NODE

echo "[5/6] 应用 dsh 环境补丁（启动期性能）…"
# 为什么必须在这里打：rawfile/dsh 是整包重建的（上面的 cpSync 会覆盖任何手工改动），
# 而 @deepseek-ai/dsh-client-modules 的 newlineCount 逐码点遍历会让 11MB 客户端
# 合并包的拼装吃掉 --jitless 冷启动一半以上时间（实测 11.4s/19.6s）。
node "$SCRIPT_DIR/patch-dsh-env-client-modules.mjs" "$REPO_ROOT/$DEST"

echo "[6/6] 环境瘦身（去掉鸿蒙运行时用不到的文件）…"
# 为什么可以裁（2026-09-11 实测，裁剪前 253.5MB / 26,762 文件）：
#   Windows 平台二进制 48.6MB、调试符号 48.1MB、其它平台 prebuilds 23.2MB、
#   服务端 source map 38.8MB、*.d.ts 36.5MB、test/ 8.2MB、*.md 7.5MB
#   → 去重并集 142.8MB（56%）。鸿蒙 arm64 永远加载不了 win32/darwin 的 dll/exe/pdb，
#   .d.ts 只服务编译期，服务端 .map 只有调试器会读（客户端合并包要用的 client.js.map 已保留）。
# 这一步直接影响 HAP 体积（HAP 是不压缩存储的，rawfile 有多大 HAP 就大多少）。
node "$SCRIPT_DIR/prune-dsh-env.mjs" --env "$REPO_ROOT/$DEST" --delete

printf '%s\n' "$READY_CONTENT" > "$REPO_ROOT/$READY_MARKER"

echo "✅ DSH 环境就绪: $REPO_ROOT/$DEST ($(du -sh "$REPO_ROOT/$DEST" | cut -f1))"
echo "   请重新构建 HAP（rawfile/dsh 会随包分发，首次启动由 DshBootstrap 解压到沙箱）"
