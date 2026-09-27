#!/usr/bin/env bash
# 在"模板（可提交）"与"本机真实签名值（不可提交）"之间切换 build-profile.json5
#
# 用法：
#   ./tools/switch-signing.sh template   # 切成模板 → 可安全 git add / commit / push
#   ./tools/switch-signing.sh local      # 切成本机真实值 → 可 devecocli build
#
# 【为什么需要它】build-profile.json5 是**被 git 跟踪**的工程配置，但它里面的签名材料
#   （密钥库口令 / 证书路径）是**机器绑定**的个人信息，绝不能进公开仓库。
#   于是：仓库里放模板，本机真实值放被忽略的 build-profile.local.json5，用本脚本切换。
#
# ⚠ 纪律：push 之前先跑 `./tools/switch-signing.sh template` 并确认 git status 干净。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
MODE="${1:-}"
case "$MODE" in
  template)
    cp tools/build-profile.template.json5 build-profile.json5
    echo "已切为模板（可提交）。"
    ;;
  local)
    cp build-profile.local.json5 build-profile.json5
    echo "已切为本机真实值（可构建）。**提交前请切回 template**"
    ;;
  *)
    echo "用法: $0 {template|local}" >&2
    exit 2
    ;;
esac
