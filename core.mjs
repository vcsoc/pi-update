import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile, open, rename, rm, chmod, access } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute, delimiter } from 'node:path';
import { homedir } from 'node:os';
import * as tar from 'tar';
import { unzipSync } from 'fflate';

const REPO = 'earendil-works/pi'; // canonical repository; pi-mono now redirects here
export const HOME = resolve(process.env.PI_UPDATE_HOME || join(homedir(), '.pi', 'update'));
export const PACKAGE = '@earendil-works/pi-coding-agent';
const MAX_ARCHIVE = 250 * 1024 * 1024, MAX_UNPACKED = 800 * 1024 * 1024;
const clean = value => String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
export function version(value) { const match = String(value).trim().match(/^v?(\d+\.\d+\.\d+)$/); if (!match) throw new Error(`Invalid stable Pi version: ${clean(value)}`); return match[1]; }
export function compare(a, b) { const x = version(a).split('.').map(Number), y = version(b).split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]); return 0; }
export function commandPath(name, env = process.env) {
  for (const directory of (env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const ext of process.platform === 'win32' ? ['', '.exe', '.cmd'] : ['']) {
      const path = join(directory, name + ext);
      try { if (existsSync(path)) return realpathSync(path); } catch {}
    }
  }
  return null;
}
export function inspectInstallation(execPath = process.execPath, argv = process.argv) {
  // Bun puts /$bunfs/root/pi in argv[1]. It is not the installed executable.
  if (execPath.includes('$bunfs')) throw new Error('Cannot update a Bun virtual path. Resolve process.execPath or use the update launcher.');
  const executable = realpathSync(execPath);
  if (executable.includes('/$bunfs/') || executable.includes('\\$bunfs\\')) throw new Error('Could not resolve the real Pi executable. Run through the update launcher.');
  const normalized = executable.replaceAll('\\', '/');
  if (/\/mise\/installs\/pi\//.test(normalized)) {
    const packageRoot = dirname(executable);
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    return { kind: 'mise', executable, args: [], current: version(manifest.version) };
  }
  let entry = argv[1];
  if (entry && !entry.includes('$bunfs') && existsSync(entry)) {
    entry = realpathSync(entry); let folder = dirname(entry);
    for (let i = 0; i < 6; i++, folder = dirname(folder)) {
      try {
        const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'));
        if (manifest.name === PACKAGE) return { kind: 'npm', executable, args: [entry], packageRoot: folder, current: version(manifest.version) };
      } catch {}
    }
  }
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(executable), 'package.json'), 'utf8'));
    if (manifest.name === PACKAGE) return { kind: 'standalone', executable, args: [], current: version(manifest.version) };
  } catch {}
  throw new Error('Unrecognized Pi installation. Refusing to update an unrelated executable.');
}
export function run(file, args, { cwd, signal, onLine = () => {}, timeout = 600000, env = process.env } = {}) {
  return new Promise((resolvePromise, reject) => {
    // npm.cmd is a script on Windows; launch npm's JS entry via node when possible.
    if (process.platform === 'win32' && /npm\.cmd$/i.test(file)) {
      const cli = join(dirname(file), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (!existsSync(cli)) return reject(new Error('Cannot locate npm-cli.js; use the standalone updater instead.'));
      args = [cli, ...args]; file = commandPath('node') || 'node';
    }
    const child = spawn(file, args, { cwd, env, signal, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '', pending = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${file} timed out`)); }, timeout);
    const receive = chunk => {
      const value = chunk.toString(); output = (output + value).slice(-16000); pending += value;
      const lines = pending.split(/[\r\n]/); pending = lines.pop() || '';
      if (pending.length > 2000) { onLine(clean(pending.slice(-1000))); pending = ''; }
      for (const line of lines) if (clean(line)) onLine(clean(line).slice(-1000));
    };
    child.stdout.on('data', receive); child.stderr.on('data', receive);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); if (pending.trim()) onLine(clean(pending).slice(-1000)); if (code === 0) resolvePromise(clean(output)); else reject(new Error(`${file} exited ${code}: ${clean(output).slice(-1500)}`)); });
  });
}
export async function latestRelease({ signal, fetcher = fetch } = {}) {
  const response = await fetcher(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'pi-update-extension/0.1' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`GitHub release lookup failed (${response.status}). Check connectivity or GitHub rate limits; your installation is unchanged.`);
  const release = await response.json();
  if (release.draft || release.prerelease) throw new Error('Refusing a draft or prerelease');
  version(release.tag_name);
  return release;
}
export function selectAsset(release, platform = process.platform, arch = process.arch) {
  const os = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[platform];
  if (!os || !['x64', 'arm64'].includes(arch)) throw new Error(`No supported Pi release for ${platform}/${arch}`);
  const name = `pi-${os}-${arch}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
  const asset = release.assets?.find(a => a.name === name);
  if (!asset || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest || '')) throw new Error(`Release is missing ${name} or its SHA-256 digest. Refusing an unverified download.`);
  if (![REPO, 'earendil-works/pi-mono'].some(repo => asset.browser_download_url === `https://github.com/${repo}/releases/download/${release.tag_name}/${name}`)) throw new Error('Unexpected release download URL');
  if (!Number.isInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ARCHIVE) throw new Error('Invalid release archive size');
  return asset;
}
export function safeEntry(name) {
  if (!name || name.includes('\\') || name.includes('\0') || isAbsolute(name) || name.includes(':') || name.split('/').includes('..')) throw new Error(`Unsafe archive path: ${name}`);
  const normalized = name.replace(/^\.\//, '');
  if (normalized !== 'pi' && !normalized.startsWith('pi/')) throw new Error(`Unexpected archive root: ${name}`);
  return normalized;
}
export async function extractArchive(file, target) {
  let total = 0, entries = 0;
  const check = (name, size) => { safeEntry(name); total += size; if (++entries > 30000 || total > MAX_UNPACKED) throw new Error('Release archive exceeds extraction limits'); };
  if (file.endsWith('.zip')) {
    const files = unzipSync(await readFile(file), { filter: entry => { check(entry.name, entry.originalSize); return true; } });
    for (const [name, data] of Object.entries(files)) {
      const output = join(target, safeEntry(name));
      if (name.endsWith('/')) await mkdir(output, { recursive: true });
      else { await mkdir(dirname(output), { recursive: true }); await writeFile(output, data, { flag: 'wx', mode: 0o600 }); }
    }
  } else {
    let invalid;
    await tar.t({ file, onReadEntry(entry) {
      try { check(entry.path, entry.size); if (!['File', 'Directory'].includes(entry.type)) throw new Error(`Unsupported archive entry type: ${entry.type}`); }
      catch (error) { invalid = error; }
    } });
    if (invalid) throw invalid;
    await tar.x({ file, cwd: target, strict: true, preservePaths: false, noChmod: false, filter: (_name, entry) => ['File', 'Directory'].includes(entry.type) });
  }
}
export async function download(asset, destination, { signal, emit = () => {}, fetcher = fetch } = {}) {
  const response = await fetcher(asset.browser_download_url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000) });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`);
  const hash = createHash('sha256'), file = await open(destination, 'wx', 0o600);
  let received = 0;
  try {
    for await (const chunk of response.body) {
      signal?.throwIfAborted(); received += chunk.length;
      if (received > asset.size || received > MAX_ARCHIVE) throw new Error('Download exceeds expected size');
      hash.update(chunk); await file.writeFile(chunk);
      emit({ phase: 'Downloading release', detail: `${(received / 1048576).toFixed(1)} / ${(asset.size / 1048576).toFixed(1)} MiB`, percent: 15 + 55 * received / asset.size });
    }
  } finally { await file.close(); }
  if (received !== asset.size || hash.digest('hex') !== asset.digest.slice(7).toLowerCase()) throw new Error('Release checksum/size mismatch. Download rejected; the old installation was not replaced.');
}
export async function verify(runtime, expected, runner = run) {
  const actual = await runner(runtime.executable, [...(runtime.args || []), '--version'], { timeout: 30000, env: { ...process.env, PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' } });
  if (version(actual) !== version(expected)) throw new Error(`Installed Pi reports ${actual}, expected ${expected}`);
}
export async function acquireLock(home = HOME) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = join(home, 'update.lock');
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Another update is running, or a previous update crashed. Inspect ${path} before removing a stale lock.`); throw error; }
  await file.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); await file.close();
  return () => rm(path, { force: true });
}
export async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export async function installPortable(release, { home = HOME, signal, emit = () => {}, runner = run, fetcher = fetch } = {}) {
  const targetVersion = version(release.tag_name), asset = selectAsset(release);
  const releases = join(home, 'releases'); await mkdir(releases, { recursive: true, mode: 0o700 });
  const target = join(releases, `${targetVersion}-${process.platform}-${process.arch}`);
  const runtime = { executable: join(target, 'pi', process.platform === 'win32' ? 'pi.exe' : 'pi'), args: [], version: targetVersion, kind: 'portable' };
  if (existsSync(target)) { await verify(runtime, targetVersion, runner); return runtime; }
  const stage = join(releases, `.stage-${randomUUID()}`); await mkdir(stage, { mode: 0o700 });
  try {
    const archive = join(stage, asset.name);
    await download(asset, archive, { signal, emit, fetcher });
    signal?.throwIfAborted(); emit({ phase: 'Verifying and extracting', detail: 'SHA-256 matched the official release metadata', percent: 74 });
    const unpack = join(stage, 'unpack'); await mkdir(unpack);
    await extractArchive(archive, unpack);
    const binary = join(unpack, 'pi', process.platform === 'win32' ? 'pi.exe' : 'pi');
    await chmod(binary, 0o755);
    await verify({ executable: binary, args: [] }, targetVersion, runner);
    signal?.throwIfAborted();
    await rename(unpack, target);
    return runtime;
  } finally { await rm(stage, { recursive: true, force: true }); }
}
export async function performUpdate({ installation, release, home = HOME, signal, emit = () => {}, runner = run, findCommand = commandPath, portable = false, extensions = false, fetcher = fetch }) {
  const unlock = await acquireLock(home);
  try {
    const targetVersion = version(release.tag_name);
    if (compare(targetVersion, installation.current) < 0) throw new Error('Installed Pi is newer than the latest stable release; refusing a downgrade.');
    if (compare(targetVersion, installation.current) === 0 && !extensions) return { changed: false, runtime: { ...installation, version: installation.current } };
    signal?.throwIfAborted();
    let runtime, fallback;
    if (!portable && installation.kind === 'mise' && compare(targetVersion, installation.current) > 0) {
      const mise = findCommand('mise');
      if (!mise) throw new Error('Pi is managed by mise but mise is not on PATH. Restore mise or explicitly use /update --portable.');
      emit({ phase: 'Installing through mise', detail: `pi@${targetVersion}; keeping the old installation`, percent: null, safeToCancel: false });
      await runner(mise, ['install', `pi@${targetVersion}`], { onLine: detail => emit({ detail }), env: { ...process.env, MISE_YES: '1' } });
      const directory = await runner(mise, ['where', `pi@${targetVersion}`], { timeout: 30000 });
      if (!isAbsolute(directory)) throw new Error('mise returned an invalid install path');
      runtime = { executable: join(directory, 'pi', process.platform === 'win32' ? 'pi.exe' : 'pi'), args: [], version: targetVersion, kind: 'mise' };
      await verify(runtime, targetVersion, runner);
      try { await runner(mise, ['reshim'], { timeout: 30000 }); } catch (error) { fallback = `Installed successfully; mise reshim needs attention: ${error.message}`; }
    } else if (!portable && installation.kind === 'npm' && compare(targetVersion, installation.current) > 0) {
      const npm = findCommand('npm'); if (!npm) throw new Error('npm is not on PATH; use /update --portable instead.');
      const globalRoot = await runner(npm, ['root', '-g'], { timeout: 30000 });
      if (realpathSync(join(globalRoot, '@earendil-works', 'pi-coding-agent')) !== installation.packageRoot) throw new Error('This is not the active global npm installation. Use /update --portable; refusing to update a different npm prefix.');
      emit({ phase: 'Installing through npm', detail: `${PACKAGE}@${targetVersion} (dependency scripts disabled)`, percent: null, safeToCancel: false });
      await runner(npm, ['install', '-g', '--ignore-scripts', `${PACKAGE}@${targetVersion}`], { onLine: detail => emit({ detail }) });
      runtime = { executable: installation.executable, args: installation.args, version: targetVersion, kind: 'npm' };
    } else if (compare(targetVersion, installation.current) === 0) runtime = { ...installation, version: installation.current };
    else runtime = await installPortable(release, { home, signal, emit, runner, fetcher });
    emit({ phase: 'Verifying installed runtime', detail: runtime.executable, percent: 88, safeToCancel: true });
    signal?.throwIfAborted(); await verify(runtime, targetVersion, runner);
    let extensionError;
    if (extensions) {
      emit({ phase: 'Updating configured Pi packages', detail: 'Local unpackaged extension folders are not fetched or overwritten', percent: 92, safeToCancel: false });
      try { await runner(runtime.executable, [...runtime.args, 'update', '--extensions'], { onLine: detail => emit({ detail }) }); }
      catch (error) { extensionError = error.message; }
    }
    signal?.throwIfAborted();
    const activePath = join(home, 'active.json');
    let previous; try { previous = JSON.parse(await readFile(activePath, 'utf8')); } catch {}
    await atomicJson(activePath, { ...runtime, previous: previous ? { executable: previous.executable, args: previous.args, version: previous.version } : { executable: installation.executable, args: installation.args, version: installation.current }, activatedAt: new Date().toISOString() });
    emit({ phase: 'Update ready', detail: `Pi ${targetVersion} verified. ${extensions ? 'Package update finished.' : 'Extensions left unchanged (use --extensions to opt in).'}`, percent: 100, safeToCancel: true });
    return { changed: compare(targetVersion, installation.current) > 0, runtime, warning: [fallback, extensionError && `Pi updated, but package update failed: ${extensionError}`].filter(Boolean).join('\n') };
  } finally { await unlock(); }
}
