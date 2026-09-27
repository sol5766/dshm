/**
 * Shared helpers for the platform implementations.
 *
 * Why this exists: the three platform files differ in exactly two ways — where user state lives and
 * how a console-less child process is spawned — and are identical in the rest. Keeping the common
 * parts here means the platform files stay short enough to audit at a glance.
 */

import os from 'node:os';
import path from 'node:path';

/** XDG-ish state directory, per-platform. */
export function defaultStateDir(platform, appName = 'dsh-harmony-hostkit') {
  if (platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, appName);
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName);
  }
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg !== undefined && xdg !== '' ? xdg : path.join(os.homedir(), '.local', 'state');
  return path.join(base, appName);
}

/**
 * Enumerate non-internal IPv4 interfaces.
 * @param {import('node:os').NetworkInterfaceInfo[]} entries
 * @returns {{name: string, address: string, netmask: string, broadcast: string|cidr:undefined}[]}
 */
export function lanIPv4FromInterfaces(entries) {
  /** @type {{name: string, address: string, netmask: string, broadcast: string|undefined}[]} */
  const out = [];
  for (const [name, list] of Object.entries(entries)) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' && info.family !== 4) continue;
      if (info.internal) continue;
      out.push({
        name,
        address: info.address,
        netmask: info.netmask,
        broadcast: broadcastOf(info.address, info.netmask),
      });
    }
  }
  return out;
}

/**
 * Compute the directed broadcast address for an `a.b.c.d / netmask` pair.
 * @param {string} address @param {string} netmask @returns {string|undefined}
 */
export function broadcastOf(address, netmask) {
  const addr = ipv4ToInt(address);
  const mask = ipv4ToInt(netmask);
  if (addr === undefined || mask === undefined) return undefined;
  return intToIpv4((addr | (~mask >>> 0)) >>> 0);
}

/** @param {string} value @returns {number|undefined} */
export function ipv4ToInt(value) {
  const parts = String(value).split('.');
  if (parts.length !== 4) return undefined;
  let out = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined;
    out = ((out << 8) | octet) >>> 0;
  }
  return out >>> 0;
}

/** @param {number} value @returns {string} */
export function intToIpv4(value) {
  const v = value >>> 0;
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff].join('.');
}

/**
 * Where to look for an `openssl` binary when the user asks hostkit to mint a self-signed pair.
 * @param {NodeJS.Platform} platform
 * @returns {string[]}
 */
export function opensslCandidates(platform) {
  if (platform === 'win32') {
    return [
      'openssl.exe',
      'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
      'C:\\Program Files (x86)\\OpenSSL-Win32\\bin\\openssl.exe',
      'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
      'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    ];
  }
  return ['openssl', '/usr/bin/openssl', '/usr/local/bin/openssl', '/opt/homebrew/bin/openssl'];
}
