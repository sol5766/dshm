#!/bin/sh
# upgrade.sh — 升级 Harmonybrew 自身 + DeepSeek Harness（鸿蒙 PC）
# 流程: brew update → brew upgrade（升级所有已装包）→ brew upgrade deepseek-harness（兜底）
# 用法: sh scripts/upgrade.sh
set -e

BREW="$HOME/.harmonybrew/bin/brew"
if [ ! -x "$BREW" ]; then
  echo "未安装 Harmonybrew，请先运行: sh scripts/install-brew.sh"
  exit 1
fi

export PATH="$HOME/.harmonybrew/bin:$PATH"

echo "==> brew --version"
$BREW --version | head -1

echo "==> brew update"
$BREW update

echo "==> brew upgrade（所有已装包）"
$BREW upgrade

echo "==> brew upgrade deepseek-harness"
$BREW upgrade deepseek-harness || true

echo "==> 当前 deepseek-harness 版本"
$BREW list --versions deepseek-harness 2>/dev/null || echo "(未安装)"

echo
echo "完成。如 dsh web 正在运行，建议重启以加载新版本:"
echo "  sh ~/.dsh/start-dsh-resident.sh   # 重启会杀死旧 dsh 后自动拉起新版"