import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const runtimeRoot = path.resolve('entry/src/main/resources/rawfile/dsh');
const appBootPath = path.join(runtimeRoot, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js');
const installAnchor = path.join(runtimeRoot, 'node_modules/@deepseek-ai/dsh/package.json');
const appBoot = await import(pathToFileURL(appBootPath).href);
const home = mkdtempSync(path.join(tmpdir(), 'dshm-profile-managed-'));
const mutablePackages = ['dshmarket', '@dsh-external/dsh-mobile-nav'];

try {
  appBoot.healProfilesModuleFallback(installAnchor, home);
  const fallbackRoot = path.join(home, 'profiles', 'node_modules');
  assert.ok(existsSync(path.join(fallbackRoot, '@earendil-works', 'pi-ai', 'package.json')));
  const fallbackMarker = path.join(home, 'profiles', '.dshm-install-fallback-revision');
  assert.equal(readFileSync(fallbackMarker, 'utf8').trim(), '20260819-50');
  rmSync(path.join(fallbackRoot, '@earendil-works', 'pi-ai'), { recursive: true, force: true });
  writeFileSync(fallbackMarker, 'stale\n', 'utf8');
  appBoot.healProfilesModuleFallback(installAnchor, home);
  assert.ok(existsSync(path.join(fallbackRoot, '@earendil-works', 'pi-ai', 'package.json')));

  const initial = appBoot.loadProfile('test', 'web', installAnchor, home, { userLayer: false });
  const profileDir = appBoot.resolveProfileDir('web', home);
  const manifestPath = path.join(profileDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  assert.equal(manifest.dshm.profileManagedSeed.version, 2);
  for (const packageName of mutablePackages) {
    assert.equal(typeof manifest.dependencies[packageName], 'string');
    assert.ok(manifest.dsh.profile.bundles.includes(packageName));
    assert.ok(existsSync(path.join(profileDir, 'node_modules', packageName, 'package.json')));
    const layer = initial.layers.find((entry) => entry.packageName === packageName);
    assert.equal(layer?.packageDir, path.join(profileDir, 'node_modules', packageName));
  }
  assert.equal(manifest.dshm.profileManagedSeed.dependencyClosureVersion, 2);
  for (const packageName of ['@deepseek-ai/cordis-plugin-include', '@deepseek-ai/cordis-plugin-loader']) {
    assert.ok(existsSync(path.join(profileDir, 'node_modules', packageName, 'package.json')));
  }

  // This mirrors dsh plugin remove: it edits profile dependencies and the
  // corresponding bundle layer. The seed marker must prevent resurrection.
  for (const packageName of mutablePackages) {
    delete manifest.dependencies[packageName];
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((item) => item !== packageName);
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const afterRemoval = appBoot.loadProfile('test', 'web', installAnchor, home, { userLayer: false });
  const removedManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const packageName of mutablePackages) {
    assert.equal(removedManifest.dependencies[packageName], undefined);
    assert.ok(!removedManifest.dsh.profile.bundles.includes(packageName));
    assert.equal(afterRemoval.layers.some((entry) => entry.packageName === packageName), false);
  }

  removedManifest.dsh.profile.bundles.push('webassembly-test-plugin');
  const unsupportedPluginDir = path.join(profileDir, 'node_modules', 'webassembly-test-plugin');
  const unsupportedDependencyDir = path.join(profileDir, 'node_modules', 'ssh2');
  mkdirSync(unsupportedPluginDir, { recursive: true });
  mkdirSync(unsupportedDependencyDir, { recursive: true });
  writeFileSync(path.join(unsupportedPluginDir, 'package.json'), JSON.stringify({
    name: 'webassembly-test-plugin',
    dependencies: { ssh2: '1.0.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } }
  }), 'utf8');
  writeFileSync(path.join(unsupportedPluginDir, 'cordis.patch.yml'), '[]\n', 'utf8');
  writeFileSync(path.join(unsupportedDependencyDir, 'package.json'), JSON.stringify({ name: 'ssh2' }), 'utf8');
  writeFileSync(manifestPath, JSON.stringify(removedManifest, null, 2) + '\n', 'utf8');
  const afterCleanup = appBoot.loadProfile('test', 'web', installAnchor, home, { userLayer: false });
  const cleanupManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.ok(!cleanupManifest.dsh.profile.bundles.includes('webassembly-test-plugin'));
  assert.equal(afterCleanup.layers.some((entry) => entry.packageName === 'webassembly-test-plugin'), false);

  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[{"id":"legacy","config":{"entry":"@deepseek-ai/dsh-client-ui-settings-ohos"}}]\n', 'utf8');
  const filteredLegacyPatch = appBoot.loadProfile('test', 'web', installAnchor, home);
  assert.equal(filteredLegacyPatch.patches.length, 0);
  console.log('profile-managed built-in plugin tests passed');
} finally {
  rmSync(home, { recursive: true, force: true });
}
