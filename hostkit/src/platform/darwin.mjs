/**
 * macOS platform implementation.
 *
 * Differences from Linux: state lives under `~/Library/Application Support`, and a console-less child
 * is spawned with `detached: true` so it leads its own process group — that gives us a *pid* to signal
 * later, and keeps Ctrl+C in the hostkit terminal from racing the child's own shutdown path.
 * We still never signal anything but a pid we spawned ourselves.
 */

import os from 'node:os';
import path from 'node:path';
import { defaultStateDir, lanIPv4FromInterfaces, opensslCandidates } from './common.mjs';

/** @type {const} */
const NAME = 'darwin';

export const darwinPlatform = {
  name: NAME,

  /**
   * @param {string} command @param {string[]} args @param {{cwd?: string, env?: Record<string,string>}} [options]
   * @returns {{command: string, args: string[], options: object}}
   */
  spawnOptions(command, args, options = {}) {
    return {
      command,
      args,
      options: {
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? process.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      },
    };
  },

  /** @returns {string} */
  stateDir() {
    return defaultStateDir(NAME);
  },

  /** @returns {string} */
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
   * @param {number} pid
   * @returns {{command: string, args: string[]}}
   */
  killTree(pid) {
    return { command: 'kill', args: ['-TERM', String(-pid)] };
  },
};
