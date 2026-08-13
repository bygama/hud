import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountChip,
  bar,
  buildLevels,
  chipColor,
  clampPct,
  configDir,
  contextPercent,
  contextSegment,
  formatReset,
  isExpired,
  limitSegment,
  limitsFromStdin,
  modelSegment,
  pctColor,
  renderLine,
  resetMs,
  sessionSegment,
  sessionStartMs,
  slotOwner,
  terminalWidth,
  usageCacheFile,
  visibleWidth,
} from '../../src/claude/statusline.mjs';

const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m';
const SEP_WIDTH = 3; // " | " (rendered dim, so assert on plain() to ignore the escapes)

// Segments are ANSI-wrapped, and the escapes themselves contain "[" and letters.
// Assert against the stripped text so a regex can't match an escape sequence.
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function tmpFile(name, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'hud-claude-'));
  const path = join(dir, name);
  if (contents !== undefined) writeFileSync(path, contents);
  return path;
}

// ---------- percentages and bars ----------

test('clampPct rounds and clamps into 0..100', () => {
  assert.equal(clampPct(-5), 0);
  assert.equal(clampPct(0), 0);
  assert.equal(clampPct(49.4), 49);
  assert.equal(clampPct(49.5), 50);
  assert.equal(clampPct(140), 100);
});

test('pctColor switches at the 70 and 90 thresholds', () => {
  assert.equal(pctColor(69), GREEN);
  assert.equal(pctColor(70), YELLOW);
  assert.equal(pctColor(89), YELLOW);
  assert.equal(pctColor(90), RED);
});

test('bar fills proportionally and keeps a constant visible width', () => {
  assert.equal(visibleWidth(bar(0, 8, GREEN)), 10); // 8 cells + 2 brackets
  assert.equal(visibleWidth(bar(100, 8, GREEN)), 10);
  assert.equal(visibleWidth(bar(37, 8, GREEN)), 10);
  assert.match(bar(0, 8, GREEN), /^\[[^#]*-{8}[^-]*\]$/);
  assert.match(bar(100, 8, GREEN), /#{8}/);
  assert.match(bar(50, 8, GREEN), /#{4}[^#]*-{4}/);
});

test('visibleWidth ignores ANSI escapes', () => {
  assert.equal(visibleWidth('abc'), 3);
  assert.equal(visibleWidth(`${GREEN}abc\x1b[0m`), 3);
  assert.equal(visibleWidth(''), 0);
});

// ---------- context ----------

test('contextPercent prefers used_percentage', () => {
  assert.equal(contextPercent({ context_window: { used_percentage: 24 } }), 24);
});

test('contextPercent falls back to summing current_usage against the window size', () => {
  const pct = contextPercent({
    context_window: {
      used_percentage: 0,
      context_window_size: 200000,
      current_usage: {
        input_tokens: 40000,
        cache_creation_input_tokens: 5000,
        cache_read_input_tokens: 5000,
      },
    },
  });
  assert.equal(pct, 25); // 50000 / 200000
});

test('contextPercent falls back to total_input_tokens when current_usage is absent', () => {
  const pct = contextPercent({
    context_window: { used_percentage: 0, context_window_size: 200000, total_input_tokens: 20000 },
  });
  assert.equal(pct, 10);
});

test('contextPercent returns 0 for missing or unusable payloads', () => {
  assert.equal(contextPercent(undefined), 0);
  assert.equal(contextPercent({}), 0);
  assert.equal(contextPercent({ context_window: { used_percentage: 0, context_window_size: 0 } }), 0);
});

test('contextSegment escalates COMPRESS? at 80 and CRITICAL at 85', () => {
  const at = (p) => contextSegment({ context_window: { used_percentage: p } });
  assert.doesNotMatch(at(79), /COMPRESS|CRITICAL/);
  assert.match(at(80), /80% COMPRESS\?/);
  assert.match(at(84), /COMPRESS\?/);
  assert.match(at(85), /85% CRITICAL/);
  assert.ok(at(85).startsWith(`ctx:`) && at(85).includes(RED));
  assert.ok(at(70).includes(YELLOW));
});

test('contextSegment can drop its bar', () => {
  const withBar = contextSegment({ context_window: { used_percentage: 24 } });
  const without = contextSegment({ context_window: { used_percentage: 24 } }, { showBar: false });
  assert.ok(visibleWidth(without) < visibleWidth(withBar));
  assert.equal(plain(without), 'ctx:24%');
  assert.match(plain(withBar), /^ctx:\[#+-*\]24%$/);
});

// ---------- reset times ----------

test('resetMs accepts epoch seconds, epoch millis and ISO strings', () => {
  assert.equal(resetMs(1800000000), 1800000000000);
  assert.equal(resetMs(1800000000000), 1800000000000);
  assert.equal(resetMs('2026-08-05T18:23:35.335Z'), Date.parse('2026-08-05T18:23:35.335Z'));
  assert.equal(resetMs(null), null);
  assert.equal(resetMs('not a date'), null);
});

test('formatReset renders hours below a day and days above it', () => {
  const now = Date.parse('2026-08-02T00:00:00Z');
  const inMs = (ms) => new Date(now + ms).toISOString();
  assert.equal(formatReset(inMs(4 * 3600e3 + 38 * 60e3), now), '4h38m');
  assert.equal(formatReset(inMs(45 * 60e3), now), '0h45m');
  assert.equal(formatReset(inMs(6 * 86400e3 + 10 * 3600e3), now), '6d10h');
});

test('formatReset returns null once the window has passed', () => {
  const now = Date.parse('2026-08-02T00:00:00Z');
  assert.equal(formatReset(new Date(now - 1000).toISOString(), now), null);
  assert.equal(formatReset(new Date(now).toISOString(), now), null);
  assert.equal(formatReset(undefined, now), null);
});

test('isExpired detects a stale stdin rate-limit snapshot', () => {
  const now = Date.parse('2026-08-02T00:00:00Z');
  assert.equal(isExpired(new Date(now - 1).toISOString(), now), true);
  assert.equal(isExpired(new Date(now + 60e3).toISOString(), now), false);
  assert.equal(isExpired(undefined, now), false); // absent is not expired
});

// ---------- limits ----------

test('limitsFromStdin maps both windows', () => {
  const limits = limitsFromStdin({
    rate_limits: {
      five_hour: { used_percentage: 2, resets_at: '2026-08-02T13:01:35Z' },
      seven_day: { used_percentage: 9, resets_at: '2026-08-05T18:23:35Z' },
    },
  });
  assert.equal(limits.fiveHour.pct, 2);
  assert.equal(limits.week.pct, 9);
  assert.equal(limits.week.resetsAt, '2026-08-05T18:23:35Z');
});

test('limitsFromStdin returns null when neither window is present', () => {
  assert.equal(limitsFromStdin(undefined), null);
  assert.equal(limitsFromStdin({}), null);
  assert.equal(limitsFromStdin({ rate_limits: {} }), null);
});

test('limitSegment drops bar and reset on request, and clamps', () => {
  const full = limitSegment('5h', 42, undefined, { showReset: false });
  assert.match(full, /^5h:\[/);
  const bare = limitSegment('5h', 42, undefined, { showBar: false, showReset: false });
  assert.equal(visibleWidth(bare), '5h:42%'.length);
  assert.match(limitSegment('5h', 140, undefined, { showBar: false, showReset: false }), /100%/);
  assert.equal(limitSegment('5h', null, undefined), null);
});

// ---------- model ----------

test('modelSegment prefers display_name, falls back to id, and pet-names Fable', () => {
  assert.equal(plain(modelSegment({ model: { display_name: 'Fable 5' } })), 'Fabio 5');
  assert.equal(plain(modelSegment({ model: { display_name: 'Opus 5' } })), 'Opus 5');
  assert.equal(plain(modelSegment({ model: { id: 'claude-fable-5' } })), 'claude-Fabio-5');
  assert.equal(modelSegment({ model: { display_name: '   ' } }), null);
  assert.equal(modelSegment({}), null);
  assert.equal(modelSegment(undefined), null);
});

// ---------- session ----------

test('sessionStartMs scans past untimestamped meta lines', () => {
  const stamp = '2026-08-02T10:00:00.000Z';
  const path = tmpFile('transcript.jsonl', [
    '{"type":"last-prompt","text":"hola"}',
    '{"type":"permission-mode","mode":"bypassPermissions"}',
    `{"type":"user","timestamp":"${stamp}"}`,
    '{"type":"assistant","timestamp":"2026-08-02T10:05:00.000Z"}',
  ].join('\n'));
  assert.equal(sessionStartMs(path), Date.parse(stamp));
});

test('sessionStartMs survives malformed lines and missing files', () => {
  const path = tmpFile('broken.jsonl', 'not json at all\n{"timestamp":"2026-08-02T10:00:00.000Z"}');
  assert.equal(sessionStartMs(path), Date.parse('2026-08-02T10:00:00.000Z'));
  assert.equal(sessionStartMs(join(tmpdir(), 'hud-does-not-exist-9e3f.jsonl')), null);
});

test('sessionSegment switches from Nm to XhYm past the hour', () => {
  const start = Date.parse('2026-08-02T10:00:00.000Z');
  const path = tmpFile('session.jsonl', `{"timestamp":"2026-08-02T10:00:00.000Z"}`);
  const at = (ms) => plain(sessionSegment({ transcript_path: path }, start + ms));
  assert.equal(at(0), 'session:0m');
  assert.equal(at(59 * 60e3), 'session:59m');
  assert.equal(at(60 * 60e3), 'session:1h0m');
  assert.equal(at(90 * 60e3), 'session:1h30m');
  assert.equal(at(25 * 3600e3), 'session:25h0m');
});

test('sessionSegment renders 0m when the transcript is missing', () => {
  assert.match(sessionSegment({}), /session:.*0m/);
  assert.match(sessionSegment({ transcript_path: 'nope.jsonl' }), /session:.*0m/);
});

test('sessionSegment colors past the 60m and 120m thresholds', () => {
  const start = Date.parse('2026-08-02T10:00:00.000Z');
  const path = tmpFile('session.jsonl', `{"timestamp":"2026-08-02T10:00:00.000Z"}`);
  const at = (min) => sessionSegment({ transcript_path: path }, start + min * 60e3);
  assert.ok(at(10).includes(GREEN));
  assert.ok(at(61).includes(YELLOW));
  assert.ok(at(121).includes(RED));
});

// ---------- responsive shrink ----------

test('renderLine picks the most detailed level that fits', () => {
  const levels = [['aaaa', 'bbbb'], ['aa', 'bb'], ['a']];
  const widest = 4 + SEP_WIDTH + 4;
  assert.equal(plain(renderLine(levels, 200)), 'aaaa | bbbb');
  assert.equal(plain(renderLine(levels, widest)), 'aaaa | bbbb'); // exact fit still counts
  assert.equal(plain(renderLine(levels, widest - 1)), 'aa | bb');
  assert.equal(plain(renderLine(levels, 2)), 'a');
});

test('renderLine overflows with the barest level rather than truncating', () => {
  const levels = [['aaaa'], ['aaa']];
  assert.equal(plain(renderLine(levels, 1)), 'aaa');
});

test('buildLevels degrades monotonically and never widens', () => {
  const stdin = { model: { display_name: 'Fable 5' }, context_window: { used_percentage: 24 } };
  const limits = {
    fiveHour: { pct: 2, resetsAt: undefined },
    week: { pct: 9, resetsAt: undefined },
  };
  const widths = buildLevels(stdin, limits).map((segs) => visibleWidth(segs.join(' | ')));
  for (let i = 1; i < widths.length; i += 1) {
    assert.ok(widths[i] <= widths[i - 1], `level ${i} (${widths[i]}) wider than ${i - 1} (${widths[i - 1]})`);
  }
  assert.ok(widths.at(-1) < widths[0]);
});

test('buildLevels drops bars first, then the model, and always keeps context', () => {
  const stdin = { model: { display_name: 'Fable 5' }, context_window: { used_percentage: 24 } };
  const limits = { fiveHour: { pct: 2 }, week: { pct: 9 } };
  const levels = buildLevels(stdin, limits);
  assert.match(levels[0].join(' | '), /Fabio 5/);
  assert.match(levels[0].join(' | '), /5h:\[/);       // 5h bar present
  assert.doesNotMatch(levels[1].join(' | '), /5h:\[/); // bars gone
  assert.match(levels[1].join(' | '), /Fabio 5/);
  assert.doesNotMatch(levels[2].join(' | '), /Fabio/); // model gone
  for (const level of levels) assert.match(level.join(' | '), /ctx:/);
});

test('buildLevels omits rate-limit segments entirely when limits are unavailable', () => {
  const levels = buildLevels({ context_window: { used_percentage: 24 } }, null);
  for (const level of levels) {
    const line = level.join(' | ');
    assert.doesNotMatch(line, /5h:|wk:/);
    assert.match(line, /ctx:/);
  }
});

// ---------- terminal width ----------

test('terminalWidth prefers COLUMNS and caches it for later runs', () => {
  const cache = tmpFile('columns.json');
  assert.equal(terminalWidth({ COLUMNS: '42' }, cache), 42);
  assert.equal(terminalWidth({}, cache), 42); // reuses the cached width
});

test('terminalWidth falls back to 80 only without COLUMNS and without a cache', () => {
  const missing = join(tmpdir(), 'hud-columns-absent-7c21.json');
  assert.equal(terminalWidth({}, missing), 80);
  assert.equal(terminalWidth({ COLUMNS: 'wide' }, missing), 80);
  assert.equal(terminalWidth({ COLUMNS: '0' }, missing), 80);
  assert.equal(terminalWidth({ COLUMNS: '-10' }, missing), 80);
});

// ---------- usage cache is per account ----------

test('configDir honours CLAUDE_CONFIG_DIR and defaults to ~/.claude', () => {
  assert.equal(configDir({ CLAUDE_CONFIG_DIR: '/somewhere/.claude-alt' }), '/somewhere/.claude-alt');
  assert.equal(configDir({}), join(homedir(), '.claude'));
});

test('usageCacheFile gives each account its own file in a shared tmpdir', () => {
  const dir = tmpdir();
  const personal = usageCacheFile({}, dir);
  const second = usageCacheFile({ CLAUDE_CONFIG_DIR: join(homedir(), '.claude-pegasuz') }, dir);

  // The whole point: one account's cached usage can never be read as another's.
  assert.notEqual(personal, second);
  assert.match(personal, /hud-usage-cache-[0-9a-f]{8}\.json$/);
  assert.match(second, /hud-usage-cache-[0-9a-f]{8}\.json$/);
});

test('usageCacheFile is stable across runs and across equivalent paths', () => {
  const dir = tmpdir();
  const env = { CLAUDE_CONFIG_DIR: join(homedir(), '.claude-pegasuz') };
  assert.equal(usageCacheFile(env, dir), usageCacheFile(env, dir));
  // An unset var and an explicit default point at one account, so they must agree.
  assert.equal(usageCacheFile({}, dir), usageCacheFile({ CLAUDE_CONFIG_DIR: join(homedir(), '.claude') }, dir));
});

// ---------- account chip ----------

const CFG = {
  accounts: {
    'a@x.com': { label: 'mateo', color: '#9DC0B7' },
    'b@y.com': { label: 'pegasuz', color: 'magenta' },
  },
  slots: {
    '~/.claude': 'a@x.com',
    '~/.claude-pegasuz': 'b@y.com',
  },
};

test('chipColor renders hex as 24-bit and names as classic ANSI', () => {
  assert.equal(chipColor('#9DC0B7'), '\x1b[38;2;157;192;183m');
  assert.equal(chipColor('9DC0B7'), '\x1b[38;2;157;192;183m');
  assert.equal(chipColor('magenta'), '\x1b[35m');
  assert.equal(chipColor('CYAN'), '\x1b[36m');
  assert.equal(chipColor('nope'), null);
  assert.equal(chipColor(undefined), null);
});

test('slotOwner expands ~ and matches the equivalent absolute path', () => {
  assert.equal(slotOwner(CFG, join(homedir(), '.claude')), 'a@x.com');
  assert.equal(slotOwner(CFG, join(homedir(), '.claude-pegasuz')), 'b@y.com');
  assert.equal(slotOwner(CFG, join(homedir(), '.claude-other')), null);
  assert.equal(slotOwner(null, join(homedir(), '.claude')), null);
});

test('accountChip shows the mapped label in the mapped color', () => {
  const chip = accountChip('a@x.com', join(homedir(), '.claude'), CFG);
  assert.equal(plain(chip), 'mateo');
  assert.match(chip, /38;2;157;192;183/);
});

test('accountChip flags a foreign credential in an owned slot in red', () => {
  // The exact failure this exists for: pegasuz's credential swapped into ~/.claude.
  const chip = accountChip('b@y.com', join(homedir(), '.claude'), CFG);
  assert.equal(plain(chip), 'pegasuz!');
  assert.match(chip, /\x1b\[31m/);
  // Same credential in its own slot: normal rendering, no alarm.
  assert.equal(plain(accountChip('b@y.com', join(homedir(), '.claude-pegasuz'), CFG)), 'pegasuz');
});

test('accountChip falls back to a dim localpart for unmapped accounts', () => {
  const chip = accountChip('someone.long.address@z.com', join(homedir(), '.claude-other'), CFG);
  assert.equal(plain(chip), 'someone.lo');
  assert.match(chip, /\x1b\[2m/);
  assert.equal(accountChip(null, join(homedir(), '.claude'), CFG), null);
});

test('accountChip narrows to a single letter, keeping the alarm', () => {
  assert.equal(plain(accountChip('a@x.com', join(homedir(), '.claude'), CFG, { narrow: true })), 'm');
  assert.equal(plain(accountChip('b@y.com', join(homedir(), '.claude'), CFG, { narrow: true })), 'p!');
});

test('buildLevels keeps the account chip at every level', () => {
  const acct = { full: 'FULLCHIP', narrow: 'N' };
  const levels = buildLevels(null, null, acct);
  for (const [i, segs] of levels.entries()) {
    const joined = segs.join('|');
    assert.match(joined, i < 3 ? /FULLCHIP/ : /(^|\|)N(\||$)/, `level ${i}`);
  }
  // And without an account, no empty segment leaks in.
  for (const segs of buildLevels(null, null, null)) assert.ok(segs.every(Boolean));
});
