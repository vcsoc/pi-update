#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOME, atomicJson, commandPath, inspectInstallation, latestRelease, performUpdate, version } from './core.mjs';

export async function installLauncher(installation, home = HOME) {
  const node = commandPath('node');
  if (!node) throw new Error('Node.js is required for the cross-platform restart launcher.');
  await mkdir(join(home, 'bin'), { recursive: true, mode: 0o700 });
  await atomicJson(join(home, 'bootstrap.json'), { executable: installation.executable, args: installation.args });
  const script = fileURLToPath(import.meta.url);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const unix = `#!/bin/sh\nexec ${quote(node)} ${quote(script)} "$@"\n`;
  const batchQuote = value => value.replaceAll('%', '%%');
  if ([node, script].some(value => /[\r\n"]/.test(value))) throw new Error('Launcher path contains unsupported characters');
  await writeFile(join(home, 'bin', 'pi'), unix, { mode: 0o755 });
  await writeFile(join(home, 'bin', 'pi.cmd'), `@echo off\r\n"${batchQuote(node)}" "${batchQuote(script)}" %*\r\n`, { mode: 0o600 });
  return join(home, 'bin');
}
async function selectedRuntime() {
  for (const file of ['active.json', 'bootstrap.json']) {
    try { const runtime = JSON.parse(await readFile(join(HOME, file), 'utf8')); if (existsSync(runtime.executable)) return runtime; } catch {}
  }
  throw new Error('No update launcher configuration. Run /update launcher inside Pi first.');
}
async function shellUpdate(runtime, options) {
  const installation = inspectInstallation(runtime.executable, [runtime.executable, runtime.args?.[0] || '/$bunfs/root/pi']);
  let status = 'Checking latest release…', percent = null, frame = 0;
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Update cancelled; any active installer will finish safely.'));
  process.on('SIGINT', cancel);
  const tick = () => {
    if (!process.stdout.isTTY) return;
    const width = Math.max(1, (process.stdout.columns || 80) - 1);
    // ASCII makes the standalone launcher width-safe without loading Pi's TUI.
    const text = `${'|/-\\'[frame++ % 4]} Pi update ${percent === null ? '' : `${Math.round(percent)}% `}${status.replace(/[^\x20-\x7e]/g, '?')}`;
    process.stdout.write('\r\x1b[2K' + text.slice(0, width));
  };
  const timer = setInterval(tick, 100);
  let lastPhase = '', lastNotice = 0;
  const emit = event => {
    if (event.percent !== undefined) percent = event.percent;
    status = [event.phase, event.detail].filter(Boolean).join(' — ');
    if (!process.stdout.isTTY && event.phase && (event.phase !== lastPhase || Date.now() - lastNotice > 1000)) { lastPhase = event.phase; lastNotice = Date.now(); console.log(status); }
  };
  try {
    const release = await latestRelease({ signal: controller.signal });
    console.log(`\nPi ${installation.current} → ${version(release.tag_name)}`);
    if (options.includes('--check')) return;
    const result = await performUpdate({ installation, release, signal: controller.signal, emit, portable: options.includes('--portable'), extensions: options.includes('--all') });
    console.log(`\n${result.changed ? 'Updated' : 'Already current'}: Pi ${result.runtime.version}. ${result.warning || ''}`);
  } finally { clearInterval(timer); process.off('SIGINT', cancel); if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K'); }
}
export async function main(args = process.argv.slice(2)) {
  let runtime = await selectedRuntime();
  if (args[0] === 'update' && args.slice(1).every(arg => ['--self', '--all', '--check', '--portable'].includes(arg))) return shellUpdate(runtime, args.slice(1));
  await mkdir(HOME, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(HOME, 'launch-'));
  const restartFile = join(directory, 'restart.json'), token = randomBytes(32).toString('hex');
  let cwd = process.cwd(), launchArgs = [...(runtime.args || []), ...args];
  try {
    while (true) {
      const child = spawn(runtime.executable, launchArgs, { cwd, env: { ...process.env, PI_UPDATE_RESTART_FILE: restartFile, PI_UPDATE_LAUNCHER_TOKEN: token }, stdio: 'inherit', windowsHide: false });
      // The foreground Pi also receives terminal Ctrl+C. Keep the supervisor alive
      // while Pi decides whether this is abort, clear-editor, or quit.
      const ignore = () => {};
      let terminating = false;
      const terminate = () => { terminating = true; child.kill('SIGTERM'); };
      process.on('SIGINT', ignore); process.on('SIGTERM', terminate); process.on('SIGHUP', terminate);
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))); }).finally(() => { process.off('SIGINT', ignore); process.off('SIGTERM', terminate); process.off('SIGHUP', terminate); });
      if (terminating) { process.exitCode = code; break; }
      let plan;
      try { plan = JSON.parse(await readFile(restartFile, 'utf8')); } catch { process.exitCode = code; break; }
      await rm(restartFile, { force: true });
      const selected = await selectedRuntime();
      if (plan.token !== token || plan.executable !== selected.executable || !Array.isArray(plan.args) || plan.args.some(arg => typeof arg !== 'string') || typeof plan.cwd !== 'string') throw new Error('Invalid restart handoff; refusing to launch');
      runtime = selected; launchArgs = plan.args; cwd = plan.cwd;
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(`Pi update: ${error.message}`); process.exitCode = 1; });
