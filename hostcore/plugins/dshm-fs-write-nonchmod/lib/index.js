/**
 * DSHM 端侧 **去 `chmod` 的 `ctx.fs` 后端**（`dshm-fs-write-nonchmod`）。
 *
 * ── 缺口（根因，已是定论，不再调查）──────────────────────────────────────
 * 上游本地后端 `@deepseek-ai/dsh-fs-local` 的 `writeFileAtomic()`
 * （lib/index.js:494-543）每一步都用 `chmod` 保护暂存目录/暂存文件：
 * `mkdir(stagingDir,{mode:448})` → **`chmod(stagingDir,448)`** → `open(tempPath,"wx",384)`
 * → **`handle.chmod(384)`** → `writeFile` → `if(mode!==void 0) handle.chmod(mode)`
 * → `rename(tempPath, absolutePath)`。
 * 鸿蒙 hmdfs 的**用户可见公共目录不放行 `chmod`** ⇒ 死在第二句，逐字报文：
 *   `Error: EPERM: operation not permitted, chmod
 *    '/storage/Users/currentUser/Download/com.dshm.dshclient/.手测-01.txt.<pid>.<uuid>.tmpdir'`
 * ⇒ 只要写入路径依赖 `chmod`，"agent 往 `Download/<包名>/` 写文件"必然失败。
 * 本包把落盘换成**同目录 `.partial` + `rename`**（原子、不用 `chmod`），细节见
 * `lib/fsio-nochmod.js` 文件头。
 *
 * ── 为什么用"换 `ctx.fs` 后端"这个插入点（而不是改上游 / 改工具 / 包一层）──
 * 上游自己把 `ctx.fs` 定义成**可替换契约**：`@deepseek-ai/dsh-fs` 的 `FileSystem`
 * 是 Service Definition，`@deepseek-ai/dsh-fs-sandbox` 的头注逐字写着
 * "Registers as `ctx.fs`（loading it INSTEAD OF `dsh-fs-local` is the whole swap）"。
 * 本端 profile 里真正注册 `ctx.fs` 的就是 `dsh-base` 的 `fs-sandbox` 行
 * （`@deepseek-ai/dsh-fs-sandbox`）。于是最合法、最小、最可逆的插入点是：
 *   **把 `fs-sandbox` 那一行换成本插件，本插件 `extends SandboxedFileSystem`，
 *   只重写 `writeText` / `editText` 两个方法，其余（resolve / stat / lstat / 读 /
 *   流 / listDir / 路径封闭 / sandboxMode / per-target 锁 / 版本语义）逐字继承上游。**
 * 三条理由：
 *   ① 不动模型可见的工具集（`dsh-tool-fs` 的 read/write/edit、`dsh-tool-str-replace-editor`
 *      一个字不改），也不动 `fs/*` 策略瀑布（`fs/write-intent`、`fs/edit-intent`、
 *      `fs/observed` 全在**工具层**发射，后端本来就不发事件——见简报 §契约对照）；
 *   ② 不动 `tools/device` 上的任何既有文件（除 profile 的一行覆盖 + pack 清单）；
 *   ③ 完全可逆：删掉 profile 的那两行 + `insert` 那一行即回到上游行为。
 * 不选"打包期文本改写上游 `dsh-fs-local`"的理由：那会让本修复随上游行号/文案漂移，
 * 且与本仓库"自带能力走自带插件"的既有约定（`dshm-tool-fs-remove` 等）不一致。
 *
 * ── 本插件改了什么（逐处）────────────────────────────────────────────────
 * 只重写两个方法，字节级对应关系见 `lib/fsio-nochmod.js` 头部：
 *   · `writeText(target, content, expected, signal, sandboxPolicy)`
 *       = `SandboxedFileSystem.checkedTarget()` 的路径封闭（原样复用）
 *       → `withLock(target.targetKey)` 的 per-target 串行化（原样复用）
 *       → `probe()` 的 version/type/mode（逐字 vendored）
 *       → `FS_NOT_REGULAR_FILE` / `FS_STALE_VERSION` / `FS_NOT_OBSERVED` 三处守卫（逐字同源）
 *       → `readTextForDiff()` 的 diff 基线（逐字 vendored）
 *       → **`writeFileAtomicNoChmod()`（同目录 `.partial` + `rename` 的原子落盘，
 *         替代上游 `writeFileAtomic()`）**
 *       → `versionAfterWrite()` + 与上游同形的返回对象。
 *   · `editText(target, edit, expected, signal, sandboxPolicy)`：同样只把中间的
 *     `writeFileAtomic()` 换成 `writeFileAtomicNoChmod()`，版本检查 / 字面替换 /
 *     行尾还原全部与上游逐字同源。
 * **不碰**：`resolve` / `stat` / `lstat` / `readText` / `streamText` / `readBytes` /
 * `readByteRange` / `listDir` / `processPath` / `fileUrl` / `contains` / `sandboxMode`。
 * **不调用**：`chmod` / `fchmod` / `handle.chmod` / `fs.promises.chmod`（本包全树除
 * 注释外零命中，由 harness 的调用计数断言复核）；也不调用 `link`（沙箱内被拒）。
 * 落盘只用 `mkdir` / `open('w')` / `write` / `close` / `rename`（同目录）/ `unlink`。
 *
 * ── 语义差异（如实登记）──────────────────────────────────────────────────
 * ① `createIfAbsent` 的 no-clobber 从"发布期"降级为"检查期"（锁内前置探测）；
 *    同进程并发完全等价，仅"进程外并发创建者"窗口不再原子守住。
 * ② `fsync` 失败不判写入失败（字节已写进临时件），只打 stderr 警告。
 * ③ `handle.close()` 失败时临时件被清掉、错误原样上抛，目标文件不受影响。
 * ④ 权限位：覆写时临时件继承目标 mode、`rename` 把它带过去；新建为 `0o600`。
 * 详见 `lib/fsio-nochmod.js` 文件头。
 *
 * ── 恢复条件 ─────────────────────────────────────────────────────────────
 * 上游若把 `writeFileAtomic()` 的 `chmod` 去掉（或改成"失败可容忍"），把
 * `hostcore/profile/ondevice/cordis.patch.yml` 里 `fs-sandbox` 的 `disabled: true`
 * 与末尾 `insert:` 的那一行删掉、并把 `tools/pack-core.mjs` 的 `DSHM_PLUGIN_PACKAGES`
 * 里本项删掉即可完全回到上游行为。
 *
 * @module dshm-fs-write-nonchmod
 */
import { FsError } from "@deepseek-ai/dsh-fs";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";
import {
	applyLiteralEdit,
	normalizeLineEndings,
	probe,
	readForEdit,
	readTextForDiff,
	restoreLineEndings,
	writeFileAtomicNoChmod
} from "./fsio-nochmod.js";

/**
 * 去 `chmod` 的本地文件系统后端：`SandboxedFileSystem` 的写入方法替换版。
 *
 * 读与路径语义**全部继承上游**（`extends SandboxedFileSystem`），只有
 * `writeText` / `editText` 的"落盘那一步"换成 `writeFileAtomicNoChmod()`
 * （同目录 `.partial` + `rename`，原子且不调用 `chmod`）。
 */
export class NonChmodFileSystem extends SandboxedFileSystem {
	/**
	 * 与 `@deepseek-ai/dsh-fs-sandbox` 逐字同源的插入声明：路径封闭需要 `sandboxPolicy`
	 * 服务。显式重写一份（而不是靠静态继承）是因为"本插件依赖什么"必须是本插件自己
	 * 可读的事实，不让读者去猜继承链。
	 */
	static inject = ["sandboxPolicy"];

	/**
	 * 原子创建/覆写 UTF-8 文本——与 `LocalFileSystem.writeText` 逐项同形，
	 * 只把 `writeFileAtomic()` 换成 `writeFileAtomicNoChmod()`。
	 * @param target - 已解析的目标。
	 * @param content - 完整的新文件内容。
	 * @param expected - 写入意图守卫；缺省表示无条件。
	 * @param signal - 取消信号。
	 * @param sandboxPolicy - 本次调用的沙箱策略；缺省用部署默认值。
	 * @returns 与上游同形的 `FsWriteOutcome`。
	 */
	async writeText(target, content, expected, signal, sandboxPolicy) {
		/* 路径封闭与上游 `SandboxedFileSystem.writeText` 同一调用、同一时机：
		 * 先按本次策略算出**这一份**要写的 target，再进入临界区（无 check-here-write-there）。 */
		const checked = await this.checkedTarget(target, sandboxPolicy);
		return this.withLock(checked.targetKey, async () => {
			const existing = await probe(checked.targetKey);
			if (existing && existing.type !== "file") throw new FsError(`cannot write "${checked.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE");
			if (expected?.kind === "replaceIfVersion") {
				if (!existing) throw new FsError(`cannot write "${checked.displayPath}": file no longer exists`, "FS_STALE_VERSION");
				if (existing.version !== expected.version) throw new FsError(`cannot write "${checked.displayPath}": file changed since it was read`, "FS_STALE_VERSION");
			} else if (expected?.kind === "createIfAbsent" && existing) throw new FsError(`cannot overwrite existing "${checked.displayPath}" without reading it first`, "FS_NOT_OBSERVED");
			const before = existing !== null && Buffer.byteLength(content, "utf8") < this.config.diffBasisMaxBytes ? await readTextForDiff(checked.targetKey, this.config.diffBasisMaxBytes, signal) : null;
			await writeFileAtomicNoChmod(checked.targetKey, content, existing?.mode, signal);
			const after = await probe(checked.targetKey);
			return {
				operation: existing ? "update" : "create",
				version: this.versionAfterWrite(after, checked),
				before,
				after: normalizeLineEndings(content)
			};
		});
	}

	/**
	 * 原子字面编辑——与 `LocalFileSystem.editText` 逐项同形，
	 * 只把 `writeFileAtomic()` 换成 `writeFileAtomicNoChmod()`。
	 * @param target - 已解析的目标。
	 * @param edit - 字面 search/replace 请求。
	 * @param expected - 版本守卫；缺省表示无前置条件。
	 * @param signal - 取消信号。
	 * @param sandboxPolicy - 本次调用的沙箱策略；缺省用部署默认值。
	 * @returns 与上游同形的 `FsEditOutcome`。
	 */
	async editText(target, edit, expected, signal, sandboxPolicy) {
		const checked = await this.checkedTarget(target, sandboxPolicy);
		return this.withLock(checked.targetKey, async () => {
			const existing = await probe(checked.targetKey);
			if (!existing) throw new FsError(`cannot edit "${checked.displayPath}": file changed since it was read`, "FS_STALE_VERSION");
			if (existing.type !== "file") throw new FsError(`cannot edit "${checked.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE");
			if (expected && existing.version !== expected.version) throw new FsError(`cannot edit "${checked.displayPath}": file changed since it was read`, "FS_STALE_VERSION");
			const original = await readForEdit(checked.targetKey, checked.displayPath, signal);
			const edited = applyLiteralEdit(original.content, edit.oldString, edit.newString, edit.replaceAll, checked.displayPath);
			const content = restoreLineEndings(edited.content, original.lineEndings);
			await writeFileAtomicNoChmod(checked.targetKey, content, existing.mode, signal);
			const after = await probe(checked.targetKey);
			return {
				version: this.versionAfterWrite(after, checked),
				before: original.content,
				after: edited.content
			};
		});
	}
}

export default NonChmodFileSystem;
