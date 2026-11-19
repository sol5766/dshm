import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = readFileSync('entry/src/main/ets/pages/WebApp.ets', 'utf8');
const panel = readFileSync('entry/src/main/ets/view/AboutPanel.ets', 'utf8');
function method(text, name, next) {
  const start = text.indexOf(`  private ${name}(`);
  const end = text.indexOf(next, start);
  assert(start >= 0 && end > start);
  return text.slice(start, end).replace(`private ${name}`, `function ${name}`)
    .replaceAll(': Array<MenuElement>', '').replaceAll(': void', '')
    .replaceAll(': MenuOptions | undefined', '').replaceAll(': MenuOptions', '');
}
function check(text) {
  const optionsCode = method(text, 'menuMaterialOptions', '\n  /**');
  for (const api of [23, 25, 26]) {
    for (const available of [false, true]) {
      let constructed = 0;
      const options = vm.runInNewContext(`${optionsCode}\nmenuMaterialOptions`, {
        deviceInfo: { sdkApiVersion: api }, uiMaterial: {
          ImmersiveStyle: available ? { THIN: 'thin' } : undefined,
          ImmersiveMaterial: class { constructor(value) { constructed++; this.style = value.style; } }
        }
      })();
      assert.equal(constructed, api >= 26 && available ? 1 : 0);
      if (api < 26 || !available) assert.equal(options, undefined);
      else {
        assert.equal(options.systemMaterial.style, 'thin');
        assert.equal(options.showInSubWindow, undefined);
      }
    }
  }
  const menuCode = method(text, 'aboutMenu', '\n  /**');
  const menu = vm.runInNewContext(`${menuCode}\naboutMenu`);
  for (const [index, tab] of [[0, 'version'], [1, 'oss']]) {
    const state = { aboutOpen: false, aboutTab: '', themeMode: 'light', topBarBg: '#FFFFFF' };
    menu.call(state)[index].action();
    assert.deepEqual(state, { aboutOpen: true, aboutTab: tab, themeMode: 'light', topBarBg: '#FFFFFF' });
    const close = /onClose: \(\): void => \{([\s\S]*?)\}/.exec(text.slice(text.indexOf('        AboutPanel({')));
    assert(close);
    vm.runInNewContext(`(function () {${close[1]}})`).call(state);
    assert.equal(state.aboutOpen, false);
    assert.equal(state.themeMode, 'light');
    assert.equal(state.topBarBg, '#FFFFFF');
  }
  assert(text.includes("WithTheme({ colorMode: this.themeMode === 'dark' ? ThemeColorMode.DARK : ThemeColorMode.LIGHT })"));
  assert(!/CustomDialog|window\.blur|\.onBlur\(/.test(panel));
  assert(panel.includes(".backgroundColor('#00000000')"));
  assert(panel.includes(".backgroundColor('#F7FFFFFF')"));
}
check(source);
console.log('PASS native menu options: API/capability fallback, THIN material, default subwindow policy; About actions/close preserve theme');
if (process.argv.includes('--self-test')) {
  const mutants = [
    text => text.replace('private menuMaterialOptions(): MenuOptions | undefined {\n    if (deviceInfo.sdkApiVersion < 26)', 'private menuMaterialOptions(): MenuOptions | undefined {\n    if (deviceInfo.sdkApiVersion < 23)'),
    text => text.replace("this.aboutTab = 'version';", "this.aboutTab = 'version'; this.topBarBg = '#000000';"),
    text => text.replace('this.aboutOpen = false;', "this.aboutOpen = false; this.themeMode = 'dark';")
  ];
  for (const mutate of mutants) {
    const changed = mutate(source);
    assert.notEqual(changed, source);
    assert.throws(() => check(changed));
  }
  console.log(`PASS self-test: ${mutants.length} native menu mutations rejected`);
}
