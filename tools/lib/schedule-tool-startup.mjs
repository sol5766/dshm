import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const scheduleHash = '5d0b03f6cf09332e07f4a7096647f75d991e0b6de82d9a9c881fe0061f95d10d';
const toolsHashes = {
  'package.json': '0546e1fefee5a5b17ad5a6cd6d64ddb742adcc84e724b9f398df99cff042c992',
  'lib/index.js': '897369e25290642f98cb6598ecedb15769d6b0bb3ab6c4d849f6abebc61e47f3',
  'lib/shared-DGx6D7zk.js': '1ab4302fb7f04957889d89217f6bbd269cc3fbaf3a1e9163502318b24b3db022',
};
const projectionsHash = '1dacb3433a94e8d6942feb2a15137337588b6aac1e0b505248ac08a66c633479';
const names = ['create', 'list', 'view', 'edit'];
const originalCall = 'ctx.tools.register(defineTool({';
const patchedCall = 'ctx.tools.register(dshmDefineScheduleTool({';
const marker = '\n// DSHM: precompiled built-in Schedule output schemas.\n';
const hash = data => createHash('sha256').update(data).digest('hex');

export function originalScheduleSource(source) {
  const at = source.indexOf(marker);
  const raw = at === -1 ? source : source.slice(0, at).replaceAll(patchedCall, originalCall);
  if (hash(raw) !== scheduleHash) throw new Error('Unexpected built-in Schedule tool source');
  return raw;
}

export function scheduleOutputSource(source, compile) {
  const raw = originalScheduleSource(source);
  // This exact, fingerprinted declaration block contains only the four author
  // schemas and their static data. Dynamic caller descriptions stay in apply().
  const start = raw.indexOf('const SESSION_CREATE_SCHEMA');
  const end = raw.indexOf('const MANAGEMENT_AUTHORIZATION');
  const constants = names.map(name => name.toUpperCase() + '_OUTPUT_SCHEMA');
  const inputs = runInNewContext(raw.slice(start, end) + '\n[' + constants.join(', ') + ']');
  const compiled = Array.from(inputs, input => compile(input));
  if (hash(JSON.stringify(compiled)) !== projectionsHash) throw new Error('Unexpected Schedule output projections');
  const cases = names.map((name, index) => {
    const json = JSON.stringify(compiled[index]);
    return '    case "schedule_' + name + '": return JSON.parse(' + JSON.stringify(json) + ');';
  });
  const wrapper = [
    'function dshmDefineScheduleTool(options) {',
    '  if (process.env.DSHM_SCHEDULE_OUTPUT_PRECOMPILED !== "1") return defineTool(options);',
    '  const tool = defineTool({ ...options, output: { ...options.output, schema: { type: "json" } } });',
    '  tool.output.schema = dshmScheduleOutput(options.name);',
    '  return tool;',
    '}',
  ].join('\n');
  const previous = raw.replaceAll(originalCall, patchedCall) + marker + [
    wrapper,
    'function dshmScheduleOutput(name) {',
    '  switch (name) {',
    ...cases,
    '    default: throw new Error("Unexpected built-in Schedule tool");',
    '  }',
    '}',
    '',
  ].join('\n');
  const timed = wrapper.replace('  const tool = defineTool', '  const endDefine = globalThis.__dshmSchedulePhase?.("defineWrapper", options.name);\n  const tool = defineTool')
    .replace('  tool.output.schema = dshmScheduleOutput(options.name);', [
      '  endDefine?.();',
      '  const endCopy = globalThis.__dshmSchedulePhase?.("copyOutput", options.name);',
      '  tool.output.schema = dshmScheduleOutput(options.name);',
      '  endCopy?.();',
    ].join('\n'));
  const next = previous.replace(wrapper, timed);
  if (source !== raw && source !== previous && source !== next) throw new Error('Modified generated Schedule output projections');
  return previous;
}

export async function useScheduleOutputPrecompile(stage) {
  const target = resolve(stage, 'node_modules/@deepseek-ai/dsh-tool-schedule/lib/index.js');
  const source = readFileSync(target, 'utf8');
  originalScheduleSource(source);
  const tools = createRequire(target).resolve('@deepseek-ai/dsh-tools');
  const root = dirname(dirname(tools));
  for (const [file, expected] of Object.entries(toolsHashes)) {
    const bytes = readFileSync(join(root, file), 'utf8');
    if (hash(bytes) !== expected) throw new Error('Unexpected dsh-tools compiler: ' + file);
  }
  if (tools !== join(root, 'lib', 'index.js')) throw new Error('Unexpected dsh-tools entry');
  const { valueSchemaSpecToJsonSchema } = await import(pathToFileURL(tools).href);
  const next = scheduleOutputSource(source, valueSchemaSpecToJsonSchema);
  if (next === source) return;
  const temporary = target + '.dshm-' + process.pid + '.tmp';
  writeFileSync(temporary, next);
  renameSync(temporary, target);
}
