import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import { zipSync } from 'fflate';
import { inspectInstallation, version, compare, selectAsset, safeEntry, latestRelease, download, extractArchive, acquireLock, performUpdate } from '../core.mjs';
import { restartArguments, canRestart, armRestart } from '../restart.mjs';

const release = tag => ({ tag_name: `v${tag}`, assets: ['linux-x64.tar.gz', 'linux-arm64.tar.gz', 'darwin-x64.tar.gz', 'darwin-arm64.tar.gz', 'windows-x64.zip', 'windows-arm64.zip'].map(suffix => ({ name: `pi-${suffix}`, digest: 'sha256:' + 'a'.repeat(64), size: 100, browser_download_url: `https://github.com/earendil-works/pi-mono/releases/download/v${tag}/pi-${suffix}` })) });
async function temp(t) { const root = await mkdtemp(join(tmpdir(), 'pi-update-test-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('compiled Bun virtual argv is ignored in favor of the actual mise executable', async t => {
  const root = await temp(t), folder = join(root, 'mise', 'installs', 'pi', '1.2.3', 'pi'); await mkdir(folder, { recursive: true });
  const binary = join(folder, 'pi'); await writeFile(binary, 'test'); await writeFile(join(folder, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.2.3' }));
  const info = inspectInstallation(binary, ['bun', '/$bunfs/root/pi']);
  assert.equal(info.kind, 'mise'); assert.equal(info.executable, realpathSync(binary)); assert.equal(info.current, '1.2.3');
});
test('Volta installation is detected from its package image', async t => {
  const root = await temp(t), folder = join(root, 'tools/image/packages', '@earendil-works/pi-coding-agent/lib/node_modules', '@earendil-works/pi-coding-agent');
  await mkdir(folder, { recursive: true });
  const entry = join(folder, 'cli.js'); await writeFile(entry, '');
  await writeFile(join(folder, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.0' }));
  const info = inspectInstallation(process.execPath, ['node', entry]);
  assert.equal(info.kind, 'volta'); assert.equal(info.voltaHome, realpathSync(root));
});
test('Volta update installs exact release and verifies before activation', async t => {
  const root = await temp(t), calls = [];
  const result = await performUpdate({ installation: { kind: 'volta', voltaHome: root, executable: process.execPath, args: ['/old/pi'], current: '1.0.0' }, release: release('1.1.0'), home: root, findCommand: name => { assert.equal(name, 'volta'); return '/volta'; }, runner: async (file, args, options) => {
    calls.push([file, ...args]);
    if (file === '/volta') { assert.equal(options.env.VOLTA_HOME, root); assert.equal(options.cwd, root); }
    if (args[0] === 'which') return join(root, 'pi.js');
    return args.includes('--version') ? '1.1.0' : '';
  } });
  assert.deepEqual(calls[0], ['/volta', 'install', '@earendil-works/pi-coding-agent@1.1.0']);
  assert.equal(result.runtime.kind, 'volta');
  assert.deepEqual(result.runtime.args, [join(root, 'pi.js')]);
  assert.equal(JSON.parse(await readFile(join(root, 'active.json'))).version, '1.1.0');
});
test('stable release comparison is numeric and rejects ambiguous/prerelease versions', () => {
  assert.equal(compare('0.9.0', '0.10.0'), -1); assert.equal(version('v0.86.1'), '0.86.1');
  for (const value of ['latest', '0.86.1-beta.1', '0.86.1;rm -rf /']) assert.throws(() => version(value));
});
test('release selection covers six platforms and demands trusted URLs and SHA256 metadata', () => {
  for (const os of ['linux', 'darwin', 'win32']) for (const arch of ['x64', 'arm64']) assert.ok(selectAsset(release('1.2.3'), os, arch));
  assert.throws(() => selectAsset(release('1.2.3'), 'linux', 'ia32'));
  const bad = release('1.2.3'); bad.assets[0].browser_download_url = 'https://evil.test/pi.tar.gz';
  assert.throws(() => selectAsset(bad, 'linux', 'x64'), /URL/);
  bad.assets[0].digest = null; assert.throws(() => selectAsset(bad, 'linux', 'x64'), /SHA-256/);
});
test('release lookup reports rate limiting and does not accept prereleases', async () => {
  await assert.rejects(latestRelease({ fetcher: async () => new Response('', { status: 403 }) }), /rate limits/);
  await assert.rejects(latestRelease({ fetcher: async () => Response.json({ ...release('1.2.3'), prerelease: true }) }), /prerelease/);
});
test('streamed download must match both expected size and SHA256', async t => {
  const root = await temp(t), data = Buffer.from('official release bytes');
  const asset = { browser_download_url: 'https://example.test/fixture', size: data.length, digest: 'sha256:' + createHash('sha256').update(data).digest('hex') };
  const events = [];
  await download(asset, join(root, 'valid'), { fetcher: async () => new Response(data), emit: event => events.push(event) });
  assert.deepEqual(await readFile(join(root, 'valid')), data); assert.equal(events.at(-1).percent, 70);
  await assert.rejects(download({ ...asset, digest: 'sha256:' + '0'.repeat(64) }, join(root, 'bad'), { fetcher: async () => new Response(data) }), /mismatch/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(download(asset, join(root, 'cancelled'), { signal: controller.signal, fetcher: async () => new Response(data) }));
});
test('archive paths cannot escape the release directory', async t => {
  for (const name of ['/tmp/evil', '../evil', 'pi/../../evil', 'C:/evil', 'pi\\..\\evil', 'elsewhere/file']) assert.throws(() => safeEntry(name));
  assert.equal(safeEntry('./pi/docs/readme.md'), 'pi/docs/readme.md');
  const root = await temp(t), file = join(root, 'bad.zip');
  await writeFile(file, zipSync({ '../escape': Buffer.from('no') }));
  await assert.rejects(extractArchive(file, root), /Unsafe/);
});
test('tar extraction rejects links and keeps regular release files', async t => {
  const root = await temp(t), input = join(root, 'input'), output = join(root, 'output');
  await mkdir(join(input, 'pi'), { recursive: true }); await mkdir(output); await writeFile(join(input, 'pi', 'pi'), 'test');
  const good = join(root, 'good.tar.gz'); await tar.c({ gzip: true, file: good, cwd: input }, ['pi']);
  await extractArchive(good, output); assert.equal(await readFile(join(output, 'pi', 'pi'), 'utf8'), 'test');
  if (process.platform !== 'win32') {
    await symlink('/tmp', join(input, 'pi', 'link'));
    const bad = join(root, 'bad.tar.gz'); await tar.c({ gzip: true, file: bad, cwd: input }, ['pi']);
    await assert.rejects(extractArchive(bad, output), /entry type/);
  }
});
test('concurrent updater lock is exclusive and can be released', async t => {
  const root = await temp(t), unlock = await acquireLock(root);
  await assert.rejects(acquireLock(root), /Another update/); await unlock(); await (await acquireLock(root))();
});
test('mise update is scoped, verified, retains old runtime and uses no built-in self-update', async t => {
  const root = await temp(t), commands = [];
  const installation = { kind: 'mise', executable: '/old/pi', args: [], current: '1.0.0' };
  const result = await performUpdate({ installation, release: release('1.1.0'), home: root, findCommand: () => '/mise', runner: async (file, args) => {
    commands.push([file, ...args]);
    if (args[0] === 'where') return root;
    if (args.includes('--version')) return '1.1.0';
    return '';
  } });
  assert.deepEqual(commands[0], ['/mise', 'install', 'pi@1.1.0']);
  assert.ok(!commands.some(cmd => cmd.includes('--self') || cmd.includes('uninstall')));
  assert.equal(result.changed, true);
  const active = JSON.parse(await readFile(join(root, 'active.json')));
  assert.equal(active.version, '1.1.0'); assert.equal(active.previous.executable, '/old/pi');
});
test('verification failure never publishes the new active runtime', async t => {
  const root = await temp(t);
  await assert.rejects(performUpdate({ installation: { kind: 'mise', executable: '/old/pi', args: [], current: '1.0.0' }, release: release('1.1.0'), home: root, findCommand: () => '/mise', runner: async (_file, args) => args[0] === 'where' ? root : args.includes('--version') ? '0.9.0' : '' }), /expected/);
  await assert.rejects(readFile(join(root, 'active.json')), { code: 'ENOENT' });
});
test('extension update failure is reported separately after core verification', async t => {
  const root = await temp(t);
  const result = await performUpdate({ installation: { kind: 'mise', executable: '/current/pi', args: [], current: '1.1.0' }, release: release('1.1.0'), home: root, extensions: true, runner: async (_file, args) => {
    if (args.includes('--extensions')) throw new Error('Package network error');
    return '1.1.0';
  } });
  assert.equal(result.changed, false); assert.match(result.warning, /Package network error/);
  assert.equal(JSON.parse(await readFile(join(root, 'active.json'))).version, '1.1.0');
});
test('npm updates only the matching prefix and disables dependency install scripts', async t => {
  const root = await temp(t), npmRoot = join(root, 'node_modules'), packageRoot = join(npmRoot, '@earendil-works', 'pi-coding-agent');
  await mkdir(packageRoot, { recursive: true }); const calls = [];
  const result = await performUpdate({ installation: { kind: 'npm', executable: '/node', args: [join(packageRoot, 'dist', 'cli.js')], packageRoot, current: '1.0.0' }, release: release('1.1.0'), home: root, findCommand: () => '/npm', runner: async (file, args) => {
    calls.push([file, ...args]); if (args[0] === 'root') return npmRoot; if (args.includes('--version')) return '1.1.0'; return '';
  } });
  assert.equal(result.runtime.kind, 'npm');
  assert.ok(calls.some(args => args.includes('--ignore-scripts') && args.includes('@earendil-works/pi-coding-agent@1.1.0')));
});
test('cancel during a manager install waits for safe completion but skips activation', async t => {
  const root = await temp(t), controller = new AbortController(); let completed = false;
  await assert.rejects(performUpdate({ installation: { kind: 'mise', executable: '/old/pi', args: [], current: '1.0.0' }, release: release('1.1.0'), home: root, signal: controller.signal, findCommand: () => '/mise', runner: async (_file, args, options) => {
    if (args[0] === 'install') { assert.equal(options.signal, undefined); controller.abort(); completed = true; }
    return args[0] === 'where' ? root : args.includes('--version') ? '1.1.0' : '';
  } }));
  assert.equal(completed, true); await assert.rejects(readFile(join(root, 'active.json')));
});
test('restart preserves session and safety flags without replaying prompts', async t => {
  const root = await temp(t), file = join(root, 'session.jsonl'); await writeFile(file, 'session');
  const args = restartArguments(['--no-approve', '--extension', '/safe/ext.ts', '--session', '/old', '--model=x', 'old user prompt', '@private.png'], file, { model: 'new-model' });
  assert.deepEqual(args, ['--no-approve', '--extension', '/safe/ext.ts', '--model=x', '--session', file, '--model', 'new-model']);
  assert.throws(() => restartArguments(['--unknown-safety-option'], file), /Cannot safely replay/);
  assert.throws(() => restartArguments([], null), /saved session/);
});
test('restart uses one process replacement only after graceful exit', async t => {
  const root = await temp(t), exe = join(root, 'pi'); await writeFile(exe, 'test');
  let onExit, executed;
  const runtime = { platform: 'linux', env: { TEST: 'yes' }, once: (event, fn) => { assert.equal(event, 'exit'); onExit = fn; }, execve: (...args) => executed = args, stderr: { write() {} } };
  await armRestart({ executable: exe, args: [] }, ['--session', '/session'], root, runtime);
  assert.equal(executed, undefined); onExit(); assert.deepEqual(executed, [exe, [exe, '--session', '/session'], { TEST: 'yes' }]);
  assert.equal(canRestart({ platform: 'win32', env: {}, execve() {} }), false);
});
