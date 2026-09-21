import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { run } from '../core.mjs';
import { persistUnflushedSession } from '../restart.mjs';

test('supervisor waits for old child exit, validates handoff, then starts replacement', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-update-launcher-')); t.after(() => rm(home, { recursive: true, force: true }));
  const child = join(home, 'fake-pi.mjs'), trace = join(home, 'trace');
  await writeFile(child, `import {appendFileSync,writeFileSync} from 'node:fs';
const trace=${JSON.stringify(trace)};
if(process.argv.includes('--resumed')){appendFileSync(trace,'new-start\\n');}
else {appendFileSync(trace,'old-start\\n');writeFileSync(process.env.PI_UPDATE_RESTART_FILE,JSON.stringify({executable:process.execPath,args:[${JSON.stringify(child)},'--resumed'],cwd:process.cwd(),token:process.env.PI_UPDATE_LAUNCHER_TOKEN}));process.on('exit',()=>appendFileSync(trace,'old-exit\\n'));}
`);
  await writeFile(join(home, 'bootstrap.json'), JSON.stringify({ executable: process.execPath, args: [child] }));
  await run(process.execPath, [fileURLToPath(new URL('../launcher.mjs', import.meta.url))], { env: { ...process.env, PI_UPDATE_HOME: home }, timeout: 15000 });
  assert.equal(await readFile(trace, 'utf8'), 'old-start\nold-exit\nnew-start\n');
});
test('unflushed first-command session snapshot preserves entries and never overwrites', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-update-snapshot-')); t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, 'session.jsonl');
  const manager = { getSessionFile: () => path, getHeader: () => ({ type: 'session', version: 3, id: 'test-session' }), getEntries: () => [{ type: 'custom', id: 'abc12345', parentId: null, customType: 'test' }] };
  assert.equal(await persistUnflushedSession(manager), path);
  const original = await readFile(path, 'utf8'); assert.equal(original.trim().split('\n').length, 2);
  manager.getEntries = () => [];
  await persistUnflushedSession(manager); assert.equal(await readFile(path, 'utf8'), original);
  assert.equal(await persistUnflushedSession({ getSessionFile: () => undefined }), undefined);
});
