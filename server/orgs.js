'use strict';
// Genesys orgs the dashboard can report on. Credentials come only from the environment.
//
// Several orgs: list their names, then give each name its own credentials:
//   GENESYS_ORGS=SC12,Acme
//   GENESYS_SC12_CLIENT_ID=...  GENESYS_SC12_CLIENT_SECRET=...  GENESYS_SC12_REGION=mypurecloud.com
//   GENESYS_ACME_CLIENT_ID=...  GENESYS_ACME_CLIENT_SECRET=...  GENESYS_ACME_REGION=usw2.pure.cloud
// The name is what the org picker shows; GENESYS_<NAME>_LABEL overrides it with a longer one.
//
// One org: GENESYS_CLIENT_ID / GENESYS_CLIENT_SECRET / GENESYS_REGION, named from Genesys.

const { createClient } = require('./genesys');

const envName = (name) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

function readOrgConfigs(env = process.env) {
  const names = (env.GENESYS_ORGS || '').split(',').map((n) => n.trim()).filter(Boolean);
  if (!names.length) {
    if (!env.GENESYS_CLIENT_ID || !env.GENESYS_CLIENT_SECRET) return [];
    return [{ key: 'default', label: env.GENESYS_ORG_LABEL || null, clientId: env.GENESYS_CLIENT_ID, clientSecret: env.GENESYS_CLIENT_SECRET, region: env.GENESYS_REGION || 'mypurecloud.com' }];
  }
  return names.map((name) => {
    const p = `GENESYS_${envName(name)}_`;
    const clientId = env[`${p}CLIENT_ID`];
    const clientSecret = env[`${p}CLIENT_SECRET`];
    if (!clientId || !clientSecret) console.warn(`Org "${name}" is listed in GENESYS_ORGS but ${p}CLIENT_ID or ${p}CLIENT_SECRET is missing`);
    return { key: envName(name).toLowerCase(), label: env[`${p}LABEL`] || name, clientId, clientSecret, region: env[`${p}REGION`] || 'mypurecloud.com', missing: !clientId || !clientSecret };
  });
}

const orgs = new Map(); // key -> { key, label, region, client }
for (const c of readOrgConfigs()) orgs.set(c.key, { key: c.key, label: c.label, region: c.region, missing: c.missing, client: createClient(c) });

function getOrg(key) {
  const org = key ? orgs.get(key) : orgs.values().next().value;
  if (!org) throw Object.assign(new Error(key ? `Unknown org "${key}"` : 'No Genesys org is configured. Set GENESYS_ORGS with credentials for each org, or GENESYS_CLIENT_ID and GENESYS_CLIENT_SECRET.'), { status: 400 });
  return org;
}

// Public list for the org picker: labels and regions only, never credentials.
async function listOrgs() {
  return Promise.all(
    [...orgs.values()].map(async (o) => {
      if (o.missing) return { key: o.key, label: o.label, region: o.region, error: 'Credentials missing' };
      if (!o.label) {
        try {
          o.label = (await o.client.request('/api/v2/organizations/me')).name;
        } catch {
          return { key: o.key, label: `${o.key} (${o.region})`, region: o.region, error: 'Could not sign in' };
        }
      }
      return { key: o.key, label: o.label, region: o.region };
    })
  );
}

module.exports = { readOrgConfigs, getOrg, listOrgs };
