'use strict';
// Genesys orgs the dashboard can report on. Credentials come only from the environment.
//
// Several orgs: list their names, then give each name its own settings:
//   GENESYS_ORGS=SC12,Acme
//   GENESYS_SC12_CLIENT_ID=...  GENESYS_SC12_CLIENT_SECRET=...  GENESYS_SC12_REGION=mypurecloud.com
//   GENESYS_ACME_CLIENT_ID=...  GENESYS_ACME_CLIENT_SECRET=...  GENESYS_ACME_REGION=usw2.pure.cloud
// The name is what the org picker shows; GENESYS_<NAME>_LABEL overrides it with a longer one.
// GENESYS_<NAME>_GOVERNMENT=true marks a government org (us-gov regions are marked automatically),
// so its transcripts never go to Anthropic's commercial API (see server/claude.js).
//
// One org: GENESYS_CLIENT_ID / GENESYS_CLIENT_SECRET / GENESYS_REGION, named from Genesys.
//
// Per-viewer sign-in (SIGN_IN=genesys): each org also needs GENESYS_<NAME>_SIGNIN_CLIENT_ID
// (GENESYS_SIGNIN_CLIENT_ID for one org), the ID of a Genesys OAuth client with the Code
// Authorization grant (used with PKCE, so no secret is needed) or, with
// GENESYS_<NAME>_SIGNIN_GRANT=implicit, the Token Implicit Grant (Browser). The CLIENT_ID and
// CLIENT_SECRET pair then becomes optional: it is only used by the daily turn-data archive.

const { createClient } = require('./genesys');

const envName = (name) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
const signInMode = (env = process.env) => ((env.SIGN_IN || '').toLowerCase() === 'genesys' ? 'genesys' : 'server');

function orgConfig(env, p, base) {
  const clientId = env[`${p}CLIENT_ID`];
  const clientSecret = env[`${p}CLIENT_SECRET`];
  const signInClientId = env[`${p}SIGNIN_CLIENT_ID`] || null;
  const grant = (env[`${p}SIGNIN_GRANT`] || 'pkce').toLowerCase() === 'implicit' ? 'implicit' : 'pkce';
  const service = Boolean(clientId && clientSecret);
  const missing = signInMode(env) === 'genesys' ? !signInClientId : !service;
  return { ...base, clientId, clientSecret, region: env[`${p}REGION`] || 'mypurecloud.com', government: env[`${p}GOVERNMENT`] === 'true', orgId: env[`${p}ORG_ID`] || null, signInClientId, grant, service, missing };
}

function readOrgConfigs(env = process.env) {
  const names = (env.GENESYS_ORGS || '').split(',').map((n) => n.trim()).filter(Boolean);
  if (!names.length) {
    const c = orgConfig(env, 'GENESYS_', { key: 'default', label: env.GENESYS_ORG_LABEL || null });
    return c.missing ? [] : [c];
  }
  return names.map((name) => {
    const p = `GENESYS_${envName(name)}_`;
    const c = orgConfig(env, p, { key: envName(name).toLowerCase(), label: env[`${p}LABEL`] || name });
    if (c.missing) console.warn(`Org "${name}" is listed in GENESYS_ORGS but ${signInMode(env) === 'genesys' ? `${p}SIGNIN_CLIENT_ID` : `${p}CLIENT_ID or ${p}CLIENT_SECRET`} is missing`);
    return c;
  });
}

// key -> { key, label, region, government, signInClientId, grant, orgId, service, missing, client }
// client is the server's own client-credentials client, or null when this org has none.
const orgs = new Map();
for (const c of readOrgConfigs()) {
  const { clientId, clientSecret, ...pub } = c;
  orgs.set(c.key, { ...pub, client: c.service ? createClient(c) : null });
}

function getOrg(key) {
  const org = key ? orgs.get(key) : orgs.values().next().value;
  if (!org) throw Object.assign(new Error(key ? `Unknown org "${key}"` : 'No Genesys org is configured. Set GENESYS_ORGS with credentials for each org, or GENESYS_CLIENT_ID and GENESYS_CLIENT_SECRET.'), { status: 400 });
  return org;
}

const allOrgs = () => [...orgs.values()];

// Public list for the org picker: labels, regions and (with per-viewer sign-in) the public
// OAuth client ID the browser signs in with. Never secrets.
async function listOrgs() {
  const genesys = signInMode() === 'genesys';
  return Promise.all(
    allOrgs().map(async (o) => {
      const pub = { key: o.key, label: o.label, region: o.region, ...(genesys ? { signIn: { clientId: o.signInClientId, grant: o.grant } } : {}) };
      if (o.missing) return { ...pub, error: genesys ? 'Sign-in client missing' : 'Credentials missing' };
      if (!o.label) {
        if (!o.client) return { ...pub, label: `Genesys Cloud (${o.region})` };
        try {
          o.label = (await o.client.request('/api/v2/organizations/me')).name;
        } catch {
          return { ...pub, label: `${o.key} (${o.region})`, error: 'Could not sign in' };
        }
      }
      return { ...pub, label: o.label };
    })
  );
}

module.exports = { readOrgConfigs, getOrg, listOrgs, allOrgs, signInMode };
