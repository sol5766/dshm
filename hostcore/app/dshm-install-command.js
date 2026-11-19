'use strict';

/**
 * 插件安装入口的命令行语法解析器。
 *
 * 设置页最初只接受裸 spec（npm 包名或 GitHub 地址）。用户从官方文档复制
 * `dsh plugin ...` / `pnpm ...` / `npm ...` 命令时，队列会把整行当包名，
 * 最终以 404 或非法 spec 结束。这里只做**词法解析**，绝不执行 shell：
 *
 *   dsh plugin --profile ondevice add @scope/plugin@1.2.3
 *   dsh --profile ondevice plugin install github:owner/repo#main
 *   dsh plugin add github:owner/repo --profile ondevice --save-exact
 *   pnpm --dir /path/to/profile add package@1.2.3 --registry https://registry.example/
 *   pnpm install package
 *   pnpm i package
 *   npm install package
 *   npm i package
 *
 * 返回值：
 *   { ok: true, spec, profile, dir, registry, saveExact, command }
 *   { ok: false, error }
 *
 * 规则刻意是“最多一个顶层安装目标”。`dsh plugin add a b` 这类命令在 pnpm
 * 语义中会一次改多个依赖，但当前面板的结果协议只能表达一个顶层插件；静默只装
 * 第一个会制造“命令成功但另一个没装”的假象，因此直接拒绝。
 */

const INSTALL_COMMANDS = new Set(['add', 'install', 'i']);
const MANAGERS = new Set(['dsh', 'pnpm', 'npm']);

/** 带独立值的常见选项。数组形式（--config a=b）也由通用 `--x=value` 分支消费。 */
const VALUE_OPTIONS = new Set([
  '--dir', '-C', '--profile', '--registry', '--reporter', '--filter',
  '--workspace', '--store-dir', '--virtual-store-dir', '--modules-dir',
  '--config', '--network-concurrency', '--fetch-timeout', '--fetch-retries',
  '--fetch-retry-factor', '--fetch-retry-mintimeout', '--fetch-retry-maxtimeout',
  '--lockfile-dir', '--lockfile-name', '--node-linker', '--package-import-method',
  '--save-prefix', '--tag', '--user-agent', '--proxy', '--https-proxy',
  '--noproxy', '--workspace-concurrency', '--loglevel',
]);

/** 可以安全忽略的布尔安装选项。插件安装始终写 production dependency。 */
const FLAG_OPTIONS = new Set([
  '--save-exact', '--save', '--save-prod', '-P', '--prod',
  '--ignore-scripts', '--no-optional', '--no-audit', '--no-fund',
  '--prefer-offline', '--offline', '--frozen-lockfile', '--no-frozen-lockfile',
  '--force', '--recursive', '-r', '--silent', '--quiet', '--color', '--no-color',
]);

function fail(error) {
  return { ok: false, error };
}

/**
 * 按空白切词，保留引号内空格。只处理引号闭合，不解释变量、命令替换或目录通配。
 * 控制运算符在引号外出现即拒绝，避免用户误以为面板会执行一整行 shell。
 */
function tokenize(raw) {
  const text = String(raw || '').trim();
  const tokens = [];
  let current = '';
  let quote = '';

  const flush = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = '';
    }
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote.length > 0) {
      if (ch === quote) {
        quote = '';
      } else if (ch === '\\' && quote === '"' && i + 1 < text.length
        && (text[i + 1] === '"' || text[i + 1] === '\\')) {
        current += text[i + 1];
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    /*
     * GitHub monorepo 的官方 spec 允许 `#ref&path:/sub`，因此 `&` 只能在
     * 紧跟 `path:` 时放行；其它位置仍按 shell 控制符拒绝。
     */
    const subdirSeparator = ch === '&' && text.slice(i + 1, i + 6).toLowerCase() === 'path:';
    if (((';&|<>`'.includes(ch) && !subdirSeparator)) || ch === '$' && text[i + 1] === '(') {
      return fail('安装入口只解析命令参数，不接受 shell 控制符、管道或命令替换');
    }
    current += ch;
  }
  if (quote.length > 0) {
    return fail('安装命令中的引号没有闭合');
  }
  flush();
  return { ok: true, tokens };
}

function validProfile(value) {
  return /^[A-Za-z0-9._~-]{1,64}$/.test(value)
    && value !== '.' && value !== '..';
}

/** 校验 registry 是无凭据的 HTTPS base URL；允许路径，拒绝 query/hash。 */
function normalizeRegistry(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function optionValue(token) {
  const at = token.indexOf('=');
  return at > 1 ? token.slice(at + 1) : '';
}

function optionName(token) {
  const at = token.indexOf('=');
  return at > 1 ? token.slice(0, at) : token;
}

/**
 * 解析一行安装输入。
 * @param {string} raw
 * @returns {{ok:true,spec:string,profile:string,dir:string,registry:string,saveExact:boolean,command:string}
 *   | {ok:false,error:string}}
 */
function parseInstallCommand(raw) {
  let input = String(raw || '').trim();
  if (input.startsWith('$ ')) {
    input = input.slice(2).trim();
  }
  if (input.length === 0) {
    return fail('安装命令为空');
  }

  const lexed = tokenize(input);
  if (!lexed.ok) {
    return lexed;
  }
  const tokens = lexed.tokens;
  if (tokens.length === 1) {
    if (tokens[0].startsWith('-')) {
      return fail('只填选项还不够，请提供 npm 包名、GitHub 地址或完整安装命令');
    }
    return {
      ok: true, spec: tokens[0], profile: '', dir: '', registry: '', saveExact: false,
      command: 'spec',
    };
  }

  const manager = tokens[0];
  if (!MANAGERS.has(manager)) {
    return fail('无法识别安装命令：应以 dsh、pnpm 或 npm 开头，或直接填一个包名 / GitHub 地址');
  }

  let profile = '';
  let dir = '';
  let registry = '';
  let saveExact = false;
  const positional = [];
  let command = '';

  const setProfile = (value) => {
    if (!validProfile(value)) {
      return '--profile 只能是不含路径分隔符的 profile 名';
    }
    if (profile.length > 0 && profile !== value) {
      return '同一命令里出现了两个不同的 --profile';
    }
    profile = value;
    return '';
  };
  const setDir = (value) => {
    if (!value.startsWith('/')) {
      return '--dir 必须是绝对路径（安装入口没有可供相对路径使用的 shell cwd）';
    }
    const normalized = require('node:path').resolve(value);
    if (dir.length > 0 && dir !== normalized) {
      return '同一命令里出现了两个不同的 --dir';
    }
    dir = normalized;
    return '';
  };
  const setRegistry = (value) => {
    const normalized = normalizeRegistry(value);
    if (normalized === null) {
      return '--registry 必须是无账号、无 query/hash 的 HTTPS 地址';
    }
    if (registry.length > 0 && registry !== normalized) {
      return '同一命令里出现了两个不同的 --registry';
    }
    registry = normalized;
    return '';
  };

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith('-')) {
      positional.push(token);
      continue;
    }

    const name = optionName(token);
    const inline = optionValue(token);
    const needsValue = VALUE_OPTIONS.has(name);
    const value = inline.length > 0 ? inline : (needsValue && i + 1 < tokens.length ? tokens[++i] : '');
    if (needsValue && value.length === 0) {
      return fail(`${name} 缺少参数值`);
    }

    let problem = '';
    if (name === '--profile') {
      problem = setProfile(value);
    } else if (name === '--dir' || name === '-C') {
      problem = setDir(value);
    } else if (name === '--registry') {
      problem = setRegistry(value);
    } else if (name === '--save-exact'
      || (name === '--config.save-exact' && inline.toLowerCase() !== 'false')) {
      saveExact = true;
    } else if (!needsValue && !FLAG_OPTIONS.has(name) && !name.startsWith('--config.')) {
      return fail(`不支持的安装选项：${name}`);
    }
    if (problem.length > 0) {
      return fail(problem);
    }
  }

  if (manager === 'dsh') {
    const pluginAt = positional.indexOf('plugin');
    if (pluginAt < 0) {
      return fail('dsh 安装命令必须是 dsh plugin [--profile <name>] add|install <spec>');
    }
    if (pluginAt > 0) {
      return fail(`dsh plugin 前只能出现 --profile，不能出现：${positional.slice(0, pluginAt).join(' ')}`);
    }
    const after = positional.slice(pluginAt + 1);
    const commandAt = after.findIndex((part) => INSTALL_COMMANDS.has(part));
    if (commandAt < 0) {
      return fail('dsh plugin 后需要 add 或 install，例如 dsh plugin --profile ondevice add <spec>');
    }
    if (commandAt > 0) {
      return fail(`dsh plugin 与安装子命令之间不能有参数：${after.slice(0, commandAt).join(' ')}`);
    }
    command = `dsh plugin ${after[0]}`;
    positional.splice(pluginAt, after.length + 1, ...after.slice(commandAt + 1));
  } else {
    const commandAt = positional.findIndex((part) => INSTALL_COMMANDS.has(part));
    if (commandAt < 0) {
      return fail(`${manager} 安装命令需要 add、install 或 i`);
    }
    if (commandAt > 0) {
      return fail(`${manager} 安装子命令前不能有参数：${positional.slice(0, commandAt).join(' ')}`);
    }
    command = `${manager} ${positional[0]}`;
    positional.splice(0, 1);
  }

  if (positional.length === 0) {
    return fail('安装命令没有给出包名或 GitHub 地址');
  }
  if (positional.length > 1) {
    return fail(`安装入口一次只接受一个插件，收到了 ${positional.length} 个：${positional.join(' ')}`);
  }

  return {
    ok: true,
    spec: positional[0],
    profile,
    dir,
    registry,
    saveExact,
    command,
  };
}

module.exports = {
  parseInstallCommand,
  tokenize,
  normalizeRegistry,
};
