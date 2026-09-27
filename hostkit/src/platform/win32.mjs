/**
 * Windows platform implementation.
 *
 * Why the `spawnOptions` shape differs per platform: a console-less spawn on Windows needs
 * `windowsHide: true` (otherwise a stray console window flickers on every restart) but must **not**
 * use `detached: true` — a detached child on Windows is not tied to our console, so a Ctrl+C in the
 * hostkit terminal would leave `dsh web` orphaned. The task book forbids killing processes by name, so
 * an orphaned child could never be reclaimed; not detaching is the only safe option.
 */

import os from 'node:os';
import path from 'node:path';
import { defaultStateDir, lanIPv4FromInterfaces, opensslCandidates } from './common.mjs';

/** @type {const} */
const NAME = 'win32';

export const win32Platform = {
  name: NAME,

  /**
   * @param {string} command @param {string[]} args @param {{cwd?: string, env?: Record<string,string>}} [options]
   * @returns {{command: string, args: string[], options: object}}
   */
  spawnOptions(command, args, options = {}) {
    return {
      command,
      args,
      // The upstream CLI ships as a `.cmd`/`.ps1` shim on Windows; `shell: true` lets Node resolve it.
      // We never interpolate untrusted strings into `command` — see hostkit/README.md §Threat model.
      options: {
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? process.env,
        windowsHide: true,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: command.endsWith('.cmd') || command.endsWith('.bat') || command === 'dsh',
      },
    };
  },

  /** @returns {string} */
  stateDir() {
    return defaultStateDir(NAME);
  },

  /** Default directory for a self-signed TLS pair minted by `hostkit start --tls-selfsigned`. */
  defaultCertDir() {
    return path.join(defaultStateDir(NAME), 'tls');
  },

  /** @returns {{name: string, address: string, netmask: string, broadcast: string|undefined}[]} */
  lanIPv4() {
    return lanIPv4FromInterfaces(os.networkInterfaces());
  },

  /** @returns {string[]} */
  findOpensslCandidates() {
    return opensslCandidates(NAME);
  },

  /**
   * Terminate a child we spawned and its descendants. Only ever called with a pid we created.
   * Windows has no process groups for `spawn` without `detached`, so the CLI supplies a
   * `taskkill /PID <pid> /T` for the *specific* pid — never a name match.
   * @param {number} pid
   * @returns {{command: string, args: string[]}}
   */
  killTree(pid) {
    return { command: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] };
  },
};
