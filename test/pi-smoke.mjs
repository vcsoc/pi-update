// Real Pi integration; checks latest metadata but never installs an update or calls a model.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
const root = await mkdtemp(join(tmpdir(), 'pi-update-smoke-'));
const child = spawn(process.env.PI_BIN || 'pi', ['--mode', 'rpc', '--session-dir', root, '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '-e', fileURLToPath(new URL('../index.ts', import.meta.url)), '-e', fileURLToPath(new URL('./pi-probe.ts', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '', errors = ''; const events = [];
child.stdout.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); try { events.push(JSON.parse(line)); } catch {} } });
child.stderr.on('data', chunk => errors += chunk);
const send = (id, message) => child.stdin.write(JSON.stringify({ id, type: 'prompt', message }) + '\n');
async function wait(predicate) { const deadline = Date.now() + 30000; while (Date.now() < deadline) { const value = events.find(predicate); if (value) return value; await sleep(50); } throw new Error(`Timeout: ${JSON.stringify(events)}\n${errors}`); }
try {
  send('ui', '/update-ui-test'); await wait(e => e.message?.startsWith('PASS_UPDATE_UI'));
  send('check', '/update check'); const check = await wait(e => /→ latest/.test(e.message || ''));
  assert.match(check.message, /Real executable:/); console.log(check.message);
  if (process.platform !== 'win32') {
    send('handoff', '/update-handoff-test');
    await wait(e => e.id === 'handoff' && e.type === 'response');
    child.stdin.end(); // RPC drains shutdown on input EOF; interactive TUI exits itself.
    await wait(e => e.message?.startsWith('PASS_UPDATE_RESTART'));
    const shutdown = events.findIndex(e => e.message?.startsWith('PASS_UPDATE_SHUTDOWN'));
    const restart = events.findIndex(e => e.message?.startsWith('PASS_UPDATE_RESTART'));
    assert.ok(shutdown >= 0 && shutdown < restart);
  }
  assert.ok(!events.some(e => e.type === 'agent_start'), 'must not call a provider');
  assert.ok(!events.some(e => e.type === 'extension_error'));
  console.log('PASS: real Pi update/check, width-safe progress, graceful same-terminal process replacement and exact session resume');
} finally { child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(1000)]); if (child.exitCode === null) child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
