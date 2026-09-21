import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { matchesKey } from '@earendil-works/pi-tui';
import { inspectInstallation, latestRelease, performUpdate, version } from './core.mjs';
import { canRestart, restartArguments, armRestart, persistUnflushedSession } from './restart.mjs';
import { installLauncher } from './launcher.mjs';
import { renderProgress, type ProgressState } from './ui.ts';

export default function updateExtension(pi: ExtensionAPI) {
  let busy = false, generation = 0;
  let controller: AbortController | undefined;

  async function withProgress<T>(ctx: ExtensionCommandContext, work: (emit: (event: any) => void, signal: AbortSignal) => Promise<T>): Promise<T> {
    controller = new AbortController();
    const active = controller, epoch = generation;
    const state: ProgressState = { phase: 'Checking Pi installation', detail: 'Resolving the real executable, not Bun’s virtual bundle path', percent: null, safeToCancel: true, started: Date.now(), cancelled: false, logs: [] };
    const emit = (event: any) => {
      if (epoch !== generation) return;
      Object.assign(state, event);
      if (event.detail && state.logs.at(-1) !== event.detail) state.logs = [...state.logs.slice(-2), event.detail];
    };
    try {
      if (ctx.mode !== 'tui') {
        let lastPhase = '', lastNotice = 0;
        return await work(event => {
          emit(event);
          if (event.phase && (event.phase !== lastPhase || Date.now() - lastNotice > 1000)) {
            lastPhase = event.phase; lastNotice = Date.now();
            ctx.ui.notify(`${event.phase}: ${event.detail || ''}`, 'info');
          }
        }, active.signal);
      }
      const result = await ctx.ui.custom<{ value?: T; error?: unknown }>((tui, theme, _keys, done) => {
        let tick = 0, disposed = false;
        const timer = setInterval(() => { tick++; if (!disposed) tui.requestRender(); }, 80);
        const dispose = () => { disposed = true; clearInterval(timer); };
        work(emit, active.signal).then(value => { if (!disposed) { dispose(); done({ value }); } }, error => { if (!disposed) { dispose(); done({ error }); } });
        return {
          render: (width: number) => renderProgress(state, width, theme, tick),
          invalidate() {}, dispose,
          handleInput(data: string) {
            if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
              state.cancelled = true;
              active.abort(new Error(state.safeToCancel ? 'Update cancelled.' : 'Restart cancelled. The active installer was allowed to finish safely.'));
              tui.requestRender();
            }
          },
        };
      });
      if (!result) throw new Error('Update UI closed.');
      if (result.error) throw result.error;
      return result.value as T;
    } finally { if (controller === active) controller = undefined; }
  }

  pi.registerCommand('update', {
    description: 'Update Pi with animated progress and safe session restart; /update check is read-only',
    getArgumentCompletions: prefix => ['check', 'help', 'launcher', '--extensions', '--portable', '--no-restart'].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/).filter(Boolean);
      if (words.includes('help')) return ctx.ui.notify('/update updates Pi and restarts this saved session. /update check is read-only. --extensions also updates configured Pi packages; --portable uses a private verified release; --no-restart keeps this process running. /update launcher creates an optional shell launcher for pi update and Windows restart.', 'info');
      if (words.some(word => !['check', 'launcher', '--extensions', '--portable', '--no-restart'].includes(word))) return ctx.ui.notify('Usage: /update [check|launcher] [--extensions] [--portable] [--no-restart]', 'warning');
      if (busy) return ctx.ui.notify('An update is already running.', 'warning');
      if (!ctx.isIdle()) return ctx.ui.notify('Wait for the current agent turn to finish before updating Pi.', 'warning');
      busy = true;
      const epoch = generation;
      try {
        const installation = inspectInstallation();
        if (words.includes('launcher')) {
          const directory = await installLauncher(installation);
          return ctx.ui.notify(`Created Pi launcher in ${directory}. Put that directory FIRST on PATH (ahead of mise), then restart your shell. The launcher fixes shell “pi update” and enables supervised restart on Windows. Your existing launchers were not changed.`, 'info');
        }
        const checkOnly = words.includes('check'), noRestart = words.includes('--no-restart');
        // Validate handoff BEFORE changing the installation. Never lose an ephemeral session.
        const shouldRestart = !checkOnly && !noRestart;
        let restartArgs: string[] | undefined;
        if (shouldRestart) {
          if (ctx.mode !== 'tui') throw new Error('Automatic restart is for interactive Pi. In RPC/print mode use /update --no-restart and let the host restart Pi.');
          if (!canRestart()) throw new Error('Automatic restart requires the update launcher on this platform. Run /update launcher and start Pi through it, or use /update --no-restart.');
          restartArgs = restartArguments(process.argv.slice(2), await persistUnflushedSession(ctx.sessionManager), { provider: ctx.model?.provider, model: ctx.model?.id, thinking: pi.getThinkingLevel() });
          if (ctx.ui.getEditorText().trim()) throw new Error('Save or clear your unsent editor draft before restarting, or use --no-restart.');
          if (ctx.hasPendingMessages()) throw new Error('Pi has queued messages. Let them finish before updating.');
        }
        const release = await withProgress(ctx, async (emit, signal) => {
          emit({ phase: 'Checking latest stable release', detail: `Installed: ${installation.current} (${installation.kind}) · ${installation.executable}` });
          return latestRelease({ signal });
        });
        if (epoch !== generation) return;
        if (checkOnly) return ctx.ui.notify(`Pi ${installation.current} → latest ${version(release.tag_name)}. Installation: ${installation.kind}. Real executable: ${installation.executable}.`, 'info');
        const target = version(release.tag_name);
        if (target === installation.current && !words.includes('--extensions')) return ctx.ui.notify(`Pi ${target} is already the latest stable release. Nothing changed.`, 'info');
        if (ctx.hasUI && !await ctx.ui.confirm('Update Pi', `${installation.current} → ${target}\n${words.includes('--portable') ? 'Private side-by-side release; existing installation is retained.' : `Installation: ${installation.kind}.`}\n${noRestart ? 'The running process will NOT restart.' : 'Pi will shut down cleanly and resume this saved session. Send/save any companion drafts (such as Annotate) first.'}\n${words.includes('--extensions') ? 'Also update configured Pi packages.' : 'Extensions stay unchanged.'}`)) return;
        const result = await withProgress(ctx, (emit, signal) => performUpdate({ installation, release, signal, emit, portable: words.includes('--portable'), extensions: words.includes('--extensions') }));
        if (epoch !== generation) return;
        if (result.warning) ctx.ui.notify(result.warning, 'warning');
        if (noRestart) return ctx.ui.notify(`Pi ${result.runtime.version} is installed and verified. This process still runs ${installation.current}; restart it to load the new harness. ${result.runtime.executable}`, 'info');
        if (!result.changed) { await ctx.reload(); return; }
        if (!ctx.isIdle() || ctx.hasPendingMessages() || ctx.ui.getEditorText().trim()) return ctx.ui.notify('Pi updated, but new activity arrived during the update. Automatic restart was skipped to preserve your work; restart manually when idle.', 'warning');
        await armRestart(result.runtime, restartArgs!, ctx.cwd);
        ctx.ui.notify(`Pi ${result.runtime.version} verified. Restarting and resuming this session…`, 'info');
        ctx.shutdown();
      } catch (error) { if (epoch === generation) ctx.ui.notify(error instanceof Error ? error.message : String(error), 'warning'); }
      finally { busy = false; }
    },
  });
  pi.on('session_shutdown', () => { generation++; controller?.abort(new Error('Session closed; update restart cancelled.')); });
}
