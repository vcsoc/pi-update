import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
test('standalone package exposes one /update entrypoint and pinned extraction dependencies', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
  assert.equal(manifest.name, 'pi-update');
  assert.equal(manifest.repository.url, 'https://github.com/vcsoc/pi-update.git');
  assert.ok(manifest.keywords.includes('pi-package'));
  assert.deepEqual(manifest.pi.extensions, ['./index.ts']);
  assert.deepEqual(manifest.dependencies, { fflate: '0.8.3', tar: '7.5.22' });
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].name, manifest.name);
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
  for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui']) {
    assert.equal(manifest.peerDependencies[name], '*');
    assert.equal(manifest.dependencies[name], undefined);
    assert.equal(manifest.peerDependenciesMeta[name].optional, true);
  }
  for (const path of ['index.ts', 'ui.ts', 'core.mjs', 'restart.mjs', 'launcher.mjs', 'README.md']) {
    await access(new URL(path, root));
    assert.ok(manifest.files.includes(path) || path.endsWith('.mjs') && manifest.files.includes('*.mjs'));
  }
});
