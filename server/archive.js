'use strict';
// Daily turn-data archive. Genesys only returns bot reporting turns for about the last ten
// days, so this job saves each finished UTC day's AVA turns, bot names, preview sessions and
// hand-offs to disk, one file per org per day. The dashboard then reads days older than
// ARCHIVE_LIVE_DAYS from the archive and the rest live, so date ranges can go back months.
//
// It runs inside the server (at start, then every ARCHIVE_EVERY_HOURS) for each org that has
// the server's own OAuth client (CLIENT_ID and CLIENT_SECRET), since it runs with nobody signed
// in. It can also run on its own from cron or a scheduler:
//   node --env-file=.env server/archive.js
//   op run --env-file=.env -- node server/archive.js
//
// Customer text is masked before it is written (MASK_SENSITIVE), the same as on screen.

const fs = require('node:fs');
const path = require('node:path');
const { fetchRaw } = require('./ava');
const { maskText } = require('./detail');

const DAY = 86_400_000;
const DIR = process.env.ARCHIVE_DIR || path.join(__dirname, '..', 'data', 'turns');
const LIVE_DAYS = Number(process.env.ARCHIVE_LIVE_DAYS) || 7;
const BACKFILL_DAYS = Number(process.env.ARCHIVE_BACKFILL_DAYS) || 9;
const KEEP_DAYS = Number(process.env.ARCHIVE_KEEP_DAYS) || 400;
const EVERY_HOURS = Number(process.env.ARCHIVE_EVERY_HOURS) || 12;
// A day is saved again until this long after it ended, so late turns and hand-offs land.
const SETTLE_MS = 36 * 3_600_000;
const MASK = process.env.MASK_SENSITIVE !== 'false';
const SENSITIVE_SLOT = /card|cvv|cvc|security|ssn|social|pin|password|account|routing|dob|birth/i;

const enabled = () => (process.env.ARCHIVE || 'on').toLowerCase() !== 'off';
const dayStart = (ms) => Math.floor(ms / DAY) * DAY;
const dayName = (ms) => new Date(ms).toISOString().slice(0, 10);
const safeKey = (k) => String(k).replace(/[^a-z0-9_-]/gi, '_');
const fileFor = (orgKey, ms) => path.join(DIR, safeKey(orgKey), `${dayName(ms)}.json`);

function maskTurn(t) {
  if (!MASK) return t;
  const out = { ...t, userInput: maskText(t.userInput || '') || undefined };
  if (t.intent?.slots) out.intent = { ...t.intent, slots: t.intent.slots.map((s) => ({ ...s, value: SENSITIVE_SLOT.test(`${s.name} ${s.type}`) ? '•••' : maskText(s.value) })) };
  return out;
}

function serialize(orgKey, ms, raw) {
  const turnsByBot = {};
  for (const [botId, bySession] of raw.turnsByBot) turnsByBot[botId] = Object.fromEntries([...bySession].map(([sid, list]) => [sid, list.map(maskTurn)]));
  return {
    version: 1,
    org: orgKey,
    day: dayName(ms),
    savedAt: new Date().toISOString(),
    complete: Date.now() >= ms + DAY + SETTLE_MS,
    bots: [...raw.bots.values()],
    previewIds: [...raw.previewIds],
    turnsByBot,
    handoffs: Object.fromEntries(raw.handoffs),
    truncated: raw.truncated,
    detailsTruncated: raw.detailsTruncated,
  };
}

function deserialize(file, startMs, endMs) {
  const inRange = (t) => {
    const at = Date.parse(t.dateCreated);
    return !(at < startMs || at >= endMs);
  };
  const turnsByBot = new Map();
  for (const [botId, sessions] of Object.entries(file.turnsByBot || {})) {
    const bySession = new Map();
    for (const [sid, list] of Object.entries(sessions)) {
      const kept = list.filter(inRange);
      if (kept.length) bySession.set(sid, kept);
    }
    if (bySession.size) turnsByBot.set(botId, bySession);
  }
  return {
    bots: new Map((file.bots || []).map((b) => [b.id, b])),
    previewIds: new Set(file.previewIds || []),
    turnsByBot,
    handoffs: new Map(Object.entries(file.handoffs || {})),
    truncated: Boolean(file.truncated),
    detailsTruncated: Boolean(file.detailsTruncated),
  };
}

const memo = new Map(); // file -> { mtimeMs, data }
function loadDay(orgKey, ms) {
  const file = fileFor(orgKey, ms);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = memo.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.data;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    memo.set(file, { mtimeMs: st.mtimeMs, data });
    if (memo.size > 200) memo.delete(memo.keys().next().value);
    return data;
  } catch (err) {
    console.error(`Archive file ${file} is unreadable: ${err.message}`);
    return null;
  }
}

// The archive reader for one org, as buildAvaTurns expects it.
function readerFor(orgKey) {
  return {
    liveFrom: () => dayStart(Date.now()) - LIVE_DAYS * DAY,
    // Saved days overlapping [startMs, endMs), and how far from startMs they cover without a gap.
    read(startMs, endMs) {
      const days = [];
      let coveredUntil = startMs;
      let gap = false;
      for (let d = dayStart(startMs); d < endMs; d += DAY) {
        const file = loadDay(orgKey, d);
        if (!file) {
          gap = true;
          continue;
        }
        days.push(deserialize(file, startMs, endMs));
        if (!gap) coveredUntil = Math.min(endMs, d + DAY);
      }
      return { days, coveredUntil };
    },
  };
}

// The first saved day for an org, so the page can offer longer ranges.
function earliestDay(orgKey) {
  try {
    const names = fs.readdirSync(path.join(DIR, safeKey(orgKey))).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
    return names.length ? names[0].slice(0, 10) : null;
  } catch {
    return null;
  }
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function prune(orgKey) {
  const dir = path.join(DIR, safeKey(orgKey));
  const cutoff = dayName(dayStart(Date.now()) - KEEP_DAYS * DAY);
  try {
    for (const n of fs.readdirSync(dir)) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(n) && n.slice(0, 10) < cutoff) fs.unlinkSync(path.join(dir, n));
  } catch {
    /* nothing saved yet */
  }
}

// Save every finished day in the last BACKFILL_DAYS that is missing or not yet settled.
async function archiveOrg(org, log = console.log) {
  if (!org.client) return { org: org.key, skipped: 'no server OAuth client (CLIENT_ID and CLIENT_SECRET)' };
  const today = dayStart(Date.now());
  const saved = [];
  for (let d = today - BACKFILL_DAYS * DAY; d < today; d += DAY) {
    const existing = loadDay(org.key, d);
    if (existing?.complete) continue;
    const raw = await fetchRaw(org.client.request, d, d + DAY);
    const data = serialize(org.key, d, raw);
    writeAtomic(fileFor(org.key, d), data);
    const sessions = Object.values(data.turnsByBot).reduce((n, s) => n + Object.keys(s).length, 0);
    saved.push(`${data.day} (${sessions} sessions${data.complete ? '' : ', will refresh'})`);
  }
  prune(org.key);
  if (saved.length) log(`Turn archive for ${org.label || org.key}: saved ${saved.join(', ')}`);
  return { org: org.key, saved };
}

const state = { lastRun: null, running: false, errors: {} };

async function archiveAll(orgs, log = console.log) {
  if (state.running) return [];
  state.running = true;
  const results = [];
  try {
    for (const org of orgs) {
      try {
        results.push(await archiveOrg(org, log));
        delete state.errors[org.key];
      } catch (err) {
        state.errors[org.key] = err.message;
        console.error(`Turn archive for ${org.label || org.key} failed: ${err.message}`);
        results.push({ org: org.key, error: err.message });
      }
    }
  } finally {
    state.running = false;
    state.lastRun = new Date().toISOString();
  }
  return results;
}

function schedule(orgs) {
  if (!enabled()) return null;
  const withClient = orgs.filter((o) => o.client);
  if (!withClient.length) return null;
  const run = () => archiveAll(withClient);
  setTimeout(run, 10_000).unref();
  return setInterval(run, EVERY_HOURS * 3_600_000).unref();
}

module.exports = { readerFor, earliestDay, archiveAll, archiveOrg, schedule, serialize, deserialize, enabled, state, LIVE_DAYS };

if (require.main === module) {
  const { allOrgs } = require('./orgs');
  archiveAll(allOrgs()).then((results) => {
    for (const r of results) console.log(r.error ? `${r.org}: failed (${r.error})` : r.skipped ? `${r.org}: skipped, ${r.skipped}` : `${r.org}: ${r.saved.length ? `saved ${r.saved.length} day(s)` : 'up to date'}`);
    process.exitCode = results.some((r) => r.error) ? 1 : 0;
  });
}
