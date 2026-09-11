import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
if (typeof root !== 'string' || root.length === 0) {
  throw new Error('usage: create-dshm-config-editor.mjs <dsh-runtime-dir>');
}

const nodeModules = path.join(root, 'node_modules');
const pluginDir = path.join(nodeModules, 'dshm-config-editor');
fs.mkdirSync(path.join(pluginDir, 'lib'), { recursive: true });
fs.mkdirSync(path.join(pluginDir, 'client'), { recursive: true });

const manifest = {
  name: 'dshm-config-editor',
  version: '1.0.0',
  private: true,
  type: 'module',
  main: './lib/index.js',
  dsh: {
    bundle: { patch: './cordis.patch.yml' },
    client: {
      inject: [
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-settings',
        '@deepseek-ai/dsh-client-locale'
      ],
      platform: 'web'
    }
  },
  exports: {
    '.': './lib/index.js',
    './client': './client/client.js',
    './cordis.patch.yml': './cordis.patch.yml',
    './package.json': './package.json'
  }
};

fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(pluginDir, 'cordis.patch.yml'), "- insert:\n    - id: dshm-config-editor\n      name: 'dshm-config-editor'\n");

const hostSource = String.raw`import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { parseDocument } from "yaml";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";

const MAX_DOCUMENT_BYTES = 256 * 1024;

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin !== "string" || typeof host !== "string") return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_DOCUMENT_BYTES + 4096) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function revisionOf(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function validateDocument(filePath, content) {
  if (Buffer.byteLength(content, "utf8") > MAX_DOCUMENT_BYTES) {
    throw new Error("configuration document exceeds 256 KiB");
  }
  const extension = extname(filePath).toLowerCase();
  if (extension === ".json") {
    const value = content.trim().length === 0 ? {} : JSON.parse(content);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("configuration document must have an object root");
    }
    return;
  }
  if (extension !== ".yaml" && extension !== ".yml") {
    throw new Error("unsupported configuration document format");
  }
  const document = parseDocument(content, { prettyErrors: true });
  if (document.errors.length > 0) throw new Error("configuration document contains invalid YAML");
  const value = document.toJS() ?? {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("configuration document must have a map root");
  }
}

async function documentPath(settings) {
  const filePath = await settings.prepareDocument();
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new Error("settings provider has no local document");
  }
  return filePath;
}

async function readDocument(settings) {
  const filePath = await documentPath(settings);
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error("settings document is not a regular file");
  if (info.size > MAX_DOCUMENT_BYTES) throw new Error("configuration document exceeds 256 KiB");
  const content = await readFile(filePath, "utf8");
  return { content, revision: revisionOf(content) };
}

export const name = "dshm-config-editor";

export function apply(ctx) {
  ctx.inject(["webServer", "settings"], (host) => {
    const settings = host.settings;
    host.effect(() => {
      // DSHM: dsh-host-webserver throws on duplicate (kind, path) registrations,
      // so GET and POST share one exact route and dispatch on the method.
      const route = host.webServer.register({
        kind: "exact",
        path: "/dshm-config-editor/document",
        handler: async (request, response) => {
          if (request.method !== "GET" && request.method !== "POST") {
            response.writeHead(405, { allow: "GET, POST" });
            response.end();
            return;
          }
          if (!sameOrigin(request)) {
            sendJson(response, 403, { error: "untrusted origin" });
            return;
          }
          if (request.method === "GET") {
            try {
              sendJson(response, 200, { ok: true, ...await readDocument(settings) });
            } catch (error) {
              sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
            }
            return;
          }
          try {
            const body = await readJsonBody(request);
            if (typeof body.content !== "string" || typeof body.revision !== "string") {
              sendJson(response, 400, { error: "invalid configuration payload" });
              return;
            }
            const filePath = await documentPath(settings);
            validateDocument(filePath, body.content);
            let nextRevision = "";
            await withFileLock(filePath, async () => {
              const current = await readFile(filePath, "utf8");
              if (revisionOf(current) !== body.revision) {
                const conflict = new Error("configuration file changed; reload and retry");
                conflict.code = "SETTINGS_CONFLICT";
                throw conflict;
              }
              await writeFileAtomic(filePath, body.content, { mode: 384, dirMode: 448 });
              nextRevision = revisionOf(body.content);
            });
            sendJson(response, 200, { ok: true, revision: nextRevision });
          } catch (error) {
            const status = error?.code === "SETTINGS_CONFLICT" ? 409 : 400;
            sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
          }
        }
      });
      return () => {
        route();
      };
    }, "dshm-config-editor: loopback settings document routes");
  });
}
`;
fs.writeFileSync(path.join(pluginDir, 'lib/index.js'), hostSource);

const clientSource = String.raw`window.__ModuleLoader__.load({ id: "dshm-config-editor", factory: (require) => {
  const React = require("react");
  const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
  const NS = "dshm-config-editor";
  const zh = { action: "编辑配置", title: "编辑配置文件", reload: "重新加载", cancel: "取消", save: "保存", saving: "保存中...", loading: "正在加载...", loadFailed: "无法加载配置文件", saveFailed: "无法保存配置文件", saved: "已保存。配置更新会自动生效。" };
  const en = { action: "Edit Configuration", title: "Edit Configuration File", reload: "Reload", cancel: "Cancel", save: "Save", saving: "Saving...", loading: "Loading...", loadFailed: "Could not load the configuration file", saveFailed: "Could not save the configuration file", saved: "Saved. Configuration changes will be applied automatically." };
  const css = ".dshm-config-editor-mask{position:fixed;inset:0;z-index:1200;background:var(--dsw-alias-bg-mask-1);display:flex;align-items:center;justify-content:center}.dshm-config-editor-panel{width:min(760px,calc(100vw - 32px));height:min(720px,calc(100vh - 32px));background:var(--dsw-alias-bg-layer-2);border-radius:12px;box-shadow:var(--dsw-shadow-lv3);padding:20px;display:flex;flex-direction:column;gap:12px}.dshm-config-editor-title{color:var(--dsw-alias-label-primary);font-size:16px;line-height:24px;font-weight:600}.dshm-config-editor-textarea{box-sizing:border-box;resize:none;flex:1;min-height:160px;width:100%;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-primary);border-radius:8px;padding:12px;font:13px/20px monospace}.dshm-config-editor-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}.dshm-config-editor-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}.dshm-config-editor-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}";
  if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=dshm-config-editor]") === null) {
    const tag = document.createElement("style");
    tag.dataset.pluginCss = "dshm-config-editor";
    tag.textContent = css;
    document.head.appendChild(tag);
  }
  async function request(method, body) {
    const response = await fetch("/dshm-config-editor/document", { method, headers: body === undefined ? {} : { "content-type": "application/json" }, credentials: "same-origin", cache: "no-store", body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new Error(typeof result.error === "string" ? result.error : "request failed");
    return result;
  }
  function ConfigEditor(props) {
    const t = props.t;
    const [open, setOpen] = React.useState(false);
    const [content, setContent] = React.useState("");
    const [revision, setRevision] = React.useState("");
    const [loading, setLoading] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState("");
    const [saved, setSaved] = React.useState(false);
    const load = React.useCallback(async () => {
      setLoading(true); setError(""); setSaved(false);
      try { const result = await request("GET"); setContent(result.content); setRevision(result.revision); }
      catch (loadError) { setError(loadError instanceof Error ? loadError.message : t("loadFailed")); }
      finally { setLoading(false); }
    }, [t]);
    React.useEffect(() => { if (open) void load(); }, [open, load]);
    const save = React.useCallback(async () => {
      setSaving(true); setError(""); setSaved(false);
      try { const result = await request("POST", { content, revision }); setRevision(result.revision); setSaved(true); }
      catch (saveError) { setError(saveError instanceof Error ? saveError.message : t("saveFailed")); }
      finally { setSaving(false); }
    }, [content, revision, t]);
    const Button = primitives.Button;
    const action = React.createElement(Button, { variant: "outline", size: "sm", onClick: () => setOpen(true) }, t("action"));
    if (!open) return action;
    return React.createElement(React.Fragment, null, action, React.createElement("div", { className: "dshm-config-editor-mask", role: "presentation" }, React.createElement("div", { className: "dshm-config-editor-panel", role: "dialog", "aria-modal": "true", "aria-label": t("title") },
      React.createElement("div", { className: "dshm-config-editor-title" }, t("title")),
      error === "" ? null : React.createElement("div", { className: "dshm-config-editor-error", role: "alert" }, error),
      saved ? React.createElement("div", { className: "dshm-config-editor-status", role: "status" }, t("saved")) : null,
      loading ? React.createElement("div", { className: "dshm-config-editor-status" }, t("loading")) : React.createElement("textarea", { className: "dshm-config-editor-textarea", value: content, spellCheck: false, onChange: (event) => setContent(event.target.value), "aria-label": t("title") }),
      React.createElement("div", { className: "dshm-config-editor-actions" },
        React.createElement(Button, { variant: "outline", size: "sm", disabled: loading || saving, onClick: () => void load() }, t("reload")),
        React.createElement(Button, { variant: "outline", size: "sm", disabled: saving, onClick: () => setOpen(false) }, t("cancel")),
        React.createElement(Button, { variant: "solid", size: "sm", disabled: loading || saving, onClick: () => void save() }, saving ? t("saving") : t("save"))
      )
    )));
  }
  const name = "dshm-config-editor";
  const inject = ["slots", "locale"];
  function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dshm-config-editor: dictionaries");
    const t = ctx.locale.bind(NS);
    ctx.slots.inject("settings.action", () => ctx.slots.register({ name: "settings.action", id: "dshm-config-editor", order: 0, locale: NS, inject: () => ({ t }) }, () => React.createElement(ConfigEditor, { t })));
  }
  return { apply, inject, name };
}});
`;
fs.writeFileSync(path.join(pluginDir, 'client/client.js'), clientSource);

const dshManifestPath = path.join(nodeModules, '@deepseek-ai/dsh/package.json');
if (fs.existsSync(dshManifestPath)) {
  const dshManifest = JSON.parse(fs.readFileSync(dshManifestPath, 'utf8'));
  dshManifest.dependencies ??= {};
  dshManifest.dependencies['dshm-config-editor'] = '1.0.0';
  const mobileManifestPath = path.join(nodeModules, '@dsh-external/dsh-mobile-nav/package.json');
  // DSHM lean-web：@dsh-external/dsh-mobile-nav 与完整 dsh peer 树在 npm 下无法共存
  //（装它需 --legacy-peer-deps 会剪掉其余 peer）。缺失时不阻断、不写入依赖，web
  // profile 仅用 dsh-base + dsh-web-app + 内置 dshm-config-editor。
  if (fs.existsSync(mobileManifestPath)) {
    const mobileManifest = JSON.parse(fs.readFileSync(mobileManifestPath, 'utf8'));
    dshManifest.dependencies['@dsh-external/dsh-mobile-nav'] = String(mobileManifest.version ?? '1.0.0');
  }
  fs.writeFileSync(dshManifestPath, JSON.stringify(dshManifest, null, 2) + '\n');
}

const settingsClientPath = path.join(nodeModules, '@deepseek-ai/dsh-client-ui-settings-general/lib/client.js');
if (fs.existsSync(settingsClientPath)) {
  let settingsClient = fs.readFileSync(settingsClientPath, 'utf8');
  const nativeAction = 'if (documentInjected !== void 0) ctx.slots.inject("settings.action", () => ctx.slots.register({';
  if (settingsClient.includes(nativeAction)) {
    settingsClient = settingsClient.replace(nativeAction, '// DSHM 鸿蒙适配：由内置配置编辑器替代原生打开动作。\n\t\t\tif (false && documentInjected !== void 0) ctx.slots.inject("settings.action", () => ctx.slots.register({');
    fs.writeFileSync(settingsClientPath, settingsClient);
  }
}

const appBootPath = path.join(nodeModules, '@deepseek-ai/dsh-app-boot/lib/index.js');
if (fs.existsSync(appBootPath)) {
  let appBoot = fs.readFileSync(appBootPath, 'utf8');
  const layersAnchor = '\tconst layers = (normalizeShippedProfile(name, dir, readProfileManifest(binName, dir)).dsh?.profile?.bundles ?? []).map((packageName) => {';
  const migrationStart = appBoot.indexOf('\t// DSHM 内置 dshmarket Web profile v');
  const migrationEnd = migrationStart === -1 ? -1 : appBoot.indexOf(layersAnchor, migrationStart);
  if (migrationEnd !== -1) appBoot = appBoot.slice(0, migrationStart) + appBoot.slice(migrationEnd);
  if (!appBoot.includes('DSHM 安装依赖 fallback 刷新版本')) {
    appBoot = appBoot.replace(
      'import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";',
      'import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";'
    );
    const fallbackAnchor = 'function healProfilesModuleFallback(installAnchor, home = resolveDshHome()) {\n\tconst modulesDir = join(join(home, PROFILES_DIR), "node_modules");\n\tmkdirSync(modulesDir, { recursive: true });';
    const fallbackReplacement = `function healProfilesModuleFallback(installAnchor, home = resolveDshHome()) {
\t// DSHM 安装依赖 fallback 刷新版本：该目录是 HAP 安装依赖的可再生缓存，
\t// 不包含用户通过插件市场安装到 profile/node_modules 的包。
\tconst modulesDir = join(join(home, PROFILES_DIR), "node_modules");
\tconst refreshMarker = join(join(home, PROFILES_DIR), ".dshm-install-fallback-revision");
\tconst refreshRevision = "20260819-50";
\tlet needsRefresh = true;
\ttry {
\t\tneedsRefresh = readFileSync(refreshMarker, "utf8").trim() !== refreshRevision;
\t} catch {}
\tif (needsRefresh) rmSync(modulesDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
\tmkdirSync(modulesDir, { recursive: true });`;
    if (appBoot.includes(fallbackAnchor)) appBoot = appBoot.replace(fallbackAnchor, fallbackReplacement);
    const fallbackEnd = '\tfor (const [packageName, target] of links) {\n\t\tconst link = join(modulesDir, packageName);\n\t\tmkdirSync(dirname(link), { recursive: true });\n\t\tensureSymlink(link, target);\n\t}\n}';
    const fallbackEndReplacement = '\tfor (const [packageName, target] of links) {\n\t\tconst link = join(modulesDir, packageName);\n\t\tmkdirSync(dirname(link), { recursive: true });\n\t\tensureSymlink(link, target);\n\t}\n\tif (needsRefresh) writeFileSync(refreshMarker, refreshRevision + "\\n");\n}';
    if (appBoot.includes(fallbackEnd)) appBoot = appBoot.replace(fallbackEnd, fallbackEndReplacement);
  }
  const profileManagedResolver = `function resolveBundleDir(binName, packageName, installAnchor, profileDir) {
\t// DSHM profile-managed bundles are seeded into profile/node_modules and
\t// deliberately resolve there first. Users can then update or uninstall
\t// them through dshmarket; the HAP copy is only the first-install cache.
\tconst profileManaged = packageName === "dshmarket" || packageName === "@dsh-external/dsh-mobile-nav";
\tconst anchors = profileManaged ? [join(profileDir, "package.json"), installAnchor] : [installAnchor, join(profileDir, "package.json")];
\tfor (const anchor of anchors) {
\t\tconst dir = packageDirFromAnchor(anchor, packageName);
\t\tif (dir !== void 0) return dir;
\t}
\tthrow new Error(binName + ": cannot resolve profile bundle " + JSON.stringify(packageName) + " from the dsh installation or " + profileDir + "; run 'dsh plugin --profile " + basename(profileDir) + " install' if its dependency is not installed");
}
function seedProfilePackageClosure(installAnchor, profileDir, packageName) {
\tconst sourceDir = packageDirFromAnchor(installAnchor, packageName);
\tif (sourceDir === void 0) return void 0;
\tconst packages = new Map();
\tconst sourceManifestPath = join(sourceDir, "package.json");
\tconst sourceManifest = JSON.parse(readFileSync(sourceManifestPath, "utf8"));
\tif (typeof sourceManifest.name !== "string" || sourceManifest.name.length === 0) return void 0;
\tpackages.set(sourceManifest.name, sourceDir);
\tconst queue = [{ anchor: sourceManifestPath, manifest: sourceManifest }];
\tfor (let next = queue.shift(); next !== void 0; next = queue.shift()) {
\t\tconst dependencyNames = Object.keys({ ...next.manifest.dependencies, ...next.manifest.optionalDependencies, ...next.manifest.peerDependencies });
\t\tfor (const dependencyName of dependencyNames) {
\t\t\tif (packages.has(dependencyName)) continue;
\t\t\tconst dependencyDir = packageDirFromAnchor(next.anchor, dependencyName);
\t\t\tif (dependencyDir === void 0) continue;
\t\t\tconst dependencyManifestPath = join(dependencyDir, "package.json");
\t\t\tconst dependencyManifest = JSON.parse(readFileSync(dependencyManifestPath, "utf8"));
\t\t\tpackages.set(dependencyName, dependencyDir);
\t\t\tqueue.push({ anchor: dependencyManifestPath, manifest: dependencyManifest });
\t\t}
\t}
\tfor (const [dependencyName, dependencyDir] of packages) {
\t\tconst targetDir = join(profileDir, "node_modules", dependencyName);
\t\tif (existsSync(join(targetDir, "package.json"))) continue;
\t\tmkdirSync(dirname(targetDir), { recursive: true });
\t\tcpSync(dependencyDir, targetDir, { recursive: true, force: true });
\t}
\treturn sourceManifest;
}`;
  // 只替换 resolveBundleDir 这一个函数体。
  // 旧写法切到“Load a profile”注释为止，会把两者之间的其它函数一并删掉 ——
  // 0.1.5 的区间里多了 loadProfileDirectory，结果 dsh-app-boot 直接
  // SyntaxError: Export 'loadProfileDirectory' is not defined，启动即崩。
  // 这里改成按函数起始位置 + 顶层收尾大括号精确定位，与版本无关。
  const resolverStart = appBoot.indexOf('function resolveBundleDir(binName, packageName, installAnchor, profileDir) {');
  let resolverEnd = -1;
  if (resolverStart !== -1) {
    // 函数体内所有代码都有缩进，因此“行首即是 } 的行”就是该顶层函数的收尾。
    resolverEnd = appBoot.indexOf('\n}\n', resolverStart);
  }
  if (resolverEnd !== -1) {
    // resolverEnd 指向函数收尾 `}` 前的换行，+2 跳过 "\n}"，保留其后的内容。
    appBoot = appBoot.slice(0, resolverStart) + profileManagedResolver + appBoot.slice(resolverEnd + 2);
  }
  if (!appBoot.includes('DSHM 鸿蒙适配：跳过依赖 WebAssembly')) {
    const wasmGuard = `
function hasUnsupportedHarmonyDependency(packageDir, visited = new Set()) {
	const manifestPath = join(packageDir, "package.json");
	if (visited.has(manifestPath)) return false;
	visited.add(manifestPath);
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		return false;
	}
	for (const packageName of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
		// DSHM 鸿蒙适配：跳过依赖 WebAssembly 的插件。ssh2 的 poly1305
		// 实现在当前 --jitless V8 中会访问未定义的 WebAssembly 并终止整个 DSH 进程。
		if (packageName === "ssh2") return true;
		const dependencyDir = packageDirFromAnchor(manifestPath, packageName);
		if (dependencyDir !== void 0 && hasUnsupportedHarmonyDependency(dependencyDir, visited)) return true;
	}
	return false;
}
`;
    const loadProfileAnchor = '/**\n* Load a profile: resolve every `dsh.profile.bundles` entry to its patch';
    if (appBoot.includes(loadProfileAnchor)) appBoot = appBoot.replace(loadProfileAnchor, wasmGuard + loadProfileAnchor);
  }
  // rc.1.2: the web profile template is now an OBJECT entry, e.g.
  //   web: {\n\t\tbundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],\n\t\tpatchReloadce: "live"\n\t},
  // Append/ensure "dshm-config-editor" in the bundles array (de-dup), and remove
  // any dshmarket duplication the same way. White-space tolerant: locate the
  // bundles:[...] array that belongs to the `web: {` block and rebuild it.
  if (!appBoot.includes('dshm-config-editor-bundles')) {
    const protectedWeb = 'web: {';
    const webBlockStart = appBoot.indexOf(protectedWeb);
    if (webBlockStart !== -1) {
      const bundlesIdx = appBoot.indexOf('bundles:', webBlockStart);
      if (bundlesIdx !== -1) {
        const arrStart = appBoot.indexOf('[', bundlesIdx);
        const arrEnd = arrStart === -1 ? -1 : appBoot.indexOf(']', arrStart);
        if (arrStart !== -1 && arrEnd > arrStart) {
          const items = appBoot
            .slice(arrStart + 1, arrEnd)
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0 && s !== '@dsh-market/plugin');
          const ordered = [];
          const seen = new Set();
          for (const it of items) { if (!seen.has(it)) { seen.add(it); ordered.push(it); } }
          if (!ordered.includes('"dshm-config-editor"')) ordered.push('"dshm-config-editor"');
          appBoot = appBoot.slice(0, arrStart) + ' [ /*dshm-config-editor*/ ' + ordered.join(', ') + ' ] ' + appBoot.slice(arrEnd + 1);
        }
      }
    }
    // Legacy flat-array form (older dsh) — keep config-editor present, drop dup dshmarket.
    const legacy = 'web: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dshm-config-editor"],';
    appBoot = appBoot
      .replace('web: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dshmarket"],', legacy)
      .replace('web: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dshmarket", "dshm-config-editor"],', legacy)
      .replace('web: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dshmarket", "dshm-config-editor", "@dsh-external/dsh-mobile-nav"],', legacy);
  }
  let seedStart = appBoot.indexOf('\t// DSHM profile-managed market seed v1:');
 if (seedStart === -1) seedStart = appBoot.indexOf('\t// DSHM profile-managed market seed v2:');
  if (seedStart === -1) seedStart = appBoot.indexOf('\t// DSHM profile-managed market seed v2:');
  if (seedStart === -1) seedStart = appBoot.indexOf('\t// DSHM profile-managed market seed v3:');
  const seedEnd = seedStart === -1 ? -1 : appBoot.indexOf(layersAnchor, seedStart);
  if (seedEnd !== -1) appBoot = appBoot.slice(0, seedStart) + appBoot.slice(seedEnd);
  const migration = `\t// DSHM profile-managed market seed v2: seed third-party bundles into the\n\t// user's web profile once. The profile manifest owns them afterwards, so\n\t// dshmarket can list, update, disable, and uninstall them like any other\n\t// plugin. HAP copies remain an offline first-install cache only.\n\tconst dshmProfileManifest = readProfileManifest(binName, dir);\n\tconst dshmSeedState = dshmProfileManifest.dshm?.profileManagedSeed;\n\tconst dshmSeedPackages = ["dshmarket", "@dsh-external/dsh-mobile-nav"];\n\tif (name === "web" && dshmSeedState === void 0) {\n\t\tconst dshmDependencies = { ...dshmProfileManifest.dependencies };\n\t\tconst dshmBundles = [...(dshmProfileManifest.dsh?.profile?.bundles ?? [])].filter((packageName) => packageName !== "@dsh-market/plugin");\n\t\tconst dshmSeeded = [];\n\t\tfor (const packageName of dshmSeedPackages) {\n\t\t\ttry {\n\t\t\t\tconst sourceDir = packageDirFromAnchor(installAnchor, packageName);\n\t\t\t\tif (sourceDir === void 0) continue;\n\t\t\t\tconst targetDir = join(dir, "node_modules", packageName);\n\t\t\t\tif (!existsSync(join(targetDir, "package.json"))) {\n\t\t\t\t\tmkdirSync(dirname(targetDir), { recursive: true });\n\t\t\t\t\tcpSync(sourceDir, targetDir, { recursive: true, force: true });\n\t\t\t\t}\n\t\t\t\tconst packageManifest = JSON.parse(readFileSync(join(targetDir, "package.json"), "utf8"));\n\t\t\t\tif (typeof packageManifest.version !== "string" || packageManifest.version.length === 0) continue;\n\t\t\t\tdshmDependencies[packageName] = packageManifest.version;\n\t\t\t\tif (!dshmBundles.includes(packageName)) dshmBundles.push(packageName);\n\t\t\t\tdshmSeeded.push(packageName);\n\t\t\t} catch (error) {\n\t\t\t\tprocess.stderr.write(\`dsh: failed to seed profile-managed plugin \${packageName}: \${String(error)}\\n\`);\n\t\t\t}\n\t\t}\n\t\twriteProfileManifest(dir, {\n\t\t\t...dshmProfileManifest,\n\t\t\tdependencies: dshmDependencies,\n\t\t\tdsh: {\n\t\t\t\t...dshmProfileManifest.dsh,\n\t\t\t\tprofile: { ...dshmProfileManifest.dsh?.profile, bundles: dshmBundles }\n\t\t\t},\n\t\t\tdshm: { ...dshmProfileManifest.dshm, profileManagedSeed: { version: 2, packages: dshmSeeded } }\n\t\t});\n\t} else if (name === "web" && dshmSeedState?.compatibilityCleanupVersion !== 1) {\n\t\t// dsh-message-rail was installed by the DSHM device smoke test. Its ssh2\n\t\t// dependency requires WebAssembly, unavailable under the required --jitless runtime.\n\t\t// Disable only this known test artifact; user-installed profile packages stay intact.\n\t\tconst incompatibleBundle = "dsh-message-rail";\n\t\tconst dshmBundles = (dshmProfileManifest.dsh?.profile?.bundles ?? []).filter((packageName) => packageName !== incompatibleBundle);\n\t\tif (dshmBundles.length !== (dshmProfileManifest.dsh?.profile?.bundles ?? []).length) {\n\t\t\tprocess.stderr.write("dsh: disabled incompatible test plugin dsh-message-rail (requires WebAssembly)\\n");\n\t\t\twriteProfileManifest(dir, {\n\t\t\t\t...dshmProfileManifest,\n\t\t\t\tdsh: { ...dshmProfileManifest.dsh, profile: { ...dshmProfileManifest.dsh?.profile, bundles: dshmBundles } },\n\t\t\t\tdshm: { ...dshmProfileManifest.dshm, profileManagedSeed: { ...dshmSeedState, compatibilityCleanupVersion: 1 } }\n\t\t\t});\n\t\t}\n\t}\n`;
  const dependencyClosureMigration = `\t// DSHM 预安装依赖闭包：HarmonyOS 禁止符号链接，profile 插件
\t// 需要在自身的 node_modules 根目录中携带可解析的依赖副本。
\tconst dshmClosureManifest = readProfileManifest(binName, dir);
\tconst dshmClosurePackages = ["dshmarket", "@dsh-external/dsh-mobile-nav"];
\tconst dshmClosureBundles = dshmClosureManifest.dsh?.profile?.bundles ?? [];
\tconst dshmClosureDependencies = dshmClosureManifest.dependencies ?? {};
\tif (name === "web" && dshmClosureManifest.dshm?.profileManagedSeed?.dependencyClosureVersion !== 2) {
\t\tfor (const packageName of dshmClosurePackages) {
\t\t\tif (!dshmClosureBundles.includes(packageName) || typeof dshmClosureDependencies[packageName] !== "string") continue;
\t\t\ttry {
\t\t\t\tseedProfilePackageClosure(installAnchor, dir, packageName);
\t\t\t} catch (error) {
\t\t\t\tprocess.stderr.write(\`dsh: failed to seed profile-managed plugin dependencies for \${packageName}: \${String(error)}\\n\`);
\t\t\t}
\t\t}
\t\twriteProfileManifest(dir, {
\t\t\t...dshmClosureManifest,
\t\t\tdshm: {
\t\t\t\t...dshmClosureManifest.dshm,
\t\t\t\tprofileManagedSeed: { ...dshmClosureManifest.dshm?.profileManagedSeed, dependencyClosureVersion: 2 }
\t\t\t}
\t\t});
\t}
`;
  const compatibilityGuard = `\t// DSHM 鸿蒙适配：阻止无法在 --jitless V8 中运行的已安装插件
\t// 终止整个 DSH server。该包仍保留在 profile dependencies 中，用户可以在市场卸载。
\tconst dshmCurrentManifest = readProfileManifest(binName, dir);
\tconst dshmCurrentBundles = dshmCurrentManifest.dsh?.profile?.bundles ?? [];
\tconst dshmCompatibleBundles = dshmCurrentBundles.filter((packageName) => {
\t\ttry {
\t\t\tconst packageDir = resolveBundleDir(binName, packageName, installAnchor, dir);
\t\t\tif (!hasUnsupportedHarmonyDependency(packageDir)) return true;
\t\t\tprocess.stderr.write(\`dsh: disabled plugin \${packageName}; it depends on WebAssembly unavailable on this HarmonyOS runtime\\n\`);
\t\t\treturn false;
\t\t} catch {
\t\t\treturn true;
\t\t}
\t});
\tif (dshmCompatibleBundles.length !== dshmCurrentBundles.length) {
\t\twriteProfileManifest(dir, {
\t\t\t...dshmCurrentManifest,
\t\t\tdsh: { ...dshmCurrentManifest.dsh, profile: { ...dshmCurrentManifest.dsh?.profile, bundles: dshmCompatibleBundles } }
\t\t});
\t}
`;
  if (appBoot.includes(layersAnchor)) appBoot = appBoot.replace(layersAnchor, migration + dependencyClosureMigration + compatibilityGuard + layersAnchor);
  if (!appBoot.includes('DSHM 鸿蒙适配：忽略旧版市场残留的不可用 UI 设置条目')) {
    const oldProfileReturn = 'const patchPath = join(dir, PROFILE_PATCH_FILENAME);\n\treturn {\n\t\tname,\n\t\tdir,\n\t\tlayers,\n\t\tpatchPath,\n\t\tpatches: options.userLayer !== false && existsSync(patchPath) ? loadOverlayPatches(binName, patchPath) : [],\n\t\tpatchReload\n\t};';
    const newProfileReturn = 'const patchPath = join(dir, PROFILE_PATCH_FILENAME);\n\tconst userPatches = options.userLayer !== false && existsSync(patchPath) ? loadOverlayPatches(binName, patchPath) : [];\n\t// DSHM 鸿蒙适配：忽略旧版市场残留的不可用 UI 设置条目，不写回用户配置。\n\tconst patches = name === "web" ? userPatches.filter((patch) => {\n\t\tif (!JSON.stringify(patch).includes("@deepseek-ai/dsh-client-ui-settings-ohos")) return true;\n\t\tprocess.stderr.write("dsh: skipped legacy unavailable ui-settings-ohos patch\\n");\n\t\treturn false;\n\t}) : userPatches;\n\treturn {\n\t\tname,\n\t\tdir,\n\t\tlayers,\n\t\tpatchPath,\n\t\tpatches,\n\t\tpatchReload\n\t};';
    if (appBoot.includes(oldProfileReturn)) appBoot = appBoot.replace(oldProfileReturn, newProfileReturn);
  }
  fs.writeFileSync(appBootPath, appBoot);
}

console.log('dshm-config-editor generated and registered');
