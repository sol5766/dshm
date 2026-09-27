/**
 * Platform selector.
 *
 * Why this module exists: D1's cross-platform requirement (Windows / macOS / Linux) means the few
 * genuinely OS-specific bits — how to spawn a console child process, where user state lives, how to
 * find a CA tool — must not leak into the core. The core imports from here only.
 *
 * Unknown platforms fall back to the Linux implementation with `name: 'generic'` instead of throwing:
 * hostkit is an *optional* component, and refusing to start on an unrecognised OS would break the
 * "L0 works without hostkit" promise for no security benefit.
 */

import { linuxPlatform } from './linux.mjs';
import { darwinPlatform } from './darwin.mjs';
import { win32Platform } from './win32.mjs';

/**
 * @param {NodeJS.Platform} [platform]
 * @returns {{name: string, spawnOptions: Function, stateDir: Function, defaultCertDir: Function, lanIPv4: Function, findOpensslCandidates: Function, killTree: Function}}
 */
export function platformFor(platform = process.platform) {
  if (platform === 'win32') return win32Platform;
  if (platform === 'darwin') return darwinPlatform;
  return linuxPlatform;
}

/** The platform implementation for the running process. */
export const platform = platformFor();

export { linuxPlatform, darwinPlatform, win32Platform };
