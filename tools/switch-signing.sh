#!/usr/bin/env bash
# 生成 / 还原 build-profile.json5（含本机真实签名值）
#
# 用法：
#   ./tools/switch-signing.sh local     # 从模板生成一份 → 再用 DevEco 自动签名填真实值
#   ./tools/switch-signing.sh template  # 用模板覆盖（清掉真实值）
#
# 【为什么这个文件不被 git 跟踪】build-profile.json5 里的签名材料
#   （密钥库口令 / 证书路径）是**机器绑定**的个人信息，绝不能进公开仓库。
#   仓库只跟踪 tools/build-profile.template.json5（占位符版）。
#   本文件与 build-profile.local.json5 均已在 .gitignore 中。
#
# 【新克隆后怎么做】
#   1. ./tools/switch-signing.sh local
#   2. 用 DevEco Studio 打开工程 → Project Structure → Signing Configs
#      → 勾选 "Automatically generate signature"
#
# 【已有本机配置时】若 build-profile.local.json5 存在（你之前生成过），
#   local 模式会优先用它，省去重新签名。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
MODE="${1:-}"
case "$MODE" in
  local)
    if [ -f build-profile.local.json5 ]; then
      cp build-profile.local.json5 build-profile.json5
      echo "已用 build-profile.local.json5 生成（含你本机的真实签名值）。"
    else
      cp tools/build-profile.template.json5 build-profile.json5
      echo "已用模板生成。请用 DevEco 自动签名填入真实值，然后："
      echo "  cp build-profile.json5 build-profile.local.json5   # 备份一份"
    fi
    ;;
  template)
    cp tools/build-profile.template.json5 build-profile.json5
    echo "已切回模板（真实值已清除）。"
    ;;
  *)
    echo "用法: $0 {local|template}" >&2
    exit 2
    ;;
esac
