# hud

My own statuslines for AI coding agents — zero-dependency Node scripts, one
folder per host.

| Host | What it is | Entry point |
|---|---|---|
| Claude Code | External statusline command | `src/claude/statusline.mjs` |
| Codex CLI | Native footer config + animated companion | `src/codex/statusline.mjs`, `src/codex/hud.mjs` |

## Claude Code

```
Fable 5 | mateo | 5h:[--------]2%(4h37m) | wk:[#-------]9%(6d9h) | session:0m | ctx:[##--------]24%
```

Shrinks in stages as the terminal narrows — bars go first, then the model,
then reset times and `session:`, down to bare `m | 5h:2% | wk:9% | ctx:24%`.
Always one line (see `COLUMNS`/`LINES` in [Test](#test)).

## Segments

| Segment | Source | Colors |
|---|---|---|
| model | stdin `model.display_name` (`Fable` renders as `Fabio`, a local pet name) | cyan |
| account chip | credential token → email via OAuth profile endpoint (cached per config dir, keyed by token hash) | per-account via `accounts.json`, dim when unmapped, red + `!` on a foreign credential |
| `5h:` / `wk:` | stdin `rate_limits`, else OAuth usage API (90s cache, invalidated when the token changes) | green <70, yellow ≥70, red ≥90 |
| `session:` | first transcript line timestamp | yellow >60m, red >120m |
| `ctx:` | stdin `context_window.used_percentage` (+fallback math) | yellow ≥70, `COMPRESS?` ≥80, `CRITICAL` red ≥85 |

### Install

`~/.claude/settings.json` (adjust the clone path):

```json
"statusLine": {
  "type": "command",
  "command": "node C:/path/to/hud/src/claude/statusline.mjs",
  "refreshInterval": 60
}
```

### Account chip

Works with zero configuration: the chip resolves which account the session's
credential actually bills (not which config dir it sits in — a swapped
credential shows within one refresh) and renders the email's localpart in
gray. To get short labels, colors, and the wrong-account alarm, create
`~/.config/hud/accounts.json`:

```json
{
  "accounts": {
    "you@example.com":  { "label": "personal", "color": "#9DC0B7" },
    "work@example.com": { "label": "work", "color": "magenta" }
  },
  "slots": {
    "~/.claude": "you@example.com",
    "~/.claude-work": "work@example.com"
  }
}
```

- `color` is a `#RRGGBB` truecolor hex (pick them from your terminal theme)
  or a classic ANSI name (`cyan`, `magenta`, ...).
- `slots` declares which account OWNS each `CLAUDE_CONFIG_DIR`. If a
  session's credential doesn't match its dir's owner, the chip renders
  red with `!` — the tripwire for a credential swapped behind your back.
- Single-account setups can skip the file entirely; multi-account setups
  want it. The file is yours and local — never commit it (it holds your
  emails).

## Codex CLI

Codex owns its TUI footer and does not execute `hud.mjs` or this repository's
renderer as a statusline command. The focused native preset keeps only this
order:

```text
model → weekly → context used → total input → total output
```

Once installed, Codex's own footer renders something like:

```text
gpt-5.6-luna · reasoning: high   weekly 9%   context used 24%   128K in · 3.2K out
```

Codex draws the exact glyphs, spacing, and theme color — this is only the
value order, not a byte-for-byte render. `--install` also writes
`status_line_use_colors = true` and `animations = true`, so this footer
picks up Codex's active theme colors and its own shimmer/spinner motion.

Install it globally with a recoverable backup:

```powershell
node src/codex/statusline.mjs --check --preset hud
node src/codex/statusline.mjs --install --preset hud
```

The native footer uses Codex's own labels and separators. Theme colors are
enabled explicitly, and `animations = true` enables Codex's own TUI motion; it
does not make the footer a custom ANSI or rainbow renderer. Restart an already
open Codex process after installing because it reads `config.toml` at startup.

The exact aligned layout and living neon gradient are available only as an
optional standalone renderer in another terminal pane:

```powershell
node src/codex/hud.mjs --once --cwd (Get-Location)
node src/codex/hud.mjs --watch --cwd (Get-Location)
```

It renders only `model`, `weekly`, `context used`, and `28.8K in · 230 out`; the
model is text-only and bars exist only on the first two groups. The companion
reads Codex rollout metadata, the active model, and token-count events only. It
never reads credentials or prompt/response text.
The existing `full` and `compact` native presets remain available. See
[docs/guides/codex.md](docs/guides/codex.md) for the native/companion
boundary, animation behavior, backup flow, and version notes.

## Test

```
node --test
node src/claude/statusline.mjs < test/fixtures/claude-stdin.json
echo {} | node src/claude/statusline.mjs
COLUMNS=35 node src/claude/statusline.mjs < test/fixtures/claude-stdin.json
```

Born as a replacement for the OMC HUD (reverse-engineered spec, reimplemented
clean: stdin-first, graceful degradation, no state, no hooks).
