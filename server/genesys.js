'use strict';
// Minimal Genesys Cloud client: client-credentials token caching, JSON requests,
// and retry on 429/5xx. The client secret never leaves this process.

const REGION = process.env.GENESYS_REGION || 'mypurecloud.com';

let cachedToken = null; // { value, expiresAt }

async function getToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const id = process.env.GENESYS_CLIENT_ID;
  const secret = process.env.GENESYS_CLIENT_SECRET;
  if (!id || !secret) throw new Error('GENESYS_CLIENT_ID and GENESYS_CLIENT_SECRET must be set');
  const res = await fetch(`https://login.${REGION}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Genesys login failed: ${res.status}`);
  const body = await res.json();
  cachedToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cachedToken.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(path, body, attempt = 0) {
  const token = await getToken();
  const res = await fetch(`https://api.${REGION}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
    await sleep(retryAfter * 1000);
    return request(path, body, attempt + 1);
  }
  if (res.status === 401 && attempt === 0) {
    cachedToken = null;
    return request(path, body, attempt + 1);
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(`Genesys ${res.status} on ${path}: ${json.message || text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// Run async fn over items with bounded concurrency to stay under API rate limits.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

module.exports = { request, mapLimit, REGION };
