#!/usr/bin/env bash
# DSHM —— 推送到 GitCode（覆盖远端 master）
#
# 用法：
#   ./tools/publish-gitcode.sh <GitCode 个人访问令牌>
#
# 【令牌怎么拿】GitCode → 右上角头像 → 设置 → 访问令牌 / Access Token
#   → 生成时**必须勾选 write 权限**（常见的 api / write_repository / read_user 三档里的 write_repository）
#   → 本项目要用 --force 覆盖，所以需要的是**仓库写权限**
#
# 【为什么不能直接写在 URL 里】https://oauth2:<token>@gitcode.com/... 会让令牌落进
#   shell 历史、进程命令行、以及 .git/config（之后 git remote -v 会打印出来）。
#   本脚本用 http.extraheader 通过 HTTP 头传令牌，不进 URL、不写仓库配置。
set -euo pipefail

TOKEN="${1:-}"
if [ -z "$TOKEN" ]; then
  echo "用法: $0 <GitCode 个人访问令牌>" >&2
  exit 2
fi

REPO_URL="https://gitcode.com/u010189254/dshm.git"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 绕过代理（本机 git 全局代理指向 127.0.0.1，连不通 gitcode）
export HTTP_PROXY="" HTTPS_PROXY="" http_proxy="" https_proxy=""
export NO_PROXY="gitcode.com,.gitcode.com"
# 禁用凭据助手，避免 Git Credential Manager 弹窗并丢弃我们传的头
export GIT_TERMINAL_PROMPT=0
export GCM_INTERACTIVE=never
export GIT_CREDENTIAL_MANAGER=0
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=credential.helper
export GIT_CONFIG_VALUE_0=""

echo "== 1/3 校验令牌（只读，不改动远端）=="
if ! git -c "http.extraheader=PRIVATE-TOKEN: $TOKEN" ls-remote --heads "$REPO_URL" >/dev/null; then
  echo "令牌校验失败（注意：该仓库公开可读，ls-remote 成功不代表令牌有效）" >&2
  exit 1
fi

echo "== 2/3 用 API 确认令牌可写 =="
CODE="$(curl -sS -o /dev/null -w '%{http_code}' --noproxy gitcode.com \
  -H "PRIVATE-TOKEN: $TOKEN" https://gitcode.com/api/v5/user)"
if [ "$CODE" != "200" ]; then
  echo "令牌不被 GitCode API 识别（HTTP $CODE）→ 多半是令牌无效或缺少权限" >&2
  exit 1
fi

echo "== 3/3 强制推送覆盖远端 master =="
git -c "http.extraheader=PRIVATE-TOKEN: $TOKEN" \
  push --force "$REPO_URL" refs/heads/master:refs/heads/master

echo "完成。请在 GitCode 网页端复核仓库内容。"
