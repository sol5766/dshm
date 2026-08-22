#!/bin/sh
# install-brew.sh — 安装 Harmonybrew（鸿蒙 PC）
# 官方安装命令来自 https://harmonybrew.atomgit.com/
# 前置条件（按官方文档）:
#   - 开发者选项已开启，"运行来自非应用市场的扩展程序"已打开
#   - zsh、curl 已安装（HiShell 通常已自带）
# 用法: sh scripts/install-brew.sh
set -e

BREW_BIN="$HOME/.harmonybrew/bin/brew"
SHELLENV_LINE='eval "$(/storage/Users/currentUser/.harmonybrew/bin/brew shellenv)"'

if [ -x "$BREW_BIN" ]; then
  echo "Harmonybrew 已安装: $($BREW_BIN --version 2>/dev/null | head -1)"
  exit 0
fi

echo "==> 从 https://harmonybrew.atomgit.com/ 拉取安装脚本并执行"
zsh -c "$(curl -fsSL https://harmonybrew.atomgit.com/install.sh)"

if [ ! -x "$BREW_BIN" ]; then
  echo "安装失败：未找到 $BREW_BIN"
  echo "请检查前置条件（开发者选项/隐私开关/curl/zsh）后重试，详见 https://harmonybrew.atomgit.com/"
  exit 1
fi

echo "==> 配置 ~/.zshrc（幂等）"
if [ -f "$HOME/.zshrc" ] && grep -qF "brew shellenv" "$HOME/.zshrc"; then
  echo "  ~/.zshrc 已有 brew shellenv，跳过"
else
  printf '\n# Harmonybrew (added by install-brew.sh)\n%s\n' "$SHELLENV_LINE" >> "$HOME/.zshrc"
  echo "  已写入 ~/.zshrc: brew shellenv"
fi

echo "==> 完成。当前 shell 已临时加载 brew（重新打开终端或 source ~/.zshrc 生效）"
export PATH="$HOME/.harmonybrew/bin:$PATH"
echo "    验证: $($BREW_BIN --version | head -1)"