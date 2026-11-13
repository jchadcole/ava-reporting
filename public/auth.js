'use strict';
// Per-viewer Genesys Cloud sign-in for the browser (used when the server runs with
// SIGN_IN=genesys). Signs the viewer in with Authorization Code + PKCE (or the implicit grant),
// keeps the access token in this tab's sessionStorage only, and sends it with each API call in
// the X-Genesys-Token header. Works inside a Genesys Cloud Client App frame: someone already
// signed in to Genesys is sent straight back without seeing a login page.
window.AvaAuth = (function () {
  const PREFIX = 'ava-auth:';
  let mode = 'server';
  let orgs = [];
  let currentOrg = '';

  const store = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(PREFIX + k)); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch { /* storage blocked */ } },
    del(k) { try { sessionStorage.removeItem(PREFIX + k); } catch { /* storage blocked */ } },
  };

  const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const randomString = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
  const redirectUri = () => location.origin + location.pathname;

  function token(orgKey) {
    const t = store.get(`token:${orgKey}`);
    return t && t.expiresAt > Date.now() + 30_000 ? t.token : null;
  }

  // Back from Genesys: a ?code= (PKCE) or #access_token= (implicit) in the URL. Restores the
  // page address the viewer was on (filters live in the hash) and saves the token.
  async function handleCallback() {
    const q = new URLSearchParams(location.search);
    const h = new URLSearchParams(location.hash.slice(1));
    const stateParam = q.get('state') || h.get('state');
    if (!stateParam || !(q.get('code') || h.get('access_token') || q.get('error') || h.get('error'))) return null;
    const pending = store.get(`pending:${stateParam}`);
    store.del(`pending:${stateParam}`);
    if (!pending) return { error: 'The sign-in response did not match a sign-in started here. Try again.' };
    history.replaceState(null, '', pending.returnTo);
    const error = q.get('error') || h.get('error');
    if (error) return { error: `Genesys sign-in failed: ${q.get('error_description') || h.get('error_description') || error}` };
    try {
      let accessToken;
      let expiresIn;
      if (h.get('access_token')) {
        accessToken = h.get('access_token');
        expiresIn = Number(h.get('expires_in')) || 3600;
      } else {
        const res = await fetch('auth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ org: pending.org, code: q.get('code'), verifier: pending.verifier, redirectUri: pending.redirectUri }) });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `Sign-in failed (${res.status})`);
        accessToken = body.accessToken;
        expiresIn = body.expiresIn;
      }
      store.set(`token:${pending.org}`, { token: accessToken, expiresAt: Date.now() + expiresIn * 1000 });
      store.set('signedInAt', Date.now());
      store.del('signedOut');
      return { org: pending.org };
    } catch (err) {
      return { error: err.message };
    }
  }

  async function signIn(orgKey) {
    const org = orgs.find((o) => o.key === orgKey);
    if (!org?.signIn?.clientId) throw new Error('Sign-in is not set up for this org. Ask whoever runs the dashboard to set its sign-in client.');
    const stateParam = randomString(16);
    const pending = { org: orgKey, returnTo: location.pathname + location.search + location.hash, redirectUri: redirectUri() };
    const p = new URLSearchParams({ client_id: org.signIn.clientId, redirect_uri: pending.redirectUri, state: stateParam });
    if (org.signIn.grant === 'implicit') {
      p.set('response_type', 'token');
    } else {
      pending.verifier = randomString(48);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pending.verifier)));
      p.set('response_type', 'code');
      p.set('code_challenge', b64url(digest));
      p.set('code_challenge_method', 'S256');
    }
    store.set(`pending:${stateParam}`, pending);
    location.assign(`https://login.${org.region}/oauth/authorize?${p}`);
    return new Promise(() => {}); // the page is leaving
  }

  // Make sure the viewer has a token for this org; signs in if not, unless they just signed out.
  async function ensure(orgKey) {
    currentOrg = orgKey;
    if (mode !== 'genesys' || token(orgKey)) return true;
    if (store.get('signedOut')) return false;
    await signIn(orgKey);
    return false;
  }

  // fetch with the viewer's token. On an expired or rejected token, signs in again once.
  async function apiFetch(url, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    const t = mode === 'genesys' ? token(currentOrg) : null;
    if (t) headers['X-Genesys-Token'] = t;
    const res = await fetch(url, { ...opts, headers });
    if (res.status === 401 && mode === 'genesys') {
      const body = await res.clone().json().catch(() => ({}));
      if (body.signIn) {
        store.del(`token:${currentOrg}`);
        // Avoid a sign-in loop when Genesys keeps rejecting fresh tokens.
        if (Date.now() - (store.get('signedInAt') || 0) > 20_000) await signIn(currentOrg);
      }
    }
    return res;
  }

  async function signOut() {
    const t = token(currentOrg);
    store.set('signedOut', true);
    for (const o of orgs) store.del(`token:${o.key}`);
    // Ends the token at Genesys in the background; the page shows signed out straight away.
    if (t) fetch('auth/signout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Genesys-Token': t }, body: JSON.stringify({ org: currentOrg }) }).catch(() => {});
  }

  function configure(signInMode, orgList) {
    mode = signInMode === 'genesys' ? 'genesys' : 'server';
    orgs = orgList || [];
  }

  return {
    handleCallback,
    configure,
    ensure,
    apiFetch,
    signOut,
    signIn: (orgKey) => { store.del('signedOut'); return signIn(orgKey || currentOrg); },
    get mode() { return mode; },
    get org() { return currentOrg; },
  };
})();
