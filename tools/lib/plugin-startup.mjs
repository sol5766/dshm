import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IMPORT = 'import { execa } from "execa";';
const MARK = '// DSHM_DEFER_EXECA: load the process runner only on a subprocess path.';
const LOCAL = 'const { execa } = await import("execa");';

// Ordered executable call sites in the two bundled rc.5 plugins. This intentionally
// excludes their CLI-only entry points and the optional GitHub forge plugin.
const statements = {
  'dsh-plugin-manager': [
    'const viewed = await execa(options.command ?? "pnpm", [',
    'const child = execa(options.command ?? "pnpm", [...options.args ?? [], ...args.map((arg) => anchorPathSpec(arg, context.cwd))], {',
    'const repairing = execa(options.command ?? "pnpm", [...options.args ?? [], ...repair], {',
    'const result = await execa(options.command ?? "pnpm", [',
    'const result = await execa(options.command ?? "pnpm", [',
    'const result = await execa(command, args, {',
    'return !(await execa("git", [',
  ],
  'dsh-plugin-market': ['const result = await execa("git", [...['],
};

export function deferPluginExeca(text, pkg) {
  const lines = text.split('\n');
  const sites = statements[pkg];
  const processed = lines.some(line => line.trimEnd() === MARK);
  const expected = processed ? MARK : IMPORT;
  if (!sites || lines.filter(line => line.trimEnd() === expected).length !== 1) {
    throw new Error('unexpected execa import in ' + pkg);
  }
  let calls = 0;
  const out = [];
  for (const line of lines) {
    const statement = line.trim();
    if (statement === expected) {
      out.push(processed ? line : line.replace(IMPORT, MARK));
      continue;
    }
    if (statement === LOCAL && processed) {
      out.push(line);
      continue;
    }
    if (/\bexeca\b/.test(statement) && !/^(?:\/\*|\*|\/\/)/.test(statement)) {
      if (sites[calls++] !== statement) throw new Error('unexpected execa usage in ' + pkg);
      // Preserve the unawaited execa subprocess for stdout streams, kill/abort,
      // nodeChildProcess and exit listeners. Await only the module acquisition.
      // The repair branch is in the same runProfilePnpm invocation as "child".
      if (!statement.startsWith('const repairing =')) {
        const local = line.replace(statement, LOCAL);
        if (!processed) out.push(local);
        else if (out.at(-1) !== local) throw new Error('missing local execa binding in ' + pkg);
      }
    }
    out.push(line);
  }
  const bindings = sites.filter(site => !site.startsWith('const repairing =')).length;
  if (calls !== sites.length || (processed && lines.filter(line => line.trim() === LOCAL).length !== bindings)) {
    throw new Error('execa call sites changed in ' + pkg);
  }
  return out.join('\n');
}

// Run after existing registry, pnpm and inspection bridge patches have been placed.
export function deferPluginSubprocessImports(stage) {
  for (const pkg of Object.keys(statements)) {
    const file = join(stage, 'node_modules', '@deepseek-ai', pkg, 'lib', 'index.js');
    const original = readFileSync(file, 'utf8');
    const next = deferPluginExeca(original, pkg);
    if (next === original) continue;
    const tmp = file + '.dshm-' + process.pid + '.tmp';
    writeFileSync(tmp, next);
    renameSync(tmp, file);
  }
}
