# Pi Update — v0.1.0

`/update` updates the Pi harness with an animated, width-safe progress panel, verifies the installed version, then gracefully restarts Pi into the **same saved session**. It does not mistake `/reload` for a binary upgrade.

## Commands

| Command | Behavior |
|---|---|
| `/update` | Check latest stable release, confirm, install, verify, restart/resume |
| `/update check` | Show current version, latest release, installation type and real executable; no installation changes |
| `/update --extensions` | Also update configured Pi packages using the new runtime's `update --extensions` command |
| `/update --portable` | Use a private, checksum-verified side-by-side release instead of mise/npm |
| `/update --no-restart` | Install/verify but leave the current process running |
| `/update launcher` | Generate an optional shell launcher for `pi update` and supervised Windows restart |
| `/update help` | Short command help |

Flags can be combined. A busy agent, pending messages, an unsent editor draft, or unsafe startup arguments prevent automatic restart. Truly ephemeral `--no-session` sessions require `--no-restart`. For a new session that Pi has not flushed yet, the updater saves its documented JSONL header/entries without overwriting an existing file.

## Why your compiled Pi failed

In this Bun build:

```text
process.argv[1] = /$bunfs/root/pi                  # virtual bundled module
process.execPath = .../mise/installs/pi/0.85.1/pi/pi # real executable
```

The updater resolves the **real executable**, recognizes installation ownership, and does not invoke the broken built-in `pi update --self` path.

- **mise:** installs the exact latest version with `mise install pi@VERSION`, checks `mise where`, verifies `--version`, and refreshes shims. Does not uninstall old versions or rewrite global/project version pins. The restarted session uses the verified new binary explicitly. Existing pinned mise configurations remain pinned; use the optional launcher if you want future launches to select the updater's active version regardless of those pins.
- **Global npm:** checks the active npm prefix matches the current Pi package before running a scoped `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@VERSION`. npm updates are managed by npm, not transactional binary swaps. No sudo is attempted.
- **Standalone or `--portable`:** downloads the official platform archive into a private staging directory, checks size and SHA-256 against GitHub release metadata, rejects unsafe archive paths/links, extracts, and executes `--version`. Only a verified release is published to a versioned directory. Existing standalone installations are retained, not overwritten.

The canonical release repository is now **`earendil-works/pi`**; the old `pi-mono` URL redirects there. Only these explicitly trusted release URL namespaces are accepted. Checksums establish integrity against HTTPS GitHub metadata; they are not an independent publisher signature.

## Install

Copy the whole directory into `~/.pi/agent/extensions/update/` (Windows: `%USERPROFILE%\.pi\agent\extensions\update\`). From that directory:

```sh
npm ci --ignore-scripts
```

Then run `/reload` in Pi. Uses small `tar` and `fflate` dependencies for safe, cross-platform extraction. Node 22+ is required for the optional launcher/tests; the extension itself runs inside Pi (tested with Pi 0.85.1 / Bun 1.3.14).

## Animated progress and cancellation

The TUI updates every 80 ms, with an animated activity indicator, phase title, progress bar, elapsed time, latest detail, and a short output trail. Downloads report actual bytes and determinate progress. Package-manager installs use an indeterminate bar plus their output rather than fabricated download percentages.

Every rendered line uses Pi's ANSI-aware `truncateToWidth`, including narrow/zero-width terminals and Unicode text. No direct terminal writes are made from the extension.

Press **Esc** or **Ctrl+C** to cancel. Downloads can stop immediately. If a package-manager installation is already running, it is allowed to finish safely, then activation/restart is skipped. Ten-minute installer timeouts prevent indefinite hangs; a timed-out package manager may need repair via its own tools. Failed verification never triggers a restart.

Concurrent updates are blocked by a private lock. If a previous process crashed, inspect `~/.pi/update/update.lock` and verify that its PID is no longer updating before removing the stale lock. It is not automatically deleted based on age alone.

## Restart mechanics

### Linux/macOS with `process.execve`

The extension first calls Pi's graceful `ctx.shutdown()`. After shutdown handlers and terminal cleanup, an exit hook uses `process.execve` to replace the process. This keeps the same PID/terminal: no competing shell prompt, second reader, or orphaned Pi process. It resumes the exact session file, carries supported safety/resource options and the current model/thinking selection, and **does not replay initial prompts or `@file` attachments**.

Automatic restart is for interactive TUI sessions. RPC/print hosts should use `--no-restart` and manage their own process lifecycle.

### Windows / runtimes without execve

Start Pi through the optional Node supervisor below. The old Pi writes an authenticated local handoff and shuts down; only after it exits does the supervisor launch the new executable with the saved session. This avoids trying to overwrite a running Windows binary or attaching two processes to the same terminal.

The supervisor is also available on Linux/macOS. Native Windows/macOS installations have not been live-tested on this Linux machine; process supervision is covered by automated tests.

## Make shell `pi update` work too

A slash-command extension cannot intercept the native executable's shell subcommands. The optional launcher provides that layer, without modifying or overwriting your existing mise/shim/binary files.

Run `/update launcher`. It generates:

```text
~/.pi/update/bin/pi      # Unix shell launcher
~/.pi/update/bin/pi.cmd  # Windows launcher
```

**Place that directory first on PATH, ahead of mise's tool directories.** For the current shell:

```sh
# Linux/macOS
export PATH="$HOME/.pi/update/bin:$PATH"
hash -r
```

```powershell
# Windows PowerShell
$env:Path = "$HOME\.pi\update\bin;" + $env:Path
```

To keep it across terminals, add the equivalent PATH setting to your shell/profile *after* mise activation. The extension deliberately does not edit shell startup files. Or invoke the generated launcher by its full path without changing PATH.

The launcher supports:

```sh
pi update             # update the harness using this updater, then return to shell
pi update --check     # inspect only
pi update --all       # harness plus configured Pi packages
pi update --portable  # private side-by-side release
pi                    # start the updater's active Pi under restart supervision
```

`pi update --extensions`, `--models`, and named package updates retain native Pi semantics and are delegated to the selected executable. Native flags not implemented by the launcher (such as `--force`) are also delegated and may still encounter upstream self-update limitations. Inside Pi, `/update --extensions` means **harness plus configured packages**, whereas native shell `pi update --extensions` updates packages only.

If your shell still prints `Location of pi executable: /$bunfs/root/pi`, it is bypassing this launcher: inspect `type -a pi` (Unix) or `Get-Command pi -All` (PowerShell). Using `/update` inside Pi does not require PATH changes on this Linux/Bun installation.

## Data and safety

- Updater data: `~/.pi/update/` (override with `PI_UPDATE_HOME`).
- Side-by-side releases: `releases/<version>-<platform>-<arch>/`.
- `active.json` stores the verified executable path and previous runtime location for manual recovery. It contains no model credentials. Portable and mise old installations remain available; npm does not automatically retain the previous package tree.
- No edits to Pi auth, model configuration, sessions already on disk, trust settings, or user extension source. No automatic root escalation, security bypass, or package-manager configuration rewrite.
- Extension/package upgrades are **opt-in**. The “Extensions are skipped” message is informational, not a harness-update failure. Local unpackaged extension folders are never magically fetched or overwritten.
- Session restart intentionally closes session-scoped companions, including unsent annotation drafts. Finish/send those before updating.
- `--no-restart` leaves the old code running in memory. `/reload` cannot turn it into a new binary; restart it or launch through the generated launcher.

## Verification

```sh
npm run check
node test/pi-smoke.mjs
```

Automated tests cover virtual-path detection, platform assets, trusted URLs, checksum/size failures, archive traversal/link rejection, update locking, scoped mise/npm commands, package-update failures, cancellation, activation only after verification, first-command session snapshots, restart argument preservation and supervised handoff.

The Pi smoke test loads the real extension, runs `/update check`, exercises animated frames at widths including 93 columns, then tests graceful POSIX replacement with the same PID, session ID and saved entries. It makes **no model calls and does not upgrade the installed Pi**. Its RPC test closes stdin to let RPC drain shutdown; an additional live 93-column interactive TUI restart was tested successfully during development.

Also live-tested: downloading the official Linux x64 0.86.1 archive, checking its SHA-256, extracting it and executing its `--version` from a temporary staging directory. The existing installation was untouched by that test.
