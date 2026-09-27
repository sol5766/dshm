/**
 * Linux platform implementation (also the fallback for unrecognised POSIX platforms).
 *
 * Differences from macOS: state follows XDG (`$XDG_STATE_HOME`, else `~/.local/state`). The child is
 * spawned `detached: true` so it becomes a process-group leader and we can signal the whole group by
 * negative pid on shutdown — again, only for a pid we created.
 */

import os from 'node:os';
import path from 'node:path';
import { defaultStateDir, lanIPv4FromInterfaces, opensslCandidates } from './common.mjs';

/** @type {const} */
const NAME = 'linux';

export const linuxPlatform = {
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
