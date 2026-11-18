'use strict';
// Per-viewer Genesys sign-in (SIGN_IN=genesys).
//
// The browser signs the viewer in to Genesys Cloud (Authorization Code with PKCE, or the
// implicit grant) and sends the viewer's access token with each API call in the
// X-Genesys-Token header. The server checks the token once (it must have been issued to this
// dashboard's own OAuth client, and to the configured org when GENESYS_<NAME>_ORG_ID is set),
// then calls Genesys with it, so Genesys applies that person's roles and divisions.
// Tokens are held only in the viewer's browser tab and in memory here; nothing is stored.

const crypto = require('node:crypto');
const { createUserClient } = require('./genesys');

const VERIFY_TTL_MS = 5 * 60_000;
const verified = new Map(); // sha256(token) -> { expires, promise }

const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');

function authError(status, message) {
  return Object.assign(new Error(message), { status, signIn: true });
}

async function lookupViewer(org, token) {
  const client = createUserClient({ token, region: org.region });
  let info;
  let me;
  try {
    [info, me] = await Promise.all([client.request('/api/v2/tokens/me'), client.request('/api/v2/users/me').catch(() => null)]);
  } catch (err) {
    if (err.status === 401) throw authError(401, 'Your Genesys sign-in has expired. Sign in again.');
    throw err;
  }
  const clientId = info.oAuthClient?.id;
  if (clientId && org.signInClientId && clientId !== org.signInClientId) throw authError(401, 'That sign-in was not made through this dashboard. Sign in again.');
  const orgId = info.organization?.id || null;
  if (org.orgId && orgId !== org.orgId) throw authError(403, 'You are signed in to a different Genesys org than this dashboard reports on.');
  return { id: me?.id || null, name: me?.name || info.name || null, email: me?.email || null, orgId, orgName: info.organization?.name || null, client };
}

// The viewer behind a request, or an error with status 401 when there is no valid token.
async function viewerFor(org, token) {
  if (!token) throw authError(401, 'Sign in with Genesys Cloud to see this org.');
  if (org.missing) throw authError(400, `Sign-in is not set up for ${org.label || org.key}.`);
  const key = `${org.key}:${tokenHash(token)}`;
  const hit = verified.get(key);
  if (hit && hit.expires > Date.now()) return hit.promise;
  const promise = lookupViewer(org, token).catch((err) => {
    verified.delete(key);
    throw err;
  });
  verified.set(key, { expires: Date.now() + VERIFY_TTL_MS, promise });
  if (verified.size > 5000) for (const [k, v] of verified) if (v.expires <= Date.now()) verified.delete(k);
  return promise;
}

// Authorization Code + PKCE: the browser sends the code and its verifier here and the server
// trades them at Genesys's token endpoint. Public client, so no secret is involved; doing it on
// the server avoids depending on CORS at login.<region>.
async function exchangeCode(org, { code, verifier, redirectUri }) {
  if (!org.signInClientId || org.grant !== 'pkce') throw authError(400, 'This org does not use the PKCE sign-in.');
  if (typeof code !== 'string' || typeof verifier !== 'string' || typeof redirectUri !== 'string' || code.length > 2000 || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw authError(400, 'Invalid sign-in response.');
  const res = await fetch(`https://login.${org.region}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: org.signInClientId, code_verifier: verifier }).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const reason = body.error_description || body.description || body.error || `status ${res.status}`;
    throw authError(401, `Genesys sign-in failed (${reason}). Check that the OAuth client uses the Code Authorization grant and lists this page's address as a redirect URI.`);
  }
  return { accessToken: body.access_token, expiresIn: body.expires_in || 3600 };
}

async function signOut(org, token) {
  verified.delete(`${org.key}:${tokenHash(token)}`);
  // Ends this token at Genesys (DELETE /api/v2/tokens/me); the viewer stays signed in to Genesys itself.
  await fetch(`https://api.${org.region}/api/v2/tokens/me`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
}

module.exports = { viewerFor, exchangeCode, signOut, tokenHash };
