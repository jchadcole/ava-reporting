'use strict';
// Web server: serves the dashboard and a small read-only API that proxies Genesys Cloud,
// so the OAuth client secret stays on the server.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fetchTurns } = require('./detail');
const { getOrg, listOrgs } = require('./orgs');
const { buildAvaTurns, avaResponse } = require('./ava');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_SECONDS || 120) * 1000;
const MAX_RANGE_DAYS = Number(process.env.MAX_RANGE_DAYS) || 92;
const AUTH_USER = process.env.DASHBOARD_USER;
const AUTH_PASSWORD = process.env.DASHBOARD_PASSWORD;

const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const ID_PATTERN = /^[A-Za-z0-9_.:?=&%-]{1,200}$/;

const cache = new Map(); // key -> { expires, promise }

function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.promise;
  const promise = fn().catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, promise });
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

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true });
  if (url.pathname === '/api/orgs') return sendJson(res, 200, { orgs: await cached('orgs', listOrgs) });

  const org = getOrg(url.searchParams.get('org'));

  // Dashboard v2: AVA sessions, with intent analyses merged in fresh on every call so the
  // page can poll while they're being worked through.
  if (url.pathname === '/api/ava') {
    const start = url.searchParams.get('start');
    const end = url.searchParams.get('end');
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || startMs >= endMs) return sendJson(res, 400, { error: 'start and end must be ISO timestamps with start before end' });
    if (endMs - startMs > MAX_RANGE_DAYS * 86_400_000) return sendJson(res, 400, { error: `Date range is limited to ${MAX_RANGE_DAYS} days` });
    const key = `ava:${org.key}:${new Date(startMs).toISOString()}:${new Date(endMs).toISOString()}`;
    const build = await cached(key, () => buildAvaTurns(org.client, start, end));
    return sendJson(res, 200, avaResponse(org.key, build));
  }

  if (url.pathname === '/api/ava/session') {
    const botId = url.searchParams.get('botId');
    const sessionId = url.searchParams.get('sessionId');
    if (!botId || !sessionId || !ID_PATTERN.test(botId) || !ID_PATTERN.test(sessionId)) return sendJson(res, 400, { error: 'botId and sessionId are required' });
    const turns = await cached(`ava-session:${org.key}:${botId}:${sessionId}`, () => fetchTurns(org.client.request, botId, sessionId));
    // Only the AVA's turns; classic bot steps in the same flow are left out.
    return sendJson(res, 200, { sessionId, turns: turns.filter((t) => t.virtualAgent) });
  }

  return sendJson(res, 404, { error: 'Not found' });
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
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="AVA reporting"' });
    return res.end();
  }
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET') {
    res.writeHead(405);
    return res.end();
  }
  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (err) {
      console.error(err);
      sendJson(res, err.status === 400 ? 400 : 502, { error: err.message });
    }
    return;
  }
  serveStatic(res, url.pathname);
});

server.listen(PORT, HOST, () => console.log(`AVA reporting dashboard on http://${HOST}:${PORT}`));
