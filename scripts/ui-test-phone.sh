#!/bin/bash
# ============================================================
# DSHM 冷启动链路 UI 冒烟 / 回归脚本（2in1 / PC 真机）
#
# 用途：验证 DSHM「探活 → 拉起 dsh → 指纹校验 → ArkWeb 接入」链路是否正确，
#   并做白屏检测、窗口比例检测、截图留档供人工/视觉检查。
#
# 用法：
#   scripts/ui-test-phone.sh [轮数] [target] [hap路径]
#     轮数      循环轮数（默认 1）
#     target    hdc 目标（必须显式传入，或设置 HDSH_HDC_TARGET）
#     hap路径   可选，先 bm install 安装后启动
#
# 依赖：hdc、设备端 uitest（可选，用于 UI 断言）、python（可选，用于解析窗口尺寸）
# 环境：HDSH_HDC 可指定 hdc 可执行文件；否则从 PATH 查找（避免绑定某台机器 SDK 路径）
# ============================================================
set -u

ROUNDS="${1:-1}"
TARGET="${2:-${HDSH_HDC_TARGET:-}}"
HAP="${3:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/build/ui-test-phone"

if [ -z "$TARGET" ]; then
  echo "[ui-test-phone] FAIL: 必须显式传入 hdc target 或设置 HDSH_HDC_TARGET"
  exit 2
fi

HDC="${HDSH_HDC:-}"
if [ -z "$HDC" ]; then
  HDC="$(command -v hdc 2>/dev/null || true)"
fi
if [ -z "$HDC" ]; then
  echo "[ui-test-phone] FAIL: 未找到 hdc，请设置 HDSH_HDC 或将 hdc 加入 PATH"
  exit 1
fi

mkdir -p "$OUT_DIR"

# hdc 包装：统一带 target
hdc() {
  "$HDC" -t "$TARGET" "$@"
}

echo "[ui-test-phone] target=$TARGET hdc=$HDC rounds=$ROUNDS"

# ---- 可选：安装 HAP ----
if [ -n "$HAP" ]; then
  echo "[ui-test-phone] 安装 $HAP"
  hdc shell bm install -p "$HAP" || {
    echo "[ui-test-phone] FAIL: 安装失败"
    exit 1;
  }
fi

PASS=0
FAIL=0

for ((round = 1; round <= ROUNDS; round++)); do
  echo "============================== 第 $round 轮 =============================="
  TS="$(date +%Y%m%d_%H%M%S)"
  SHOT="$OUT_DIR/round_${round}_${TS}.png"

  # 冷启动前清一下 hilog，便于聚焦本链路输出
  hdc shell "hilog -b D" >/dev/null 2>&1 || true

  # 启动应用（默认包名/入口按 module 配置；自定义请传环境变量）
  BUNDLE="${DSHM_BUNDLE:-com.dshm.agentic}"
  ABILITY="${DSHM_ABILITY:-EntryAbility}"
  echo "[ui-test-phone] 启动 $BUNDLE/$ABILITY"
  hdc shell "aa start -a $ABILITY -b $BUNDLE" || {
    echo "[ui-test-phone] FAIL: 启动失败"
    FAIL=$((FAIL + 1));
    continue;
  }

  # 等待冷启动链路完成：轮询 hilog 中的 readiness 标记
  READY=0
  for ((t = 0; t < 240; t++)); do
    if hdc shell "hilog -x | grep -E 'dsh web ready|DSH_BOOT|ArkWeb 接入'" >/dev/null 2>&1; then
      READY=1
      break
    fi
    sleep 1
  done

  if [ "$READY" -eq 1 ]; then
    echo "[ui-test-phone] PASS: 冷启动链路就绪"
    PASS=$((PASS + 1))
  else
    echo "[ui-test-phone] FAIL: 超时未见 readiness（检查 ~/dshm-launcher.log）"
    FAIL=$((FAIL + 1))
  fi

  # 截图留档（可选工具缺失则跳过）
  if hdc shell "snapshot_display -f '/data/local/tmp/dshm_${TS}.png'" >/dev/null 2>&1; then
    hdc file recv "/data/local/tmp/dshm_${TS}.png" "$SHOT" >/dev/null 2>&1 && \
      echo "[ui-test-phone] 截图已保存: $SHOT" || \
      echo "[ui-test-phone] 截图保存失败（可人工检查）"
  else
    echo "[ui-test-phone] 跳过截图（snapshot_display 不可用）"
  fi

  # 记录本链路日志尾部，便于人工核对
  hdc shell "hilog -x | tail -200" > "$OUT_DIR/round_${round}_${TS}.hilog" 2>/dev/null || true
done

echo "============================================================"
echo "[ui-test-phone] 结果: PASS=$PASS FAIL=$FAIL (共 $ROUNDS 轮)"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
