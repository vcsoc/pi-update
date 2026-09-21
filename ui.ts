import { truncateToWidth } from '@earendil-works/pi-tui';

export interface ProgressState {
  phase: string;
  detail: string;
  percent: number | null;
  safeToCancel: boolean;
  started: number;
  cancelled: boolean;
  logs: string[];
}
const plain = (value: string) => String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ');
const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export function renderProgress(state: ProgressState, width: number, theme: any, tick: number): string[] {
  const w = Math.max(0, Math.floor(width));
  if (!w) return [''];
  const inside = Math.max(0, w - 4), size = Math.max(0, Math.min(48, inside - 8));
  const fraction = state.percent === null ? 0 : Math.max(0, Math.min(1, state.percent / 100));
  const filled = Math.floor(size * fraction), pulse = tick % Math.max(1, size);
  const bar = Array.from({ length: size }, (_, i) => state.percent === null ? (Math.abs(i - pulse) < 3 ? '━' : '─') : (i < filled ? '━' : '─')).join('');
  const elapsed = Math.floor((Date.now() - state.started) / 1000);
  const lines = [
    theme.fg('accent', `╭─ ${frames[tick % frames.length]} PI UPDATE ${'─'.repeat(Math.max(0, Math.min(w - 18, 45)))}`),
    `  ${theme.bold(plain(state.phase))}`,
    `  ${theme.fg('accent', bar)} ${state.percent === null ? ' working' : `${Math.round(fraction * 100)}%`}`,
    `  ${theme.fg('muted', plain(state.detail))}`,
    '',
    ...state.logs.slice(-3).map(line => `  ${theme.fg('dim', '› ' + plain(line))}`),
    '',
    `  ${theme.fg('dim', `${elapsed}s elapsed · ${state.cancelled ? 'Cancellation requested; waiting for safe completion' : state.safeToCancel ? 'Esc cancels · installation is verified before restart' : 'Installer running · Esc skips restart after it finishes safely'}`)}`,
    theme.fg('accent', '╰' + '─'.repeat(Math.max(0, Math.min(w - 1, 63)))),
  ];
  return lines.map(line => truncateToWidth(line, w));
}
