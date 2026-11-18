'use strict';
// Per-viewer Genesys Cloud sign-in for the browser (used when the server runs with
// SIGN_IN=genesys). Signs the viewer in with Authorization Code + PKCE (or the implicit grant),
// keeps the access token in this tab's sessionStorage only, and sends it with each API call in
// the X-Genesys-Token header.
//
// Inside the Genesys Cloud Apps tab the page is in a frame. Someone whose Genesys login session
// is fresh is sent straight back, so the first sign-in there just redirects the frame. But once
// that session ages, Genesys hands sign-in to the identity provider (Okta, Azure AD...), whose
// login page refuses to load in a frame, and the frame gets stuck. So in a frame, a sign-in the
// viewer starts, or one after a redirect that never came back, opens Genesys sign-in in a pop-up
// instead. The pop-up passes the one-time code back through the server (see /auth/relay); only
// this frame holds the PKCE verifier needed to use it.
window.AvaAuth = (function () {
  const PREFIX = 'ava-auth:';
  const FRAME_TRY_KEY = 'ava-auth-frame-try';
  const FRAME_FAIL_WINDOW_MS = 12 * 3_600_000;
  let mode = 'server';
  let orgs = [];
  let currentOrg = '';

  const inFrame = (() => {
    try { return window.self !== window.top; } catch { return true; }
  })();

  const store = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(PREFIX + k)); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch { /* storage blocked */ } },
    del(k) { try { sessionStorage.removeItem(PREFIX + k); } catch { /* storage blocked */ } },
  };
  // A frame redirect that was started but never came back. Kept across tabs (localStorage).
  const frameTry = {
    get() { try { return Number(localStorage.getItem(FRAME_TRY_KEY)) || 0; } catch { return 0; } },
    set() { try { localStorage.setItem(FRAME_TRY_KEY, String(Date.now())); } catch { /* storage blocked */ } },
    clear() { try { localStorage.removeItem(FRAME_TRY_KEY); } catch { /* storage blocked */ } },
  };
  const frameRedirectFailed = () => inFrame && Date.now() - frameTry.get() < FRAME_FAIL_WINDOW_MS;

  const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const randomString = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
  const redirectUri = () => location.origin + location.pathname;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function token(orgKey) {
    const t = store.get(`token:${orgKey}`);
    return t && t.expiresAt > Date.now() + 30_000 ? t.token : null;
  }

  function saveToken(orgKey, accessToken, expiresIn) {
    store.set(`token:${orgKey}`, { token: accessToken, expiresAt: Date.now() + expiresIn * 1000 });
    store.set('signedInAt', Date.now());
    store.del('signedOut');
  }

  async function exchange(pending, code) {
    const res = await fetch('auth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ org: pending.org, code, verifier: pending.verifier, redirectUri: pending.redirectUri }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Sign-in failed (${res.status})`);
    saveToken(pending.org, body.accessToken, body.expiresIn);
  }

  // The pop-up landed back here with a code: hand it to the frame through the server, then close.
  async function finishPopup(stateParam, code, error) {
    document.title = 'Signing in…';
    const say = (text) => { document.body.innerHTML = ''; const p = document.createElement('p'); p.style.cssText = 'font: 16px system-ui, sans-serif; margin: 40px; text-align: center'; p.textContent = text; document.body.appendChild(p); };
    if (error) {
      say(`Genesys sign-in failed: ${error}. Close this window and try again.`);
      return;
    }
    try {
      const res = await fetch('auth/relay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: stateParam, code }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `status ${res.status}`);
      say('Signed in. You can close this window.');
      setTimeout(() => window.close(), 300);
    } catch (err) {
      say(`Sign-in couldn't finish (${err.message}). Close this window and try again.`);
    }
  }

  // Back from Genesys: a ?code= (PKCE) or #access_token= (implicit) in the URL. Restores the
  // page address the viewer was on (filters live in the hash) and saves the token.
  // Returns { popup: true } when this window is a sign-in pop-up, which then shows nothing else.
  async function handleCallback() {
    const q = new URLSearchParams(location.search);
    const h = new URLSearchParams(location.hash.slice(1));
    const stateParam = q.get('state') || h.get('state');
    if (!stateParam || !(q.get('code') || h.get('access_token') || q.get('error') || h.get('error'))) return null;
    const error = q.get('error_description') || h.get('error_description') || q.get('error') || h.get('error');
    if (stateParam.startsWith('p.')) {
      await finishPopup(stateParam, q.get('code'), error);
      return { popup: true };
    }
    const pending = store.get(`pending:${stateParam}`);
    store.del(`pending:${stateParam}`);
    frameTry.clear(); // the redirect came back, so redirects work here
    if (!pending) return { error: 'The sign-in response did not match a sign-in started here. Try again.' };
    history.replaceState(null, '', pending.returnTo);
    if (error) return { error: `Genesys sign-in failed: ${error}` };
    try {
      if (h.get('access_token')) saveToken(pending.org, h.get('access_token'), Number(h.get('expires_in')) || 3600);
      else await exchange(pending, q.get('code'));
      return { org: pending.org };
    } catch (err) {
      return { error: err.message };
    }
  }

  async function authorizeUrl(org, { popup = false } = {}) {
    const stateParam = (popup ? 'p.' : '') + randomString(24);
    const pending = { org: org.key, returnTo: location.pathname + location.search + location.hash, redirectUri: redirectUri() };
    const p = new URLSearchParams({ client_id: org.signIn.clientId, redirect_uri: pending.redirectUri, state: stateParam });
    if (org.signIn.grant === 'implicit' && !popup) {
      p.set('response_type', 'token');
    } else {
      pending.verifier = randomString(48);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pending.verifier)));
      p.set('response_type', 'code');
      p.set('code_challenge', b64url(digest));
      p.set('code_challenge_method', 'S256');
    }
    return { url: `https://login.${org.region}/oauth/authorize?${p}`, stateParam, pending };
  }

  function orgFor(orgKey) {
    const org = orgs.find((o) => o.key === orgKey);
    if (!org?.signIn?.clientId) throw new Error('Sign-in is not set up for this org. Ask whoever runs the dashboard to set its sign-in client.');
    return org;
  }

  // Full-page (or full-frame) redirect to Genesys sign-in.
  async function redirectSignIn(orgKey) {
    const { url, stateParam, pending } = await authorizeUrl(orgFor(orgKey));
    store.set(`pending:${stateParam}`, pending);
    if (inFrame) frameTry.set(); // cleared when the redirect comes back
    location.assign(url);
    return new Promise(() => {}); // the page is leaving
  }

  // Pop-up sign-in, for frames. Must be called from a click, or the browser blocks the pop-up.
  async function popupSignIn(orgKey) {
    const org = orgFor(orgKey);
    if (org.signIn.grant === 'implicit') throw new Error('Pop-up sign-in needs a Code Authorization / PKCE client.');
    const win = window.open('about:blank', 'ava-signin', 'popup,width=520,height=720');
    if (!win) throw new Error('Your browser blocked the sign-in pop-up. Allow pop-ups for this site and try again.');
    const { url, stateParam, pending } = await authorizeUrl(org, { popup: true });
    win.location.href = url;
    const deadline = Date.now() + 3 * 60_000;
    while (Date.now() < deadline) {
      await sleep(1500);
      const res = await fetch('auth/relay/take', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: stateParam }) });
      const body = await res.json().catch(() => ({}));
      if (body.code) {
        await exchange(pending, body.code);
        return true;
      }
    }
    throw new Error('Sign-in timed out. Try again.');
  }

  // Make sure the viewer has a token for this org. Redirects to sign in when that can work on
  // its own; returns false when the viewer needs to press Sign in (signed out, or in a frame
  // where redirects can't finish).
  async function ensure(orgKey) {
    currentOrg = orgKey;
    if (mode !== 'genesys' || token(orgKey)) return true;
    if (store.get('signedOut') || frameRedirectFailed()) return false;
    await redirectSignIn(orgKey);
    return false;
  }

  // fetch with the viewer's token. On an expired or rejected token, signs in again when it can,
  // and otherwise throws an error with needsSignIn, so the page can offer a Sign in button.
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
        const recent = Date.now() - (store.get('signedInAt') || 0) < 20_000;
        if (!recent && !frameRedirectFailed()) await redirectSignIn(currentOrg);
        throw Object.assign(new Error(body.error || 'Sign in again.'), { needsSignIn: true });
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

  // The Sign in button. In a frame it uses the pop-up and resolves true when done.
  async function signIn(orgKey) {
    store.del('signedOut');
    const key = orgKey || currentOrg;
    if (inFrame) return popupSignIn(key);
    return redirectSignIn(key);
  }

  return {
    handleCallback,
    configure,
    ensure,
    apiFetch,
    signOut,
    signIn,
    get mode() { return mode; },
    get org() { return currentOrg; },
    get inFrame() { return inFrame; },
    get signedOut() { return Boolean(store.get('signedOut')); },
  };
})();
