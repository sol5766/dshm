(function () {
  var native = globalThis.__DSHM_PET_BRIDGE__;
  // JD-019：插件 sprite/input.js 对 e.screenX 再做一次 toLocal(÷scale)，而 ArkWeb 的
  // screenX 已是 CSS px ⇒ 拖拽位移被二次除 scale。这里把 screenX/Y 还原成物理 px，
  // 插件内部 ÷scale 后正好得到 CSS px，拖拽 1:1。
  try {
    var dpr = window.devicePixelRatio || 1;
    if (dpr !== 1 && typeof MouseEvent === 'function') {
      var px = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'screenX');
      var py = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'screenY');
      if (px && px.get) {
        Object.defineProperty(MouseEvent.prototype, 'screenX', {
          configurable: true,
          get: function () { return px.get.call(this) * dpr; }
        });
      }
      if (py && py.get) {
        Object.defineProperty(MouseEvent.prototype, 'screenY', {
          configurable: true,
          get: function () { return py.get.call(this) * dpr; }
        });
      }
    }
  } catch (e) { /* 事件原型不可改：保留原语义 */ }

  // ArkWeb 下 WebM 的「透明」底色实测 alpha=1/255，浅色背景上会显出淡灰矩形（插件
  // PET_ALPHA_FIX_ENABLED 默认关闭）。这里强制挂 pet-alpha-fix 类，启用 index.html
  // 里的 SVG 滤镜把 alpha 扣掉 1/255 精确归零。
  function enableAlphaFix() {
    try { document.documentElement.classList.add('pet-alpha-fix'); } catch (e) { }
  }
  if (document.readyState !== 'loading') enableAlphaFix();
  else document.addEventListener('DOMContentLoaded', enableAlphaFix);

  // JD-018：触摸拖拽被 Chromium 的默认 touch-action 滚动判定吃掉；补一行覆盖。
  function installTouchCss() {
    try {
      if (document.getElementById('dshm-pet-touch-css')) return;
      var s = document.createElement('style');
      s.id = 'dshm-pet-touch-css';
      s.textContent = '.pet-hit{touch-action:none!important}';
      (document.head || document.documentElement).appendChild(s);
    } catch (e) { /* 无 DOM：忽略 */ }
  }
  if (document.head) installTouchCss();
  else document.addEventListener('DOMContentLoaded', installTouchCss);

  var cbs = { displays: [], pointerLeft: [], flight: [], hit: [] };
  var lastDisplays = null;
  globalThis.__DSHM_PET_DELIVER__ = function (name, payload) {
    try {
      if (name === 'displays') {
        lastDisplays = payload;
        for (var i = 0; i < cbs.displays.length; i++) cbs.displays[i](payload);
      } else if (name === 'pointerLeft') {
        for (var j = 0; j < cbs.pointerLeft.length; j++) cbs.pointerLeft[j]();
      } else if (name === 'flight') {
        for (var k = 0; k < cbs.flight.length; k++) cbs.flight[k](payload);
      } else if (name === 'hit') {
        for (var m = 0; m < cbs.hit.length; m++) cbs.hit[m](payload);
      }
    } catch (e) { /* 页面回调异常不阻断 */ }
  };
  // —— 窗口几何：宠物本体 ∪ 可见插件 UI 的并集（物理像素）；#root 平移锚定宠物 ——
  // 常态窗口紧贴宠物（+20px），消除大块透明余量与窗口阴影矩形；菜单/气泡/待办/对话
  // 出现时按 DOM 实测尺寸自动扩窗，消失自动回缩。
  var lastFullArgs = null;
  var applied = null;
  var PAD = 20;
  var UI_SEL = '[class*="dsh-pet-"],[class*="pet-bubble"],[class*="pet-error"]';
  var uiUnion = null;

  /** 查询可见插件 UI 的屏幕包围盒（菜单打开后宠物停止漫游，缓存到下一次刷新仍有效）。 */
  function refreshUI() {
    var args = lastFullArgs;
    if (!args) return;
    var dpr = window.devicePixelRatio || 1;
    var winX = applied ? applied.x : args[0];
    var winY = applied ? applied.y : args[1];
    var u = null;
    try {
      var els = document.querySelectorAll(UI_SEL);
      for (var i = 0; i < els.length; i++) {
        var rc = els[i].getBoundingClientRect();
        if (rc.width <= 1 || rc.height <= 1) continue;
        var l = winX + rc.left * dpr;
        var t = winY + rc.top * dpr;
        var r = winX + rc.right * dpr;
        var b = winY + rc.bottom * dpr;
        if (!u) {
          u = { l: l, t: t, r: r, b: b };
        } else {
          if (l < u.l) u.l = l;
          if (t < u.t) u.t = t;
          if (r > u.r) u.r = r;
          if (b > u.b) u.b = b;
        }
      }
    } catch (e) { /* DOM 未就绪 */ }
    uiUnion = u;
    recompute();
  }

  function recompute() {
    var args = lastFullArgs;
    var size = args ? args[6] : 0;
    if (!native || !args || !(size > 0)) return;
    var dpr = window.devicePixelRatio || 1;
    var winH = size * 9 / 16 + args[7];
    var left = args[4];
    var top = args[5];
    var right = args[4] + size;
    var bottom = args[5] + winH;
    if (uiUnion) {
      if (uiUnion.l < left) left = uiUnion.l;
      if (uiUnion.t < top) top = uiUnion.t;
      if (uiUnion.r > right) right = uiUnion.r;
      if (uiUnion.b > bottom) bottom = uiUnion.b;
    }
    left = Math.round(left - PAD);
    top = Math.round(top - PAD);
    var tw = Math.round(right - left + PAD);
    var th = Math.round(bottom - top + PAD);
    if (!applied || Math.abs(applied.x - left) > 1 || Math.abs(applied.y - top) > 1
      || Math.abs(applied.w - tw) > 1 || Math.abs(applied.h - th) > 1) {
      applied = { x: left, y: top, w: tw, h: th };
      native.setBounds(left, top, tw, th, args[4], args[5], args[6], args[7],
        args[8], args[9], args[10], args[11]);
    }
    var root = document.getElementById('root');
    if (root) {
      var dbg = window.__dshPetDebug || {};
      var wo = dbg.winOffset || { x: args[10] / dpr, y: args[11] / dpr };
      root.style.transform = 'translate(' + ((args[4] - left) / dpr - wo.x) + 'px,'
        + ((args[5] - top) / dpr - wo.y) + 'px)';
    }
  }

  try {
    var mo = new MutationObserver(function () { refreshUI(); });
    // 只观察 class/子节点：自身写 #root style.transform 不应引发回环
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    setInterval(refreshUI, 250);
  } catch (e) { /* 无 MutationObserver：仅靠 setBounds 驱动 */ }
  window.petBridge = {
    setBounds: function (x, y, w, h, boxX, boxY, size, bottomPad, vx, vy, marginL, marginT) {
      lastFullArgs = [Number(x), Number(y), Number(w), Number(h), Number(boxX), Number(boxY),
        Number(size), Number(bottomPad), Number(vx), Number(vy), Number(marginL), Number(marginT)];
      recompute();
    },
    setInteractive: function (v) { if (native) native.setInteractive(!!v); },
    setInputBusy: function (v) { if (native) native.setInputBusy(!!v); },
    setInputRegions: function (v) { if (native) native.setInputRegions(JSON.stringify(v || [])); },
    requestKeyboardFocus: function () { if (native) native.requestKeyboardFocus(); },
    openDshSite: function (u) { if (native) native.openDshSite(String(u)); },
    focusDshHost: function () { if (native) native.focusDshHost(); },
    captureScreen: function () { return Promise.resolve(null); },
    onFlightStates: function (cb) { cbs.flight.push(cb); },
    reportCollide: function () {},
    onPetHit: function (cb) { cbs.hit.push(cb); },
    onDisplays: function (cb) { cbs.displays.push(cb); if (lastDisplays) cb(lastDisplays); },
    onPointerLeft: function (cb) { cbs.pointerLeft.push(cb); }
  };
})();
