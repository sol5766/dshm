/**
 * 重连退避（D2 §3，必须逐档实现）。
 *
 * 档位：500ms → 1s → 2s → 4s → 8s → 10s（上限），每档抖动 50%–100%。
 * 10s 档再失败进入 `disconnected` 终态；`reconnect()` 立即从第 1 档重来。
 */

import { RetryProgress } from './Types';

/** 退避档位表（毫秒） */
export const BACKOFF_STEPS_MS: number[] = [500, 1000, 2000, 4000, 8000, 10000];

/** 抖动下限比例 */
const JITTER_MIN: number = 0.5;

/**
 * 计算第 attempt 档（1 起）的实际等待毫秒，含 50%–100% 抖动。
 * attempt 超过档位数时固定使用最后一档。
 */
export function backoffDelayMs(attempt: number, random: number = Math.random()): number {
  const index: number = Math.min(Math.max(attempt, 1), BACKOFF_STEPS_MS.length) - 1;
  const base: number = BACKOFF_STEPS_MS[index];
  const clamped: number = Math.min(Math.max(random, 0), 1);
  const factor: number = JITTER_MIN + (1 - JITTER_MIN) * clamped;
  return Math.round(base * factor);
}

/** 是否为可继续重试的档位（未超过上限档数） */
export function isRetryable(attempt: number): boolean {
  return attempt <= BACKOFF_STEPS_MS.length;
}

/**
 * 重连调度器：只负责「第几档 + 等待多少毫秒 + 何时进入终态」，
 * 不持有连接本身（连接建立由调用方注入）。
 */
export class ReconnectController {
  private attempt: number = 0;
  private timer?: number;
  private stopped: boolean = false;

  /** 当前档位（1 起；0 表示尚未重试） */
  currentAttempt(): number {
    return this.attempt;
  }

  /** 重置到第 1 档（对应上游「重新连接」语义） */
  reset(): void {
    this.attempt = 0;
    this.cancelTimer();
  }

  /** 标记成功：档位归零 */
  succeeded(): void {
    this.attempt = 0;
    this.cancelTimer();
  }

  /** 停止调度（永久） */
  stop(): void {
    this.stopped = true;
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * 安排下一次尝试。
   * @param run 执行一次连接尝试；返回 true 表示成功（不再重试）
   * @param onProgress 每次安排重试时的进度回调（供 UI 展示）
   * @param onExhausted 超过上限档位仍失败时回调（进入终态）
   */
  schedule(run: () => Promise<boolean>,
    onProgress: (progress: RetryProgress) => void,
    onExhausted: () => void): void {
    if (this.stopped) {
      return;
    }
    this.cancelTimer();
    this.attempt += 1;
    if (!isRetryable(this.attempt)) {
      onExhausted();
      return;
    }
    const delayMs: number = BACKOFF_STEPS_MS[Math.min(this.attempt, BACKOFF_STEPS_MS.length) - 1];
    const waitMs: number = backoffDelayMs(this.attempt);
    const progress: RetryProgress = { attempt: this.attempt, delayMs: delayMs, waitMs: waitMs };
    onProgress(progress);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      run().then((ok: boolean) => {
        if (ok) {
          this.succeeded();
        } else {
          this.schedule(run, onProgress, onExhausted);
        }
      }).catch((_error: Object) => {
        this.schedule(run, onProgress, onExhausted);
      });
    }, waitMs);
  }
}
