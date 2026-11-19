/** Cooperative cancellation: cannot undo a system request already submitted. */
export class SyncTask {
  private valid: boolean = true;

  cancel(): void {
    this.valid = false;
  }

  isCurrent(): boolean {
    return this.valid;
  }

  check(): void {
    if (!this.valid) {
      throw new Error('同步任务已取消；已提交的系统操作无法撤回');
    }
  }
}
