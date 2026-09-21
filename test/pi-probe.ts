import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
const trace = (text: string) => { if (process.env.PI_UPDATE_PROBE_TRACE) appendFileSync(process.env.PI_UPDATE_PROBE_TRACE, text + '\n'); };
import { visibleWidth } from '@earendil-works/pi-tui';
import { renderProgress } from '../ui.ts';
import { armRestart, restartArguments, persistUnflushedSession } from '../restart.mjs';

export default function probe(pi: any) {
  pi.registerCommand('update-ui-test', { handler: async (_args: string, ctx: any) => {
    const theme = ctx.ui.theme;
    for (const width of [0, 1, 2, 5, 12, 30, 60, 93, 112, 180]) {
      for (const percent of [null, 0, 15.3, 70, 100]) {
        for (const tick of [0, 1, 7, 101]) {
          const lines = renderProgress({ phase: 'Installing Pi 界🙂'.repeat(8), detail: '/very/long/path '.repeat(50) + '\n\x1b[31mred', percent, safeToCancel: false, started: Date.now() - 2400, cancelled: tick === 7, logs: ['Test\nnewline', '界🙂'.repeat(100), 'Installer is still working'] }, width, theme, tick);
          for (const line of lines) { assert.ok(!line.includes('\n')); assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`); }
        }
      }
    }
    ctx.ui.notify('PASS_UPDATE_UI: animated determinate/indeterminate frames fit all widths including 93 columns', 'info');
  } });
  pi.registerCommand('update-handoff-test', { handler: async (_args: string, ctx: any) => {
    pi.appendEntry('update-test-session', { marker: 'preserve me' });
    const file = await persistUnflushedSession(ctx.sessionManager);
    process.env.PI_UPDATE_PROBE_RESUMED = '1';
    process.env.PI_UPDATE_PROBE_PID = String(process.pid);
    process.env.PI_UPDATE_PROBE_SESSION = ctx.sessionManager.getSessionId();
    await armRestart({ executable: process.execPath, args: [] }, restartArguments(process.argv.slice(2), file), ctx.cwd);
    ctx.shutdown();
  } });
  pi.on('session_start', (_event: any, ctx: any) => {
    if (process.env.PI_UPDATE_PROBE_RESUMED !== '1') return;
    assert.equal(String(process.pid), process.env.PI_UPDATE_PROBE_PID);
    assert.equal(ctx.sessionManager.getSessionId(), process.env.PI_UPDATE_PROBE_SESSION);
    assert.ok(ctx.sessionManager.getEntries().some((entry: any) => entry.type === 'custom' && entry.customType === 'update-test-session'));
    trace('resumed');
    ctx.ui.notify('PASS_UPDATE_RESTART: same PID, same saved session and entries, fresh Pi process', 'info');
    ctx.shutdown();
  });
  pi.on('session_shutdown', (_event: any, ctx: any) => { trace('shutdown'); ctx.ui.notify('PASS_UPDATE_SHUTDOWN: graceful extension cleanup ran', 'info'); });
}
