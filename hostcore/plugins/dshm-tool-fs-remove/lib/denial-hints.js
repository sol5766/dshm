/**
 * 「写到磁盘 / 改名那一步被平台拒绝」的 errno → 人话 译码（真机 P1-2，见 docs/108）。
 *
 * ── 为什么单独成一个文件，而且在**两个插件目录里各放一份**─────────────────
 * 用它的两个包是**各自独立分发**的自带插件（`tools/pack-core.mjs` 的
 * `embedDshmToolPackages()` 逐个目录拷进核心树，两者之间没有可共享的包）：
 *   · `dshm-fs-write-nonchmod` —— `write` / `edit` 的落盘那一步；
 *   · `dshm-tool-fs-remove`    —— `publish` 的落盘、`move` 的改名、`remove` 的删除、
 *     以及三个工具解析路径时的 `lstat`。
 * 在本仓的结构里让两者 import 同一个 npm 包做不到，所以做法是**同一份文件逐字节
 * 复制两份**，并由 `tools/check-denial-hints.mjs` 钉住「两份必须逐字节一致」
 * ＋「三档命中与放行的行为正确」＋「三个工具的调用点真的接上了」。
 *
 * ── 判据为什么按字符串 code 而不是数字 errno ──────────────────────────────
 * node 在 Linux / 鸿蒙上把 errno 记成**负数**（EPERM → -1、EACCES → -13、
 * EROFS → -30），按数字判会随平台/版本漂移；字符串 code 才是稳定口径（真机自检
 * 报告里写的「EPERM(1)」是**正**的 C errno，与 node 暴露的字段同名不同号，
 * 正是这条注释要挡的误读）。
 *
 * @module dshm-denial-hints
 */
import { basename, dirname } from "node:path";

/** 三档判据表（errno code → 人话）。两份副本逐字节相同，改动必须同改两处。 */
export const WRITE_DENIAL_HINTS = {
	EPERM: "目录受系统保护、当前没有读写授权（EPERM）",
	EACCES: "当前身份无权访问该目录（EACCES）",
	EROFS: "该位置是只读文件系统（EROFS）"
};

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 把被拒的裸 errno 翻成「用户能读懂」的形态（真机 P1-2，见 docs/108）。
 *
 * 【缺口】上游 / node 把裸错直接抛出来，逐字长这样：
 *   EPERM: operation not permitted, open '…/Documents/报告.md.41230.<uuid>.partial'
 * 里面有三样对用户无意义的东西：本实现的内部临时件名（.partial）、open / rename
 * 这个 syscall 名、以及「被拒的是**目录**、报出来的却是文件」的路径错位。
 * 用户与模型都只能猜。
 *
 * 【为什么改写 message 而不是抛新错】调用方（以及 UI）是按 error.code 分派的；
 * 换成新错误 / 新 code 会改变分派行为，属于超出本缺陷范围的改动。这里因此
 * **只改 message**，把 code / errno / stack 原样留下，并把原始报错附在末尾备查。
 *
 * @param error - 被拒那一步捕获到的错误。
 * @param absolutePath - 该步骤的绝对路径（用来点明「被拒的是哪个目录」）。
 * @param label - `absolutePath` 在文案里的身份。落盘 / 改名 / 删除的**操作数**用
 *   `"路径"`；写下去的那个**目的地文件**用默认值 `"目标文件"`（`write` 的既有文案
 *   因此逐字不变）。
 * @returns 三档命中时是**改写后 message 的原错误对象**；其余情况原样返回（语义不变）。
 */
export function describeWriteFailure(error, absolutePath, label = "目标文件") {
	if (!(error instanceof Error)) return error;
	const code = typeof error.code === "string" ? error.code : "";
	const hint = WRITE_DENIAL_HINTS[code];
	if (hint === void 0) return error;
	const original = errorMessage(error);
	error.message = `${hint}：${dirname(absolutePath)}（${label} ${basename(absolutePath)}）。`
		+ `这是平台策略拒绝，重试无效；请改写到有权限的位置（如本应用认领的 `
		+ `Download/<包名>/ 或沙箱），并如实告诉用户。原始报错：${original}`;
	return error;
}
