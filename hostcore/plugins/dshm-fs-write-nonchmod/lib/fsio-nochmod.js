/**
 * 去 `chmod` 的本地文件写入机制（DSHM 端侧）。
 *
 * ── 缺口：上游的写入原语要求 `chmod` ──────────────────────────────────────
 * 上游 `@deepseek-ai/dsh-fs-local` 的 `writeFileAtomic()`（lib/index.js:494-543）用
 * "私有暂存目录 + 原子发布"实现写入，其中前三步都调用 `chmod`：
 *
 *   await mkdir(stagingDir, { mode: 448 });   // 0o700
 *   await chmod(stagingDir, 448);             // ← 鸿蒙 hmdfs 公共目录在这一句报 EPERM
 *   handle = await open(tempPath, "wx", 384); // 0o600
 *   await handle.chmod(384);                  // ← 同类调用
 *   ...
 *   if (mode !== void 0) await handle.chmod(mode);
 *   await rename(tempPath, absolutePath);
 *
 * 鸿蒙 hmdfs 的**用户可见公共目录**不放行 `chmod`（会话 cwd = `Download/<包名>`），
 * 逐字报文：
 *   Error: EPERM: operation not permitted, chmod
 *   '/storage/Users/currentUser/Download/com.dshm.dshclient/.手测-01.txt.41316.<uuid>.tmpdir'
 * ⇒ 写入路径只要依赖 `chmod`，"agent 往用户可见目录写文件"就不可能成功。
 *
 * ── 本实现：同目录 `.partial` + `rename`（原子），全程不用 `chmod` ─────────
 *   · 同目录建隐藏临时**文件** `.<basename>.<pid>.<uuid>.partial`（不是目录，与上游
 *     的 `.<名字>.<pid>.<uuid>.tmpdir` 命名不冲突）；
 *   · `open(temp,'w'[,mode])` → `writeFile(buf)` → `sync()`（失败只告警）→ `close()`；
 *   · `rename(temp, target)` —— 换上去这一步是原子的；
 *   · 任何一步失败：清掉临时件并把错误**原样上抛**，目标文件保持原样（旧内容完好，
 *     或根本不存在）；
 *   · 覆写时把**目标既有 mode** 交给 `open`（`rename` 会把临时件的 mode 带过去，而
 *     `open` 的 mode 实参只对**新建**的临时件生效）⇒ 不用 `chmod` 也能保住权限位；
 *   · 写入前清掉**同目标**、同命名模式的遗留 `.partial`（只匹配本实现的名字形状，
 *     同目录里的其它文件一概不碰）。
 * 用到的原语：`mkdir` / `open('w')` / `write` / `close` / `rename` / `unlink`，全部
 * 落在已验证放行的组合里。`rename` 只用于**同一目录内**的改名（`move` 工具在同一
 * 目录内的改名可用；跨目录 / `EXDEV` 不在本实现的设计内，也不被依赖）。
 *
 * ── 与上游的语义差异（如实登记）──────────────────────────────────────────
 * ① `createIfAbsent` 的 no-clobber 由**锁内前置探测**提供（上游在发布期用硬链接 /
 *    rename 做 no-replace）：同一进程序列化完全等价，仅"进程外并发创建者"这一个
 *    窗口不再被原子守住。
 * ② `fsync` 失败不再让写入失败：字节已写进临时件，`sync` 只影响 durability，故本
 *    实现尝试 sync、失败时打一条 stderr 警告（`process.emitWarning`）后继续。
 * ③ `handle.close()` 失败 ⇒ 临时件被清掉、错误原样上抛，目标文件不受影响（上游把它
 *    折成 `FS_NOT_FOUND`）。
 * ④ 权限位：覆写时由"临时件继承目标 mode"保住；新建文件 `0o600`（与上游
 *    `open(tempPath,"wx",384)` 同值）；两者同样受进程 umask 掩码。
 *
 * ── vendored 来源（MIT）────────────────────────────────────────────────────
 * 下面带"逐字同源"注释的函数，逐字节抄自
 * `@deepseek-ai/dsh-fs-local/lib/index.js`（本机版本 0.1.5-rc.2）的 `lib/types/fsio.js`
 * 区段，只改了导出形式与注释。抄而不 import 的理由：它们是**模块私有**函数，上游没有
 * 导出（`export { LocalFileSystem, LocalFileSystem as default }` 只导出服务类），
 * 而写入的临界区必须是"版本探测 + 读旧值 + 写新值"同一套语义，少抄一个都会漂移。
 *
 * @module dshm-fs-write-nonchmod/fsio
 */
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import { FsError, FsVersion } from "@deepseek-ai/dsh-fs";
import { describeWriteFailure } from "./denial-hints.js";

/** 二进制采样的字节数——与上游 `BINARY_SAMPLE_BYTES` 逐字同源。 */
const BINARY_SAMPLE_BYTES = 8192;
/** diff 基线的分块读大小——与上游 `DIFF_BASIS_READ_CHUNK_BYTES` 逐字同源。 */
const DIFF_BASIS_READ_CHUNK_BYTES = 64 * 1024;
/**
 * 新建文件的权限位 `0o600`——与上游 `open(tempPath, "wx", 384)` 的第三个实参逐字一致
 * （上游新建文件的最终 mode 就是这个值，因为 `mode === undefined` 时它不 chmod）。
 */
const NEW_FILE_MODE = 384;
/** 同目录临时件的后缀：点号前缀（隐藏）+ `.partial` 结尾，与上游 `.tmpdir` 不撞名。 */
const PARTIAL_SUFFIX = ".partial";
/**
 * 临时件名字里"`.<pid>.<uuid>`"那一段的形状（`uuid` 与 `randomUUID()` 同形）。
 * 残渣清理**只**认这一整形状 ⇒ 同目录里的诱饵 / 别人的文件不会被误删。
 */
const PARTIAL_MIDDLE = "\\.[0-9]+\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.partial$";

function isENOENT(error) {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function isENOTDIR(error) {
	return error instanceof Error && "code" in error && error.code === "ENOTDIR";
}
function isAbortError(error) {
	return error instanceof Error && error.name === "AbortError";
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
/** 取消检查——文案与上游 `throwIfAborted` 逐字同源（`<verb> aborted` / `FS_ABORTED`）。 */
function throwIfAborted(signal, verb) {
	if (signal?.aborted) throw new FsError(`${verb} aborted`, "FS_ABORTED");
}
/**
 * 带信号的 `readFile`，把中途的 `AbortError` 翻成 `FS_ABORTED`
 * （逐字同源于上游 `readFileAbortable`）。
 */
async function readFileAbortable(absolutePath, verb, signal) {
	try {
		return await readFile(absolutePath, signal ? { signal } : {});
	} catch (error) {
		if (!isAbortError(error)) throw error;
		throw new FsError(`${verb} aborted`, "FS_ABORTED");
	}
}
/** 版本串——与上游 `versionOf` 逐字同源，保证版本比较与上游完全同一口径。 */
function versionOf(info) {
	return FsVersion(`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`);
}
function pathType(info) {
	if (info.isFile()) return "file";
	if (info.isDirectory()) return "directory";
	return "other";
}
async function probeStats(absolutePath, readStats) {
	try {
		return await readStats(absolutePath);
	} catch (error) {
		if (!isENOENT(error) && !isENOTDIR(error)) throw error;
		return null;
	}
}
/**
 * 探测路径的 version / mode / type / size；不存在（或父段不是目录）返回 `null`。
 * 逐字同源于上游 `probe`——`mode` 正是上游写路径用来"保留权限位"的那个值。
 * @param absolutePath - 要 stat 的路径（跟随符号链接，通常就是 targetKey）。
 * @returns 元数据，或 `null`。
 */
export async function probe(absolutePath) {
	const info = await probeStats(absolutePath, (path) => stat(path, { bigint: true }));
	if (!info) return null;
	return {
		version: versionOf(info),
		mode: Number(info.mode & 511n),
		type: pathType(info),
		size: Number(info.size)
	};
}
/** 行尾归一化——与上游 `normalizeLineEndings` 逐字同源。 */
export function normalizeLineEndings(content) {
	return content.replaceAll("\r\n", "\n");
}
/** 行尾探测——与上游 `detectLineEndings` 逐字同源。 */
function detectLineEndings(raw) {
	const sample = raw.slice(0, 4096);
	const crlfCount = sample.split("\r\n").length - 1;
	return crlfCount > sample.split("\n").length - 1 - crlfCount ? "CRLF" : "LF";
}
/** 行尾还原——与上游 `restoreLineEndings` 逐字同源。 */
export function restoreLineEndings(content, lineEndings) {
	return lineEndings === "LF" ? content : normalizeLineEndings(content).split("\n").join("\r\n");
}
function countOccurrences(content, needle) {
	let count = 0;
	let index = 0;
	while (true) {
		const found = content.indexOf(needle, index);
		if (found === -1) return count;
		count += 1;
		index = found + needle.length;
	}
}
/** 非 UTF-8 文案——与上游 `notTextError` 逐字同源。 */
function notTextError(verb, displayPath) {
	return new FsError(`cannot ${verb} "${displayPath}": invalid UTF-8 text`, "FS_NOT_TEXT");
}
/** 严格 UTF-8 解码——与上游 `decodeUtf8` 逐字同源。 */
function decodeUtf8(buffer, verb, displayPath) {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		throw notTextError(verb, displayPath);
	}
}
/**
 * 读并解码一个待编辑文件：拒绝二进制，返回 LF 归一化后的内容 + 原行尾风格。
 * 与上游 `readForEdit` 逐字同源（含 `FS_NOT_TEXT` 的文案）。
 * @param absolutePath - 要读的文件（通常是 targetKey）。
 * @param displayPath - 报错文案里给调用方看的路径。
 * @param signal - 取消（`FS_ABORTED`）。
 * @returns `{ content, lineEndings }`。
 */
export async function readForEdit(absolutePath, displayPath, signal) {
	throwIfAborted(signal, "edit");
	const buffer = await readFileAbortable(absolutePath, "edit", signal);
	throwIfAborted(signal, "edit");
	if (buffer.includes(0)) throw new FsError(`cannot edit "${displayPath}": binary file`, "FS_NOT_TEXT");
	const raw = decodeUtf8(buffer, "edit", displayPath);
	return {
		content: normalizeLineEndings(raw),
		lineEndings: detectLineEndings(raw)
	};
}
/**
 * 尽力而为的"覆写前 diff 基线"：二进制 / 非法 UTF-8 / 达到或超过字节上限 / 读不到，
 * 一律返回 `null`，让写入照常成功、呈现层退回整文件 diff。
 * 与上游 `readTextForDiff` 逐字同源（含边界判定口径）。
 * @param absolutePath - 要读的文件（通常是 targetKey）。
 * @param maxBytes - 作为 diff 基线的**排他**上界。
 * @param signal - 取消会传播（`FS_ABORTED`），与 I/O 失败不同。
 * @returns LF 归一化后的文本，或 `null`。
 */
export async function readTextForDiff(absolutePath, maxBytes, signal) {
	throwIfAborted(signal, "read");
	try {
		const handle = await open(absolutePath, "r");
		let buffer;
		let total = 0;
		let openedSize = 0;
		try {
			throwIfAborted(signal, "read");
			const info = await handle.stat();
			throwIfAborted(signal, "read");
			if (!info.isFile()) return null;
			if (info.size >= maxBytes) return null;
			openedSize = info.size;
			buffer = Buffer.allocUnsafe(openedSize + 1);
			while (total < buffer.length) {
				throwIfAborted(signal, "read");
				const length = Math.min(buffer.length - total, DIFF_BASIS_READ_CHUNK_BYTES);
				const { bytesRead } = await handle.read(buffer, total, length, null);
				if (bytesRead === 0) break;
				total += bytesRead;
			}
		} finally {
			await handle.close();
		}
		throwIfAborted(signal, "read");
		if (total !== openedSize) return null;
		const basis = buffer.subarray(0, total);
		if (basis.includes(0)) return null;
		try {
			return normalizeLineEndings(new TextDecoder("utf-8", { fatal: true }).decode(basis));
		} catch (error) {
			if (!(error instanceof TypeError)) throw error;
			return null;
		}
	} catch (error) {
		if (error instanceof FsError) throw error;
		if (error instanceof Error && "code" in error) return null;
		throw error;
	}
}
/**
 * 把字面替换作用在 LF 归一化后的内容上。
 * 与上游 `applyLiteralEdit` 逐字同源（`FS_EDIT_NOT_FOUND` / `FS_AMBIGUOUS_EDIT` 文案也一致）。
 * @param content - 当前内容（已 LF 归一化）。
 * @param oldString - 要查找的字面文本（内部 CRLF 先归一化）。
 * @param newString - 替换文本（同样归一化）。
 * @param replaceAll - 是否替换全部匹配。
 * @param displayPath - 报错文案里给调用方看的路径。
 * @returns `{ content, replacements }`。
 */
export function applyLiteralEdit(content, oldString, newString, replaceAll, displayPath) {
	const oldNorm = normalizeLineEndings(oldString);
	if (oldNorm.length === 0) throw new FsError("old_string must be a non-empty string", "FS_EDIT_NOT_FOUND");
	const newNorm = normalizeLineEndings(newString);
	const replacements = countOccurrences(content, oldNorm);
	if (replacements === 0) throw new FsError(`old_string was not found in "${displayPath}"`, "FS_EDIT_NOT_FOUND");
	if (!replaceAll && replacements > 1) throw new FsError(`old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`, "FS_AMBIGUOUS_EDIT");
	return {
		content: content.split(oldNorm).join(newNorm),
		replacements
	};
}
/**
 * 正则元字符转义（目标文件名会被拼进残渣清理用的正则里，必须按字面匹配）。
 * @param text - 要转义的文本。
 * @returns 可安全拼进 `RegExp` 的文本。
 */
function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
 * 本次写入用的同目录临时件路径：`.<basename>.<pid>.<uuid>.partial`。
 * 每次调用都唯一（`randomUUID`），且与上游的 `.<名字>.<pid>.<uuid>.tmpdir` 不同名。
 * @param absolutePath - 最终目标。
 * @returns 同目录临时件的绝对路径。
 */
function partialPathOf(absolutePath) {
	return join(dirname(absolutePath), `.${basename(absolutePath)}.${process.pid}.${randomUUID()}${PARTIAL_SUFFIX}`);
}
/**
 * "本实现为这个目标留下的临时件"的匹配正则：完整名字形状 + 同目录。
 * 同目录里任何不符合这一形状的文件（诱饵、别人的 `.tmpdir`、普通文件）都不匹配。
 * @param absolutePath - 最终目标。
 * @returns 只匹配本实现临时件的正则。
 */
function partialPatternOf(absolutePath) {
	return new RegExp(`^\\.${escapeRegExp(basename(absolutePath))}${PARTIAL_MIDDLE}`);
}
/**
 * 写入前清掉**同目标**的遗留临时件（上一次硬崩留下的 `.partial`）。
 * 只删"同目录 + 同 basename 前缀 + 完整本实现命名形状"的条目；清理失败只告警，
 * 不影响本次写入（新临时件的名字里带新 uuid，不会撞上任何遗留件）。
 * @param directory - 目标所在目录（已确保存在）。
 * @param absolutePath - 最终目标。
 * @returns 清理完成（或尽力而为后返回）的 Promise。
 */
async function removeStalePartials(directory, absolutePath) {
	let entries;
	try {
		entries = await readdir(directory);
	} catch (error) {
		process.emitWarning(`dshm-fs-write-nonchmod: could not scan "${directory}" for leftover partial files: ${errorMessage(error)}`, "DshmFsWriteWarning");
		return;
	}
	const pattern = partialPatternOf(absolutePath);
	for (const entry of entries) {
		if (!pattern.test(entry)) continue;
		try {
			await unlink(join(directory, entry));
		} catch (error) {
			if (!isENOENT(error)) process.emitWarning(`dshm-fs-write-nonchmod: could not remove the leftover partial file "${join(directory, entry)}": ${errorMessage(error)}`, "DshmFsWriteWarning");
		}
	}
}
/**
 * 失败路径上的临时件清理：尽力而为，**绝不**触碰目标文件。
 * @param tempPath - 本次写入的临时件。
 * @param absolutePath - 最终目标（只用于告警文案）。
 * @returns 清理完成（或尽力而为后返回）的 Promise。
 */
async function removePartial(tempPath, absolutePath) {
	try {
		await unlink(tempPath);
	} catch (error) {
		if (isENOENT(error)) return;
		process.emitWarning(`dshm-fs-write-nonchmod: could not remove the partial file for "${absolutePath}" after a failed write: ${errorMessage(error)}`, "DshmFsWriteWarning");
	}
}
/**
 * 去 `chmod` 的原子写入原语：同目录临时件 + `rename` 发布。
 *
 * 步骤（每一步失败都清掉临时件、原样上抛，目标保持原样）：
 *   ① `mkdir(dirname, {recursive:true})`（与上游同一句）；
 *   ② 清掉同目标的遗留 `.partial`；
 *   ③ `open(temp,'w',mode ?? 0o600)` —— 覆写时 mode = 目标既有权限位，
 *      `rename` 会把它带给目标；新建时与上游同值 `0o600`；
 *   ④ `handle.writeFile(content, {encoding:"utf8", signal?})`（与上游同一句）；
 *   ⑤ `handle.sync()` —— 失败只告警，不判写入失败；
 *   ⑥ `handle.close()`；
 *   ⑦ 再查一次取消信号（与上游在发布前查一次同形）；
 *   ⑧ `rename(temp, absolutePath)` —— 唯一改动目标的那一下。
 *
 * @param absolutePath - 目标文件（父目录不存在会递归创建）。
 * @param content - 要写入的完整 UTF-8 文本。
 * @param mode - 既有文件的权限位（`probe().mode`），新建时传 `undefined`。
 * @param signal - 写前、写中与发布前检查的取消信号。
 * @returns 写入完成（或抛出）后的 Promise；`createIfAbsent` 的 no-clobber 由
 *   **调用方的锁内前置探测**保证，本函数不额外承担发布期守卫（见文件头 ①）。
 */
export async function writeFileAtomicNoChmod(absolutePath, content, mode, signal) {
	throwIfAborted(signal, "write");
	const directory = dirname(absolutePath);
	await mkdir(directory, { recursive: true });
	throwIfAborted(signal, "write");
	await removeStalePartials(directory, absolutePath);
	throwIfAborted(signal, "write");
	const tempPath = partialPathOf(absolutePath);
	let handle = null;
	try {
		/* 只允许 `'w'`：已验证放行的组合。不用 `'wx'`/`O_EXCL`（未验证的 flag 会让"新建
		 * 文件"这一主用例整体失败），no-clobber 由调用方的锁内前置探测提供（见文件头 ①）。 */
		handle = await open(tempPath, "w", mode ?? NEW_FILE_MODE);
		await handle.writeFile(content, {
			encoding: "utf8",
			...signal ? { signal } : {}
		});
		try {
			/* 字节已写进临时件，fsync 只影响 durability ⇒ 不把写入判死，但要留下可观测痕迹。 */
			await handle.sync();
		} catch (syncError) {
			process.emitWarning(`dshm-fs-write-nonchmod: fsync failed after writing "${absolutePath}": ${errorMessage(syncError)}`, "DshmFsWriteWarning");
		}
		await handle.close();
		handle = null;
		throwIfAborted(signal, "write");
		/* 换上去这一下是原子的：在此之前目标一直是旧内容（或不存在）。 */
		await rename(tempPath, absolutePath);
	} catch (error) {
		if (handle !== null) {
			try {
				await handle.close();
			} catch (_closeAfterFailure) {
				/* 失败路径上的二次 close 失败不改写错误：临时件马上被删掉。 */
			}
		}
		await removePartial(tempPath, absolutePath);
		throw isAbortError(error) ? new FsError("write aborted", "FS_ABORTED") : describeWriteFailure(error, absolutePath);
	}
}
