import { FrameCallback } from '@kit.ArkUI';

export const DESKTOP_PROGRESSIVE_STARTUP: boolean = true;
export const KEY_DESKTOP_HOST_STARTUP: string = 'dshDesktopHostStartup';
export const DESKTOP_WORKBENCH_PAINTED_EVENT: string = 'dshDesktopWorkbenchPainted';

export enum DesktopHostStartupStage {
  WaitingForFolders = 0,
  CheckingCore = 8,
  StartingHost = 16,
  PortListening = 64
}

export const DESKTOP_WEB_START: number = 70;
export const DESKTOP_WEB_NETWORK_LOADED: number = 96;
export const DESKTOP_WEB_LOADED: number = 98;

export interface DesktopProgressMotion {
  lead: number;
  leadMs: number;
  limit: number;
  tailMs: number;
}

export interface DesktopProgressSegment {
  duration: number;
  first: number;
  second: number;
}

export class DesktopProgressTimeline {
  private from: number = 0;
  private target: number = 0;
  private started: number = 0;
  private duration: number = 0;
  private first: number = 0;
  private second: number = 1;

  retarget(target: number, minimumMs: number, now: number, landingSpeed: number = 0,
    fasterWebProgress: boolean = false): DesktopProgressSegment {
    // The two fixed X control points make the bezier parameter equal elapsed time.
    const t: number = this.duration > 0 ? Math.min(1, Math.max(0, (now - this.started) / this.duration)) : 1;
    const u: number = 1 - t;
    const progress: number = 3 * u * u * t * this.first + 3 * u * t * t * this.second + t * t * t;
    const slope: number = 3 * (u * u * this.first + 2 * u * t * (this.second - this.first) +
      t * t * (1 - this.second));
    const span: number = this.target - this.from;
    const speed: number = this.duration > 0 ? span * slope / this.duration : 0;
    this.from += span * progress;
    this.target = Math.max(target, this.from);
    this.started = now;
    const remaining: number = Math.max(0.001, this.target - this.from);
    this.duration = target === 100
      ? Math.min(96, Math.max(fasterWebProgress ? 48 : 64, Math.ceil(remaining * 5)))
      : Math.max(minimumMs, Math.ceil(remaining * (fasterWebProgress ? 16 : 34)));
    this.first = Math.min(0.49, speed * this.duration / (3 * remaining));
    this.second = Math.max(0.51, 1 - landingSpeed * this.duration / (3 * remaining));
    return { duration: this.duration, first: this.first, second: this.second };
  }
}

/** Reserve each milestone until the event that confirms it. */
export function desktopStartupMotion(confirmed: number, fasterWebProgress: boolean = false): DesktopProgressMotion {
  if (confirmed < DesktopHostStartupStage.CheckingCore) {
    return { lead: 4, leadMs: 190, limit: 7.8, tailMs: 1400 };
  }
  if (confirmed < DesktopHostStartupStage.StartingHost) {
    return { lead: 10.5, leadMs: 700, limit: 15.8, tailMs: 12000 };
  }
  if (confirmed < DesktopHostStartupStage.PortListening) {
    return { lead: 55, leadMs: 2200, limit: 63.8, tailMs: 7800 };
  }
  if (confirmed < DESKTOP_WEB_START) {
    return { lead: 67, leadMs: 340, limit: 69.8, tailMs: 1400 };
  }
  if (confirmed < DESKTOP_WEB_NETWORK_LOADED) {
    return { lead: 91.5, leadMs: fasterWebProgress ? 430 : 1080, limit: 95.8, tailMs: 3000 };
  }
  if (confirmed < DESKTOP_WEB_LOADED) {
    return { lead: 97, leadMs: 260, limit: 97.8, tailMs: 1300 };
  }
  return { lead: 99, leadMs: 180, limit: 99.8, tailMs: 900 };
}

export const DESKTOP_WORKBENCH_PAINT_PREFIX: string = 'DSHM-STARTUP-WORKBENCH-PAINT:';

// The authenticated page can paint its own UI as the native brand fades.
export const TABLET_STARTUP_WEB_HANDOFF: string = `(() => {
  if (window !== top || location.protocol !== 'http:' || location.hostname !== '127.0.0.1' ||
      location.pathname !== '/') return;
  globalThis.__DSHM_TABLET_WORKBENCH_STARTUP__ = true;
  function hideBootFragment() {
    const root = document.head || document.documentElement;
    if (!root) return false;
    const style = document.createElement('style');
    style.textContent = '#root > [data-dsh-boot] { visibility: hidden; pointer-events: none; } ' +
      '#root > [data-dsh-boot], #root > [data-dsh-boot] * { animation: none !important; }';
    root.append(style);
    return true;
  }
  if (hideBootFragment()) return;
  const observer = new MutationObserver(() => {
    if (hideBootFragment()) observer.disconnect();
  });
  observer.observe(document, { childList: true });
})();`;

export function desktopWorkbenchPaintPage(url: string): string {
  const match: RegExpExecArray | null = /^http:\/\/127\.0\.0\.1:\d+\/?(?=[?#]|$)/.exec(url);
  if (match === null) {
    return '';
  }
  return match[0].endsWith('/') ? match[0] : match[0] + '/';
}

const WORKBENCH_PAINT_HIT_TEST: string = `function visible(element) {
  if (!element || element.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
  if (element.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true}) === false) return false;
  const bounds = element.getBoundingClientRect();
  const left = Math.max(0, bounds.left), right = Math.min(innerWidth, bounds.right);
  const top = Math.max(0, bounds.top), bottom = Math.min(innerHeight, bounds.bottom);
  if (left >= right || top >= bottom) return false;
  const style = getComputedStyle(element);
  if (style.visibility !== 'visible' || style.opacity === '0') return false;
  return element.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2));
}
function workbenchTargets() {
  const root = document.getElementById('root');
  return [root?.querySelector('[data-sidebar-workspace-header]'),
    root?.querySelector('[data-conversation-content] [data-composer-input][role="textbox"]')];
}`;

export const DESKTOP_WORKBENCH_PAINT_OBSERVER: string = `(() => {
  if (window !== top || location.protocol !== 'http:' || location.hostname !== '127.0.0.1' ||
      location.pathname !== '/' || globalThis.__DSHM_WORKBENCH_PAINTED__) return;
  ${WORKBENCH_PAINT_HIT_TEST}
  let previous, painted;
  let frame = 0;
  let deadline = 0;
  const discovery = new MutationObserver(discover);
  const lifetime = setTimeout(stop, 5000);
  function stop() {
    discovery.disconnect();
    clearTimeout(lifetime);
    if (frame) cancelAnimationFrame(frame);
  }
  function discover() {
    const root = document.getElementById('root');
    if (!root) return;
    if (document.querySelector('meta[name="dshm-onboarding-signed-out"]')?.content !== '1') {
      stop();
      return;
    }
    const nodes = workbenchTargets();
    if (!nodes[0] || !nodes[1]) return;
    discovery.disconnect();
    deadline = performance.now() + 180;
    Object.defineProperty(globalThis, '__DSHM_WORKBENCH_PAINTED__', {value: () => {
      if (!painted || document.visibilityState !== 'visible') return false;
      const current = workbenchTargets();
      return current[0] === painted[0] && current[1] === painted[1] && current.every(visible);
    }});
    frame = requestAnimationFrame(observeFrame);
  }
  function observeFrame() {
    frame = 0;
    if (performance.now() > deadline || document.visibilityState !== 'visible') {
      stop();
      return;
    }
    const current = workbenchTargets();
    if (current.every(visible)) {
      if (previous?.[0] === current[0] && previous?.[1] === current[1]) {
        painted = current;
        stop();
        return;
      }
      previous = current;
    } else {
      previous = undefined;
    }
    frame = requestAnimationFrame(observeFrame);
  }
  discovery.observe(document, {childList:true, subtree:true});
  discover();
  window.addEventListener('pagehide', stop, {once:true});
})();`;

export function buildDesktopWorkbenchPaintScript(page: string, message: string, waitMs: number,
  reportRegions: boolean = false): string {
  return `(() => {
    if (window !== top || location.origin + location.pathname !== ${JSON.stringify(page)}) return;
    const deadline = performance.now() + ${waitMs};
    let lastSidebar, lastComposer;
    let reportedSidebar = false, reportedComposer = false;
    const reportRegions = ${reportRegions};
    if (globalThis.__DSHM_WORKBENCH_PAINTED__?.() === true) {
      console.info(${JSON.stringify(message)});
      return;
    }
    ${WORKBENCH_PAINT_HIT_TEST}
    function check() {
      if (performance.now() > deadline || document.visibilityState !== 'visible') return;
      const [sidebar, composer] = workbenchTargets();
      const sidebarVisible = visible(sidebar) && (!reportRegions || visible(
        document.getElementById('root')?.querySelector('[data-sidebar-list-area]')));
      const composerVisible = visible(composer);
      const sidebarPainted = sidebarVisible && sidebar === lastSidebar;
      const composerPainted = composerVisible && composer === lastComposer;
      if (sidebarPainted && composerPainted) {
        console.info(${JSON.stringify(message)});
        return;
      }
      if (reportRegions && sidebarPainted && !reportedSidebar) {
        reportedSidebar = true;
        console.info(${JSON.stringify(message + ':sidebar')});
      }
      if (reportRegions && composerPainted && !reportedComposer) {
        reportedComposer = true;
        console.info(${JSON.stringify(message + ':composer')});
      }
      lastSidebar = sidebarVisible ? sidebar : undefined;
      lastComposer = composerVisible ? composer : undefined;
      requestAnimationFrame(check);
    }
    requestAnimationFrame(check);
  })();`;
}
export class StartupFrameCallback extends FrameCallback {
  private readonly afterFrame: () => void;

  constructor(afterFrame: () => void) {
    super();
    this.afterFrame = afterFrame;
  }

  onIdle(_timeLeftInNano: number): void {
    this.afterFrame();
  }
}
