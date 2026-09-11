const fs = require('node:fs');
const path = require('node:path');
const root = 'entry/src/main/resources/rawfile/dsh/node_modules';
const J = (p) => path.join(root, p);
const has = (p, needle) => {
  if (!fs.existsSync(p)) return { ok: false, why: 'NOFILE' };
  const c = fs.readFileSync(p, 'utf-8');
  return { ok: c.includes(needle), why: c.includes(needle) ? '' : 'MARKER_MISSING' };
};
const checks = [];
function chk(n, p, needle) { checks.push({ n, p, needle }); }
chk('base-mode-danger', J('@deepseek-ai/dsh-base/cordis.patch.yml'), "mode: !!js process.env.DSH_PERMISSION_MODE ?? 'danger-full-access'");
chk('base-approval-never', J('@deepseek-ai/dsh-base/cordis.patch.yml'), "(process.env.DSH_PERMISSION_MODE ?? 'danger-full-access') === 'danger-full-access' ? 'never' : 'ask'");
for (const p of ['dsh-shell','dsh-bash-local','dsh-sandbox','dsh-sandbox-policy']) chk('peer-'+p, J('@deepseek-ai/'+p+'/package.json'), '');
chk('bash-local-getter', J('@deepseek-ai/dsh-bash-local/lib/index.js'), 'return "danger-full-access"');
const ab = J('@deepseek-ai/dsh-app-boot/lib/index.js');
chk('app-boot-barrel', ab, 'PROFILE_TEMPLATES =');
chk('app-boot-web-bundle', ab, 'dshmarket');
chk('app-boot-config-editor', ab, 'dshm-config-editor');
chk('app-boot-profile-filter', ab, 'ui-settings-ohos');
chk('app-boot-activation', ab, '[DSHM] app-boot activation degraded');
chk('app-boot-ensureSymlink', ab, 'DSHM 鸿蒙适配');
chk('run-node-version', J('@deepseek-ai/dsh-code-runtime-worker-thread/lib/index.js'), 'transpileModule');
chk('spill-tmpdir', J('@deepseek-ai/dsh-spill-local/lib/index.js'), 'DSHM 鸿蒙适配');
chk('subprocess-tmpdir', J('@deepseek-ai/dsh-subprocess-local/lib/index.js'), 'DSHM 鸿蒙适配');
chk('fs-search-fallback', J('@deepseek-ai/dsh-tool-fs-search/lib/index.js'), 'DSHM 鸿蒙适配');
const plugDir = J('@deepseek-ai/dsh/lib');
let plugPath='';
if (fs.existsSync(plugDir)) { const e=fs.readdirSync(plugDir).find(f=>f.startsWith('plugin-')&&f.endsWith('.js')); if(e) plugPath=path.join(plugDir,e); }
chk('dsh-plugin-bridge', plugPath||'NOMATCH', 'DSHM 鸿蒙适配：主进程');
chk('dshmarket-bridge', J('dshmarket/lib/dsh-cli.js'), 'DSHM 鸿蒙适配：dshmarket Worker CLI bridge');
chk('fetch-shim', J('@deepseek-ai/dsh/lib/_fetch-shim.cjs'), 'WebAssembly stub installed early');
chk('pi-ai-manifest', J('@earendil-works/pi-ai/dist/providers/data/manifest.json'), '"schemaVersion"');
let fail=0;
let ver='?';
try{ ver=JSON.parse(fs.readFileSync(J('@deepseek-ai/dsh/package.json'),'utf-8')).version; }catch{}
console.log('PATCH LANDING AUDIT @', ver, '\n');
for(const c of checks){ const r=has(c.p,c.needle); if(!r.ok) fail++; console.log((r.ok?'PASS':'FAIL')+'  '+c.n+(r.ok?'':'  ['+r.why+'] '+c.p)); }
console.log(`\n${checks.length-fail}/${checks.length} passed.`);
process.exit(0);