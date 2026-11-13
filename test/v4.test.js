'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-v4-'));
process.env.ARCHIVE_DIR = tmp;
process.env.AVA_CACHE_FILE = path.join(tmp, 'analyses.json');

const DAY = 86_400_000;
const turn = (sid, at, extra = {}) => ({ turnId: `${sid}-${at}`, sessionId: sid, dateCreated: new Date(at).toISOString(), dateCompleted: new Date(at + 1000).toISOString(), conversation: { id: `c-${sid}` }, askAction: { agentDetails: { agentId: 'a1', agentName: 'Billing AVA', agentVersion: 1 } }, botPrompts: ['Hi'], ...extra });

// A fake Genesys API: bot list, turns by interval, no conversation detail.
function fakeRequest(allTurns, { bots = [{ botId: 'b1', botName: 'Billing', botFlowType: 'DIGITALBOT' }] } = {}) {
  return async (p, body) => {
    if (p.startsWith('/api/v2/analytics/bots/aggregates/query')) return body.groupBy.includes('botId') ? { results: bots.map((g) => ({ group: g })) } : { results: [] };
    if (p.startsWith('/api/v2/analytics/conversations/details/query')) return { conversations: [] };
    const m = p.match(/reportingturns\?.*interval=([^&]+)/);
    const [a, b] = decodeURIComponent(m[1]).split('/').map(Date.parse);
    return { entities: allTurns.filter((t) => Date.parse(t.dateCreated) >= a && Date.parse(t.dateCreated) < b) };
  };
}

test('readOrgConfigs: per-viewer sign-in needs only the sign-in client', () => {
  const { readOrgConfigs } = require('../server/orgs');
  const [c] = readOrgConfigs({ SIGN_IN: 'genesys', GENESYS_ORGS: 'Gov', GENESYS_GOV_SIGNIN_CLIENT_ID: 'pub', GENESYS_GOV_REGION: 'use2.us-gov-pure.cloud' });
  assert.equal(c.missing, false);
  assert.equal(c.service, false);
  assert.equal(c.grant, 'pkce');
  assert.equal(c.signInClientId, 'pub');
  const [d] = readOrgConfigs({ SIGN_IN: 'genesys', GENESYS_SIGNIN_CLIENT_ID: 'x', GENESYS_SIGNIN_GRANT: 'implicit' });
  assert.equal(d.grant, 'implicit');
  // Without SIGN_IN=genesys the old client-credentials rule still applies.
  assert.equal(readOrgConfigs({ GENESYS_SIGNIN_CLIENT_ID: 'x' }).length, 0);
});

test('archive: saved days are masked, read back, and merged with live data across midnight', async () => {
  const archive = require('../server/archive');
  const { fetchRaw, buildAvaTurns } = require('../server/ava');
  const day0 = Math.floor(Date.now() / DAY) * DAY - 20 * DAY; // well outside the live window
  const turns = [
    turn('s1', day0 + 3_600_000, { userInput: 'card 4111 1111 1111 1234' }),
    turn('s2', day0 + DAY - 60_000),
    turn('s2', day0 + DAY + 60_000), // same session continues after midnight
  ];
  const request = fakeRequest(turns);
  for (const d of [day0, day0 + DAY]) {
    const data = archive.serialize('org1', d, await fetchRaw(request, d, d + DAY));
    fs.mkdirSync(path.join(tmp, 'org1'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'org1', `${data.day}.json`), JSON.stringify(data));
  }
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'org1', `${new Date(day0).toISOString().slice(0, 10)}.json`), 'utf8'));
  assert.equal(saved.turnsByBot.b1.s1[0].userInput, 'card ••••••••••••1234');
  assert.equal(archive.earliestDay('org1'), new Date(day0).toISOString().slice(0, 10));

  // Genesys has aged the turns out: live returns nothing, the archive fills in.
  const build = await buildAvaTurns({ request: fakeRequest([]) }, new Date(day0).toISOString(), new Date(day0 + 2 * DAY).toISOString(), { archive: archive.readerFor('org1') });
  const ids = build.sessions.map((s) => [s.id, s.turns]).sort();
  assert.deepEqual(ids, [['s1', 1], ['s2', 2]]);

  // A viewer whose own permissions don't show that bot gets no archived sessions.
  const hidden = await buildAvaTurns({ request: fakeRequest([], { bots: [] }), user: true }, new Date(day0).toISOString(), new Date(day0 + 2 * DAY).toISOString(), { archive: archive.readerFor('org1') });
  assert.equal(hidden.sessions.length, 0);
});

test('archive: a gap in saved days is read live', () => {
  const archive = require('../server/archive');
  const day0 = Math.floor(Date.now() / DAY) * DAY - 40 * DAY;
  const r = archive.readerFor('nothing-saved').read(day0, day0 + 3 * DAY);
  assert.equal(r.days.length, 0);
  assert.equal(r.coveredUntil, day0);
});

test('viewerFor checks the token was issued to this dashboard and caches the check', async () => {
  const { viewerFor } = require('../server/auth');
  const org = { key: 'o', region: 'mypurecloud.com', signInClientId: 'mine', orgId: 'org-1', missing: false };
  const realFetch = global.fetch;
  let calls = 0;
  let client = 'mine';
  global.fetch = async (url) => {
    calls++;
    const body = url.endsWith('/tokens/me') ? { oAuthClient: { id: client }, organization: { id: 'org-1', name: 'SC12' } } : { id: 'u1', name: 'Pat Lee', email: 'pat@example.com' };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const v = await viewerFor(org, 'tok-a');
    assert.equal(v.name, 'Pat Lee');
    assert.equal(v.client.user, true);
    await viewerFor(org, 'tok-a');
    assert.equal(calls, 2); // second call served from the cache
    client = 'someone-else';
    await assert.rejects(viewerFor(org, 'tok-b'), (e) => e.status === 401);
    await assert.rejects(viewerFor(org, ''), (e) => e.status === 401 && e.signIn);
  } finally {
    global.fetch = realFetch;
  }
});

test('server: security headers allow framing by Genesys only, and API needs a viewer token', async () => {
  process.env.SIGN_IN = 'genesys';
  process.env.GENESYS_SIGNIN_CLIENT_ID = 'pub';
  for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}server${path.sep}`)) delete require.cache[k];
  const { server } = require('../server/index');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/`);
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /frame-ancestors 'self' https:\/\/\*\.mypurecloud\.com/);
    assert.match(csp, /us-gov-pure\.cloud/);
    const orgs = await (await fetch(`${base}/api/orgs`)).json();
    assert.equal(orgs.signIn, 'genesys');
    assert.deepEqual(orgs.orgs[0].signIn, { clientId: 'pub', grant: 'pkce' });
    const res = await fetch(`${base}/api/ava?start=2026-11-01T00:00:00Z&end=2026-11-02T00:00:00Z`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).signIn, true);
    const bad = await fetch(`${base}/auth/token`, { method: 'POST', body: JSON.stringify({ code: 'x', verifier: 'short', redirectUri: base }) });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
    delete process.env.SIGN_IN;
    delete process.env.GENESYS_SIGNIN_CLIENT_ID;
  }
});
