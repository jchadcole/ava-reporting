'use strict';
// Web server: serves the dashboard and a small read-only API that proxies Genesys Cloud.
//
// Two ways to sign in (SIGN_IN):
//   server (default): the server calls Genesys with its own OAuth client (client credentials),
//     so the secret stays here and everyone who can open the page sees the same data. Right for
//     one person on their own computer.
//   genesys: each viewer signs in to Genesys Cloud in the browser and the server calls Genesys
//     with that viewer's own token, so their roles and divisions decide what they see. Use this
//     when the dashboard is shared, for example as a Genesys Cloud Client App.
//
// HTTPS: set TLS_CERT_FILE and TLS_KEY_FILE to serve HTTPS directly, or run behind a reverse
// proxy or load balancer that terminates TLS (set TRUST_PROXY=true).

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fetchTurns } = require('./detail');
const { getOrg, listOrgs, allOrgs, signInMode } = require('./orgs');
const { providerInfo } = require('./claude');
const { buildAvaTurns, avaResponse, fetchBots } = require('./ava');
const { viewerFor, exchangeCode, signOut } = require('./auth');
const archive = require('./archive');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_SECONDS || 120) * 1000;
const MAX_RANGE_DAYS = Number(process.env.MAX_RANGE_DAYS) || 92;
const AUTH_USER = process.env.DASHBOARD_USER;
const AUTH_PASSWORD = process.env.DASHBOARD_PASSWORD;
const SIGN_IN = signInMode();
const TLS_CERT = process.env.TLS_CERT_FILE;
const TLS_KEY = process.env.TLS_KEY_FILE;
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
// Who may show the page in a frame: Genesys Cloud's own app domains in every region,
// including FedRAMP (us-gov-pure.cloud). Override with a space-separated list.
const FRAME_ANCESTORS = process.env.FRAME_ANCESTORS || "'self' https://*.mypurecloud.com https://*.mypurecloud.ie https://*.mypurecloud.de https://*.mypurecloud.jp https://*.mypurecloud.com.au https://*.pure.cloud https://*.us-gov-pure.cloud";

const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const ID_PATTERN = /^[A-Za-z0-9_.:?=&%-]{1,200}$/;
const DAY = 86_400_000;

const cache = new Map(); // key -> { expires, promise }

function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.promise;
  const promise = fn().catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, promise });
  if (cache.size > 500) for (const [k, v] of cache) if (v.expires <= Date.now()) cache.delete(k);
  return promise;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  if (!AUTH_USER || !AUTH_PASSWORD) return true;
  const header = req.headers.authorization || '';
  const expected = 'Basic ' + Buffer.from(`${AUTH_USER}:${AUTH_PASSWORD}`).toString('base64');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const isHttps = (req) => Boolean(TLS_CERT) || (TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');

function securityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Keeps sign-in codes and tokens in the URL out of Referer headers.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self' https:; base-uri 'none'; object-src 'none'; frame-ancestors ${FRAME_ANCESTORS}`);
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

// The Genesys client for this request: the viewer's own (SIGN_IN=genesys) or the server's.
async function clientFor(req, org) {
  if (SIGN_IN === 'genesys') {
    const viewer = await viewerFor(org, req.headers['x-genesys-token']);
    return { client: viewer.client, scope: `user:${viewer.id || viewer.name}`, viewer };
  }
  if (!org.client) throw Object.assign(new Error(`No OAuth client credentials are set for ${org.label || org.key}.`), { status: 400 });
  return { client: org.client, scope: 'server', viewer: null };
}

function readBody(req, limit = 16_384) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request too large'), { status: 400 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function handleAuth(req, res, url) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  if (SIGN_IN !== 'genesys') return sendJson(res, 404, { error: 'Not found' });
  const body = await readBody(req);
  const org = getOrg(body.org);
  if (url.pathname === '/auth/token') return sendJson(res, 200, await exchangeCode(org, body));
  if (url.pathname === '/auth/signout') {
    if (req.headers['x-genesys-token']) await signOut(org, req.headers['x-genesys-token']);
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: 'Not found' });
}

const archiveReader = (org) => (archive.enabled() ? archive.readerFor(org.key) : null);

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true });
  if (url.pathname === '/api/config') {
    return sendJson(res, 200, { signIn: SIGN_IN, maxRangeDays: MAX_RANGE_DAYS, archive: { enabled: archive.enabled(), liveDays: archive.LIVE_DAYS, lastRun: archive.state.lastRun } });
  }
  if (url.pathname === '/api/orgs') {
    const orgs = await cached('orgs', listOrgs);
    return sendJson(res, 200, { signIn: SIGN_IN, orgs: orgs.map((o) => ({ ...o, archivedFrom: archive.enabled() ? archive.earliestDay(o.key) : null })) });
  }

  const org = getOrg(url.searchParams.get('org'));

  if (url.pathname === '/api/me') {
    const { viewer } = await clientFor(req, org);
    return sendJson(res, 200, viewer ? { signIn: SIGN_IN, name: viewer.name, email: viewer.email, orgName: viewer.orgName } : { signIn: SIGN_IN });
  }

  // Dashboard v2: AVA sessions, with intent analyses merged in fresh on every call so the
  // page can poll while they're being worked through.
  if (url.pathname === '/api/ava') {
    const start = url.searchParams.get('start');
    const end = url.searchParams.get('end');
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || startMs >= endMs) return sendJson(res, 400, { error: 'start and end must be ISO timestamps with start before end' });
    if (endMs - startMs > MAX_RANGE_DAYS * DAY) return sendJson(res, 400, { error: `Date range is limited to ${MAX_RANGE_DAYS} days` });
    const { client, scope } = await clientFor(req, org);
    // Per-viewer results are cached per viewer, so nobody is served data fetched with another's permissions.
    const key = `ava:${org.key}:${scope}:${new Date(startMs).toISOString()}:${new Date(endMs).toISOString()}`;
    const build = await cached(key, () => buildAvaTurns(client, start, end, { archive: archiveReader(org) }));
    return sendJson(res, 200, avaResponse(org.key, build, org));
  }

  if (url.pathname === '/api/ava/session') {
    const botId = url.searchParams.get('botId');
    const sessionId = url.searchParams.get('sessionId');
    const startMs = Date.parse(url.searchParams.get('start') || '');
    if (!botId || !sessionId || !ID_PATTERN.test(botId) || !ID_PATTERN.test(sessionId)) return sendJson(res, 400, { error: 'botId and sessionId are required' });
    const { client, scope } = await clientFor(req, org);
    const turns = await cached(`ava-session:${org.key}:${scope}:${botId}:${sessionId}`, async () => {
      const live = await fetchTurns(client.request, botId, sessionId);
      if (live.length || Number.isNaN(startMs) || !archive.enabled()) return live;
      return archivedSessionTurns(org, client, botId, sessionId, startMs);
    });
    // Only the AVA's turns; classic bot steps in the same flow are left out.
    return sendJson(res, 200, { sessionId, turns: turns.filter((t) => t.virtualAgent) });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

// A session older than Genesys keeps turns for: read it from the archive. With per-viewer
// sign-in, only when the viewer's own permissions show that bot in that period.
async function archivedSessionTurns(org, client, botId, sessionId, startMs) {
  const { summarizeTurn } = require('./detail');
  const from = startMs - DAY;
  const to = startMs + 2 * DAY;
  if (client.user) {
    const { bots } = await fetchBots(client.request, from, Math.min(to, Date.now()));
    if (!bots.has(botId)) return [];
  }
  const { days } = archive.readerFor(org.key).read(from, to);
  const turns = days.flatMap((d) => d.turnsByBot.get(botId)?.get(sessionId) || []);
  const seen = new Map(turns.map((t) => [t.turnId || t.id || `${t.dateCreated}|${t.userInput || ''}`, t]));
  return [...seen.values()].sort((a, b) => (a.dateCreated || '').localeCompare(b.dateCreated || '')).map(summarizeTurn);
}

function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function errorStatus(err) {
  if (err.signIn && err.status) return err.status;
  if (err.status === 400) return 400;
  if (err.status === 401) return 401; // the viewer's Genesys token was rejected
  if (err.status === 403) return 403; // the viewer's Genesys role lacks a permission
  return 502;
}

async function onRequest(req, res) {
  securityHeaders(req, res);
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="AVA reporting"' });
    return res.end();
  }
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/auth/')) return await handleAuth(req, res, url);
    if (req.method !== 'GET') {
      res.writeHead(405);
      return res.end();
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
  } catch (err) {
    const status = errorStatus(err);
    if (status >= 500) console.error(err);
    const message = status === 403 && !err.signIn ? `Your Genesys Cloud role is missing a permission this dashboard needs (analytics views for bots and conversation detail). ${err.message}` : err.message;
    return sendJson(res, status, { error: message, signIn: status === 401 && SIGN_IN === 'genesys' });
  }
  serveStatic(res, url.pathname);
}

const server = TLS_CERT && TLS_KEY ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, onRequest) : http.createServer(onRequest);

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`AVA reporting dashboard on ${TLS_CERT && TLS_KEY ? 'https' : 'http'}://${HOST}:${PORT}`);
    console.log(SIGN_IN === 'genesys' ? 'Sign-in: each viewer signs in with Genesys Cloud' : "Sign-in: the server's own OAuth client (everyone sees the same data)");
    const llm = providerInfo();
    console.log(llm.provider === 'bedrock' ? `Claude analysis: Amazon Bedrock (${llm.api}) in ${llm.region || 'no region set'}` : `Claude analysis: ${llm.provider === 'anthropic' ? "Anthropic's API" : 'off'}`);
    const timer = archive.schedule(allOrgs());
    console.log(timer ? `Turn archive: on, saving finished days to disk every ${Number(process.env.ARCHIVE_EVERY_HOURS) || 12} hours` : `Turn archive: ${archive.enabled() ? 'off (needs an org with CLIENT_ID and CLIENT_SECRET)' : 'off'}`);
  });
}

module.exports = { server, onRequest };
