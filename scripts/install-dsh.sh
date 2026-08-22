#!/bin/sh
# install-dsh.sh — DSHM 一键部署：自动装 Harmonybrew（如缺失）→ 装 dsh 后端。
# 装完手动前台启动: dsh web
# 或后台守护:        sh scripts/start-dsh-resident.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v brew >/dev/null 2>&1 && [ ! -x "$HOME/.harmonybrew/bin/brew" ]; then
  echo "==> 检测到 Harmonybrew 未安装，先安装"
  sh "$SCRIPT_DIR/install-brew.sh"
fi

export PATH="$HOME/.harmonybrew/bin:$PATH"

echo "==> brew install deepseek-harness"
brew install deepseek-harness

echo
echo "安装完成。"
echo "前台启动:   dsh web"
echo "后台守护:   sh scripts/start-dsh-resident.sh        # 默认 3080"
echo "            sh scripts/start-dsh-resident.sh 8080   # 自定义端口"
echo "客户端会自动检测端口（10 秒内未检测到进引导页，提示手动启动）。"