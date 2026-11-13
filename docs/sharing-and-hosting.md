# Sharing the dashboard: per-viewer sign-in, HTTPS hosting and the turn-data archive

Version 4 lets other people open the dashboard, including as a tab inside Genesys Cloud, each with their own Genesys permissions. It also keeps AVA turn data beyond the roughly ten days Genesys holds it, so date ranges of 30, 60 and 90 days work.

Nothing here needs an ATO-style shared service: an agency or customer runs its own copy on its own HTTPS server (on premises or in its own approved cloud), signs in to its own Genesys org, and uses its own approved LLM (see Bedrock in the README).

## 1. How sign-in works

| `SIGN_IN` | Who the server calls Genesys as | Use it for |
| --- | --- | --- |
| `server` (default) | The server's own OAuth client (client credentials). Everyone who can open the page sees the same data. | One person on their own computer, as before. |
| `genesys` | Each viewer. The page signs them in to Genesys Cloud and the server calls Genesys with their own token, so their roles and divisions decide what they see. | Sharing the dashboard, and the Genesys Cloud Client App tab. |

With `SIGN_IN=genesys`:

- The browser uses the OAuth Authorization Code grant with PKCE, so no client secret is involved in signing in. The token lives only in that browser tab (sessionStorage) and in the server's memory; nothing is written to disk.
- The server checks each token once with Genesys (`GET /api/v2/tokens/me`): it must have been issued to this dashboard's sign-in client, and to the expected org when `GENESYS_<NAME>_ORG_ID` is set.
- Someone already signed in to Genesys Cloud (for example, opening the Client App tab) goes straight through without seeing a login page.
- Cached results are kept per viewer, so nobody is shown data fetched with someone else's permissions.
- Claude's saved intent analyses are shared, but each viewer only sees analyses for the sessions their own Genesys query returns.

## 2. Genesys Cloud setup (an admin does this once per org)

### OAuth client for sign-in

Admin > Integrations > OAuth > Add Client:

- App name: `AVA Dashboard sign-in`
- Grant type: **Code Authorization** (used with PKCE). If your org can't use it, choose **Token Implicit Grant (Browser)** instead and set `GENESYS_<NAME>_SIGNIN_GRANT=implicit`.
- Authorized redirect URIs: the dashboard's exact address, for example `https://ava.example.gov/`. It must match what the browser shows, including the trailing slash, and must be HTTPS (`http://127.0.0.1:3000/` works for local testing).
- Scopes: `analytics:readonly` and `users:readonly`.

Put the new client's ID in `GENESYS_<NAME>_SIGNIN_CLIENT_ID`. Its secret is not needed.

### Viewer permissions

Each viewer's Genesys role needs view access to bot analytics and conversation detail. In the role editor these are under Analytics: the bot aggregate, bot flow reporting turn and conversation detail view permissions. A viewer without them sees a message saying a permission is missing. Division access applies as it does everywhere in Genesys.

### Client App tab (optional)

Admin > Integrations > Add Integration > Client Application:

- Application URL: the dashboard address, for example `https://ava.example.gov/?theme=light` (`theme` is optional: `light`, `dark` or `auto`).
- Application Type: standalone.
- **Group Filtering: select at least one group.** An empty group filter hides the app from everyone.
- The tab appears under Apps in the left navigation.

The server allows Genesys Cloud's own domains in every region (including FedRAMP, `*.us-gov-pure.cloud`) to show it in a frame, and no one else. Change this with `FRAME_ANCESTORS` if needed.

## 3. Hosting it on HTTPS

Requirements: Node 20 or later, an HTTPS address viewers' browsers can reach, and a persistent `data/` folder (saved analyses and the turn archive).

```sh
git clone https://github.com/jchadcole/ava-reporting.git && cd ava-reporting
npm ci
cp .env.example .env    # fill in, or use op:// references with 1Password
```

Minimal `.env` for a shared, single-org install:

```sh
SIGN_IN=genesys
GENESYS_ORGS=SC12
GENESYS_SC12_REGION=mypurecloud.com
GENESYS_SC12_SIGNIN_CLIENT_ID=<sign-in client ID>
# Optional but recommended: the server's own client, used only by the daily archive
GENESYS_SC12_CLIENT_ID=<client credentials ID>
GENESYS_SC12_CLIENT_SECRET=<client credentials secret>
HOST=0.0.0.0
PORT=443
TLS_CERT_FILE=/etc/ava/cert.pem
TLS_KEY_FILE=/etc/ava/key.pem
```

Two ways to get HTTPS:

1. **Built in.** Set `TLS_CERT_FILE` and `TLS_KEY_FILE` (PEM). Use a certificate from your organization's CA or Let's Encrypt.
2. **Behind a reverse proxy or load balancer** (nginx, Caddy, IIS, an AWS ALB or Azure App Gateway) that ends TLS. Keep `HOST=127.0.0.1` (or the private address the proxy reaches), leave the TLS variables unset and set `TRUST_PROXY=true`. With Caddy, for example:

   ```
   ava.example.gov {
     reverse_proxy 127.0.0.1:3000
   }
   ```

Start it the same way as before, as a service so it restarts on its own:

```sh
op run --env-file=.env -- node server/index.js     # 1Password
node --env-file=.env server/index.js                # plain .env
```

A systemd unit, for example:

```
[Service]
WorkingDirectory=/opt/ava-reporting
ExecStart=/usr/bin/node --env-file=/opt/ava-reporting/.env server/index.js
Restart=always
User=ava
```

`DASHBOARD_USER` and `DASHBOARD_PASSWORD` (basic auth) still work and can sit in front of Genesys sign-in, but they're not needed with `SIGN_IN=genesys`.

## 4. FedRAMP and other government orgs

- Set the org's region to its Genesys domain, for example `GENESYS_GOV_REGION=use2.us-gov-pure.cloud`. Sign-in then uses `login.use2.us-gov-pure.cloud` and API calls go to `api.use2.us-gov-pure.cloud`.
- Create the sign-in OAuth client in that org (section 2).
- Government orgs are never sent to Anthropic's commercial API. Use `LLM_PROVIDER=bedrock` with AWS GovCloud, or leave analysis off.
- The archive and saved analyses stay on the agency's own server.

## 5. The daily turn-data archive

Genesys appears to return bot reporting turns only for about the last ten days. The archive saves each finished UTC day to `data/turns/<org>/<YYYY-MM-DD>.json`, with customer text masked the same way as on screen (`MASK_SENSITIVE`). The dashboard reads days older than `ARCHIVE_LIVE_DAYS` from the archive and the rest live, and offers 30, 60 and 90-day ranges once an org has saved days.

- It runs inside the server: 10 seconds after start, then every `ARCHIVE_EVERY_HOURS` (12). Each run saves any day in the last `ARCHIVE_BACKFILL_DAYS` (9) that is missing, and saves each day again until 36 hours after it ends, so late turns and hand-offs land.
- It uses the server's own OAuth client (`CLIENT_ID` and `CLIENT_SECRET`) because it runs with nobody signed in. Orgs without one are skipped.
- It can also run on its own from cron or a task scheduler, for example daily at 02:00:

  ```
  0 2 * * * cd /opt/ava-reporting && node --env-file=.env server/archive.js
  ```

- It only saves days still inside Genesys's window, so history starts the day it's first turned on. A day missed by more than about nine days can't be recovered.
- Size: in GenesysSC12, a day of 25 to 115 AVA sessions was 0.1 to 1.1 MB. Files older than `ARCHIVE_KEEP_DAYS` (400) are deleted.
- Access with `SIGN_IN=genesys`: archived sessions are shown only for bots the viewer's own Genesys query returns for that period, so someone without bot analytics access sees none. Genesys can't re-check finer, per-conversation division rules for days it no longer holds, so treat the archive as visible to anyone with bot analytics access.
- Turn it off with `ARCHIVE=off`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SIGN_IN` | `server` | `genesys` for per-viewer sign-in |
| `GENESYS_<NAME>_SIGNIN_CLIENT_ID` | – | Sign-in OAuth client (Code Authorization) |
| `GENESYS_<NAME>_SIGNIN_GRANT` | `pkce` | `implicit` for a Token Implicit Grant client |
| `GENESYS_<NAME>_ORG_ID` | unset | Only accept sign-ins to this Genesys org ID |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | unset | Serve HTTPS directly |
| `TRUST_PROXY` | `false` | Behind a TLS-ending proxy (sends HSTS when the proxy says HTTPS) |
| `FRAME_ANCESTORS` | Genesys Cloud domains | Who may show the page in a frame |
| `ARCHIVE` | `on` | `off` to stop saving turn data |
| `ARCHIVE_DIR` | `data/turns` | Where saved days go |
| `ARCHIVE_LIVE_DAYS` | `7` | Days read live from Genesys before the archive is used |
| `ARCHIVE_BACKFILL_DAYS` | `9` | How far back each run looks for missing days |
| `ARCHIVE_EVERY_HOURS` | `12` | How often the server runs it |
| `ARCHIVE_KEEP_DAYS` | `400` | Saved days kept |

For a single org without `GENESYS_ORGS`, use `GENESYS_SIGNIN_CLIENT_ID`, `GENESYS_SIGNIN_GRANT` and `GENESYS_ORG_ID`.
