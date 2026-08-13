# hud

Statuslines for AI coding agents, one folder per host under `src/`. The
Claude Code statusline (`src/claude/statusline.mjs`) is one zero-dependency
Node script rendering model, account chip, 5h/weekly rate-limit bars,
session timer, and context bar. Replaces the OMC HUD. Codex integration
lives in `src/codex/` (see `## Codex compatibility`).

## Layout

`src/<host>/` renderers, `test/<host>/` tests, `test/fixtures/` sample
payloads, `docs/guides/<host>.md` install docs. Nothing new goes in the repo
root. Local tool state (`.codex/`, `.omc/`, `.worktrees/`) is gitignored.

## Commands

- `node --test` — Codex regression tests (pass from any cwd)
- `node src/claude/statusline.mjs < test/fixtures/claude-stdin.json` — render
  with the sample payload (run from the repo root: the sample's
  transcript_path is relative)
- `echo '{}' | node src/claude/statusline.mjs` — exercise the OAuth usage-API
  fallback path
- `COLUMNS=35 node src/claude/statusline.mjs < test/fixtures/claude-stdin.json`
  — simulate a narrow terminal to check the shrink (PowerShell:
  `$env:COLUMNS=35; node src/claude/statusline.mjs < test/fixtures/claude-stdin.json`)

## Gotchas

- Claude Code pipes the statusline JSON on stdin (`rate_limits`,
  `context_window`, `model`, `transcript_path`); the OAuth fallback only
  fires when stdin carries no rate limits. Fallback reads
  `$CLAUDE_CONFIG_DIR/.credentials.json` (default `~/.claude`) and never
  refreshes the token (Claude Code keeps it fresh) — an expired token silently
  drops the bars, by design.
- Usage-API responses cache 90s in
  `%TEMP%/hud-usage-cache-<8-hex>.json`, where the suffix hashes the config
  dir. It MUST stay keyed: accounts are separated only by
  `CLAUDE_CONFIG_DIR` and share one tmpdir, so an unkeyed file served
  whichever account refreshed last to all the others — and with
  `refreshInterval` below the 90s TTL that was the common case, not a race.
  5h windows are globally aligned, so a wrong reading carries a plausible
  `resets_at` and only the percentage looks off.
- The account chip identifies the CREDENTIAL, not the config dir: token
  hash → email via `api.anthropic.com/api/oauth/profile`, cached per dir in
  `%TEMP%/hud-acct-cache-<8-hex>.json` keyed by the token hash, so the
  network is hit only when the token changes and a credential swapped under
  a live session (Orca's account manager does this) shows within one
  refresh. `~/.config/hud/accounts.json` (optional, never committed; on
  this machine restored by workstation's `accounts/` step) maps emails to
  labels/colors (`#RRGGBB` truecolor or classic ANSI names) and declares
  each dir's owning account — a foreign credential in an owned slot renders
  red with `!`. Fallback when the network is out: `.claude.json`
  `oauthAccount` (home root for the default dir, inside the dir when
  `CLAUDE_CONFIG_DIR` is set), which can be stale — it never overrides the
  profile lookup.
- Session start is parsed from the FIRST line of the transcript (head read);
  a missing/unreadable transcript renders `session:0m`, not an error.
- Wired in `~/.claude/settings.json` → `statusLine.command`; changes to
  `src/claude/statusline.mjs` apply on the next statusline refresh, no
  restart needed. Moving or renaming that file breaks the statusline until
  `settings.json` is updated to match.
- Terminal width comes from the `COLUMNS` env var, which Claude Code sets
  to the live terminal size before each run (v2.1.153+) — `tput cols` and
  `process.stdout.columns` don't work since our stdout is captured, not
  connected to the terminal. Falls back to 80 when `COLUMNS` is absent or
  invalid. `buildLevels()` renders 4 detail levels (full → no bars → no
  Model → bare `label:%`); `renderLine()` picks the most detailed one that
  fits on one line, printing the barest level anyway (overflow) if even
  that doesn't fit. Never wraps to multiple lines, never truncates text.
- The script only re-runs (and re-reads `COLUMNS`) on Claude Code's normal
  refresh triggers — new assistant message, `/compact` finishing, a
  permission-mode change, vim-mode toggle, or a `refreshInterval` timer.
  Resizing the terminal alone does NOT trigger a refresh: the shrink/grow
  only becomes visible next time one of those events fires, not live as
  you drag the window edge.

## Codex compatibility

Codex CLI owns its TUI footer instead of invoking an external statusline
command. The native focused preset therefore uses only
`model-with-reasoning`, `weekly-limit`, `context-used`,
`total-input-tokens`, and `total-output-tokens`, in that order. The companion
`src/codex/hud.mjs` is not part of that footer: it reads the active model and
sanitized token-count events from rollout files to provide the exact aligned
rainbow line only when explicitly run in a separate PowerShell/terminal pane.

The native installer sets `tui.status_line_use_colors = true` and
`tui.animations = true`, which enable Codex's theme colors and its own TUI
animations. Codex still controls the native labels, separators, and rendering;
there is no supported external command or arbitrary ANSI hook. Restart Codex
after installing because it loads this configuration at process startup.

- `node src/codex/statusline.mjs --check --preset hud` validates the installed
  Codex parser and the native visual settings without writing configuration.
- `node src/codex/statusline.mjs --install --preset hud` updates
  `CODEX_HOME/config.toml` only after an explicit request and creates a
  timestamped backup before changing an existing file.
- `node src/codex/hud.mjs --once --cwd .` renders one deterministic line.
- `node src/codex/hud.mjs --watch --cwd .` animates the gradient until Ctrl+C.
- The companion is opt-in and never reads auth files, prompt text, response
  text, or provider credentials.
- `full` and `compact` remain available for contributors who need more native
  Codex fields.

## Hard constraints

- Never print anything to stdout other than the statusline content —
  Claude Code renders whatever this script prints. Always a single line
  (content shrinks to fit narrow terminals instead of wrapping).
- The script must never exit non-zero or throw: degrade by omitting
  segments (worst case prints a dim `hud: err`).
