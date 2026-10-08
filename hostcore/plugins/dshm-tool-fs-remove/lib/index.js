/**
 * DSHM 端侧自带的"文件改动"工具：`remove`、`move`、`publish`。
 * 三者都是 `ctx.fs` 契约里**没有**、而模型又必须有的文件操作（见下两节）。
 *
 * ── 为什么需要它（缺口的事实，已核实）────────────────────────────────────
 * dsh 的文件能力是 `ctx.fs` 服务，契约在 `@deepseek-ai/dsh-fs`。该契约**没有**
 * 删除/移动方法：抽象类 `FileSystem` 只声明
 * `watch / sandboxMode / resolve / processPath / processPathFromHostPath / fileUrl /
 *  contains / stat / lstat / readText / streamText / readBytes / readByteRange /
 *  listDir / writeText / editText`
 * （`@deepseek-ai/dsh-fs/lib/types/index.d.ts`，逐行核对：全文不含
 *  `remove` / `rename` / `rm` / `unlink` / `delete` / `move` 任何一个词），策略事件也只有
 * `fs/write-intent`、`fs/edit-intent`、`fs/observed` 三个——**没有删除意图槽**。
 * 而实现层是有的：后端 `@deepseek-ai/dsh-fs-local` 自己
 * `import { …, rename, rm, stat } from "node:fs/promises"`（lib/index.js:10）。
 * 也就是说"能删"这件事存在，但**没有暴露到模型可见的工具集**——模型只有
 * read/write/edit/glob/grep，删不掉任何东西。bash 路线已死（证据：`/system/bin/sh`
 * 被 SELinux MAC 拒 exec、随包 `ash` 同样 `denied`、沙箱内自建 ELF 亦被拒）。
 * 本包就是补上这一个缺口。
 *
 * ── 为什么还需要 `publish`（复制，缺口同样已核实）────────────────────────
 * 目标形态：agent 的成品要落在**用户看得见**的 `Download/<包名>/` 里。正常路径是
 * "直接把工作区 cwd 设成那个目录、就地读写"（ArkTS 认领 + host 侧登记，见 profile ⑧）。
 * 但工作区**可能回退到沙箱**（认领失败 / 探写不过），此时 agent 只能写进
 * `<files>/workspace/…`，用户看不见。把成品搬出去需要一个复制动作，而：
 *   · 端侧**没有 `cp`**，也没有可用的 shell（bash 路线已死，见上）⇒ 只能由工具实现；
 *   · `ctx.fs` 契约同样**没有**复制方法（与没有删除方法是同一个缺口）；
 *   · 复制必须**按字节**（`readFile` → 写 Buffer），不能走文本编解码——二进制与
 *     非 UTF-8 内容经文本层必然损坏。
 * 于是 `publish(source, target?)`：把**沙箱里的一个文件**写到本应用的用户可见下载
 * 目录 `Download/<包名>/`（绝对路径取自 ArkTS 认领后经 `DSHM_PUBLIC_DOWNLOAD`
 * 传进来的那个目录），返回**最终的用户可见绝对路径**供 agent 告知用户。
 * 目标根目录**只认这一个来源**：env 为空时如实报错，**绝不**退到进程 cwd 或沙箱里
 * 另找一个"看起来像"的地方（那正是"静默换地方"）。
 *
 * ── `publish` 的落盘原语（与去 chmod 写入后端同源）────────────────────────
 * `writeFileAtomicBytes()`：`mkdir(dirname)` → 同目录隐藏临时**文件**
 * `.<名字>.<pid>.<uuid>.partial` → `open(temp,'w'[,mode])` →
 * `handle.writeFile(buffer)` → `handle.sync()`（失败只告警）→ `close()` →
 * `rename(temp, target)`。与 `dshm-fs-write-nonchmod` 的
 * `writeFileAtomicNoChmod()` 是同一套原语（那边写 UTF-8 文本，这边写 `Buffer`）。
 * **不使用** `chmod` / `link`：`chmod` 在鸿蒙公共目录报 EPERM，`link` 在沙箱内被拒。
 * `rename` 只用于**同一目录内**的发布（本插件的 `move` 工具同样依赖同目录改名）。
 * 由此得到的行为：
 *   · **原子**：写完、`close` 之后才 `rename` 上去，写入中途失败 / 被取消时目标文件
 *     保持原样（旧内容完好，或根本不存在）；临时件在任何失败路径上都被删掉。
 *   · **不做文本层**：`Buffer` 进 `Buffer` 出，中文与二进制逐字节不变（harness 各有一例）。
 *   · 权限位：新建时用**源文件的 mode**（`cp` 语义），覆写时把**目标既有 mode** 交给
 *     `open` 由 `rename` 带过去 ⇒ 同样不需要 chmod。
 *   · 写入前清掉**同目标**、同命名模式的遗留 `.partial`（只认本实现的名字形状）。
 * 复制完成后发一条 `fs/observed` present 观察（带新版本），使观察策略对**这个目标**
 * 的版本认知与磁盘一致（与 remove/move 发 absent 同一口径）。
 *
 * ── 路径语义：与 POSIX `rm` / `ln` 一致 —— **软链只动链接本身** ──
 * 操作数用的是**模型所给路径的词法绝对路径**，不是 `resolve()` 之后被 realpath 的
 * "目标"：
 *   · `ctx.fs.resolve(path, {cwd})` 只在需要 `displayPath`（回显/报错文案）时用；
 *     它的 `targetKey` 是 `realpath(displayPath)`（`dsh-fs-local/lib/index.js:169-180`
 *     的 `resolveLocalTarget` → `FsTargetKey(await realpath(displayPath))`），
 *     **本插件不再把 `processPath(target)` 当作 `rm` / `rename` 的操作数** ——
 *     那是上一版的真 bug：`rm` 落在链接目标上，链接条目反而留下（悬空链）；
 *     链接指向目录时还会因 `stat` 跟随而索要 `recursive=true`，进而 `rm -r` 删掉整棵
 *     目标树。
 *   · 类型判定用 `ctx.fs.lstat(path, {cwd})`（**不跟随**末段链接，契约
 *     `@deepseek-ai/dsh-fs` 的 `lstat` 就是为此而设：`lib/types/index.d.ts:139-155`
 *     写明"path-shaped, not target-shaped … lets a consumer reject the path itself
 *     before that follow happens"）⇒ 软链的 type 是 `"symlink"`，按"链接文件"处理，
 *     **不需要 `recursive`**；悬空链也能被 lstat 看见 ⇒ 可删。
 *   · 真正的 `rm` / `rename` 用 `displayPath`：相对路径按会话 cwd 解析、绝对路径原样
 *     （归一化由后端的 `localDisplayPath()` 负责，与 `lstat` 同一口径）。
 * 结果：`remove(link)` 只删链接条目；`move(link, link2)` 只挪链接。与 shell 的
 * `rm` / `mv` 对符号链接的行为一致。
 * 唯一的语义缺口（如实记录，见简报 §⑥）：`ctx.emit("fs/observed", …, {kind:"absent"})`
 * 的 target 仍是 realpath 身份；对**软链**而言"链接条目已消失"不等于"该 target 已消失"，
 * 故软链分支**不发**这条观察（否则会让 observation-policy 把仍然存在的链接目标记成
 * absent，从而放松后续写入的读-改-写守卫）。非软链路径照旧发。
 *
 * ── 取舍：删除/移动**绕过 `ctx.fs` 策略层**（如实声明）────────────────────
 * 路径解析仍走 `ctx.fs.resolve()`（同一套 cwd 语义与后端归一化，`displayPath`
 * 也来自它），但真正的 `rm` / `rename` 由本进程的 `node:fs/promises` 执行，
 * 不经过任何 fs 策略瀑布。理由与影响面：
 *   · 上游本来就没有"删除意图"的策略事件可走（见上），所以这不是"绕开一道闸门"，
 *     而是"这道闸门不存在"；
 *   · 端侧 fs 后端是 `danger-full-access`（`hostcore/profile/ondevice/cordis.patch.yml`
 *     的 `sandbox-policy` 行），本来就不加路径范围限制，故实际影响有限。
 * 恢复条件：上游 `@deepseek-ai/dsh-fs` 若提供 remove/rename（含策略事件），
 * 把下面两处 `rm/rename` 改回 `ctx.fs.*` 即可，其余代码不用动。
 *
 * ── 路径范围：工具层**完全不设限**（用户明确要求）────────────────────────
 * 本插件在工具层**不做任何路径范围判断、不做任何确认/审批握手、不接 approval 服务**：
 * 绝对路径、会话 cwd 之外的路径，一律照常执行。唯一的闸门是**操作系统的路径授权**
 * （端侧 `sandbox-policy: danger-full-access` 且 `permission-presets` 的
 * `danger-full-access ⇒ approval: never`，见 cordis.patch.yml —— 工具层没有任何审批
 * 闸门；某个路径能不能删 / 移动 / 写入，由 OS 按包名/沙箱归属决定：自己包名目录内可
 * 删，其余用户目录由 OS 返回拒绝，本插件把该错误**原样上报**）。
 * 工具层唯一保留的失败情形是**解析不了**：相对路径在会话没有 cwd 时无从解析，
 * 此时如实报错而不是退到进程 cwd 去猜（`dsh-fs-local` 的 `resolve()` 在 `opts.cwd`
 * 缺省时会静默用 `config.cwd`，那会变成一个没有报错的错误路径）。
 * 这是本端的决定、**不是上游语义**；上游若提供 remove/rename（含策略事件），
 * 把下面两处 `rm/rename` 改回 `ctx.fs.*` 即可，路径范围策略随之回到 `ctx.fs`。
 *
 * @module dshm-tool-fs-remove
 */
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { FsError, FsVersion } from "@deepseek-ai/dsh-fs";
import { describeWriteFailure } from "./denial-hints.js";

/** Stable Loader identity. */
const name = "tool-fs-remove";
/** Services required: the tool registry, the fs seam (path resolution), prompt sections. */
const inject = ["tools", "fs", "systemPrompt"];

/**
 * The session workspace cwd for this call, or `undefined` when none applies.
 * 与 `@deepseek-ai/dsh-tool-fs/lib/index.js` 的 `sessionCwd()` 逐字同源。
 */
function sessionCwd(exec) {
	return exec.agent?.session.header.cwd;
}

/**
 * 解析一个模型给的路径。**这是语义必需的解析，不是范围判断**：相对路径必须有
 * 一个基准目录，绝对路径不需要。
 *
 * 返回三样东西，**操作数只取 `path`**：
 *   · `path` —— `resolve()` 的 `displayPath`：后端口径的**词法**绝对路径
 *     （`dsh-fs-local` 的 `localDisplayPath()`），`rm` / `rename` 用的就是它；
 *   · `info` —— `ctx.fs.lstat()`（不跟随末段链接）的类型元数据；
 *   · `target` —— 只用于 `displayPath` 回显与 `fs/observed` 的 target 身份。
 * **绝不**把 `ctx.fs.processPath(target)`（= realpath 后的目标）当作删除/移动的操作数。
 * @param ctx - 插件上下文（用它的 `fs` 服务解析路径）。
 * @param exec - 本次工具执行（取会话 cwd、取消信号）。
 * @param requestedPath - 模型给的原始路径（相对路径按会话 cwd 解析）。
 * @param tool - 工具名，用于可读的报错。
 * @returns `{ target, path, info }`；`info` 在路径不存在时为 `undefined`。
 */
async function resolveTarget(ctx, exec, requestedPath, tool) {
	const cwd = sessionCwd(exec);
	const hasCwd = cwd !== undefined && cwd.length > 0;
	// 唯一的失败情形：相对路径 + 会话无 cwd ⇒ 无法解析。**不因"路径不在工作区"报错。**
	if (!hasCwd && !isAbsolute(requestedPath)) {
		throw new Error(`${tool}: cannot resolve the relative path "${requestedPath}" — this session has no workspace cwd, so there is no base directory for a relative path. Pass an absolute path instead.`);
	}
	// resolve() 只用来拿 displayPath（词法绝对路径）；它的 targetKey（realpath）不参与删除/移动。
	const target = await ctx.fs.resolve(requestedPath, { cwd, signal: exec.signal });
	const opts = hasCwd ? { cwd } : {};
	// 不跟随末段符号链接 —— 软链按"链接文件"处理，悬空链也可见。
	// 解析这一步本身也可能被平台拒（策略更严的设备会连 stat 都不放行）⇒ 同样翻成人话，
	// 否则 remove / move / publish 会把「没权限」报成裸 EPERM（真机 P1-2，见 docs/109）。
	let info;
	try {
		info = await ctx.fs.lstat(requestedPath, opts, exec.signal);
	} catch (error) {
		throw describeWriteFailure(error, target.displayPath, "路径");
	}
	return { target, path: target.displayPath, info };
}

/**
 * 新建文件时的缺省权限位（`open` 的第三个实参，`0o600`）——与
 * `dshm-fs-write-nonchmod` 的 `NEW_FILE_MODE` 同值同源；只有源文件 mode 读不到时才用它。
 */
const NEW_FILE_MODE = 384;

function isENOENT(error) {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function isAbortError(error) {
	return error instanceof Error && error.name === "AbortError";
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
/** 取消检查（文案与去 chmod 写入后端同一口径：`<verb> aborted` / `FS_ABORTED`）。 */
function throwIfAborted(signal, verb) {
	if (signal?.aborted) throw new FsError(`${verb} aborted`, "FS_ABORTED");
}

/**
 * `publish` 的目标根目录 = 本应用**用户可见**的 `Download/<包名>/`。
 *
 * 唯一来源是 ArkTS 认领成功后经 `DSHM_PUBLIC_DOWNLOAD` 传进来的那个绝对路径
 * （Host 启动期已用 `lstat` + `create+write+unlink` 探写验证过，见
 * `hostcore/app/main.js` 的 `resolveWorkspaceDir()`）。**没有第二条来源**：
 *   · 为空 ⇒ **如实报错**，不退到进程 cwd、不拼 `$HOME/Download/...`（HOME 已被改成
 *     沙箱 HOME，拼出来的路径看起来对、实际是沙箱里的假目录 ⇒ 就是"静默换地方"）；
 *   · 不是绝对路径 ⇒ 报错（相对路径会被 `open` 按**宿主进程 cwd** 解释，同样静默换地方）。
 * @returns 用户可见下载目录的绝对路径。
 */
function publicDownloadRoot() {
	const dir = (process.env.DSHM_PUBLIC_DOWNLOAD || "").trim();
	if (dir.length === 0) {
		throw new Error("publish: no user-visible download directory is available — DSHM_PUBLIC_DOWNLOAD is empty, so this launch did not claim `Download/<bundle>/` (the session workspace fell back to the sandbox). The file stays in the sandbox and is NOT published anywhere else; report this to the user instead of writing to a substitute directory.");
	}
	if (!isAbsolute(dir)) {
		throw new Error(`publish: refusing to publish into "${dir}" (from DSHM_PUBLIC_DOWNLOAD): it is not an absolute path, so a write "into" it would silently land relative to the host process cwd.`);
	}
	return dir;
}

/**
 * 算出目标的绝对路径。
 *   · 给了 `target`：绝对路径原样使用（与 remove/move 一样**不设范围限制**），
 *     相对路径按用户可见下载目录解析；
 *   · 没给：源是相对路径 ⇒ **保持同一个相对路径**（`notes/a.md` ⇒ `<root>/notes/a.md`）；
 *     源是绝对路径 ⇒ 取它的文件名（`<root>/a.md`）。
 * @param root - 用户可见下载目录（绝对路径）。
 * @param sourceArg - 模型给的 `source` 原文（决定缺省目标）。
 * @param targetArg - 模型给的 `target`，可能缺省。
 * @returns 目标的绝对路径（词法归一化，不跟随链接）。
 */
function publishDestination(root, sourceArg, targetArg) {
	if (typeof targetArg === "string" && targetArg.trim().length > 0) {
		return isAbsolute(targetArg) ? targetArg : resolvePath(root, targetArg);
	}
	return isAbsolute(sourceArg) ? resolvePath(root, basename(sourceArg)) : resolvePath(root, sourceArg);
}

/** 同目录临时件的后缀：点号前缀（隐藏）+ `.partial` 结尾，与上游 `.tmpdir` 不撞名。 */
const PARTIAL_SUFFIX = ".partial";
/**
 * 临时件名字里"`.<pid>.<uuid>`"那一段的形状（`uuid` 与 `randomUUID()` 同形）。
 * 残渣清理**只**认这一整形状 ⇒ 同目录里的诱饵 / 别人的文件不会被误删。
 */
const PARTIAL_MIDDLE = "\\.[0-9]+\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.partial$";

/** 正则元字符转义（目标文件名会被拼进残渣清理用的正则里，必须按字面匹配）。 */
function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** 本次发布用的同目录临时件路径：`.<basename>.<pid>.<uuid>.partial`。 */
function partialPathOf(absolutePath) {
	return join(dirname(absolutePath), `.${basename(absolutePath)}.${process.pid}.${randomUUID()}${PARTIAL_SUFFIX}`);
}
/** "本实现为这个目标留下的临时件"的匹配正则（同目录 + 完整名字形状）。 */
function partialPatternOf(absolutePath) {
	return new RegExp(`^\\.${escapeRegExp(basename(absolutePath))}${PARTIAL_MIDDLE}`);
}
/**
 * 发布前清掉**同目标**的遗留临时件（上一次硬崩留下的 `.partial`）。
 * 只删"同目录 + 同 basename 前缀 + 完整本实现命名形状"的条目；清理失败只告警。
 */
async function removeStalePartials(directory, absolutePath) {
	let entries;
	try {
		entries = await readdir(directory);
	} catch (error) {
		process.emitWarning(`dshm-tool-fs-remove: could not scan "${directory}" for leftover partial files: ${errorMessage(error)}`, "DshmFsPublishWarning");
		return;
	}
	const pattern = partialPatternOf(absolutePath);
	for (const entry of entries) {
		if (!pattern.test(entry)) continue;
		try {
			await unlink(join(directory, entry));
		} catch (error) {
			if (!isENOENT(error)) process.emitWarning(`dshm-tool-fs-remove: could not remove the leftover partial file "${join(directory, entry)}": ${errorMessage(error)}`, "DshmFsPublishWarning");
		}
	}
}
/** 失败路径上的临时件清理：尽力而为，**绝不**触碰目标文件。 */
async function removePartial(tempPath, absolutePath) {
	try {
		await unlink(tempPath);
	} catch (error) {
		if (isENOENT(error)) return;
		process.emitWarning(`dshm-tool-fs-remove: could not remove the partial file for "${absolutePath}" after a failed publish: ${errorMessage(error)}`, "DshmFsPublishWarning");
	}
}

/**
 * 去 `chmod` 的**按字节**原子落盘原语：同目录临时件 + `rename` 发布。
 *
 *   `mkdir(dirname)` → 清遗留 `.partial` → `open(temp,'w',mode ?? 0o600)` →
 *   `handle.writeFile(buffer)` → `handle.sync()`（失败只告警）→ `close()` →
 *   `rename(temp, target)`。
 *
 * 与 `dshm-fs-write-nonchmod` 的 `writeFileAtomicNoChmod()` 是同一套原语（那边写
 * UTF-8 文本，这边写 `Buffer`）。**不使用** `chmod` / `link`：`chmod` 在鸿蒙公共目录
 * 报 EPERM，`link` 在沙箱内被禁；`rename` 只用于同一目录内的发布。任何一步失败都会
 * 清掉临时件并把错误**原样上抛**，目标文件保持原样。详见文件头"publish 的落盘原语"。
 * @param absolutePath - 目标文件（父目录不存在会递归创建）。
 * @param bytes - 要写入的完整字节（`Buffer`，不做任何编码转换）。
 * @param mode - 目标文件的权限位；`undefined` 时用 `NEW_FILE_MODE`（仅对**新建**生效）；
 *   覆写时传**目标既有 mode**，由 `rename` 带到目标上。
 * @param signal - 写前、写中与发布前检查的取消信号。
 * @returns 写入完成（或抛出）后的 Promise。
 */
async function writeFileAtomicBytes(absolutePath, bytes, mode, signal) {
	throwIfAborted(signal, "publish");
	const directory = dirname(absolutePath);
	await mkdir(directory, { recursive: true });
	throwIfAborted(signal, "publish");
	await removeStalePartials(directory, absolutePath);
	throwIfAborted(signal, "publish");
	const tempPath = partialPathOf(absolutePath);
	let handle = null;
	try {
		handle = await open(tempPath, "w", mode ?? NEW_FILE_MODE);
		await handle.writeFile(bytes, { ...signal ? { signal } : {} });
		try {
			/* 字节已写进临时件，fsync 只影响 durability ⇒ 不把复制判死，但留下可观测痕迹。 */
			await handle.sync();
		} catch (syncError) {
			process.emitWarning(`dshm-tool-fs-remove: fsync failed after publishing "${absolutePath}": ${errorMessage(syncError)}`, "DshmFsPublishWarning");
		}
		await handle.close();
		handle = null;
		throwIfAborted(signal, "publish");
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
		throw isAbortError(error) ? new FsError("publish aborted", "FS_ABORTED") : describeWriteFailure(error, absolutePath);
	}
}

/**
 * Register the `publish` tool (sandbox file → user-visible `Download/<bundle>/`).
 * @param ctx - the plugin context; registration is scoped to it.
 */
function applyPublishTool(ctx) {
	ctx.tools.register(defineTool({
		name: "publish",
		description: "Publish one file from the sandbox into this app's user-visible download directory (Download/<bundle>/), so the user can open it in the file manager. Use it when the session workspace lives inside the sandbox and a plain write therefore cannot reach the user-visible directory: write the file in the sandbox first, then publish it. The bytes are copied as-is (binary-safe, no text re-encoding), and missing parent directories of the destination are created. Relative paths resolve against the session cwd; a relative target resolves against the download directory. The tool imposes no path restriction — whether the copy is permitted is decided by the operating system, and its error is reported as-is. The copy is atomic: the bytes are written to a hidden temporary file in the destination directory and renamed into place, so a failed or interrupted copy leaves an existing destination file untouched (a destination that did not exist stays absent).",
		parameters: {
			source: {
				type: "string",
				required: true,
				description: "Path of the existing file to publish. A relative path resolves against the session cwd (the sandbox workspace when the workspace fell back to the sandbox)."
			},
			target: {
				type: "string",
				description: "Destination path. A relative path resolves against this app's user-visible download directory (Download/<bundle>/); an absolute path is used as given. Defaults to the source path as given when it is relative, or to the source file name when it is absolute. Missing parent directories are created."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					source: {
						type: "string",
						required: true
					},
					path: {
						type: "string",
						required: true
					},
					operation: {
						type: "string",
						required: true,
						enum: ["create", "update"]
					},
					bytes: {
						type: "integer",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Published ${value.source} → ${value.path}\n<bytes>${value.bytes}</bytes>\n<operation>${value.operation}</operation>`
			}]
		},
		async execute(args, exec) {
			/* 顺序：先拿目标根（缺 env 时**立刻**报错，不读源、更不写任何地方）。 */
			const root = publicDownloadRoot();
			const from = await resolveTarget(ctx, exec, args.source, "publish");
			/* 源必须存在且是**普通文件**：目录/其它类型一律拒绝（readFile 对 FIFO 会挂住）。 */
			let sourceInfo;
			try {
				sourceInfo = await stat(from.path);
			} catch (error) {
				if (isENOENT(error)) throw new FsError(`cannot publish "${from.target.displayPath}": not found`, "FS_NOT_FOUND");
				throw describeWriteFailure(error, from.path, "路径");
			}
			if (!sourceInfo.isFile()) {
				throw new Error(`publish: "${from.target.displayPath}" is not a regular file${sourceInfo.isDirectory() ? " (it is a directory)" : ""}; publish copies one file.`);
			}
			const destination = publishDestination(root, args.source, args.target);
			throwIfAborted(exec.signal, "publish");
			/* 目标是否已存在 —— 决定返回的 operation，并在这里就拒绝**存在但不是普通文件**
			 * （目录等）：否则会走进 `open(…,'w')` 的 EISDIR，错误文案远不如直接说清来源。 */
			let destinationInfo = null;
			try {
				destinationInfo = await stat(destination);
			} catch (error) {
				if (!isENOENT(error)) throw describeWriteFailure(error, destination, "路径");
			}
			if (destinationInfo !== null && !destinationInfo.isFile()) {
				throw new Error(`publish: "${destination}" is not a regular file${destinationInfo.isDirectory() ? " (it is a directory)" : ""}; publish writes one file.`);
			}
			const existed = destinationInfo !== null;
			/* 按字节读（不经过文本编解码）。 */
			let bytes;
			try {
				bytes = await readFile(from.path, exec.signal ? { signal: exec.signal } : {});
			} catch (error) {
				throw describeWriteFailure(error, from.path, "路径");
			}
			/* 原子落盘：失败时临时件由落盘原语清掉，**目标一直是旧内容或根本不存在**——
			 * 所以这里不需要、也绝不允许再去删目标（那会毁掉用户已有文件或并发创建的文件）。 */
			await writeFileAtomicBytes(destination, bytes, existed ? destinationInfo.mode & 0o777 : sourceInfo.mode & 0o777, exec.signal);
			/* 复制已落盘 ⇒ 把这个目标的"存在 + 版本"作为**权威观察**发出去，
			 * 与 remove/move 发 absent 同一口径（观察策略按 targetKey 记账）。 */
			const after = await stat(destination, { bigint: true });
			const observed = await ctx.fs.resolve(destination, exec.signal ? { signal: exec.signal } : {});
			ctx.emit("fs/observed", observed, {
				kind: "present",
				version: FsVersion(`${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}`)
			}, exec);
			return {
				source: from.target.displayPath,
				path: destination,
				operation: existed ? "update" : "create",
				bytes: bytes.length
			};
		}
	}));
}

/**
 * Register the `remove` tool (file and, with `recursive=true`, directory).
 * @param ctx - the plugin context; registration is scoped to it.
 */
function applyRemoveTool(ctx) {
	ctx.tools.register(defineTool({
		name: "remove",
		description: "Delete one file, one symbolic link, or one directory. A symbolic link is removed as the link itself — its target is untouched — and never needs recursive, even when it points at a directory. A directory requires recursive=true. Relative paths resolve against the session cwd; absolute paths are used as given. The tools themselves impose no path restriction — whether the deletion is permitted is decided by the operating system, and its error is reported as-is.",
		parameters: {
			path: {
				type: "string",
				required: true,
				description: "Path to delete. A relative path resolves against the session cwd; an absolute path is used as given. A symbolic link is removed as the link itself."
			},
			recursive: {
				type: "boolean",
				description: "Set true to delete a directory together with everything inside it. Defaults to false, and deleting a directory without it is an error. A symbolic link never needs it, even when it points at a directory."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: {
						type: "string",
						required: true
					},
					kind: {
						type: "string",
						required: true,
						enum: ["file", "directory", "symlink", "other"]
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `<path>${value.path}</path>\n<type>${value.kind}</type>\n<content>\nRemoved\n</content>`
			}]
		},
		async execute(args, exec) {
			const { target, path, info } = await resolveTarget(ctx, exec, args.path, "remove");
			if (info === undefined) throw new FsError(`cannot remove "${target.displayPath}": not found`, "FS_NOT_FOUND");
			// lstat 的 type：软链是 "symlink"（不是它指向的目录）⇒ 删链接**不需要** recursive。
			if (info.type === "directory" && args.recursive !== true) {
				throw new Error(`remove: "${target.displayPath}" is a directory; pass recursive=true to delete it and everything inside it.`);
			}
			// 词法路径 —— 软链只删链接条目本身，与 POSIX `rm` 一致。
			try {
				await rm(path, { recursive: info.type === "directory", force: false });
			} catch (error) {
				throw describeWriteFailure(error, path, "路径");
			}
			// 软链的 target 身份是"链接目标"，它并没有消失 ⇒ 不发 absent 观察（见文件头）。
			if (info.type !== "symlink") ctx.emit("fs/observed", target, { kind: "absent" }, exec);
			return { path: target.displayPath, kind: info.type };
		}
	}));
}

/**
 * Register the `move` tool (rename/move; both endpoints resolved the same way).
 * @param ctx - the plugin context; registration is scoped to it.
 */
function applyMoveTool(ctx) {
	ctx.tools.register(defineTool({
		name: "move",
		description: "Move or rename one file, one symbolic link, or one directory. A symbolic link is moved as the link itself — its target is untouched. Relative paths resolve against the session cwd; absolute paths are used as given. The tools themselves impose no path restriction — whether the operation is permitted is decided by the operating system, and its error is reported as-is. The destination directory must already exist.",
		parameters: {
			source: {
				type: "string",
				required: true,
				description: "Existing path to move. Relative paths resolve against the session cwd."
			},
			destination: {
				type: "string",
				required: true,
				description: "Target path, resolved the same way as source. Overwriting an existing file follows node:fs rename semantics."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					source: {
						type: "string",
						required: true
					},
					destination: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Moved ${value.source} → ${value.destination}`
			}]
		},
		async execute(args, exec) {
			const from = await resolveTarget(ctx, exec, args.source, "move");
			const to = await resolveTarget(ctx, exec, args.destination, "move");
			if (from.info === undefined) throw new FsError(`cannot move "${from.target.displayPath}": not found`, "FS_NOT_FOUND");
			// 两端都用词法路径 ⇒ 软链移动的是链接本身（与 POSIX `mv` 一致）。
			try {
				await rename(from.path, to.path);
			} catch (error) {
				throw describeWriteFailure(error, to.path);
			}
			// 同 remove：软链的目标身份没有消失 ⇒ 不发 absent 观察。
			if (from.info.type !== "symlink") ctx.emit("fs/observed", from.target, { kind: "absent" }, exec);
			return { source: from.target.displayPath, destination: to.target.displayPath };
		}
	}));
}

/**
 * Register the three tools plus their scope-aware system-prompt guidance.
 * @param ctx - agent- or deployment-scoped services.
 */
function apply(ctx) {
	ctx.systemPrompt.section({
		name: "tool:remove",
		/*
		 * 【为什么 order 是字面量而不是 getSectionOrder(...)】上游 `dsh-system-prompt`
		 * 的 SECTION_ORDERS 表里没有"删除工具"这一项（tool-fs 用的是 TOOL_READ/
		 * TOOL_WRITE/TOOL_EDIT 三个键，lib/index.js:19-21）。`getSectionOrder()`
		 * 对未知键返回 undefined，section() 会因 order 非有限数抛错；而"往上游那张表
		 * 里加一行"正是本 patch 不打算做的事。故就近取 TOOL_EDIT(1300) 之后的空档。
		 */
		order: 1305,
		/*
		 * 逐工具条件拼接：某个工具在当前作用域不可见时，不提它（与上游
		 * `tool-fs` 的 `ctx.tools.get(name, scope) === void 0 ? "" : …` 同一形态）。
		 * `publish` 那一句要写清**什么时候用它**（工作区回退到沙箱时才需要），
		 * 否则模型会在"本来就能直接写进用户可见目录"时多绕一步。
		 */
		text: ({ scope }) => {
			const lines = [];
			if (ctx.tools.get("remove", scope) !== void 0) lines.push("Use remove to delete files or directories, and move to rename or relocate them.");
			if (ctx.tools.get("publish", scope) !== void 0) lines.push("Use publish to copy a file out of the sandbox into the user-visible download directory (Download/<bundle>/): when the session workspace is inside the sandbox, write the file there first and then publish it, and tell the user the final path publish returns.");
			if (lines.length === 0) return "";
			return `${lines.join(" ")} Relative paths resolve against the session cwd and absolute paths are used as given; the tools themselves restrict no path — permission comes from the operating system, whose error is reported as-is.`;
		}
	});
	applyRemoveTool(ctx);
	applyMoveTool(ctx);
	applyPublishTool(ctx);
}

export { apply, inject, name };
