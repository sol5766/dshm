#!/bin/bash
# ============================================================
# HDSH: 准备 DSH 运行环境（rawfile/dsh）
# 将 @deepseek-ai/dsh、内置 dsh-market 及其依赖完整安装到临时目录，应用 OpenHarmony 适配，
# 再拷入 entry/src/main/resources/rawfile/dsh/ 随 HAP 分发。
#
# 用法: scripts/prepare-dsh-env.sh [dsh版本，默认 0.1.0-rc.7]
# 环境变量: DSH_MARKET_VERSION（默认 1.13.1）、DSH_MOBILE_NAV_REVISION（默认固定提交）
# 产物: entry/src/main/resources/rawfile/dsh/（gitignore 不提交，需重新构建 HAP）
# 注意: 原生模块（node-pty/sharp/koffi）在鸿蒙无预编译 binding，
#       安装后由 apply-dsh-ohos-adapt.sh stub；若 Windows 编译失败可加 --ignore-scripts。
# ============================================================
set -e
DSH_VERSION="${1:-0.1.0-rc.7}"
DSH_MARKET_VERSION="${DSH_MARKET_VERSION:-1.13.1}"
DSH_MOBILE_NAV_REVISION="${DSH_MOBILE_NAV_REVISION:-a96035f1b18162adefa5d322b24123159fb85855}"
HDSH_ADAPT_REVISION="20260819-54"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="entry/src/main/resources/rawfile/dsh"
READY_MARKER="$DEST/.hdsh-env-ready"
READY_CONTENT="dsh=$DSH_VERSION;market=$DSH_MARKET_VERSION;mobile=$DSH_MOBILE_NAV_REVISION;adapt=$HDSH_ADAPT_REVISION"

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
npm install --no-audit --no-fund --ignore-scripts "@deepseek-ai/dsh@$DSH_VERSION"

echo "[1.5/4] 安装内置 dshmarket@$DSH_MARKET_VERSION..."
npm install --no-audit --no-fund --ignore-scripts "dshmarket@$DSH_MARKET_VERSION"
[ -f node_modules/dshmarket/lib/index.js ] || { echo "错误: dshmarket 插件入口不存在"; exit 1; }
[ -f node_modules/dshmarket/lib/dsh-cli.js ] || { echo "错误: dshmarket CLI 入口不存在"; exit 1; }
[ -f node_modules/dshmarket/cordis.patch.yml ] || { echo "错误: dshmarket Cordis patch 不存在"; exit 1; }

echo "[1.6/4] 安装内置 dsh-web-mobile@$DSH_MOBILE_NAV_REVISION..."
npm install --no-audit --no-fund --ignore-scripts "git+https://github.com/mexiaosqwq/dsh-web-mobile.git#$DSH_MOBILE_NAV_REVISION"
[ -f node_modules/@dsh-external/dsh-mobile-nav/lib/client.js ] || { echo "错误: dsh-web-mobile 客户端入口不存在"; exit 1; }
[ -f node_modules/@dsh-external/dsh-mobile-nav/cordis.patch.yml ] || { echo "错误: dsh-web-mobile Cordis patch 不存在"; exit 1; }

echo "[2/4] 校验 dsh 主入口..."
[ -f node_modules/@deepseek-ai/dsh/lib/bin.js ] || { echo "错误: bin.js 不存在"; exit 1; }

# HDSH 鸿蒙适配：预装 typescript（run_code 类型剥离用）。必须在此处用 bash
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

# HDSH 鸿蒙适配：预装 pnpm（dsh plugin 主进程桥接用）。同样用 bash tar
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
printf '%s\n' "$READY_CONTENT" > "$REPO_ROOT/$READY_MARKER"

echo "✅ DSH 环境就绪: $REPO_ROOT/$DEST ($(du -sh "$REPO_ROOT/$DEST" | cut -f1))"
echo "   请重新构建 HAP（rawfile/dsh 会随包分发，首次启动由 DshBootstrap 解压到沙箱）"
