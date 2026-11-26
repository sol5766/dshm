/**
 * Mirrors the workbench account menu into the native shell after the upstream
 * menu opens. Keep the original buttons as the owners of their actions.
 */
export const ACCOUNT_MENU_SHIM_JS: string = `(function () {
  if (window.top !== window || !/^http:\\/\\/127\\.0\\.0\\.1:[0-9]+$/.test(location.origin) ||
    window.__DSHM_ACCOUNT_MENU__) { return; }

  var triggerSelector = 'button[data-signed-out][data-collapsed][aria-haspopup="menu"]';
  var menuSelector = '[role="menu"]';
  var itemSelector = 'button[role="menuitem"]';
  var active = null;
  var requestId = 0;

  function findMenu(before) {
    var menus = Array.from(document.querySelectorAll(menuSelector)).filter(function (menu) {
      return before.indexOf(menu) < 0 && menu.getBoundingClientRect().width > 0;
    });
    if (menus.length !== 1) { return null; }
    var node = menus[0];
    var items = Array.from(node.querySelectorAll(itemSelector));
    if (items.length !== 3 || items.some(function (item) {
      return item.disabled || item.closest(menuSelector) !== node ||
        item.getAttribute('aria-disabled') === 'true' || item.hasAttribute('aria-haspopup');
    })) { return null; }
    var labels = items.map(function (item) {
      // The shortcut and decorative glyphs are separate from the item label.
      var label = item.querySelector('span[class*="itemLabel"]');
      return label ? label.textContent.trim() : '';
    });
    if (labels.some(function (label) { return !label || label.length > 80; }) ||
      new Set(labels).size !== labels.length) { return null; }
    return { node: node, items: items, labels: labels };
  }

  function whenOpen(trigger, before, visit, frames) {
    requestAnimationFrame(function () {
      if (!trigger.isConnected) { return; }
      var found = trigger.getAttribute('aria-expanded') === 'true' ? findMenu(before) : null;
      if (found) { visit(found); }
      else if (frames > 1) { whenOpen(trigger, before, visit, frames - 1); }
    });
  }

  document.addEventListener('click', function (event) {
    if (!event.isTrusted || active || !(event.target instanceof Element)) { return; }
    var trigger = event.target.closest(triggerSelector);
    if (!trigger || !trigger.closest('.dshm-sbcol') || trigger.getAttribute('aria-expanded') !== 'false') { return; }
    var b = window.__DSHM_BRIDGES__;
    if (!b || typeof b.openWebAccountMenu !== 'function') { return; }
    var before = Array.from(document.querySelectorAll(menuSelector));
    var id = ++requestId;
    whenOpen(trigger, before, function (menu) {
      if (id !== requestId || active) { return; }
      var rect = menu.node.getBoundingClientRect();
      var accepted = false;
      try {
        accepted = b.openWebAccountMenu(id, Math.max(0, rect.left) / window.innerWidth,
          Math.max(0, rect.top) / window.innerHeight, menu.labels[0], menu.labels[1], menu.labels[2]) === true;
      } catch (e) { return; }
      if (!accepted) { return; }
      active = { id: id, trigger: trigger, menu: menu, visibility: menu.node.style.visibility };
      menu.node.style.visibility = 'hidden';
    }, 4);
  }, true);

  window.__DSHM_ACCOUNT_MENU__ = {
    finish: function (id, action) {
      if (!active || id !== active.id) { return; }
      var entry = active;
      active = null;
      entry.menu.node.style.visibility = entry.visibility;
      if (!entry.trigger.isConnected) { return; }
      if (entry.menu.node.isConnected && entry.trigger.getAttribute('aria-expanded') === 'true') {
        if (action === -1) { entry.trigger.click(); }
        else if (action >= 0) {
          var item = entry.menu.items[action];
          if (item && item.isConnected && !item.disabled && item.getAttribute('aria-disabled') !== 'true') { item.click(); }
        }
        return;
      }
      if (action < -2 || action === -1 || entry.trigger.getAttribute('aria-expanded') !== 'false') { return; }
      // Some Web versions dismiss the source menu when native focus moves.
      var before = Array.from(document.querySelectorAll(menuSelector));
      entry.trigger.click();
      if (action >= 0) {
        whenOpen(entry.trigger, before, function (menu) {
          if (requestId === id && menu.labels.join('\\n') === entry.menu.labels.join('\\n') && menu.items[action]) {
            menu.items[action].click();
          }
        }, 4);
      }
    }
  };
})();
`;
