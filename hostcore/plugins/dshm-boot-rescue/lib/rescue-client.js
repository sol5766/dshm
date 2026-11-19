// dshm-boot-rescue — 失败页救援脚本（单文件、零依赖，由宿主 tapIndex 注入浏览器）。
//
// 契约来源：.recon/SPEC.md 第 6 节。关键行为：
//   * 只在 DSHM「插件加载失败页」挂载：根文本含 "Failed to load plugins" 且没有健康 UI 时。
//     失败页 root 在 #root 内、标题是一个 div，因此这里只按根节点文本检测。
//   * 已知失败文案全部识别：failed to import loader entry、failed to apply / resolve /
//     initialize loader entry、client-modules: bundle script ... failed to load、
//     web boot: N entries did not activate、<name>: pending (waiting for service: ...)。
//   * 插件启停只在进程启动时拼装，本页面里做任何重载都不会生效 —— 脚本从不触发页面重载，
//     只写带标记的停用行并提示「停用后请划掉后台重新打开应用」。
//   * 只用 var/function 传统语法（ArkWeb 兼容）；全部逻辑 try/catch；零遥测。
(function () {
  "use strict";

  try {
    if (window.__DSHM_BOOT_RESCUE__) return;
    window.__DSHM_BOOT_RESCUE__ = true;
  } catch (error) {
    return;
  }

  // ── 1. 常量 ───────────────────────────────────────────────────────────────
  var API_STATE = "/dshm-boot-rescue/state";
  var API_DISABLE = "/dshm-boot-rescue/disable";
  var API_RESTORE = "/dshm-boot-rescue/restore";
  var API_HEALTH = "/dshm-boot-rescue/health";
  // 失败页标题：「Failed to load plugins」渲染在 #root 内的一个 div 里，不是语义标题元素。
  var FAILURE_TITLE = "Failed to load plugins";
  // 健康 DSHM 界面一定存在树控件或可编辑控件；聊天里引用错误文本时用它排除误挂。
  var HEALTHY_UI_SELECTOR = '[role="tree"],textarea,[contenteditable="true"],[role="textbox"],input:not([type="hidden"])';
  var PREVIEW_ATTR = "data-dshm-boot-rescue-preview";
  var MAX_SELECTION = 32;
  var MAX_WATCH_MS = 120000;
  var MAX_FAILURE_TEXT = 12000;
  var RESTART_GUIDE = "停用后请划掉后台重新打开应用";
  var RESTART_DETAIL = "插件启停只在进程启动时拼装，重新打开本页面不会生效";
  var PREVIEW_NOTICE = "只读自检：不会修改任何配置";
  var FALLBACK_WARNING = "本次停用重启应用后失效，请进入系统后立即卸载肇事插件";
  var SERVICE_DOWN_TITLE = "救援服务暂时不可用";
  // 已知失败文案逐条识别（name 只用于诊断；不要求每条同时出现）：
  //   failed to import loader entry <name> (<pkg>)
  //   failed to apply / resolve / initialize loader entry <name> (<pkg>)
  //   client-modules: bundle script <url> failed to load
  //   web boot: N entries did not activate（整体错误，不单独提取名字）
  //   <name>: pending (waiting for service: <service>)
  var LOADER_HINT_PATTERNS = [
    /failed to import loader entry\s+([^\s(]+)(?:\s+\(([^)]+)\))?/i,
    /failed to apply loader entry\s+([^\s(]+)(?:\s+\(([^)]+)\))?/i,
    /failed to resolve loader entry\s+([^\s(]+)(?:\s+\(([^)]+)\))?/i,
    /failed to initialize loader entry\s+([^\s(]+)(?:\s+\(([^)]+)\))?/i
  ];
  var BUNDLE_HINT_PATTERN = /client-modules:\s*bundle script\s+([^\s]+)\s+failed to load/i;
  var ACTIVATION_PATTERN = /web boot:\s*\d+\s+entr(?:y|ies)\s+did not activate/i;
  var PENDING_HINT_PATTERN = /([^\s:]+):\s*pending \(waiting for service[^)]*\)/i;
  // dsh 0.2.1 的失败项实际文案是 "<name>: import failed: <message>" /
  // "<name>: import failed (see console for the import error)"（见核心 bundle 的 bZ()）。
  var IMPORT_FAILED_PATTERN = /([^\s:]+):\s*import failed\b/i;

  // ── 2. 运行时状态 ─────────────────────────────────────────────────────────
  var INSERTED = false;
  var observer = null;
  var watchStopTimer = null;
  var mountTimer = null;
  var restoreConfirmTimer = null;
  var panel = null;
  var isPreview = false;
  var failureText = "";
  var model = {
    version: "", generatedAt: "", mode: "rows", writable: true,
    readOnlyReason: "", readOnlyReasonCode: "", warning: "",
    rowsPath: "", profileDir: "",
    entries: [], rescueRows: {}, suspects: {}, selected: {},
    filter: "user", query: "", busy: false, confirmRestore: false,
    statusText: "", statusTone: ""
  };

  // ── 3. 通用工具 ───────────────────────────────────────────────────────────
  function esc(value) {
    try {
      return String(value === undefined || value === null ? "" : value).replace(/[&<>"']/g, function (character) {
        return character === "&" ? "&amp;" : character === "<" ? "&lt;" : character === ">" ? "&gt;" : character === '"' ? "&quot;" : "&#39;";
      });
    } catch (error) {
      return "";
    }
  }

  function normalizeText(value) {
    try {
      return String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim();
    } catch (error) {
      return "";
    }
  }

  function asStringArray(value) {
    var output = [];
    var index;
    try {
      if (typeof value === "string") value = [value];
      if (!value || !value.length) return output;
      for (index = 0; index < value.length; index++) {
        var item = String(value[index] === undefined || value[index] === null ? "" : value[index]).trim();
        if (item && output.indexOf(item) === -1) output.push(item);
      }
    } catch (error) {
      return [];
    }
    return output;
  }

  function formatTime(value) {
    try {
      var date = new Date(value);
      if (isNaN(date.getTime())) return "";
      var pad = function (number) { return number < 10 ? "0" + number : String(number); };
      return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " +
        pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
    } catch (error) {
      return "";
    }
  }

  function errorMessage(error) {
    return error && error.message ? String(error.message) : "未知错误";
  }

  // ── 4. 条目判定 ───────────────────────────────────────────────────────────
  function groupKey(entry) {
    try {
      return String(entry.groupId || entry.packageName || entry.name || entry.id || "");
    } catch (error) {
      return "";
    }
  }

  function aliasesOf(raw) {
    var output = [];
    try {
      var list = raw && raw.aliases;
      for (var index = 0; list && index < list.length; index++) {
        var value = String(list[index] === undefined || list[index] === null ? "" : list[index]).trim();
        if (value && output.indexOf(value) === -1) output.push(value);
      }
    } catch (error) {
      return [];
    }
    return output;
  }

  // 防御式合并同 id 条目（服务端已去重，这里只做兜底）。
  function normalizeEntries(list) {
    var output = [];
    var byId = {};
    if (!list || !list.length) return output;
    try {
      for (var index = 0; index < list.length; index++) {
        var raw = list[index];
        if (!raw || !raw.id) continue;
        var id = String(raw.id);
        var entry = byId[id];
        if (!entry) {
          entry = {
            id: id, groupId: String(raw.groupId || ""),
            name: String(raw.name || raw.packageName || id), packageName: String(raw.packageName || ""),
            aliases: aliasesOf(raw), builtin: !!raw.builtin, protected: !!raw.protected,
            protectedReason: String(raw.protectedReason || ""), installed: raw.installed !== false,
            hasUserRow: !!raw.hasUserRow, disabled: !!raw.disabled,
            disabledByRescue: !!raw.disabledByRescue, actionable: raw.actionable !== false,
            reason: String(raw.reason || "")
          };
          byId[id] = entry;
          output.push(entry);
          continue;
        }
        var extraAliases = aliasesOf(raw);
        for (var aliasIndex = 0; aliasIndex < extraAliases.length; aliasIndex++) {
          if (entry.aliases.indexOf(extraAliases[aliasIndex]) === -1) entry.aliases.push(extraAliases[aliasIndex]);
        }
        entry.hasUserRow = entry.hasUserRow || !!raw.hasUserRow;
        entry.installed = entry.installed || raw.installed !== false;
        entry.disabled = entry.disabled || !!raw.disabled;
        entry.disabledByRescue = entry.disabledByRescue || !!raw.disabledByRescue;
        entry.builtin = entry.builtin || !!raw.builtin;
        entry.protected = entry.protected || !!raw.protected;
        entry.actionable = entry.actionable && raw.actionable !== false;
        if (!entry.reason && raw.reason) entry.reason = String(raw.reason);
        if (!entry.protectedReason && raw.protectedReason) entry.protectedReason = String(raw.protectedReason);
      }
    } catch (error) {
      return output;
    }
    return output;
  }

  function findEntry(id) {
    try {
      for (var index = 0; index < model.entries.length; index++) {
        if (model.entries[index].id === id) return model.entries[index];
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  function isRescueDisabled(entry) {
    try {
      return !!entry.disabledByRescue || !!model.rescueRows[entry.id];
    } catch (error) {
      return false;
    }
  }

  // 可写 + 非内置/受保护 + 未被救援停用 + 未被配置禁用。
  function isActionable(entry) {
    try {
      if (!entry || !model.writable || entry.actionable === false) return false;
      if (entry.builtin || entry.protected) return false;
      if (isRescueDisabled(entry) || entry.disabled) return false;
      return true;
    } catch (error) {
      return false;
    }
  }

  function isUserEntry(entry) {
    return !entry.builtin && !entry.protected;
  }

  // ── 5. 失败页检测与疑似识别（SPEC 4.2）────────────────────────────────────
  function hasKnownFailure(text) {
    try {
      var index;
      for (index = 0; index < LOADER_HINT_PATTERNS.length; index++) {
        if (LOADER_HINT_PATTERNS[index].test(text)) return true;
      }
      return BUNDLE_HINT_PATTERN.test(text) || ACTIVATION_PATTERN.test(text) || PENDING_HINT_PATTERN.test(text)
        || IMPORT_FAILED_PATTERN.test(text);
    } catch (error) {
      return false;
    }
  }

  // 从 client-modules 的 bundle URL 里尽力取出包名 / 插件 id。
  function packageNamesFromUrl(url) {
    var names = [];
    try {
      var value = String(url || "");
      try { value = decodeURIComponent(value); } catch (decodeError) { /* 用原始值继续 */ }
      var match = /\/plugins\/([^\/\s?#]+)\//.exec(value);
      if (match && match[1]) names.push(match[1]);
      match = /node_modules\/((?:@[^\/\s?#]+\/)?[^\/\s?#]+)/.exec(value);
      if (match && match[1]) names.push(match[1]);
      var file = value.split(/[?#]/)[0].split("/").pop() || "";
      if (file) {
        var base = file.replace(/\.(?:js|cjs|mjs|json)(?:\.map)?$/i, "");
        if (base) names.push(base);
      }
    } catch (error) {
      return names;
    }
    return names;
  }

  function collectHints(text) {
    var hints = [];
    var index;
    var match;
    try {
      for (index = 0; index < LOADER_HINT_PATTERNS.length; index++) {
        var pattern = new RegExp(LOADER_HINT_PATTERNS[index].source, "gi");
        while ((match = pattern.exec(text))) {
          if (match[1]) hints.push(match[1]);
          if (match[2]) hints.push(match[2]);
        }
      }
      var bundlePattern = new RegExp(BUNDLE_HINT_PATTERN.source, "gi");
      while ((match = bundlePattern.exec(text))) {
        var names = packageNamesFromUrl(match[1]);
        for (index = 0; index < names.length; index++) hints.push(names[index]);
      }
      var pendingPattern = new RegExp(PENDING_HINT_PATTERN.source, "gi");
      while ((match = pendingPattern.exec(text))) {
        if (match[1]) hints.push(match[1]);
      }
      var importFailedPattern = new RegExp(IMPORT_FAILED_PATTERN.source, "gi");
      while ((match = importFailedPattern.exec(text))) {
        if (match[1]) hints.push(match[1]);
      }
    } catch (error) {
      return hints;
    }
    return hints;
  }

  function identifySuspects(entries, text) {
    var suspects = {};
    var index;
    try {
      var hints = collectHints(text);
      var lowerText = String(text || "").toLowerCase();
      var lowerHints = [];
      for (index = 0; index < hints.length; index++) {
        var hint = String(hints[index] === undefined || hints[index] === null ? "" : hints[index]).trim().toLowerCase();
        if (hint) lowerHints.push(hint);
      }
      for (index = 0; index < entries.length; index++) {
        var entry = entries[index];
        var values = [entry.id, entry.name, entry.packageName].concat(entry.aliases || []);
        for (var valueIndex = 0; valueIndex < values.length; valueIndex++) {
          var value = String(values[valueIndex] === undefined || values[valueIndex] === null ? "" : values[valueIndex]).trim().toLowerCase();
          if (value && lowerHints.indexOf(value) !== -1) { suspects[entry.id] = true; break; }
        }
      }
      // 兜底：较长且带 -/@/. 的 alias 出现在失败页文本里即命中（短 alias 只认精确命中）。
      for (index = 0; index < entries.length; index++) {
        if (suspects[entries[index].id]) continue;
        var aliases = entries[index].aliases || [];
        for (var aliasIndex = 0; aliasIndex < aliases.length; aliasIndex++) {
          var alias = String(aliases[aliasIndex] || "").trim().toLowerCase();
          if (alias.length >= 5 && /[-@.]/.test(alias) && lowerText.indexOf(alias) !== -1) {
            suspects[entries[index].id] = true;
            break;
          }
        }
      }
      // 整插件：命中 entry 的同 groupId 条目全部视为疑似（整组停用）。
      var groups = {};
      for (index = 0; index < entries.length; index++) {
        if (suspects[entries[index].id]) groups[groupKey(entries[index])] = true;
      }
      for (index = 0; index < entries.length; index++) {
        if (groups[groupKey(entries[index])]) suspects[entries[index].id] = true;
      }
    } catch (error) {
      return suspects;
    }
    return suspects;
  }

  // 返回失败页根节点；健康 UI、空页、加载页一律返回 null（永不挂载）。
  function findFailureRoot() {
    try {
      var root = document.getElementById("root") || document.body;
      if (!root || !root.querySelector) return null;
      if (root.querySelector(HEALTHY_UI_SELECTOR)) return null;
      var text = normalizeText(root.textContent || "");
      if (!text) return null;
      failureText = text.slice(0, MAX_FAILURE_TEXT);
      // 兜底要求：有标题即挂载，不依赖细节文案；已知失败正则只作附加信号。
      if (text.indexOf(FAILURE_TITLE) === -1 && !hasKnownFailure(text)) return null;
      return root;
    } catch (error) {
      return null;
    }
  }

  // ── 6. state 归一化（SPEC 5.2）────────────────────────────────────────────
  function normalizeState(state) {
    try {
      var data = state || {};
      model.version = String(data.version || "");
      model.generatedAt = String(data.generatedAt || "");
      model.mode = String(data.mode || "rows");
      model.writable = data.writable !== false;
      model.readOnlyReason = String(data.readOnlyReason || "");
      model.readOnlyReasonCode = String(data.readOnlyReasonCode || "");
      model.warning = String(data.warning || "");
      model.rowsPath = String(data.rowsPath || "");
      model.profileDir = String(data.profileDir || "");
      model.entries = normalizeEntries(data.entries);
      model.rescueRows = {};
      var index;
      var rescue = asStringArray(data.rescueRows);
      for (index = 0; index < rescue.length; index++) model.rescueRows[rescue[index]] = true;
      for (index = 0; index < model.entries.length; index++) {
        if (model.rescueRows[model.entries[index].id]) model.entries[index].disabledByRescue = true;
      }
      model.suspects = identifySuspects(model.entries, failureText);
      model.selected = {};
      model.query = "";
      model.busy = false;
      model.confirmRestore = false;
      model.statusText = "";
      model.statusTone = "";
      var actionableSuspects = 0;
      for (index = 0; index < model.entries.length; index++) {
        var suspectEntry = model.entries[index];
        if (model.suspects[suspectEntry.id] && isActionable(suspectEntry)) actionableSuspects++;
      }
      // 有「可操作」疑似时默认看「疑似故障」，否则默认「用户插件」。
      // 疑似高亮与诊断条不受影响：全部疑似项都受保护/不可操作时不再落入空标签页。
      model.filter = actionableSuspects ? "suspect" : "user";
      // 自动勾选所有可操作的疑似项（最多 32 项）。
      var selected = 0;
      for (index = 0; index < model.entries.length; index++) {
        var entry = model.entries[index];
        if (!model.suspects[entry.id] || !isActionable(entry)) continue;
        if (selected >= MAX_SELECTION) break;
        model.selected[entry.id] = true;
        selected++;
      }
    } catch (error) {
      model.entries = [];
      model.suspects = {};
      model.selected = {};
    }
  }

  // ── 7. 样式（固定覆盖层 + 暗色适配，类前缀统一 dbr-）──────────────────────
  function detectDark() {
    try {
      if (document.body && document.body.hasAttribute("data-ds-dark-theme")) return true;
      if (document.documentElement && document.documentElement.hasAttribute("data-ds-dark-theme")) return true;
      if (document.documentElement) {
        var explicit = document.documentElement.getAttribute("data-theme") || document.documentElement.getAttribute("data-color-scheme");
        if (explicit === "dark") return true;
        if (explicit === "light") return false;
      }
      return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    } catch (error) {
      return false;
    }
  }

  function injectStyles() {
    try {
      if (document.getElementById("dshm-boot-rescue-styles")) return;
      var style = document.createElement("style");
      style.id = "dshm-boot-rescue-styles";
      style.textContent = [
        ".dbr-overlay{--dbr-bg:#fff;--dbr-raised:#f5f6f8;--dbr-hover:#edf1f5;--dbr-border:#dde2e8;--dbr-border-strong:#c4ccd5;--dbr-text:#1c232b;--dbr-muted:#68727e;--dbr-faint:#8a939e;--dbr-accent:#c4543a;--dbr-accent-hover:#ab452d;--dbr-accent-ink:#fff;--dbr-warn-bg:#fff6e8;--dbr-warn-border:#ecc78d;--dbr-warn-text:#8a4a15;--dbr-danger:#c34a4a;--dbr-ok:#2b8f68;position:fixed;inset:0;z-index:2147483000;overflow:auto;overscroll-behavior:contain;padding:24px 12px 56px;background:rgba(10,14,20,.5);color:var(--dbr-text);font:13px/1.55 'HarmonyOS Sans',Inter,system-ui,-apple-system,'Segoe UI',sans-serif;text-align:left;-webkit-overflow-scrolling:touch}",
        ".dbr-overlay.dbr-dark{--dbr-bg:#1a1d21;--dbr-raised:#24272c;--dbr-hover:#2b2f35;--dbr-border:#33383f;--dbr-border-strong:#464d56;--dbr-text:#eef1f4;--dbr-muted:#a6aeb8;--dbr-faint:#7e8893;--dbr-accent:#e07a5f;--dbr-accent-hover:#ea8b72;--dbr-accent-ink:#17191c;--dbr-warn-bg:#2c241c;--dbr-warn-border:#6b4a27;--dbr-warn-text:#f1bd80;--dbr-danger:#e06868;--dbr-ok:#54b98d;background:rgba(0,0,0,.6)}",
        ".dbr-overlay *,.dbr-overlay *:before,.dbr-overlay *:after{box-sizing:border-box}.dbr-overlay [hidden]{display:none!important}.dbr-overlay button,.dbr-overlay input{font:inherit;color:inherit}.dbr-overlay button{appearance:none;border:0;background:transparent;cursor:pointer}.dbr-svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;display:block;flex:0 0 auto}",
        ".dbr-card{width:min(760px, calc(100% - 24px));margin:0 auto;background:var(--dbr-bg);border:1px solid var(--dbr-border);border-radius:18px;box-shadow:0 18px 60px rgba(8,12,18,.28);overflow:hidden}",
        ".dbr-head{display:flex;align-items:flex-start;gap:14px;padding:20px 22px 16px;border-bottom:1px solid var(--dbr-border)}",
        ".dbr-emblem{width:42px;height:42px;display:flex;align-items:center;justify-content:center;flex:0 0 auto;color:var(--dbr-accent);background:var(--dbr-raised);border:1px solid var(--dbr-border);border-radius:12px}.dbr-emblem .dbr-svg{width:23px;height:23px}",
        ".dbr-head-main{min-width:0;flex:1}.dbr-kicker{display:flex;align-items:center;gap:8px;color:var(--dbr-muted);font-size:10px;font-weight:700;letter-spacing:.12em}.dbr-live{display:inline-flex;align-items:center;gap:5px;letter-spacing:0;font-weight:600;text-transform:none}.dbr-dot{width:6px;height:6px;border-radius:50%;background:var(--dbr-ok);box-shadow:0 0 0 3px rgba(43,143,104,.14)}.dbr-live.dbr-readonly-state .dbr-dot{background:var(--dbr-warn-text);box-shadow:0 0 0 3px rgba(210,138,62,.16)}.dbr-live.dbr-degraded-state .dbr-dot{background:var(--dbr-danger);box-shadow:0 0 0 3px rgba(195,74,74,.16)}.dbr-live.dbr-preview-state .dbr-dot{background:var(--dbr-faint);box-shadow:none}",
        ".dbr-title{font-size:19px;line-height:1.35;font-weight:650;letter-spacing:-.01em;margin-top:3px}.dbr-subtitle{margin-top:3px;color:var(--dbr-muted);font-size:12px}.dbr-version{margin-top:3px;color:var(--dbr-faint);font:10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}",
        ".dbr-preview{flex:0 0 auto;padding:3px 9px;border:1px solid var(--dbr-warn-border);border-radius:999px;background:var(--dbr-warn-bg);color:var(--dbr-warn-text);font-size:10px;font-weight:650;white-space:nowrap}",
        ".dbr-diagnosis{display:flex;align-items:center;gap:11px;margin:14px 20px 0;padding:11px 12px;border:1px solid var(--dbr-warn-border);border-radius:11px;background:var(--dbr-warn-bg);color:var(--dbr-warn-text)}.dbr-diagnosis .dbr-svg{flex:0 0 auto}.dbr-diagnosis-text{min-width:0;flex:1}.dbr-diagnosis-text strong{display:block;font-size:12px}.dbr-diagnosis-text span{display:block;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}.dbr-diagnosis-note{flex:0 0 auto;font-size:10px;font-weight:650}",
        ".dbr-warning{display:flex;align-items:flex-start;gap:10px;margin:12px 20px 0;padding:11px 12px;border:1px solid var(--dbr-warn-border);border-left:3px solid var(--dbr-danger);border-radius:10px;background:var(--dbr-warn-bg);color:var(--dbr-warn-text)}.dbr-warning .dbr-svg{margin-top:1px;color:var(--dbr-danger)}.dbr-warning-text strong{display:block;font-size:12px}.dbr-warning-text span{display:block;margin-top:2px;font-size:11.5px;line-height:1.5}",
        ".dbr-notice{display:flex;flex-direction:column;gap:2px;margin:14px 20px 0;padding:11px 13px;border-left:3px solid var(--dbr-accent);border-radius:8px;background:var(--dbr-raised)}.dbr-notice strong{font-size:12.5px}.dbr-notice span{color:var(--dbr-muted);font-size:11.5px}",
        ".dbr-controls{padding:14px 20px 8px}.dbr-search{width:100%;height:40px;padding:0 12px;color:var(--dbr-text);background:var(--dbr-raised);border:1px solid var(--dbr-border-strong);border-radius:10px;outline:none}.dbr-search::placeholder{color:var(--dbr-faint)}.dbr-search:focus{border-color:var(--dbr-accent);box-shadow:0 0 0 3px rgba(196,84,58,.16)}",
        ".dbr-tabs{display:flex;align-items:center;gap:3px;margin-top:10px;overflow-x:auto;scrollbar-width:none}.dbr-tabs::-webkit-scrollbar{display:none}.dbr-tab{min-height:32px;padding:5px 10px;border-radius:8px;color:var(--dbr-muted);font-size:11.5px;white-space:nowrap}.dbr-tab:hover{background:var(--dbr-hover)}.dbr-tab[aria-selected='true']{color:var(--dbr-text);background:var(--dbr-raised);font-weight:650}",
        ".dbr-list-meta{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 20px;min-height:30px;color:var(--dbr-muted);font-size:11px}.dbr-meta-actions{display:flex;gap:12px}.dbr-text-btn{padding:3px 0;color:var(--dbr-muted);font-size:11px}.dbr-text-btn:hover{color:var(--dbr-text)}.dbr-text-btn[disabled]{opacity:.4;cursor:not-allowed}",
        ".dbr-list{max-height:42vh;overflow:auto;padding:0 12px 8px;scrollbar-color:var(--dbr-border-strong) transparent}",
        ".dbr-item{display:flex;align-items:center;gap:10px;min-height:54px;padding:7px 9px;border:1px solid transparent;border-radius:10px}.dbr-item+.dbr-item{margin-top:3px}.dbr-item:hover{background:var(--dbr-hover)}.dbr-item.dbr-selected{border-color:var(--dbr-accent);background:var(--dbr-raised)}.dbr-item.dbr-suspect:not(.dbr-selected){border-color:var(--dbr-warn-border)}.dbr-item-main{display:flex;align-items:center;gap:10px;flex:1;min-width:0;cursor:pointer}.dbr-item-main.dbr-inert{cursor:default}",
        ".dbr-check{width:18px;height:18px;flex:0 0 auto;accent-color:var(--dbr-accent);cursor:pointer}.dbr-check[disabled]{cursor:not-allowed;opacity:.4}.dbr-plugin{display:flex;flex-direction:column;min-width:0;flex:1;gap:1px}.dbr-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:600}.dbr-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dbr-muted);font:10.5px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}",
        ".dbr-badges{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px;flex:0 1 auto;max-width:46%}.dbr-badge{padding:2px 7px;border:1px solid var(--dbr-border);border-radius:999px;background:var(--dbr-raised);color:var(--dbr-muted);font-size:10px;font-weight:600;white-space:nowrap}.dbr-badge-warn{border-color:var(--dbr-warn-border);background:var(--dbr-warn-bg);color:var(--dbr-warn-text)}.dbr-badge-info{border-color:var(--dbr-border-strong);color:var(--dbr-text)}.dbr-badge-muted{opacity:.85}",
        ".dbr-row-btn{flex:0 0 auto;min-height:28px;padding:3px 9px;border:1px solid var(--dbr-border-strong);border-radius:7px;font-size:11px;font-weight:600;white-space:nowrap}.dbr-row-btn:hover{background:var(--dbr-hover)}.dbr-row-btn[disabled]{opacity:.4;cursor:not-allowed}.dbr-empty{padding:28px 12px;text-align:center;color:var(--dbr-muted);font-size:12px}",
        ".dbr-readonly{margin:12px 20px 0;padding:12px 14px;border:1px solid var(--dbr-warn-border);border-radius:10px;background:var(--dbr-warn-bg);color:var(--dbr-warn-text);font-size:11.5px;line-height:1.55}.dbr-readonly-title{font-size:12px;font-weight:650;margin-bottom:4px}.dbr-readonly p{margin:4px 0 0}.dbr-readonly code,.dbr-fallback code{display:inline-block;padding:1px 5px;border-radius:5px;background:rgba(0,0,0,.06);font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all}",
        ".dbr-dark .dbr-readonly code,.dbr-dark .dbr-fallback code{background:rgba(255,255,255,.08)}",
        ".dbr-foot{display:flex;flex-direction:column;gap:10px;margin-top:14px;padding:14px 20px 16px;border-top:1px solid var(--dbr-border);background:var(--dbr-raised)}.dbr-status{min-height:18px;color:var(--dbr-muted);font-size:11.5px}.dbr-status[data-tone='error']{color:var(--dbr-danger)}.dbr-status[data-tone='success']{color:var(--dbr-ok)}.dbr-status[data-tone='warn']{color:var(--dbr-warn-text)}.dbr-status[data-tone='preview']{color:var(--dbr-warn-text)}.dbr-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}",
        ".dbr-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:38px;padding:7px 14px;border:1px solid var(--dbr-border-strong);border-radius:10px;background:var(--dbr-bg);font-size:12px;font-weight:600;white-space:nowrap}.dbr-btn:hover{background:var(--dbr-hover)}.dbr-btn .dbr-svg{width:15px;height:15px}.dbr-btn.dbr-primary{border-color:var(--dbr-accent);background:var(--dbr-accent);color:var(--dbr-accent-ink)}.dbr-btn.dbr-primary:hover{background:var(--dbr-accent-hover);border-color:var(--dbr-accent-hover)}.dbr-btn.dbr-restore-confirm{border-color:var(--dbr-warn-border);background:var(--dbr-warn-bg);color:var(--dbr-warn-text)}.dbr-btn[disabled]{opacity:.45;cursor:not-allowed}",
        ".dbr-overlay button:focus-visible,.dbr-overlay input:focus-visible{outline:2px solid var(--dbr-accent);outline-offset:2px}",
        ".dbr-fallback-body{padding:24px}.dbr-fallback-body p{margin:10px 0 0;color:var(--dbr-muted);font-size:12px;line-height:1.6}.dbr-fallback-body .dbr-title{font-size:17px}.dbr-hint{color:var(--dbr-warn-text)!important}",
        "@media(max-width:640px){.dbr-overlay{padding:12px 8px 32px}.dbr-card{width:calc(100% - 16px);border-radius:14px}.dbr-head{padding:16px 15px 13px}.dbr-controls{padding:12px 15px 6px}.dbr-diagnosis,.dbr-notice,.dbr-warning,.dbr-readonly{margin-left:15px;margin-right:15px}.dbr-list-meta{padding:0 15px}.dbr-list{padding-left:7px;padding-right:7px;max-height:38vh}.dbr-foot{padding:12px 15px 14px}.dbr-actions{display:grid;grid-template-columns:1fr 1fr}.dbr-actions .dbr-primary{grid-column:1/-1}.dbr-btn{min-height:42px}.dbr-badges{max-width:38%}}",
        "@media(prefers-reduced-motion:reduce){.dbr-overlay *{animation:none!important;transition:none!important}}"
      ].join("");
      document.head.appendChild(style);
    } catch (error) {
      // 样式失败不影响功能：面板仍可操作，只是无样式。
    }
  }

  // ── 8. 同源 API ───────────────────────────────────────────────────────────
  function api(url, options) {
    try {
      var init = { credentials: "same-origin" };
      if (options) {
        if (options.method) init.method = options.method;
        if (options.headers) init.headers = options.headers;
        if (options.body !== undefined) init.body = options.body;
      }
      return fetch(url, init).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok || (body && body.ok === false)) {
            var failure = new Error((body && body.error) || ("HTTP " + response.status));
            failure.code = (body && body.code) || "";
            throw failure;
          }
          return body || {};
        });
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function postJSON(url, payload) {
    return api(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload || {}) });
  }

  // ── 9. 数据视图 ───────────────────────────────────────────────────────────
  function countSelected() {
    try { return Object.keys(model.selected).length; } catch (error) { return 0; }
  }

  function countRescueRows() {
    try { return Object.keys(model.rescueRows).length; } catch (error) { return 0; }
  }

  function selectedActionableIds() {
    var ids = [];
    try {
      for (var index = 0; index < model.entries.length; index++) {
        var entry = model.entries[index];
        if (model.selected[entry.id] && isActionable(entry)) ids.push(entry.id);
      }
    } catch (error) {
      return ids;
    }
    return ids;
  }

  function suspectEntries() {
    var output = [];
    try {
      for (var index = 0; index < model.entries.length; index++) {
        if (model.suspects[model.entries[index].id]) output.push(model.entries[index]);
      }
    } catch (error) {
      return output;
    }
    return output;
  }

  function suspectText() {
    var suspects = suspectEntries();
    var names = [];
    for (var index = 0; index < suspects.length; index++) {
      names.push((suspects[index].name || suspects[index].id) + " [" + suspects[index].id + "]");
    }
    return names.join(", ");
  }

  function filteredEntries() {
    var output = [];
    try {
      var query = model.query.trim().toLowerCase();
      for (var index = 0; index < model.entries.length; index++) {
        var entry = model.entries[index];
        if (query) {
          var haystack = [entry.name, entry.id, entry.packageName].concat(entry.aliases || []).join(" ").toLowerCase();
          if (haystack.indexOf(query) !== -1) output.push(entry);
          continue;
        }
        if (model.filter === "suspect" && !model.suspects[entry.id]) continue;
        if (model.filter === "user" && !isUserEntry(entry)) continue;
        if (model.filter === "rescue" && !isRescueDisabled(entry) && !entry.disabled) continue;
        output.push(entry);
      }
      output.sort(function (left, right) {
        var suspectDelta = (model.suspects[right.id] ? 1 : 0) - (model.suspects[left.id] ? 1 : 0);
        if (suspectDelta) return suspectDelta;
        var actionableDelta = (isActionable(right) ? 1 : 0) - (isActionable(left) ? 1 : 0);
        if (actionableDelta) return actionableDelta;
        var leftName = String(left.name || left.id).toLowerCase();
        var rightName = String(right.name || right.id).toLowerCase();
        return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
      });
    } catch (error) {
      return output;
    }
    return output;
  }

  // ── 10. 面板渲染 ──────────────────────────────────────────────────────────
  var ICONS = {
    rescue: '<svg class="dbr-svg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.4"/><path d="M5.7 5.7 9.3 9.3m5.4 5.4 3.6 3.6m0-12.6-3.6 3.6m-5.4 5.4-3.6 3.6"/></svg>',
    warning: '<svg class="dbr-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 4.1 2.6 17.5A1.7 1.7 0 0 0 4.1 20h15.8a1.7 1.7 0 0 0 1.5-2.5L13.7 4.1a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 3.4v.01"/></svg>',
    copy: '<svg class="dbr-svg" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
    arrow: '<svg class="dbr-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"/></svg>'
  };

  function buildOverlay() {
    injectStyles();
    var overlay = document.createElement("div");
    overlay.className = "dbr-overlay" + (detectDark() ? " dbr-dark" : "");
    overlay.id = "dshm-boot-rescue-overlay";
    overlay.innerHTML = [
      '<section class="dbr-card" role="dialog" aria-labelledby="dbr-title">',
      '<header class="dbr-head">',
      '<div class="dbr-emblem">' + ICONS.rescue + '</div>',
      '<div class="dbr-head-main">',
      '<div class="dbr-kicker">DSHM BOOT RESCUE<span class="dbr-live" data-role="service-state"><span class="dbr-dot"></span><span data-role="service-label">救援服务在线</span></span></div>',
      '<div class="dbr-title" id="dbr-title">启动恢复中心</div>',
      '<div class="dbr-subtitle">插件加载中断。这里可以定位故障插件并临时停用，让 DSHM 恢复启动。</div>',
      '<div class="dbr-version" data-role="version"></div>',
      '</div>',
      '<span class="dbr-preview" data-role="preview-badge" hidden>只读自检</span>',
      '</header>',
      '<div class="dbr-diagnosis" data-role="diagnosis" hidden>' + ICONS.warning + '<div class="dbr-diagnosis-text"><strong>已定位疑似故障插件</strong><span data-role="suspects"></span></div><span class="dbr-diagnosis-note">已自动勾选</span></div>',
      '<div class="dbr-warning" data-role="warning" hidden>' + ICONS.warning + '<div class="dbr-warning-text"><strong data-role="warning-title">降级模式警示</strong><span data-role="warning-text"></span></div></div>',
      '<div class="dbr-notice"><strong>' + RESTART_GUIDE + '</strong><span>' + RESTART_DETAIL + '</span></div>',
      '<div class="dbr-controls">',
      '<input class="dbr-search" data-role="search" type="search" autocomplete="off" spellcheck="false" placeholder="搜索插件名称、包名或入口 id" aria-label="搜索插件">',
      '<div class="dbr-tabs" role="tablist" aria-label="插件范围">',
      '<button class="dbr-tab" data-filter="suspect" role="tab" type="button">疑似故障</button>',
      '<button class="dbr-tab" data-filter="user" role="tab" type="button">用户插件</button>',
      '<button class="dbr-tab" data-filter="rescue" role="tab" type="button">已停用</button>',
      '<button class="dbr-tab" data-filter="all" role="tab" type="button">全部</button>',
      '</div>',
      '</div>',
      '<div class="dbr-list-meta"><span data-role="summary"></span><span class="dbr-meta-actions"><button class="dbr-text-btn" data-act="select-visible" type="button">选择当前可用项</button><button class="dbr-text-btn" data-act="clear" type="button">清除选择</button></span></div>',
      '<div class="dbr-list" data-role="list" role="list"></div>',
      '<div class="dbr-readonly" data-role="readonly" hidden></div>',
      '<footer class="dbr-foot">',
      '<div class="dbr-status" data-role="status" role="status" aria-live="polite"></div>',
      '<div class="dbr-actions">',
      '<button class="dbr-btn" data-act="copy" type="button">' + ICONS.copy + '<span>复制诊断</span></button>',
      '<button class="dbr-btn" data-act="restore-all" type="button"><span data-role="restore-label">恢复救援停用项</span></button>',
      '<button class="dbr-btn dbr-primary" data-act="disable" type="button"><span data-role="disable-label">停用所选并等待重启</span>' + ICONS.arrow + '</button>',
      '</div>',
      '</footer>',
      '</section>'
    ].join("");
    return overlay;
  }

  function entryMarkup(entry) {
    var suspect = !!model.suspects[entry.id];
    var rescueDisabled = isRescueDisabled(entry);
    var selected = !!model.selected[entry.id];
    var actionable = isActionable(entry);
    var classes = "dbr-item" + (selected ? " dbr-selected" : "") + (suspect ? " dbr-suspect" : "");
    var badges = [];
    if (suspect) badges.push('<span class="dbr-badge dbr-badge-warn">疑似故障</span>');
    if (rescueDisabled) badges.push('<span class="dbr-badge dbr-badge-info">已由救援停用</span>');
    else if (entry.disabled) badges.push('<span class="dbr-badge">配置已禁用</span>');
    if (entry.builtin) {
      badges.push('<span class="dbr-badge dbr-badge-muted" title="内置受保护条目，救援脚本不会修改">内置受保护</span>');
    } else if (entry.protected) {
      badges.push('<span class="dbr-badge dbr-badge-muted" title="' + esc(entry.protectedReason || "") + '">' + (entry.protectedReason === "self" ? "救援自身" : "受保护") + '</span>');
    } else if (!actionable && !rescueDisabled && entry.reason) {
      badges.push('<span class="dbr-badge dbr-badge-muted" title="' + esc(entry.reason) + '">未映射</span>');
    }
    var meta = [];
    if (entry.packageName && entry.packageName !== entry.id) meta.push("包名 " + entry.packageName);
    meta.push("入口 id: " + entry.id);
    if (entry.hasUserRow) meta.push("已有用户行");
    var checkbox = '<input class="dbr-check" type="checkbox" data-id="' + esc(entry.id) + '"' + (selected ? " checked" : "") + (actionable && !model.busy && !isPreview ? "" : " disabled") + ' aria-label="选择 ' + esc(entry.name || entry.id) + '">';
    var restoreButton = rescueDisabled
      ? '<button class="dbr-row-btn" data-act="restore-one" data-id="' + esc(entry.id) + '" type="button"' + (model.busy || !model.writable || isPreview ? " disabled" : "") + '>恢复</button>'
      : "";
    return '<div class="' + classes + '" role="listitem" data-id="' + esc(entry.id) + '">' +
      '<label class="dbr-item-main' + (actionable ? "" : " dbr-inert") + '">' + checkbox +
      '<span class="dbr-plugin"><span class="dbr-name" title="' + esc(entry.name || entry.id) + '">' + esc(entry.name || entry.id) + '</span>' +
      '<span class="dbr-meta" title="' + esc(meta.join(" · ")) + '">' + esc(meta.join(" · ")) + '</span></span></label>' +
      '<span class="dbr-badges">' + badges.join("") + '</span>' + restoreButton + '</div>';
  }

  function defaultStatus() {
    if (isPreview) return { text: PREVIEW_NOTICE, tone: "preview" };
    if (!model.writable) return { text: model.readOnlyReason || "当前无法安全修改配置，已进入只读模式。", tone: "error" };
    var selected = countSelected();
    if (selected) return { text: "已选择 " + selected + " 个插件；只会写入带救援标记的临时停用行。", tone: "" };
    var rescueCount = countRescueRows();
    if (rescueCount) return { text: "当前有 " + rescueCount + " 个插件由救援停用。", tone: "" };
    if (model.mode === "patch-fallback") return { text: "当前为降级模式：停用只在本轮启动内有效，请按上方警示处理。", tone: "warn" };
    return { text: "选择疑似故障插件后执行停用；不会删除插件或用户数据。", tone: "" };
  }

  function paintStatus() {
    if (!panel) return;
    try {
      var element = panel.querySelector('[data-role="status"]');
      if (!element) return;
      var text = model.statusText;
      var tone = model.statusTone;
      if (!text) {
        var preset = defaultStatus();
        text = preset.text;
        tone = preset.tone;
      }
      element.textContent = text;
      element.setAttribute("data-tone", tone || "");
    } catch (error) {
      // 状态渲染失败不抛出
    }
  }

  function setStatus(text, tone) {
    model.statusText = text || "";
    model.statusTone = tone || "";
    paintStatus();
  }

  function renderPanel() {
    if (!panel) return;
    try {
      // 统一复位所有按钮：setBusy(true) 会禁用全部按钮，重渲染若只细化部分按钮，
      // 标签页等按钮会永久保持禁用。先按 busy 复位，再由下面的具体逻辑细化。
      var allButtons = panel.querySelectorAll("button");
      for (var allIndex = 0; allIndex < allButtons.length; allIndex++) allButtons[allIndex].disabled = !!model.busy;
      // 顶部状态 + 版本小字
      var label = "救援服务在线";
      var stateClass = "dbr-live";
      if (isPreview) { label = "只读自检"; stateClass += " dbr-preview-state"; }
      else if (!model.writable) { label = "救援服务只读"; stateClass += " dbr-readonly-state"; }
      else if (model.mode === "patch-fallback") { label = "降级模式"; stateClass += " dbr-degraded-state"; }
      var serviceLabel = panel.querySelector('[data-role="service-label"]');
      if (serviceLabel) serviceLabel.textContent = label;
      var serviceState = panel.querySelector('[data-role="service-state"]');
      if (serviceState) serviceState.className = stateClass;
      var versionLine = model.version ? "版本 " + model.version : "";
      if (model.generatedAt) {
        var stamp = formatTime(model.generatedAt);
        if (stamp) versionLine += (versionLine ? " · " : "") + "生成于 " + stamp;
      }
      var versionElement = panel.querySelector('[data-role="version"]');
      if (versionElement) versionElement.textContent = versionLine;
      var previewBadge = panel.querySelector('[data-role="preview-badge"]');
      if (previewBadge) previewBadge.hidden = !isPreview;

      // 疑似诊断条
      var suspects = suspectEntries();
      var diagnosis = panel.querySelector('[data-role="diagnosis"]');
      if (diagnosis) diagnosis.hidden = !suspects.length;
      var suspectNames = [];
      for (var index = 0; index < suspects.length; index++) suspectNames.push(suspects[index].name || suspects[index].id);
      var suspectElement = panel.querySelector('[data-role="suspects"]');
      if (suspectElement) suspectElement.textContent = suspectNames.join(" · ");

      // 降级模式 warning（显著展示）
      var warningText = model.mode === "patch-fallback" ? (model.warning || FALLBACK_WARNING) : model.warning;
      var warningBox = panel.querySelector('[data-role="warning"]');
      if (warningBox) warningBox.hidden = !warningText;
      var warningTitle = panel.querySelector('[data-role="warning-title"]');
      if (warningTitle) warningTitle.textContent = model.mode === "patch-fallback" ? "降级模式警示" : "提示";
      var warningElement = panel.querySelector('[data-role="warning-text"]');
      if (warningElement) warningElement.textContent = warningText;

      // 标签页
      var tabs = panel.querySelectorAll(".dbr-tab");
      for (var tabIndex = 0; tabIndex < tabs.length; tabIndex++) {
        tabs[tabIndex].setAttribute("aria-selected", tabs[tabIndex].getAttribute("data-filter") === model.filter ? "true" : "false");
      }

      // 列表
      var visible = filteredEntries();
      var html = [];
      var actionableVisible = 0;
      for (var listIndex = 0; listIndex < visible.length; listIndex++) {
        html.push(entryMarkup(visible[listIndex]));
        if (isActionable(visible[listIndex])) actionableVisible++;
      }
      var list = panel.querySelector('[data-role="list"]');
      if (list) list.innerHTML = visible.length ? html.join("") : '<div class="dbr-empty">当前范围内没有匹配的插件</div>';
      var summary = panel.querySelector('[data-role="summary"]');
      if (summary) summary.textContent = "显示 " + visible.length + " 项 · 可操作 " + actionableVisible + " 项 · 已选择 " + countSelected() + " 项";
      var selectVisible = panel.querySelector('[data-act="select-visible"]');
      if (selectVisible) selectVisible.disabled = model.busy || !model.writable || isPreview || actionableVisible === 0;
      var clear = panel.querySelector('[data-act="clear"]');
      if (clear) clear.disabled = model.busy || countSelected() === 0;

      // 只读原因 + 手改指引
      var readonlyBox = panel.querySelector('[data-role="readonly"]');
      if (readonlyBox) {
        if (model.writable) {
          readonlyBox.hidden = true;
          readonlyBox.innerHTML = "";
        } else {
          var target = "";
          if (model.mode === "patch-fallback") target = model.profileDir ? model.profileDir.replace(/\/+$/, "") + "/cordis.patch.yml" : "当前 profile 目录下的 cordis.patch.yml";
          else if (model.rowsPath) target = model.rowsPath;
          else if (model.profileDir) target = model.profileDir.replace(/\/+$/, "") + "/.dshm-plugin-rows.yml";
          else target = "当前 profile 目录下的 .dshm-plugin-rows.yml";
          readonlyBox.hidden = false;
          readonlyBox.innerHTML = '<div class="dbr-readonly-title">只读模式：按钮已禁用，不会写入任何配置</div>' +
            '<p>原因：' + esc(model.readOnlyReason || "当前无法安全修改配置，已进入只读模式。") + '</p>' +
            '<p>手改指引：编辑 <code>' + esc(target) + '</code>，为故障插件追加 <code>- id: &lt;entry id&gt;</code> 与 <code>&nbsp;&nbsp;disabled: true</code> 两行后保存；或到系统设置 → 插件 中卸载该插件。</p>';
        }
      }

      // 底部按钮
      var selectedCount = countSelected();
      var rescueCount = countRescueRows();
      var disableButton = panel.querySelector('[data-act="disable"]');
      var restoreButton = panel.querySelector('[data-act="restore-all"]');
      var disableLabel = panel.querySelector('[data-role="disable-label"]');
      var restoreLabel = panel.querySelector('[data-role="restore-label"]');
      if (disableLabel) disableLabel.textContent = "停用所选并等待重启" + (selectedCount ? "（" + selectedCount + "）" : "");
      if (restoreLabel) restoreLabel.textContent = (model.confirmRestore ? "再次点击确认恢复" : "恢复救援停用项") + (rescueCount ? "（" + rescueCount + "）" : "");
      if (disableButton) disableButton.disabled = model.busy || !model.writable || isPreview || selectedCount === 0;
      if (restoreButton) {
        restoreButton.disabled = model.busy || !model.writable || isPreview || rescueCount === 0;
        restoreButton.className = "dbr-btn" + (model.confirmRestore ? " dbr-restore-confirm" : "");
      }
      var copyButton = panel.querySelector('[data-act="copy"]');
      if (copyButton) copyButton.disabled = model.busy;

      paintStatus();
    } catch (error) {
      // 单次渲染失败不影响宿主页面
    }
  }

  // ── 11. 挂载 / 回退 ───────────────────────────────────────────────────────
  function wireEvents() {
    if (!panel) return;
    panel.addEventListener("input", onPanelInput);
    panel.addEventListener("change", onPanelChange);
    panel.addEventListener("click", onPanelClick);
  }

  function appendOverlay(overlay, interactive) {
    try {
      var host = document.body || document.getElementById("root") || document.documentElement;
      if (!host || !overlay) return false;
      host.appendChild(overlay);
      if (interactive) {
        panel = overlay;
        wireEvents();
        renderPanel();
      }
      return true;
    } catch (error) {
      return false;
    }
  }

  // 服务不可用回退面板：不猜路径，只给同源 health 与手改指引。
  function buildFallback(error) {
    injectStyles();
    var overlay = document.createElement("div");
    overlay.className = "dbr-overlay" + (detectDark() ? " dbr-dark" : "");
    overlay.id = "dshm-boot-rescue-overlay";
    overlay.innerHTML = [
      '<section class="dbr-card dbr-fallback" role="dialog" aria-label="' + SERVICE_DOWN_TITLE + '">',
      '<div class="dbr-fallback-body">',
      '<div class="dbr-title">' + SERVICE_DOWN_TITLE + '</div>',
      '<p>无法读取救援状态：<code>' + esc(errorMessage(error)) + '</code></p>',
      '<p>可以尝试：打开 <code>' + API_HEALTH + '</code> 检查救援服务；或手动编辑当前 profile 的用户行文件，为故障插件追加 <code>- id: &lt;entry id&gt;</code> 与 <code>&nbsp;&nbsp;disabled: true</code> 两行；也可以在系统设置 → 插件 中卸载该插件。</p>',
      '<p class="dbr-hint">' + RESTART_GUIDE + '。' + RESTART_DETAIL + '。</p>',
      '</div></section>'
    ].join("");
    return overlay;
  }

  // ── 12. 写操作（成功后不重载页面，只更新 UI + 重启指引）──────────────────
  function setBusy(busy) {
    model.busy = !!busy;
    if (!panel) return;
    if (busy) {
      var buttons = panel.querySelectorAll("button");
      for (var index = 0; index < buttons.length; index++) buttons[index].disabled = true;
    } else {
      renderPanel();
    }
  }

  function markDisabled(ids, data) {
    var changed = {};
    var index;
    try {
      for (index = 0; index < ids.length; index++) changed[String(ids[index])] = true;
      var added = asStringArray(data && data.disabled);
      for (index = 0; index < added.length; index++) changed[added[index]] = true;
      var already = asStringArray(data && data.already);
      for (index = 0; index < already.length; index++) changed[already[index]] = true;
      if (data && data.rescueRows) {
        model.rescueRows = {};
        var rows = asStringArray(data.rescueRows);
        for (index = 0; index < rows.length; index++) model.rescueRows[rows[index]] = true;
      }
      var keys = Object.keys(changed);
      for (index = 0; index < keys.length; index++) {
        model.rescueRows[keys[index]] = true;
        var entry = findEntry(keys[index]);
        if (entry) {
          entry.disabledByRescue = true;
          entry.disabled = true;
        }
      }
      if (data && data.mode) model.mode = String(data.mode);
      if (data && data.warning) model.warning = String(data.warning);
    } catch (error) {
      return changed;
    }
    return changed;
  }

  // 写操作成功后拉取一次权威 state：以服务端 entries 为准重渲染，避免本地猜测与真实用户行不符。
  // 刷新失败时保留调用方已做的本地更新与结果文案，不阻断流程。
  function refreshAfterWrite(message, tone) {
    var previousFilter = model.filter;
    var previousQuery = model.query;
    api(API_STATE).then(function (state) {
      try {
        normalizeState(state);
        model.filter = previousFilter;
        model.query = previousQuery;
        model.selected = {};
        var search = panel ? panel.querySelector('[data-role="search"]') : null;
        if (search) search.value = model.query;
        setStatus(message, tone);
        renderPanel();
      } catch (error) {
        setStatus(message, tone);
        setBusy(false);
      }
    }).catch(function () {
      setStatus(message, tone);
      setBusy(false);
    });
  }

  function doDisable() {
    if (isPreview) {
      setStatus(PREVIEW_NOTICE, "preview");
      return;
    }
    if (!model.writable) {
      setStatus(model.readOnlyReason || "当前为只读模式，无法写入配置。", "error");
      return;
    }
    var ids = selectedActionableIds();
    if (!ids.length) {
      setStatus("请先选择要停用的插件。", "error");
      return;
    }
    if (ids.length > MAX_SELECTION) {
      setStatus("单次最多停用 " + MAX_SELECTION + " 个插件，请分批操作。", "error");
      return;
    }
    setBusy(true);
    setStatus("正在写入临时停用行…", "");
    postJSON(API_DISABLE, { ids: ids }).then(function (result) {
      var data = result || {};
      markDisabled(ids, data);
      model.selected = {};
      model.confirmRestore = false;
      var addedCount = asStringArray(data.disabled).length;
      var message = (addedCount ? "已停用 " + addedCount + " 个插件。" : "所选插件已在救援停用列表中。") + RESTART_GUIDE + "。" + RESTART_DETAIL + "。";
      if (model.mode === "patch-fallback") message += " " + (model.warning || FALLBACK_WARNING);
      refreshAfterWrite(message, "success");
    }).catch(function (error) {
      setStatus("停用失败：" + errorMessage(error), "error");
      setBusy(false);
    });
  }

  function doRestore(ids) {
    if (isPreview) {
      setStatus(PREVIEW_NOTICE, "preview");
      return;
    }
    if (!model.writable) {
      setStatus(model.readOnlyReason || "当前为只读模式，无法写入配置。", "error");
      return;
    }
    var restoringAll = !ids || !ids.length;
    var payload = restoringAll ? {} : { ids: ids };
    setBusy(true);
    setStatus(restoringAll ? "正在恢复全部救援停用项…" : "正在恢复插件…", "");
    postJSON(API_RESTORE, payload).then(function (result) {
      var data = result || {};
      var restored = asStringArray(data.restored);
      for (var index = 0; index < restored.length; index++) {
        delete model.rescueRows[restored[index]];
        var entry = findEntry(restored[index]);
        if (entry) {
          entry.disabledByRescue = false;
          entry.disabled = false;
        }
      }
      model.selected = {};
      model.confirmRestore = false;
      if (data.mode) model.mode = String(data.mode);
      var message = restored.length ? "已恢复 " + restored.length + " 个插件。" + RESTART_GUIDE + "。" : "没有可恢复的救援停用项。";
      refreshAfterWrite(message, restored.length ? "success" : "");
    }).catch(function (error) {
      setStatus("恢复失败：" + errorMessage(error), "error");
      setBusy(false);
    });
  }

  // ── 13. 复制诊断 ──────────────────────────────────────────────────────────
  function buildReport() {
    var lines = [];
    try {
      lines.push("DSHM 启动救援诊断");
      lines.push("版本: " + (model.version || "未知"));
      lines.push("时间: " + (formatTime(model.generatedAt) || new Date().toISOString()));
      lines.push("模式: " + (model.mode || "rows"));
      lines.push("只读: " + (model.writable ? "否" : "是"));
      if (!model.writable) lines.push("只读原因: " + (model.readOnlyReason || "未提供"));
      lines.push("rowsPath: " + (model.rowsPath || "未提供"));
      lines.push("profileDir: " + (model.profileDir || "未提供"));
      lines.push("疑似故障: " + (suspectText() || "未识别"));
      lines.push("已由救援停用: " + (Object.keys(model.rescueRows).join(", ") || "无"));
      if (model.warning) lines.push("降级警示: " + model.warning);
      lines.push("失败页文本: " + (failureText || "未捕获"));
      if (isPreview) lines.push(PREVIEW_NOTICE);
    } catch (error) {
      return "DSHM 启动救援诊断（收集失败）";
    }
    return lines.join("\n");
  }

  function copyDiagnostics() {
    var report = buildReport();
    var done = function () { setStatus("诊断信息已复制到剪贴板。", "success"); };
    var fallback = function () {
      var area = null;
      var copied = false;
      try {
        area = document.createElement("textarea");
        area.value = report;
        area.setAttribute("readonly", "readonly");
        area.style.position = "fixed";
        area.style.top = "-1000px";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        copied = !!document.execCommand("copy");
      } catch (error) {
        copied = false;
      }
      try {
        if (area && area.parentNode) area.parentNode.removeChild(area);
      } catch (removeError) {
        // 忽略清理失败
      }
      if (copied) done();
      else setStatus("剪贴板不可用，请手动复制诊断信息。", "error");
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(report).then(done, fallback);
      else fallback();
    } catch (error) {
      fallback();
    }
  }

  // ── 14. 事件 ──────────────────────────────────────────────────────────────
  function closestButton(node) {
    try {
      while (node && node !== panel) {
        if (node.nodeType === 1 && node.tagName === "BUTTON") return node;
        node = node.parentNode;
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  function onPanelInput(event) {
    try {
      var target = event.target;
      if (!target || target.getAttribute("data-role") !== "search") return;
      model.query = String(target.value || "");
      model.statusText = "";
      model.statusTone = "";
      renderPanel();
    } catch (error) {
      // 搜索渲染失败不影响操作
    }
  }

  function onPanelChange(event) {
    try {
      var target = event.target;
      if (!target || !target.classList || !target.classList.contains("dbr-check")) return;
      if (isPreview) return;
      var id = target.getAttribute("data-id");
      if (!id) return;
      if (target.checked) {
        if (countSelected() >= MAX_SELECTION) {
          target.checked = false;
          setStatus("单次最多停用 " + MAX_SELECTION + " 个插件，请分批操作。", "error");
          return;
        }
        model.selected[id] = true;
      } else {
        delete model.selected[id];
      }
      model.statusText = "";
      model.statusTone = "";
      renderPanel();
    } catch (error) {
      // 选择状态异常时保持原状
    }
  }

  function clearRestoreTimer() {
    if (restoreConfirmTimer) {
      window.clearTimeout(restoreConfirmTimer);
      restoreConfirmTimer = null;
    }
  }

  function onPanelClick(event) {
    try {
      var button = closestButton(event.target);
      if (!button || button.disabled) return;
      var filter = button.getAttribute("data-filter");
      if (filter) {
        model.filter = filter;
        model.query = "";
        var search = panel.querySelector('[data-role="search"]');
        if (search) search.value = "";
        model.statusText = "";
        model.statusTone = "";
        renderPanel();
        return;
      }
      var action = button.getAttribute("data-act");
      if (action === "select-visible") {
        var room = MAX_SELECTION - countSelected();
        if (room <= 0) {
          setStatus("单次最多停用 " + MAX_SELECTION + " 个插件，请先清除部分选择。", "error");
          return;
        }
        var visible = filteredEntries();
        var added = 0;
        var skipped = 0;
        for (var index = 0; index < visible.length; index++) {
          var entry = visible[index];
          if (!isActionable(entry) || model.selected[entry.id]) continue;
          if (added >= room) { skipped++; continue; }
          model.selected[entry.id] = true;
          added++;
        }
        model.statusText = "";
        model.statusTone = "";
        renderPanel();
        if (skipped) setStatus("已选择前 " + added + " 项；单次最多 " + MAX_SELECTION + " 项。", "warn");
      } else if (action === "clear") {
        model.selected = {};
        model.statusText = "";
        model.statusTone = "";
        renderPanel();
      } else if (action === "copy") {
        copyDiagnostics();
      } else if (action === "disable") {
        doDisable();
      } else if (action === "restore-one") {
        var restoreId = button.getAttribute("data-id");
        if (restoreId) doRestore([restoreId]);
      } else if (action === "restore-all") {
        if (!model.writable) {
          setStatus(model.readOnlyReason || "当前为只读模式，无法写入配置。", "error");
          return;
        }
        if (countRescueRows() === 0) return;
        if (!model.confirmRestore) {
          model.confirmRestore = true;
          clearRestoreTimer();
          restoreConfirmTimer = window.setTimeout(function () {
            restoreConfirmTimer = null;
            model.confirmRestore = false;
            if (panel && !model.busy) renderPanel();
          }, 5000);
          setStatus("再次点击「恢复救援停用项」以确认；只会撤销救援写入的临时停用行。", "warn");
          renderPanel();
        } else {
          clearRestoreTimer();
          model.confirmRestore = false;
          doRestore(null);
        }
      }
    } catch (error) {
      setStatus("操作失败：" + errorMessage(error), "error");
    }
  }

  // ── 15. 侦测 / 挂载生命周期 ───────────────────────────────────────────────
  function stopWatching() {
    try {
      if (observer) observer.disconnect();
    } catch (error) {
      // 忽略断开失败
    }
    observer = null;
    if (watchStopTimer) { window.clearTimeout(watchStopTimer); watchStopTimer = null; }
    if (mountTimer) { window.clearTimeout(mountTimer); mountTimer = null; }
  }

  function scheduleMount() {
    if (INSERTED || mountTimer) return;
    mountTimer = window.setTimeout(function () {
      mountTimer = null;
      try { mount(); } catch (error) { stopWatching(); }
    }, 100);
  }

  // 健康 UI 已出现时说明不是失败页，没必要继续观察（避免健康页白挂 120s observer）。
  function healthyUiPresent() {
    try {
      var host = document.getElementById("root") || document.body;
      return !!(host && host.querySelector && host.querySelector(HEALTHY_UI_SELECTOR));
    } catch (error) {
      return false;
    }
  }

  function mount() {
    try {
      if (INSERTED) return;
      var root = findFailureRoot();
      if (!root) {
        if (healthyUiPresent()) stopWatching();
        return;
      }
      INSERTED = true;
      isPreview = !!(document.body && document.body.hasAttribute(PREVIEW_ATTR));
      // 一旦决定挂载就停止观察，避免自身 DOM 变更反复触发。
      stopWatching();
      api(API_STATE).then(function (state) {
        try {
          normalizeState(state);
          appendOverlay(buildOverlay(), true);
        } catch (error) {
          appendOverlay(buildFallback(error), false);
        }
      }).catch(function (error) {
        appendOverlay(buildFallback(error), false);
      });
    } catch (error) {
      stopWatching();
    }
  }

  function startWatching() {
    try {
      if (INSERTED) return;
      // 首次检查：DOMContentLoaded 后立即执行一次。
      mount();
      if (INSERTED || observer || typeof MutationObserver === "undefined") return;
      var target = document.documentElement || document.body;
      if (!target) return;
      // 只观察、不轮询；失败页可能在首次检查之后才渲染出来。
      observer = new MutationObserver(scheduleMount);
      observer.observe(target, { childList: true, characterData: true, subtree: true });
      // 观察上限 120000ms，超时后永久停止，避免长期占用渲染进程。
      watchStopTimer = window.setTimeout(stopWatching, MAX_WATCH_MS);
    } catch (error) {
      stopWatching();
    }
  }

  function boot() {
    try {
      if (document.body && document.body.hasAttribute(PREVIEW_ATTR)) isPreview = true;
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startWatching, { once: true });
      else startWatching();
    } catch (error) {
      stopWatching();
    }
  }

  boot();
})();
