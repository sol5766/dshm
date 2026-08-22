#!/bin/sh
# start-dsh-resident.sh — 启动 `dsh web` 并后台守护（鸿蒙 PC）
#
# 用法: sh start-dsh-resident.sh [PORT]    # 默认 3080
#
# 行为:
#   单实例    再次执行只在守护已在跑时打印状态并退出。
#   自脱离    首次执行通过 setsid + nohup 把本脚本作为后台守护进程;
#             关闭启动它的终端不影响 dsh 在线。
#   接管/拉起 启动时若端口已被合法 dsh 占用,优先按 DSH_PIDFILE 接管;
#             否则启新 dsh(EADDRINUSE 等情况不退出,等端口空闲再接管)。
#   崩溃自愈  每 20 秒同时验证 dsh PID 存活 + 端口可达;按情况拉起或等待。
#   停止      kill $(cat $HOME/.dsh/dsh-web-<PORT>.daemon.pid)
#             默认 TERM;若仍不退出再用 kill -9。
#             注意:守护死了不等于 dsh 死了(dsh 是 setsid 出的独立进程,
#             仍会继续服务 3080,客户端不受影响)。要连 dsh 一起停:
#               kill $(cat $HOME/.dsh/dsh-web-<PORT>.daemon.pid) \
#                    $(cat $HOME/.dsh/dsh-web-<PORT>.pid)
#
# 路径约定:依赖 harmonybrew 安装的 dsh ($HOME/.harmonybrew/bin/dsh)。
set -e

export PATH="/usr/bin:/bin:$HOME/.harmonybrew/bin:$PATH"

PORT="${1:-3080}"
URL="http://127.0.0.1:${PORT}/"
BASE="$HOME/.dsh"
LOG="$BASE/dsh-web-${PORT}.log"
DAEMON_LOG="$BASE/dsh-web-${PORT}.daemon.log"
PIDFILE="$BASE/dsh-web-${PORT}.daemon.pid"
DSH_PIDFILE="$BASE/dsh-web-${PORT}.pid"
LOCKDIR="$BASE/.start-dsh-resident.lock.d"
DSH="$HOME/.harmonybrew/bin/dsh"

stamp() { date "+%Y-%m-%d %H:%M:%S"; }

# --- 单实例检测 ---
if [ -d "$LOCKDIR" ] && [ -f "$LOCKDIR/pid" ]; then
  LP=$(cat "$LOCKDIR/pid" 2>/dev/null)
  if [ -n "$LP" ] && kill -0 "$LP" 2>/dev/null; then
    DPID=$(cat "$DSH_PIDFILE" 2>/dev/null || echo "?")
    code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$URL/" 2>/dev/null || echo down)
    echo "已在守护: port=${PORT} daemon_pid=${LP} dsh_pid=${DPID} 端口=${URL} 当前 ${code}"
    echo "停止: kill $(cat $PIDFILE)  (TERM 不响应再 -9)"
    exit 0
  fi
  rm -rf "$LOCKDIR"
fi

# --- 第一次执行:自脱离 ---
if [ -z "$DSH_RESIDENT_DAEMON" ]; then
  mkdir -p "$BASE"
  : > "$DAEMON_LOG"
  export DSH_RESIDENT_DAEMON=1
  setsid nohup "$0" "$PORT" </dev/null >>"$DAEMON_LOG" 2>&1 &
  echo $! > "$PIDFILE"
  # 等守护进程写好锁目录,最多 10 秒
  i=0
  while [ "$i" -lt 10 ]; do
    if [ -d "$LOCKDIR" ]; then break; fi
    i=$((i+1)); sleep 1
  done
  DPID=$(cat "$DSH_PIDFILE" 2>/dev/null || echo "?")
  code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$URL/" 2>/dev/null || echo down)
  echo "已启动守护: port=${PORT} daemon_pid=$(cat "$PIDFILE" 2>/dev/null) dsh_pid=${DPID} 端口=${URL} 当前 ${code}"
  echo "停止: kill $(cat $PIDFILE)  (TERM 不响应再 -9)"
  exit 0
fi

# --- 守护进程主体 ---
mkdir -p "$BASE"
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  echo "$(stamp) failed to create $LOCKDIR" >> "$DAEMON_LOG"
  exit 1
fi
echo $$ > "$LOCKDIR/pid"
# 退出时清理 LOCKDIR 和 PIDFILE。
# INT/TERM 触发 trap 后立即 exit 0（nohup 链路下 sh 默认不响应 TERM,必须显式 exit）。
# EXIT 仅清理文件不重复 exit。
trap 'rm -rf "$LOCKDIR"; rm -f "$PIDFILE"; exit 0' INT TERM
trap 'rm -rf "$LOCKDIR"; rm -f "$PIDFILE"' EXIT

echo "$(stamp) daemon start pid=$$ port=$PORT" >> "$DAEMON_LOG"

# 启动 dsh;写 DSH_PIDFILE;返回 pid。不 truncate 日志,append 便于排查历史。
start_dsh() {
  cd "$HOME" || return 1
  setsid "$DSH" web --port "$PORT" >>"$LOG" 2>&1 < /dev/null &
  local pid=$!
  echo "$pid" > "$DSH_PIDFILE"
  echo "$pid"
}

# 等待:端口可达 AND 我们记录的 pid 还活 + 稳定 3 秒(过 dsh 启动窗口:
# 启动慢 + bind 失败可能在 5-10 秒后才退出;不二次确认会把刚启动就死的进程当 ready)。
max_dsh_ready() {
  i=0
  while [ "$i" -lt 60 ]; do
    DPID=$(cat "$DSH_PIDFILE" 2>/dev/null)
    if [ -n "$DPID" ] && kill -0 "$DPID" 2>/dev/null; then
      sleep 3
      if kill -0 "$DPID" 2>/dev/null && curl -s -m 2 -o /dev/null "$URL/"; then
        return 0
      fi
    fi
    # 快速出口:启动 5 秒后,如果端口已被占但我们的 pid 已死(EADDRINUSE),
    # 判定为"foreign dsh 占着端口",不再等满 60s;主循环会按规则接管。
    if [ "$i" -ge 5 ] && curl -s -m 2 -o /dev/null "$URL/"; then
      return 1
    fi
    i=$((i+1)); sleep 1
  done
  return 1
}

# 接管路径:仅当端口有 dsh + DSH_PIDFILE 记录的 pid 还活 + 是我们启过的进程才接管。
# 否则启新。指纹检查不可靠(网络抖动/cURL 超时)被有意弱化。
adopted_pid=""
if curl -s -m 2 "$URL/" 2>/dev/null | grep -q "__DSH_BOOT__"; then
  if [ -f "$DSH_PIDFILE" ]; then
    DPID=$(cat "$DSH_PIDFILE" 2>/dev/null)
    if [ -n "$DPID" ] && kill -0 "$DPID" 2>/dev/null; then
      adopted_pid="$DPID"
    fi
  fi
fi

if [ -n "$adopted_pid" ]; then
  echo "$(stamp) adopt existing dsh pid=$adopted_pid on port $PORT" >> "$DAEMON_LOG"
else
  if [ ! -x "$DSH" ]; then
    echo "$(stamp) dsh-bin-missing: $DSH" >> "$DAEMON_LOG"
    exit 1
  fi
  pid=$(start_dsh)
  if max_dsh_ready; then
    echo "$(stamp) dsh ready on port $PORT (pid $pid)" >> "$DAEMON_LOG"
  else
    # EADDRINUSE 等:我们的新进程被旧 dsh 顶掉。不退出,守护继续监测端口状态。
    echo "$(stamp) initial start failed (pid=$pid died); foreign dsh may hold port; daemon will retry" >> "$DAEMON_LOG"
  fi
fi

# --- 守护循环 ---
# 三种状态分支:
#   (port_ok && pid_ok)           健康,sleep 20s
#   (port_ok && !pid_ok)          端口被别的 dsh 占,我们的 pid 死了;等
#   (!port_ok)                    端口空,重启 dsh
while true; do
  DPID=$(cat "$DSH_PIDFILE" 2>/dev/null)
  port_ok=0
  curl -s -m 2 -o /dev/null "$URL/" && port_ok=1
  pid_ok=0
  if [ -n "$DPID" ] && kill -0 "$DPID" 2>/dev/null; then pid_ok=1; fi

  if [ "$port_ok" = "1" ] && [ "$pid_ok" = "1" ]; then
    sleep 20
    continue
  fi

  if [ "$port_ok" = "1" ] && [ "$pid_ok" = "0" ]; then
    echo "$(stamp) our dsh (pid=$DPID) gone but port still held by other dsh; waiting" >> "$DAEMON_LOG"
    sleep 20
    continue
  fi

  echo "$(stamp) dsh down (port=$port_ok pid=$pid_ok), restarting" >> "$DAEMON_LOG"
  pid=$(start_dsh)
  if max_dsh_ready; then
    echo "$(stamp) dsh ready again on port $PORT (pid $pid)" >> "$DAEMON_LOG"
  else
    echo "$(stamp) dsh restart failed (pid=$pid died); will retry next cycle" >> "$DAEMON_LOG"
  fi
  sleep 5
done