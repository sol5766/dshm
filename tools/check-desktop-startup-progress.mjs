import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const common = read('entry/src/main/ets/common/DesktopStartup.ets');
const progressView = read('entry/src/main/ets/common/DesktopStartupProgress.ets');
const web = read('entry/src/main/ets/pages/WebApp.ets');
const node = read('hostruntime/src/main/ets/runtime/NodeRuntime.ets');
const between = (source, start, end) => {
  const from = source.indexOf(start);
  const until = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && until > from, 'startup implementation anchor missing');
  return source.slice(from, until);
};


function checkWorkbenchScript(source) {
  const functions = between(source, 'export const DESKTOP_WORKBENCH_PAINT_PREFIX', 'export class StartupFrameCallback')
    .replaceAll('export ', '');
  const { buildDesktopWorkbenchPaintScript, desktopWorkbenchPaintPage } = runInNewContext(stripTypeScriptTypes(`
    ${functions}
    ({ buildDesktopWorkbenchPaintScript, desktopWorkbenchPaintPage })
  `));
  const origin = 'http://127.0.0.1:3120';
  const page = origin + '/';
  assert.equal(desktopWorkbenchPaintPage(origin), page);
  assert.equal(desktopWorkbenchPaintPage(page + '?token=fixture'), page);
  assert.equal(desktopWorkbenchPaintPage(origin + '/settings'), '');
  assert.equal(desktopWorkbenchPaintPage(origin + '@example.com/'), '');

  const frames = [];
  const messages = [];
  let now = 0;
  const node = x => ({
    closest: () => null,
    contains: target => target === x,
    getBoundingClientRect: () => ({ left: x, right: x + 20, top: 0, bottom: 30 }),
  });
  let sidebar = node(0);
  let composer = node(30);
  const list = node(12);
  const document = {
    visibilityState: 'visible',
    getElementById: () => ({ querySelector: selector => selector.includes('list-area') ? list :
      selector.includes('sidebar') ? sidebar : composer }),
    elementFromPoint: x => x - 10,
  };
  const window = {};
  const context = {
    window, top: window, document,
    innerWidth: 100, innerHeight: 100,
    location: { origin, pathname: '/' },
    performance: { now: () => now },
    console: { info: message => messages.push(message) },
    getComputedStyle: () => ({ visibility: 'visible', opacity: '1' }),
    requestAnimationFrame: callback => frames.push(callback),
  };
  const frame = () => { now += 15; frames.shift()(); };
  const script = buildDesktopWorkbenchPaintScript(page, 'fixture-frame', 400);
  runInNewContext(script, context);
  frame();
  assert.deepEqual(messages, [], 'the first observed frame has not yet been painted');
  sidebar = node(0);
  frame();
  assert.deepEqual(messages, [], 'replaced controls require a new painted frame');
  frame();
  assert.deepEqual(messages, ['fixture-frame']);
  assert.equal(frames.length, 0);

  context.location.pathname = '/settings';
  runInNewContext(script, context);
  assert.equal(frames.length, 0, 'only the current local workbench can confirm paint');
  context.location.pathname = '/';
  composer = node(110);
  runInNewContext(script, context);
  for (let i = 0; i < 18; i++) {
    assert.equal(frames.length, 1, 'continue observing while the native fallback is pending');
    frame();
  }
  assert.deepEqual(messages, ['fixture-frame'], 'an offscreen composer cannot confirm paint');
  composer = node(30);
  frame();
  frame();
  assert.deepEqual(messages, ['fixture-frame', 'fixture-frame'], 'late workbench paint wins over the fallback');

  composer = node(110);
  runInNewContext(script, context);
  for (let i = 0; i < 27; i++) frame();
  assert.equal(frames.length, 0, 'no recurring frame checks after the deadline');
  assert.deepEqual(messages, ['fixture-frame', 'fixture-frame']);

  runInNewContext(buildDesktopWorkbenchPaintScript(page, 'staged-frame', 400, true), context);
  frame();
  frame();
  assert.equal(messages.at(-1), 'staged-frame:sidebar');
  composer = node(30);
  frame();
  assert.equal(messages.at(-1), 'staged-frame:sidebar');
  frame();
  assert.equal(messages.at(-1), 'staged-frame');
}

function checkTabletHandoff(source) {
  const declaration = between(source, 'export const TABLET_STARTUP_WEB_HANDOFF', 'export function desktopWorkbenchPaintPage')
    .replace('export ', '');
  const script = runInNewContext(stripTypeScriptTypes(declaration + '\nTABLET_STARTUP_WEB_HANDOFF'));
  const top = {};
  const styles = [];
  const document = {
    head: { append: style => styles.push(style.textContent) },
    createElement: tag => { assert.equal(tag, 'style'); return {}; },
  };
  const location = { protocol: 'http:', hostname: '127.0.0.1', pathname: '/' };
  for (const globals of [
    { top, window: {}, document, location },
    { top, window: top, document, location: { ...location, pathname: '/settings' } },
    { top, window: top, document, location: { ...location, hostname: 'remote.example' } },
  ]) {
    runInNewContext(script, globals);
    assert.equal(globals.__DSHM_TABLET_WORKBENCH_STARTUP__, undefined);
  }
  assert.deepEqual(styles, []);
  const globals = { top, window: top, document, location };
  runInNewContext(script, globals);
  assert.equal(globals.__DSHM_TABLET_WORKBENCH_STARTUP__, true);
  assert.equal(styles.length, 1);
  assert.match(styles[0], /^#root > \[data-dsh-boot\] \{ visibility: hidden; pointer-events: none; \}/);
  assert.match(styles[0], /#root > \[data-dsh-boot\] \* \{ animation: none !important; \}/);
}


function checkEarlyWorkbenchPaint(source) {
  const shared = between(source, 'export const DESKTOP_WORKBENCH_PAINT_PREFIX', 'export class StartupFrameCallback')
    .replaceAll('export ', '');
  const { observer, build } = runInNewContext(stripTypeScriptTypes(`
    ${shared}
    ({ observer: DESKTOP_WORKBENCH_PAINT_OBSERVER, build: buildDesktopWorkbenchPaintScript })
  `));
  const frameCallbacks = new Map();
  let frameId = 0;
  let now = 0;
  let newestObserver;
  let hint = false;
  let found = false;
  const element = (left, name) => ({
    name,
    closest: () => null,
    contains: candidate => candidate?.name === name,
    getBoundingClientRect: () => ({ left, top: 0, right: left + 20, bottom: 20 }),
  });
  const sidebar = element(0, 'sidebar');
  let composer = element(25, 'composer');
  const document = {
    visibilityState: 'visible',
    getElementById: () => found ? { querySelector: rule => rule.includes('sidebar') ? sidebar : composer } : null,
    querySelector: () => hint ? { content: '1' } : null,
    elementFromPoint: x => x < 20 ? sidebar : composer,
  };
  const window = { addEventListener() {} };
  const messages = [];
  const context = {
    window, top: window, document, location: { origin: 'http://127.0.0.1:3120', protocol: 'http:', hostname: '127.0.0.1', pathname: '/' },
    performance: { now: () => now }, innerWidth: 100, innerHeight: 100,
    getComputedStyle: () => ({ visibility: 'visible', opacity: '1' }),
    setTimeout: () => 1, clearTimeout() {},
    requestAnimationFrame: fn => { frameCallbacks.set(++frameId, fn); return frameId; },
    cancelAnimationFrame: id => frameCallbacks.delete(id),
    console: { info: v => messages.push(v) },
    MutationObserver: class {
      constructor(fn) { newestObserver = fn; }
      observe() {}
      disconnect() {}
    },
  };
  const frame = () => {
    now += 15;
    const [id, cb] = frameCallbacks.entries().next().value;
    frameCallbacks.delete(id);
    cb();
  };
  runInNewContext(observer, context);
  assert.equal(frameCallbacks.size, 0);
  found = true;
  newestObserver();
  assert.equal(frameCallbacks.size, 0, 'pages without the signed-out hint use only the original probe');
  hint = true;
  runInNewContext(observer, context);
  frame();
  assert.equal(context.__DSHM_WORKBENCH_PAINTED__(), false);
  composer = element(25, 'composer');
  frame();
  assert.equal(context.__DSHM_WORKBENCH_PAINTED__(), false, 'a replacing node must be painted itself');
  frame();
  assert.equal(context.__DSHM_WORKBENCH_PAINTED__(), true);
  runInNewContext(build('http://127.0.0.1:3120/', 'fresh-marker', 400), context);
  assert.deepEqual(messages, ['fresh-marker']);
  assert.equal(frameCallbacks.size, 0, 'reuse sends the new navigation marker before a duplicate RAF');
  document.visibilityState = 'hidden';
  assert.equal(context.__DSHM_WORKBENCH_PAINTED__(), false);
  document.visibilityState = 'visible';
  composer = element(25, 'composer');
  assert.equal(context.__DSHM_WORKBENCH_PAINTED__(), false);
}

function checkProgress(source) {
  const methods = between(source, '  private usesDesktopStartup()', '  /** 预挂载的 Web')
    .replaceAll('private ', '');
  const progress = between(source, '((event: OnProgressChangeEvent)', '\n          .onPageBegin');
  const fallback = source.match(/^const DESKTOP_STARTUP_PAINT_FALLBACK_MS:.*;$/m)?.[0];
  const tabletFallback = source.match(/^const TABLET_STARTUP_PAINT_FALLBACK_MS:.*;$/m)?.[0];
  const fade = source.match(/^const DESKTOP_STARTUP_FADE_MS:.*;$/m)?.[0];
  const hold = source.match(/^const TABLET_STARTUP_BRAND_HOLD_MS:.*;$/m)?.[0];
  assert.ok(hold);
  const tabletBackdrop = source.match(/^const TABLET_STARTUP_BACKDROP_FADE_MS:.*;$/m)?.[0];
  const revealedBackdrop = source.match(/^const TABLET_STARTUP_REVEALED_BG:.*;$/m)?.[0];
  assert.ok(fallback && tabletFallback && fade && tabletBackdrop && revealedBackdrop);
  const event = common.match(/^export const DESKTOP_WORKBENCH_PAINTED_EVENT:.*;$/m)?.[0];
  assert.ok(event);
  const shared = (event + '\n' +
    between(common, 'export const DESKTOP_WEB_START', 'export interface DesktopProgressMotion') +
    between(common, 'export const DESKTOP_WORKBENCH_PAINT_PREFIX', 'export class StartupFrameCallback'))
    .replaceAll('export ', '');
  const timers = new Map();
  let timerId = 0;
  const page = runInNewContext(stripTypeScriptTypes(`
    ${shared}
    ${fallback}
    ${tabletFallback}
    ${fade}
    ${hold}
    ${tabletBackdrop}
    ${revealedBackdrop}
    class Page { ${methods} onProgress = ${progress.slice(1, -1)}; }
    new Page()
  `), {
    DESKTOP_PROGRESSIVE_STARTUP: true, SPLASH_BG: '#FFFFFF', Curve: { EaseIn: 'ease-in', EaseOut: 'ease-out' }, WebPhase: { LOADING: 'loading', READY: 'ready' },
    hilog: { info() {} }, util: { generateRandomUUID: () => 'fixture' }, DOMAIN: 0, TAG: '',
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
  });
  const backdropTransitions = [];
  const readyEvents = [];
  page.getUIContext = () => ({
    animateTo: (options, change) => { backdropTransitions.push(options); change(); },
    getHostContext: () => ({ eventHub: { emit: name => readyEvents.push(name) } }),
  });
  Object.assign(page, {
    rawDeviceType: 'tablet', desktopStartupBackdrop: '#FFFFFF',
    startupPageActive: true, desktopForced: true, startupMainWindow: true,
    desktopStartupComplete: false, phase: 'loading', loadFailed: false,
    webNavigationStarted: false, webFirstPaintReported: false, startupPaintTimer: -1, startupWebProgress: 70,
  });
  page.onProgress({ newProgress: 100 });
  assert.equal(page.startupWebProgress, 70, 'blank page cannot advance formal load');
  page.webNavigationStarted = true;
  page.onProgress({ newProgress: 50 });
  assert.equal(page.startupWebProgress, 70, 'intermediate Web events do not retarget the animation');
  page.onProgress({ newProgress: 10 });
  assert.equal(page.startupWebProgress, 70, 'redirecting Web progress stays at the confirmed milestone');
  page.onProgress({ newProgress: 100 });
  assert.equal(page.startupWebProgress, 96, 'browser progress alone cannot complete startup');
  page.onProgress({ newProgress: 85 });
  assert.equal(page.startupWebProgress, 96, 'late intermediate Web events cannot undo a confirmed milestone');
  page.webFirstPaintReported = true;
  page.completeDesktopStartup();
  assert.equal(page.desktopStartupComplete, false, 'paint before successful load must keep the splash');
  page.resetDesktopStartupNavigation();
  assert.equal(page.startupWebProgress, 70);
  assert.equal(page.webFirstPaintReported, false, 'new attempt cannot reuse a previous paint');
  page.phase = 'ready';
  page.finishDesktopStartupLoad();
  assert.equal(page.startupWebProgress, 98, 'page end alone reserves the last step');
  assert.equal(timers.size, 1);
  page.startupProgressVisible = true;
  page.webFirstPaintReported = true;
  page.completeDesktopStartup();
  assert.equal(page.desktopStartupComplete, true);
  assert.equal(page.startupWebProgress, 100);
  assert.equal(timers.size, 0, 'paint cancels the fallback');
  assert.equal(page.desktopStartupFinishing, true, 'the overlay stays mounted for the 100% fill');
  assert.equal(backdropTransitions.length, 0, 'generic first content paint cannot reveal the workspace behind the splash');
  page.startupProgressVisible = false;

  page.desktopStartupComplete = false;
  page.webFirstPaintReported = false;
  page.finishDesktopStartupLoad();
  const fallbackCallback = timers.get(timerId);
  page.loadFailed = true;
  fallbackCallback();
  assert.equal(page.desktopStartupComplete, false, 'a failed load cannot finish via fallback');
  page.loadFailed = false;
  page.finishDesktopStartupLoad();
  timers.get(timerId)();
  assert.equal(page.desktopStartupComplete, true, 'successful legacy pages can finish without a paint callback');


  page.desktopStartupComplete = false;
  page.webFirstPaintReported = false;
  page.webWorkbenchPaintReported = false;
  page.webNavigationStarted = true;
  page.launchUrl = 'http://127.0.0.1:3120/?token=fixture';
  page.desktopPaintMessage = '';
  let current = 'http://127.0.0.1:3120/';
  let probes = 0;
  let reports = 0;
  page.controller = {
    getUrl: () => current,
    runJavaScript: script => { assert.match(script, /performance\.now\(\) \+ 1000/); probes++; },
  };
  page.reportWebVisibleFrame = () => { reports++; };
  page.requestDesktopWorkbenchPaint('https://example.com/');
  assert.equal(probes, 0);
  page.requestDesktopWorkbenchPaint(current);
  assert.equal(probes, 1);
  const message = page.desktopPaintMessage;
  assert.ok(message);
  page.acceptDesktopWorkbenchPaint(message + '-stale');
  assert.equal(reports, 0, 'stale navigation marks must be ignored');
  current = 'http://127.0.0.1:3121/';
  page.acceptDesktopWorkbenchPaint(message);
  assert.equal(reports, 0, 'a different current page cannot unlock the overlay');
  current = 'http://127.0.0.1:3120/';
  page.loadFailed = true;
  page.acceptDesktopWorkbenchPaint(message);
  assert.equal(reports, 0, 'an unsuccessful load cannot unlock the overlay');
  page.loadFailed = false;
  page.startupProgressVisible = true;
  page.acceptDesktopWorkbenchPaint(message);
  assert.equal(reports, 1);
  assert.equal(page.webWorkbenchPaintReported, true);
  assert.equal(backdropTransitions.length, 1, 'confirmed tablet paint starts the backdrop transition');
  assert.equal(page.desktopStartupBackdrop, '#59FFFFFF');
  assert.equal(page.desktopStartupFinishing, true, 'the track stays drawn over the translucent backdrop');
  assert.equal(page.desktopStartupComplete, true);
  assert.equal(page.desktopPaintMessage, '');
  page.acceptDesktopWorkbenchPaint(message);
  assert.equal(reports, 1, 'the same navigation marker is consumed once');
  assert.deepEqual(readyEvents, ['dshDesktopWorkbenchPainted']);
  assert.equal(backdropTransitions.length, 1, 'repeated paint messages cannot replay the backdrop transition');

  page.desktopStartupComplete = false;
  page.webWorkbenchPaintReported = false;
  page.tabletStartupBrandTimer = -1;
  page.scheduleTabletStartupBrandRelease();
  timers.get(timerId)();
  assert.equal(page.tabletStartupBrandReleased, true);
  assert.equal(page.desktopStartupComplete, false, 'branding can finish while the workspace is still loading');
  page.requestDesktopWorkbenchPaint(current);
  const staged = page.desktopPaintMessage;
  page.acceptDesktopWorkbenchPaint(staged + '-stale:sidebar');
  page.acceptDesktopWorkbenchPaint(staged + ':sidebar');
  assert.equal(page.desktopStartupComplete, false);
  page.acceptDesktopWorkbenchPaint(staged + ':composer');
  assert.equal(page.desktopStartupComplete, false);
  page.acceptDesktopWorkbenchPaint(staged);
  assert.equal(page.desktopStartupComplete, true);
  assert.equal(page.desktopStartupFinishing, false);
  assert.doesNotMatch(source, /TabletStartupPlaceholder|dshm-tablet-workspace-loading/);
  assert.match(source, /if \(!this.tabletStartupBrandReleased &&/);

  assert.match(source, /if \(this\.isStartupBlankNavigation\(event\.url\)\) \{\s+return;/);
  assert.match(source, /iterations: -1,\s+playMode: PlayMode\.Alternate,[\s\S]+?this\.brandBreath = 1\.09/);
  assert.match(source, /if \(!this\.usesDesktopStartup\(\) && this\.loadTicker === -1\)/);
  assert.match(source, /scan: this\.phase === WebPhase\.BOOTING/);
  assert.match(source, /\.hitTestBehavior\(this\.desktopStartupComplete \? HitTestMode\.None : HitTestMode\.Default\)/);
  assert.match(source, /!this\.desktopStartupComplete \|\| this\.desktopStartupFinishing/);
  assert.match(source, /await bundleManager\.getBundleInfoForSelf\(/);
}

function checkWebPreparation(source) {
  const body = between(source, '  private prepareDesktopWebAfterFrame()', '  private isStartupBlankNavigation')
    .replace('private ', '');
  const delay = source.match(/^const TABLET_STARTUP_WEB_PREPARE_DELAY_MS:.*;$/m)?.[0];
  assert.ok(delay);
  const frames = [];
  const timers = [];
  const makePage = runInNewContext(stripTypeScriptTypes(`
    ${delay}
    class Page {
      startupPageActive = true;
      startupWebPrepared = false;
      phase = 'booting';
      launchUrl = '';
      pickerShimScripts = [];
      usesDesktopStartup() { return true; }
      getUIContext() { return { postFrameCallback: cb => frames.push(cb) }; }
      ${body}
    }
    () => new Page()
  `), {
    frames,
    setTimeout: (run, ms) => { timers.push({ run, ms }); return timers.length; },
    StartupFrameCallback: class { constructor(run) { this.run = run; } },
    WebPhase: { BOOTING: 'booting' }, DESKTOP_WORKBENCH_PAINT_OBSERVER: 'observer',
    TABLET_STARTUP_WEB_HANDOFF: 'handoff',
  });
  const tablet = makePage();
  tablet.rawDeviceType = 'tablet';
  tablet.prepareDesktopWebAfterFrame();
  frames.shift().run();
  assert.equal(tablet.startupWebPrepared, false);
  assert.equal(timers[0].ms, 1100);
  timers.shift().run();
  assert.equal(tablet.startupWebPrepared, true);
  assert.deepEqual(Array.from(tablet.webDocumentStartScripts(), item => item.script), ['observer', 'handoff']);

  const fastHost = makePage();
  fastHost.rawDeviceType = 'tablet';
  fastHost.prepareDesktopWebAfterFrame();
  frames.shift().run();
  fastHost.launchUrl = 'http://127.0.0.1:3120/';
  timers.shift().run();
  assert.equal(fastHost.startupWebPrepared, false, 'an authenticated URL takes precedence over the queued blank Web');
  assert.deepEqual(Array.from(fastHost.webDocumentStartScripts(), item => item.script), ['handoff']);

  const desktop = makePage();
  desktop.rawDeviceType = '2in1';
  desktop.prepareDesktopWebAfterFrame();
  frames.shift().run();
  assert.equal(desktop.startupWebPrepared, true);
  assert.deepEqual(Array.from(desktop.webDocumentStartScripts(), item => item.script), ['observer']);
  assert.equal(timers.length, 0);
}

function checkProgressMotion(source) {
  const shared = between(source, 'export enum DesktopHostStartupStage', 'export const DESKTOP_WORKBENCH_PAINT_PREFIX')
    .replaceAll('export ', '');
  const { motion, timeline, tablet } = runInNewContext(stripTypeScriptTypes(
    shared + '\n({ motion: desktopStartupMotion, timeline: new DesktopProgressTimeline(), tablet: new DesktopProgressTimeline() })',
    { mode: 'transform' }));
  const milestones = [0, 8, 16, 64, 70, 96, 98, 100];
  let last = 0;
  for (let i = 0; i < milestones.length - 1; i++) {
    const step = motion(milestones[i]);
    assert.ok(step.lead > last && step.limit > step.lead && step.limit < milestones[i + 1]);
    assert.ok(step.leadMs > 0 && step.tailMs >= step.leadMs);
    last = step.limit;
  }
  const first = timeline.retarget(55, 2200, 0, 8.8 / 7800);
  assert.equal(first.duration, 2200);
  const t = 200 / first.duration;
  const u = 1 - t;
  const painted = 55 * (3 * u * t * t * first.second + t * t * t);
  const speed = 55 * 3 * (2 * u * t * first.second + t * t * (1 - first.second)) / first.duration;
  const next = timeline.retarget(91.5, 1080, 200);
  assert.equal(next.duration, Math.ceil((91.5 - painted) * 34), 'fast milestones respect the minimum travel time');
  const continuedSpeed = 3 * next.first * (91.5 - painted) / next.duration;
  assert.ok(Math.abs(speed - continuedSpeed) < 1e-9, 'retargeting carries the painted velocity into the next segment');
  assert.ok(timeline.retarget(95.8, 3000, 10000).duration >= 3000);
  assert.equal(timeline.retarget(100, 0, 10001).duration, 64, 'short completion uses a gentle minimum duration');
  assert.equal(timeline.retarget(100, 0, 200).duration, 64, 'a backward clock does not reverse progress');
  const fresh = timeline.retarget(100, 0, 200);
  assert.ok(fresh.first <= fresh.second && fresh.second <= 1, 'the curve stays within the progress track');

  const desktopLead = motion(70);
  const tabletLead = motion(70, true);
  assert.deepEqual(motion(64, true), motion(64), 'tablet acceleration begins with Web navigation');
  assert.equal(tabletLead.limit, desktopLead.limit, 'a faster animation has the same confirmed ceiling');
  assert.ok(tabletLead.leadMs < desktopLead.leadMs);
  assert.equal(tablet.retarget(100, 0, 0, 0, true).duration, 96, 'a long final move still gets time to settle');
  assert.equal(tablet.retarget(100, 0, 96, 0, true).duration, 48, 'a nearly full tablet track settles faster');
}

function checkProgressView(source) {
  const shared = between(common, 'export enum DesktopHostStartupStage', 'export const DESKTOP_WORKBENCH_PAINT_PREFIX')
    .replaceAll('export ', '');
  const methods = between(source, '  private scheduleMotion()', '  build()').replaceAll('private ', '');
  const frames = [];
  const animations = [];
  let now = 0;
  const ui = {
    postFrameCallback: frame => frames.push(frame),
    animateTo: (options, change) => { change(); animations.push(options); },
  };
  const view = runInNewContext(stripTypeScriptTypes(
    shared + '\nclass View { timeline = new DesktopProgressTimeline(); getUIContext() { return ui; }\n' +
      methods + '\n}\nnew View()', { mode: 'transform' }), {
    ui, Date: { now: () => now }, curves: { cubicBezierCurve: (...control) => control },
    StartupFrameCallback: class { constructor(callback) { this.run = callback; } },
  });
  Object.assign(view, { visible: true, confirmed: 16, accepted: -1, motionId: 0 });
  view.scheduleMotion();
  view.scheduleMotion();
  assert.equal(frames.length, 1);
  frames.shift().run();
  assert.equal(view.fill, 55);
  now += 200;
  view.confirmed = 64;
  view.scheduleMotion();
  view.confirmed = 70;
  view.scheduleMotion();
  assert.equal(frames.length, 1, 'multiple milestones before paint retarget only once');
  frames.shift().run();
  assert.equal(view.fill, 91.5);
  animations[0].onFinish();
  assert.equal(view.fill, 91.5, 'a superseded animation cannot restore the preceding cap');
  view.confirmed = 64;
  view.scheduleMotion();
  assert.equal(frames.length, 0, 'a retry on the same splash cannot move the bar backwards');
  view.visible = false;
  animations[1].onFinish();
  assert.equal(animations.length, 2, 'a removed splash cannot start another animation');
  view.visible = true;
  view.confirmed = 100;
  view.scheduleMotion();
  assert.equal(frames.length, 1);
  frames.shift().run();
  assert.equal(view.fill, 100, 'the ready milestone completes the visible fill');
  assert.equal(animations[2].duration, 96, 'a substantial distance to 100 takes longer to settle');
  let fullPaints = 0;
  view.onFullPaint = () => { fullPaints++; };
  animations[2].onFinish();
  assert.equal(view.full, true, 'the final track uses a static full-width fill');
  assert.equal(fullPaints, 0, 'wait for the completed fill to reach a frame before removing it');
  frames.shift().run();
  assert.equal(fullPaints, 1);
  animations[1].onFinish();
  assert.equal(view.fill, 100, 'a late tail cannot undo the completed bar');
}

async function checkConsoleSink(source) {
  const body = between(source, 'class WebConsoleFileSink {', 'class DshDirectoryPickerBridge {')
    .replaceAll('private ', '');
  const timers = [];
  const opens = [];
  const writes = [];
  const closed = [];
  let unlockFirst;
  const fileIo = {
    OpenMode: { CREATE: 1, READ_WRITE: 2, TRUNC: 4, APPEND: 8 },
    async open(path, mode) { opens.push({ path, mode }); return { fd: opens.length }; },
    write(fd, text) {
      writes.push({ fd, text });
      return fd === 1 ? new Promise(resolve => { unlockFirst = resolve; }) : Promise.resolve(text.length);
    },
    async close(fd) { closed.push(fd); },
  };
  const sink = runInNewContext(stripTypeScriptTypes(body + '\nnew WebConsoleFileSink("/fixture/console")'), {
    fileIo, CONSOLE_SINK_LINE_CAP: 4,
    setTimeout: callback => timers.push(callback),
    hilog: { warn() {} }, DOMAIN: 0, TAG: '',
  });
  const turn = () => new Promise(resolve => setImmediate(resolve));
  sink.append('first\n', 'timestamp');
  sink.append('second\n', 'timestamp');
  assert.equal(timers.length, 1, 'message bursts share one delayed write');
  assert.equal(writes.length, 0);
  timers.shift()();
  await turn();
  assert.equal(opens.length, 1);
  assert.match(writes[0].text, /本次冷启动开始.*\nfirst\nsecond\n$/);
  sink.append('third\n', 'timestamp');
  sink.append('fourth\n', 'timestamp');
  sink.append('discarded\n', 'timestamp');
  assert.equal(timers.length, 0, 'another batch cannot overtake an in-flight write');
  unlockFirst();
  await turn();
  assert.equal(timers.length, 1);
  timers.shift()();
  await turn();
  assert.deepEqual(opens.map(open => open.mode), [7, 11], 'first write truncates, later writes append');
  assert.deepEqual(closed, [1, 2]);
  assert.match(writes[1].text, /^third\nfourth\ntimestamp === 已达 4 行上限/);
  assert.equal(timers.length, 0);
}

async function checkPolling(source) {
  const method = between(source, '  private async waitListening(', '  /**\n   * 端口是否在监听')
    .replace('private ', '');
  const constants = source.match(/^const (?:FOREGROUND_READY_POLL_\w+|READY_(?:POLL_INTERVAL|ALIVE_GRACE|PROGRESS_LOG)_MS):.*;$/gm);
  const sleeps = [];
  let now = 0;
  const create = runInNewContext(stripTypeScriptTypes(`
    ${constants.join('\n')}
    class NodeRuntime { ${method} }
    () => new NodeRuntime()
  `), {
    Date: { now: () => now }, dshhost: { isHostRunning: () => true },
    hilog: { info() {}, error() {} }, DOMAIN: 0, TAG: '',
  });
  for (const foreground of [false, true]) {
    now = 0;
    sleeps.length = 0;
    const runtime = create();
    if (foreground) runtime.startupListeningCallback = () => {};
    runtime.portAnswers = async () => now >= 5500;
    runtime.sleep = async ms => { sleeps.push([now, ms]); now += ms; };
    assert.equal(await runtime.waitListening(3120, 6000), true);
    assert.ok(sleeps.some(([time]) => time >= 5000));
    for (const [time, ms] of sleeps) {
      assert.equal(ms, foreground && time >= 2000 && time < 5000 ? 64 : 250);
    }
  }
}

async function checkAuthRetry(source) {
  const method = between(source, '  private async readAuthUrlWithRetry(', '  /** 读入口脚本落下的 authenticatedUrl')
    .replace('private ', '');
  const constants = source.match(/^const (?:FOREGROUND_)?AUTH_URL_\w*:.*;$/gm);
  const runtime = runInNewContext(stripTypeScriptTypes(`
    ${constants.join('\n')}
    class NodeRuntime { ${method} }
    new NodeRuntime()
  `));
  let now = 0;
  runtime.sleep = async ms => { now += ms; };
  runtime.readAuthUrl = () => now >= 44 ? 'current-url' : '';
  assert.equal(await runtime.readAuthUrlWithRetry('/home', 3120, true), 'current-url');
  assert.equal(now, 56);
  now = 0;
  assert.equal(await runtime.readAuthUrlWithRetry('/home', 3120, false), 'current-url');
  assert.equal(now, 80);
  for (const foreground of [false, true]) {
    now = 0;
    runtime.readAuthUrl = () => '';
    assert.equal(await runtime.readAuthUrlWithRetry('/home', 3120, foreground), '');
    assert.equal(now, 15000, 'both modes keep the full retry budget');
  }
}

checkProgress(web);
checkWebPreparation(web);
checkProgressMotion(common);
checkProgressView(progressView);
checkWorkbenchScript(common);
checkTabletHandoff(common);
checkEarlyWorkbenchPaint(common);
await checkConsoleSink(web);
await checkPolling(node);
await checkAuthRetry(node);
if (process.argv.includes('--self-test')) {
  assert.throws(() => checkWebPreparation(web.replace("this.rawDeviceType === 'tablet'", 'false')));
  assert.throws(() => checkProgressMotion(common.replace('limit: 63.8', 'limit: 64')));
  assert.throws(() => checkProgressView(progressView.replace('animation !== this.motionId ||', 'false ||')));
  assert.throws(() => checkProgressMotion(common.replace('speed * this.duration', '0 * this.duration')));
  assert.throws(() => checkProgressMotion(common.replace('fasterWebProgress ? 48 : 64', '64')));
  assert.throws(() => checkProgressView(progressView.replace('this.fill = 100;', 'this.fill = 99;')));
  assert.throws(() => checkEarlyWorkbenchPaint(common.replace('previous?.[0] === current[0] && previous?.[1] === current[1]', 'true')));
  assert.throws(() => checkWorkbenchScript(common.replace('${waitMs}', '180')));
  assert.throws(() => checkTabletHandoff(common.replace('visibility: hidden; pointer-events', 'visibility: visible; pointer-events')));
  assert.throws(() => checkWorkbenchScript(common.replace('sidebarVisible && sidebar === lastSidebar', 'sidebarVisible')));
  assert.throws(() => checkProgress(web.replace('message !== this.desktopPaintMessage || ', '')));
  assert.throws(() => checkProgress(web.replace('this.getUIContext().getHostContext()?.eventHub.emit(DESKTOP_WORKBENCH_PAINTED_EVENT);', '')));
  assert.throws(() => checkProgress(web.replace('this.webNavigationStarted && this.phase', 'this.phase')));
  assert.throws(() => checkProgress(web.replace('|| this.loadFailed || this.desktopStartupComplete', '|| this.desktopStartupComplete')));
  assert.throws(() => checkProgress(web.replace('this.startupWebProgress = DESKTOP_WEB_LOADED;', 'this.startupWebProgress = 100;')));
  assert.throws(() => checkProgress(web.replace('this.desktopStartupFinishing && this.webWorkbenchPaintReported', 'this.desktopStartupFinishing')));
  await assert.rejects(() => checkConsoleSink(web.replace('first ? fileIo.OpenMode.TRUNC', 'first ? fileIo.OpenMode.APPEND')));
  await assert.rejects(() => checkPolling(node.replace('foreground ? FOREGROUND_READY_POLL_INTERVAL_MS : READY_POLL_INTERVAL_MS', 'FOREGROUND_READY_POLL_INTERVAL_MS')));
  await assert.rejects(() => checkAuthRetry(node.replace('[12, 12, 16, 16, 20, 20, 24]', '[16, 24, 40]')));
}
console.log('PASS desktop startup progress, paint fallback, retries and bounded foreground polling');
