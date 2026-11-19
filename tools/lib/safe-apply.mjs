/**
 * 文件落盘的小工具：先计划、再执行；支持 dry-run 与备份。
 *
 * 【为什么单独抽出来】`place-host-app` 这类工具会覆盖 resfile 生成物，出问题时
 * 没有"改了什么、原内容在哪"的记录。这里把差异判断、备份、dry-run 收成一处，
 * 后续工具可以直接复用同一语义。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/**
 * 计划一次写入（不落盘）。
 * @param {string} dst 目标绝对路径
 * @param {Buffer|string} content 期望内容
 * @returns {{dst:string, exists:boolean, changed:boolean}}
 */
export function planWrite(dst, content) {
  if (!existsSync(dst)) return { dst, exists: false, changed: true };
  const current = readFileSync(dst);
  const next = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return { dst, exists: true, changed: !current.equals(next) };
}

/**
 * 执行计划：dry-run 只返回动作；否则按 changed 写入，`backupDir` 非空时先把旧文件备份。
 * @param {Array<{dst:string, exists:boolean, changed:boolean}>} plans
 * @param {{content: Map<string, Buffer|string>, dryRun?: boolean, backupDir?: string}} options
 * @returns {{written:string[], backedUp:string[], skipped:string[]}}
 */
export function applyPlans(plans, options) {
  const dryRun = options.dryRun === true;
  const backupDir = options.backupDir || '';
  const written = [];
  const backedUp = [];
  const skipped = [];
  for (const plan of plans) {
    if (!plan.changed) { skipped.push(plan.dst); continue; }
    written.push(plan.dst);
    if (dryRun) continue;
    mkdirSync(dirname(plan.dst), { recursive: true });
    if (backupDir.length > 0 && plan.exists) {
      const rel = plan.dst.replace(/^\/+/, '').replace(/[:\\/]+/g, '_');
      const target = join(backupDir, rel);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(plan.dst, target);
      backedUp.push(target);
    }
    const content = options.content.get(plan.dst);
    if (content === undefined) throw new Error(`applyPlans: 缺少内容 ${plan.dst}`);
    writeFileSync(plan.dst, content);
  }
  return { written, backedUp, skipped };
}

/** 备份目录名：<root>/<tool>/<ISO 时间戳>。 */
export function backupDirFor(root, tool, when = new Date()) {
  const stamp = when.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  return join(root, 'dist', 'backups', tool, stamp);
}

export { relative };
