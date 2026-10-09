'use strict';
// Genesys orgs the dashboard can report on. Credentials come only from the environment:
//   GENESYS_CLIENT_ID / GENESYS_CLIENT_SECRET / GENESYS_REGION        the default org
//   GENESYS_ORG_<N>_CLIENT_ID / _CLIENT_SECRET / _REGION / _LABEL   more orgs, N = 1, 2, ...
// A label is optional; without one the org's name is read from Genesys.

const { createClient } = require('./genesys');

function readOrgConfigs(env = process.env) {
  const configs = [];
  if (env.GENESYS_CLIENT_ID && env.GENESYS_CLIENT_SECRET) {
    configs.push({ key: 'default', label: env.GENESYS_ORG_LABEL || null, clientId: env.GENESYS_CLIENT_ID, clientSecret: env.GENESYS_CLIENT_SECRET, region: env.GENESYS_REGION || 'mypurecloud.com' });
  }
  const numbers = new Set();
  for (const name of Object.keys(env)) {
    const m = /^GENESYS_ORG_(\d+)_CLIENT_ID$/.exec(name);
    if (m) numbers.add(Number(m[1]));
  }
  for (const n of [...numbers].sort((a, b) => a - b)) {
    const p = `GENESYS_ORG_${n}_`;
    if (!env[`${p}CLIENT_SECRET`]) continue;
    configs.push({ key: `org${n}`, label: env[`${p}LABEL`] || null, clientId: env[`${p}CLIENT_ID`], clientSecret: env[`${p}CLIENT_SECRET`], region: env[`${p}REGION`] || 'mypurecloud.com' });
  }
  return configs;
}

const orgs = new Map(); // key -> { key, label, region, client }
for (const c of readOrgConfigs()) orgs.set(c.key, { key: c.key, label: c.label, region: c.region, client: createClient(c) });

function getOrg(key) {
  const org = key ? orgs.get(key) : orgs.values().next().value;
  if (!org) throw Object.assign(new Error(key ? `Unknown org "${key}"` : 'No Genesys org is configured. Set GENESYS_CLIENT_ID and GENESYS_CLIENT_SECRET.'), { status: 400 });
  return org;
}

// Public list for the org picker: labels and regions only, never credentials.
async function listOrgs() {
  return Promise.all(
    [...orgs.values()].map(async (o) => {
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
