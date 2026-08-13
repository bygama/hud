#!/usr/bin/env node
/**
 * hud — standalone Claude Code statusline.
 * Renders: <model> | acct | 5h:[####----]N%(4h38m) | wk:[#-------]N%(6d10h) | session:Nm | ctx:[##--------]N%
 * Shrinks in stages as the terminal narrows: bars go first, then Model, then reset
 * times + session, down to bare "5h:N% | wk:N% | ctx:N%". Always one line, no wrap.
 * Data: Claude Code statusline stdin JSON (primary); OAuth usage API (fallback for rate limits).
 * Zero dependencies. Never throws: worst case prints a minimal line.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------- ANSI ----------
const R = "\x1b[0m", DIM = "\x1b[2m";
const RED = "\x1b[31m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m", CYAN = "\x1b[36m";
const dim = (s) => `${DIM}${s}${R}`;
const SEP = dim(" | ");

export const pctColor = (p) => (p >= 90 ? RED : p >= 70 ? YELLOW : GREEN);
export const clampPct = (p) => Math.min(100, Math.max(0, Math.round(p)));

export function bar(pct, width, color) {
  const filled = Math.round((pct / 100) * width);
  return `[${color}${"#".repeat(filled)}${R}${DIM}${"-".repeat(width - filled)}${R}]`;
}

// resetsAt (epoch seconds, epoch ms, or ISO string) -> epoch ms, or null if unparseable
export function resetMs(resetsAt) {
  if (!resetsAt) return null;
  const t = typeof resetsAt === "number"
    ? (Math.abs(resetsAt) < 1e12 ? resetsAt * 1000 : resetsAt)
    : Date.parse(resetsAt);
  return Number.isFinite(t) ? t : null;
}

// "4h38m" | "6d10h" | null when past/absent
export function formatReset(resetsAt, now = Date.now()) {
  const t = resetMs(resetsAt);
  if (t == null) return null;
  const diff = t - now;
  if (diff <= 0) return null;
  const m = Math.floor(diff / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d > 0 ? `${d}d${h % 24}h` : `${h}h${m % 60}m`;
}

// stdin's rate_limits are a snapshot from the last API response — stale once its
// window's resets_at is in the past (e.g. an idle session that hasn't sent a
// message since the window rolled over).
export function isExpired(resetsAt, now = Date.now()) {
  const t = resetMs(resetsAt);
  return t != null && t <= now;
}

export function limitSegment(label, pct, resetsAt, { dimLabel = false, width = 8, showBar = true, showReset = true } = {}) {
  if (pct == null) return null;
  const p = clampPct(pct);
  const reset = showReset ? formatReset(resetsAt) : null;
  const lbl = dimLabel ? dim(`${label}:`) : `${label}:`;
  const barPart = showBar ? bar(p, width, pctColor(p)) : "";
  return `${lbl}${barPart}${pctColor(p)}${p}%${R}${reset ? dim(`(${reset})`) : ""}`;
}

// ---------- stdin ----------
async function readStdin() {
  if (process.stdin.isTTY) return null;
  try {
    let data = "";
    for await (const chunk of process.stdin) data += chunk;
    return data.trim() ? JSON.parse(data) : null;
  } catch { return null; }
}

// ---------- segments ----------
// No "Model:" prefix — the name is recognizable on its own and the chars are
// better spent on the bars. "Fable" renders as "Fabio", a local pet name.
export function modelSegment(stdin) {
  const name = stdin?.model?.display_name?.trim() || stdin?.model?.id?.trim();
  return name ? `${CYAN}${name.replace(/\bfable\b/i, "Fabio")}${R}` : null;
}

export function contextPercent(stdin) {
  const cw = stdin?.context_window;
  if (!cw) return 0;
  if (cw.used_percentage > 0) return clampPct(cw.used_percentage);
  const u = cw.current_usage;
  const total = u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) : 0;
  if (total > 0 && cw.context_window_size > 0) return clampPct((total / cw.context_window_size) * 100);
  if (cw.total_input_tokens > 0 && cw.context_window_size > 0) return clampPct((cw.total_input_tokens / cw.context_window_size) * 100);
  return 0;
}

export function contextSegment(stdin, { showBar = true } = {}) {
  const p = contextPercent(stdin);
  const color = p >= 85 ? RED : p >= 70 ? YELLOW : GREEN;
  const suffix = p >= 85 ? " CRITICAL" : p >= 80 ? " COMPRESS?" : "";
  const barPart = showBar ? bar(p, 10, color) : "";
  return `ctx:${barPart}${color}${p}%${suffix}${R}`;
}

// Session start = first timestamped transcript entry. The transcript opens with meta
// lines (last-prompt, mode, permission-mode) that carry NO timestamp, so scan the head
// until one appears; fall back to file birthtime.
export function sessionStartMs(path) {
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, 65536, 0);
    closeSync(fd);
    for (const line of buf.toString("utf8", 0, n).split("\n")) {
      if (!line.trim()) continue;
      try {
        const ts = Date.parse(JSON.parse(line)?.timestamp);
        if (Number.isFinite(ts)) return ts;
      } catch { /* meta entry or line truncated at the 64KB boundary */ }
    }
    return statSync(path).birthtimeMs || null;
  } catch { return null; }
}

export function sessionSegment(stdin, now = Date.now()) {
  let minutes = 0;
  const start = stdin?.transcript_path ? sessionStartMs(stdin.transcript_path) : null;
  if (start) minutes = Math.max(0, Math.floor((now - start) / 60000));
  const color = minutes > 120 ? RED : minutes > 60 ? YELLOW : GREEN;
  const label = minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
  return `session:${color}${label}${R}`;
}

// ---------- rate limits: stdin first, OAuth usage API fallback ----------
export function limitsFromStdin(stdin) {
  const rl = stdin?.rate_limits;
  if (rl?.five_hour?.used_percentage == null && rl?.seven_day?.used_percentage == null) return null;
  return {
    fiveHour: { pct: rl.five_hour?.used_percentage, resetsAt: rl.five_hour?.resets_at },
    week: { pct: rl.seven_day?.used_percentage, resetsAt: rl.seven_day?.resets_at },
  };
}

const CACHE_TTL_MS = 90_000;

export function configDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

// Several accounts can share one machine (CLAUDE_CONFIG_DIR is the only thing
// separating them), and they then share one tmpdir too. An unkeyed cache file
// makes whichever statusline refreshed last serve ITS usage to every other
// account — and since refreshInterval is typically below the 90s TTL, that
// collision is the common case, not a rare race. Key the file by config dir so
// each account caches its own numbers.
export function dirKey(env = process.env) {
  return createHash("sha256").update(resolve(configDir(env))).digest("hex").slice(0, 8);
}

export function usageCacheFile(env = process.env, dir = tmpdir()) {
  return join(dir, `hud-usage-cache-${dirKey(env)}.json`);
}

function readOAuthCredentials(dir = configDir()) {
  try {
    const raw = JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8"));
    const creds = raw.claudeAiOauth ?? raw;
    // No refresh here: Claude Code keeps this token fresh; expired -> skip quietly.
    if (!creds.accessToken || (creds.expiresAt && creds.expiresAt <= Date.now())) return null;
    return creds;
  } catch { return null; }
}

function oauthHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
    "Content-Type": "application/json",
  };
}

async function limitsFromApi() {
  const creds = readOAuthCredentials();
  if (!creds) return null;
  // The cache is validated against the token, not just the dir: a credential
  // swapped into this dir (login in the wrong window, Orca's account manager)
  // must never be served the previous account's bars, not even for the TTL.
  const tokenHash = createHash("sha256").update(creds.accessToken).digest("hex").slice(0, 16);
  const cacheFile = usageCacheFile();
  try {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (cached.tokenHash === tokenHash && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;
  } catch { /* no cache */ }
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: oauthHeaders(creds.accessToken),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const data = {
      fiveHour: { pct: body.five_hour?.utilization, resetsAt: body.five_hour?.resets_at },
      week: { pct: body.seven_day?.utilization, resetsAt: body.seven_day?.resets_at },
    };
    try { writeFileSync(cacheFile, JSON.stringify({ ts: Date.now(), tokenHash, data })); } catch { /* best effort */ }
    return data;
  } catch { return null; }
}

// ---------- account identity chip ----------
// Which account is this session actually billing? The config dir alone can't
// answer that: a third-party account manager (Orca) swaps .credentials.json
// inside a dir without touching anything else, so the chip identifies the
// CREDENTIAL, not the folder. The token is hashed and mapped to an email via
// the OAuth profile endpoint, cached per config dir keyed by that hash — so
// the network is hit only when the token actually changes (login, refresh,
// swap), and a swap under a live session shows up on the next refresh.
//
// ~/.config/hud/accounts.json (optional, never committed anywhere) maps
// emails to short labels and colors, and declares which account OWNS each
// config dir. A credential that doesn't match its slot's owner renders red
// with a "!" — that's the tripwire for exactly the silent-swap case.
export function accountsConfigPath() {
  return join(homedir(), ".config", "hud", "accounts.json");
}

export function loadAccountsConfig(path = accountsConfigPath()) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

// "#9DC0B7" -> 24-bit color escape; "cyan" -> classic ANSI; anything else -> null.
// Hexes let the mapping follow a terminal theme; names keep it usable without one.
const ANSI_NAMES = { black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37 };
export function chipColor(spec) {
  const hex = /^#?([0-9a-fA-F]{6})$/.exec(spec ?? "");
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
  }
  const code = ANSI_NAMES[String(spec ?? "").toLowerCase()];
  return code ? `\x1b[${code}m` : null;
}

// Slot keys accept "~/..." and, on Windows, compare case-insensitively.
export function slotOwner(cfg, dir) {
  const fold = process.platform === "win32" ? (s) => s.toLowerCase() : (s) => s;
  const norm = (p) => fold(resolve(String(p).replace(/^~(?=$|[\\/])/, homedir())));
  for (const [slot, email] of Object.entries(cfg?.slots ?? {})) {
    if (norm(slot) === norm(dir)) return email;
  }
  return null;
}

export function accountChip(email, dir, cfg, { narrow = false } = {}) {
  if (!email) return null;
  const entry = cfg?.accounts?.[email];
  const base = entry?.label ?? email.split("@")[0].slice(0, 10);
  const label = narrow ? base.slice(0, 1) : base;
  const owner = slotOwner(cfg, dir);
  if (owner && owner !== email) return `${RED}${label}!${R}`; // foreign credential in this slot
  const color = (entry && chipColor(entry.color)) ?? DIM;
  return `${color}${label}${R}`;
}

async function accountEmail() {
  const dir = configDir();
  const cacheFile = join(tmpdir(), `hud-acct-cache-${dirKey()}.json`);
  const creds = readOAuthCredentials(dir);
  if (creds) {
    const tokenHash = createHash("sha256").update(creds.accessToken).digest("hex").slice(0, 16);
    try {
      const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
      if (cached.tokenHash === tokenHash && cached.email) return cached.email;
    } catch { /* no cache yet */ }
    try {
      const res = await fetch("https://api.anthropic.com/api/oauth/profile", {
        headers: oauthHeaders(creds.accessToken),
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const email = (await res.json()).account?.email;
        if (email) {
          try { writeFileSync(cacheFile, JSON.stringify({ tokenHash, email })); } catch { /* best effort */ }
          return email;
        }
      }
    } catch { /* offline -> fall through */ }
  }
  // Last-login identity as fallback. Claude Code keeps .claude.json at the
  // home root for the default dir and inside the dir when CLAUDE_CONFIG_DIR
  // is set. It goes stale against a swapped credential, so it never overrides
  // the profile lookup above — it only fills in when the network can't.
  try {
    const cfgJson = process.env.CLAUDE_CONFIG_DIR?.trim()
      ? join(dir, ".claude.json")
      : join(homedir(), ".claude.json");
    return JSON.parse(readFileSync(cfgJson, "utf8")).oauthAccount?.emailAddress ?? null;
  } catch { return null; }
}

// ---------- responsive shrink ----------
// Claude Code captures our stdout instead of connecting it to the terminal, so
// COLUMNS/LINES (which it sets before running the script, v2.1.153+) are the only
// way to read live terminal size. COLUMNS isn't reliably set on every refresh
// trigger, though — when it's missing, reuse the last valid width we saw instead
// of a fixed 80: on a narrow terminal, an 80-col guess can pick a detail level
// that overflows and gets clipped by the host. Only a true first run (no COLUMNS
// ever observed) falls back to 80, leaning toward shrinking over assuming wide.
const COLUMNS_CACHE_FILE = join(tmpdir(), "hud-columns-cache.json");

export function terminalWidth(env = process.env, cacheFile = COLUMNS_CACHE_FILE) {
  const cols = parseInt(env.COLUMNS, 10);
  if (Number.isFinite(cols) && cols > 0) {
    try { writeFileSync(cacheFile, String(cols)); } catch { /* best effort */ }
    return cols;
  }
  try {
    const cached = parseInt(readFileSync(cacheFile, "utf8"), 10);
    if (Number.isFinite(cached) && cached > 0) return cached;
  } catch { /* no cache yet */ }
  return 80;
}

export function visibleWidth(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "").length;
}

// Five detail levels, most to least detailed. Drop order: 5h/wk bars, then Model,
// then session, then reset times (down to bare 5h/wk label:%) — reset times
// outlast session since knowing when a limit frees up is more useful than the
// session clock, and the context bar outlasts everything since it's the segment
// most worth a glance even in the tightest terminal. The account chip never
// drops entirely — knowing WHO is being billed matters at every width — it
// only shrinks to its first letter alongside the narrow levels. Each level is
// tried in order and the first that fits `width` on one line wins; if even the
// barest level doesn't fit, it's printed anyway (overflow, never truncated).
export function buildLevels(stdin, limits, acct = null) {
  const model = modelSegment(stdin);
  const session = sessionSegment(stdin);
  const ctx = contextSegment(stdin);
  const a = acct?.full ?? null;
  const an = acct?.narrow ?? null;
  const fiveHour = (opts) => limits ? limitSegment("5h", limits.fiveHour.pct, limits.fiveHour.resetsAt, opts) : null;
  const week = (opts) => limits ? limitSegment("wk", limits.week.pct, limits.week.resetsAt, { dimLabel: true, ...opts }) : null;

  const levels = [
    [model, a, fiveHour({}), week({}), session, ctx],
    [model, a, fiveHour({ showBar: false }), week({ showBar: false }), session, ctx],
    [a, fiveHour({ showBar: false }), week({ showBar: false }), session, ctx],
    [an, fiveHour({ showBar: false }), week({ showBar: false }), ctx],
    [an, fiveHour({ showBar: false, showReset: false }), week({ showBar: false, showReset: false }), ctx],
  ];
  return levels.map((segs) => segs.filter(Boolean));
}

export function renderLine(levels, width) {
  for (const segs of levels) {
    const line = segs.join(SEP);
    if (visibleWidth(line) <= width) return line;
  }
  return levels[levels.length - 1].join(SEP);
}

// ---------- main ----------
async function main() {
  const stdin = await readStdin();
  const stdinLimits = limitsFromStdin(stdin);
  const stale = stdinLimits && (isExpired(stdinLimits.fiveHour.resetsAt) || isExpired(stdinLimits.week.resetsAt));
  // Limits and identity resolve concurrently; each is usually a cache hit.
  const [apiLimits, email] = await Promise.all([
    stdinLimits && !stale ? null : limitsFromApi(),
    accountEmail(),
  ]);
  const limits = stdinLimits && !stale ? stdinLimits : apiLimits ?? stdinLimits;
  const cfg = loadAccountsConfig();
  const acct = email ? {
    full: accountChip(email, configDir(), cfg),
    narrow: accountChip(email, configDir(), cfg, { narrow: true }),
  } : null;
  const levels = buildLevels(stdin, limits, acct);
  console.log(renderLine(levels, terminalWidth()));
}

// Run only when invoked as a script, so tests can import the helpers above
// without the renderer firing (and blocking on stdin).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => console.log(`${DIM}hud: err${R}`));
}
