import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { atomicJson } from './core.mjs';

const valued = new Set(['--provider', '--model', '--thinking', '--models', '--api-key', '--session-dir', '--tools', '-t', '--exclude-tools', '-xt', '--extension', '-e', '--skill', '--prompt-template', '--theme', '--system-prompt', '--append-system-prompt', '--tui-mode', '--use-theme', '--mode']);
const flags = new Set(['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '-nc', '--no-builtin-tools', '-nbt', '--no-tools', '-nt', '--verbose', '--approve', '-a', '--no-approve', '-na', '--offline']);
const sessionValues = new Set(['--session', '--fork', '--name', '-n']);
const sessionFlags = new Set(['-c', '--continue', '-r', '--resume']);

// Pi may defer its first disk flush until an assistant message exists. Preserve
// the documented JSONL header/entries for a first-command update, never overwrite
// an existing session. Truly ephemeral (--no-session) sessions remain in memory.
export async function persistUnflushedSession(manager) {
  const file = manager.getSessionFile();
  if (!file || existsSync(file)) return file;
  const header = manager.getHeader();
  if (!header || header.type !== 'session') throw new Error('Cannot snapshot the new session safely. Use --no-restart.');
  await mkdir(dirname(file), { recursive: true });
  try { await writeFile(file, [header, ...manager.getEntries()].map(entry => JSON.stringify(entry)).join('\n') + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return file;
}
export function restartArguments(original, sessionFile, selection = {}) {
  if (!sessionFile || !isAbsolute(sessionFile) || !existsSync(sessionFile)) throw new Error('Automatic restart needs a saved session file. Use /update --no-restart for an ephemeral session.');
  const result = [];
  for (let i = 0; i < original.length; i++) {
    const arg = original[i];
    if (arg === '--') break; // Never replay an initial prompt, file attachment or command.
    if (sessionFlags.has(arg)) continue;
    if (sessionValues.has(arg)) { i++; continue; }
    if (arg.startsWith('--session=') || arg.startsWith('--fork=') || arg.startsWith('--name=')) continue;
    if (valued.has(arg)) { if (i + 1 >= original.length) throw new Error(`Missing value for ${arg}`); result.push(arg, original[++i]); continue; }
    if (flags.has(arg)) { result.push(arg); continue; }
    const equal = arg.indexOf('=');
    if (equal > 0 && valued.has(arg.slice(0, equal))) { result.push(arg); continue; }
    if (arg.startsWith('-')) throw new Error(`Cannot safely replay startup option ${arg}. Use /update --no-restart and restart with your original options.`);
    // Ignore positional prompts and @files rather than executing the same request twice.
  }
  result.push('--session', sessionFile);
  if (selection.provider) result.push('--provider', selection.provider);
  if (selection.model) result.push('--model', selection.model);
  if (selection.thinking) result.push('--thinking', selection.thinking);
  return result;
}
export function canRestart(runtime = process) {
  return Boolean(runtime.env.PI_UPDATE_RESTART_FILE && runtime.env.PI_UPDATE_LAUNCHER_TOKEN) || (runtime.platform !== 'win32' && typeof runtime.execve === 'function');
}
export async function armRestart(target, args, cwd, runtime = process) {
  if (!isAbsolute(target.executable) || !existsSync(target.executable)) throw new Error('Verified restart executable is missing');
  if (runtime.env.PI_UPDATE_RESTART_FILE && runtime.env.PI_UPDATE_LAUNCHER_TOKEN) {
    await atomicJson(runtime.env.PI_UPDATE_RESTART_FILE, { executable: target.executable, args: [...(target.args || []), ...args], cwd, token: runtime.env.PI_UPDATE_LAUNCHER_TOKEN });
    return;
  }
  if (!canRestart(runtime)) throw new Error('This runtime cannot replace itself safely. Start Pi through the update launcher for automatic restart, or use --no-restart.');
  const env = Object.fromEntries(Object.entries(runtime.env).filter(([, value]) => typeof value === 'string'));
  runtime.once('exit', () => {
    try { runtime.execve(target.executable, [target.executable, ...(target.args || []), ...args], env); }
    catch (error) { runtime.stderr.write(`\nPi was updated but restart failed: ${error.message}\nResume with: ${JSON.stringify(target.executable)} --session ${JSON.stringify(args[args.indexOf('--session') + 1])}\n`); }
  });
}
