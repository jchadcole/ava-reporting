# ava-reporting

Custom reporting for Genesys Cloud virtual agents (bots and AI Virtual Agents). One dashboard shows containment and intent performance, with a filterable list of every bot session underneath and a drill-down into each one.

## What's on the dashboard

- **Genesys org**: pick which org to report on when more than one is configured (see [Several orgs](#several-orgs)).
- **Filters**: date range (presets or custom, up to 92 days), virtual agent, channel, intent, outcome (contained or escalated), bot exit reason, recognition failure, intents per session (none, one, more than one), and preview sessions (test sessions from Architect's preview mode, left out by default). Filters apply to every panel and are kept in the URL, so a filtered view can be bookmarked.
- **Key metrics**: bot sessions, containment rate, sessions that reached an agent, query self-service rate, intent recognition rate, recognition failure rate, turns per session, median session length, and bot response time (median and longest).
- **Sessions per day**: contained versus escalated.
- **Why sessions left the bot**: Genesys bot results (customer asked to leave, bot handed back, customer disconnected, recognition failure exits, errors). Select a bar to filter.
- **Intent performance**: per intent, its sessions, matches (counting repeats within a session), share, containment, agent rate, turns, recognition failures, and how often it was the final intent.
- **Recognition failures**: no-match versus no-input.
- **Virtual agents**: the same metrics per bot, including median and longest bot response time.
- **Sessions**: sortable, searchable by conversation ID, exportable to CSV. Each session shows its intents in the order they were recognized (looping bots such as Navigator can match several) and its median and longest bot response time. Selecting a session opens its conversation path (call flow, bot, queue, agent, survey) and the turn-by-turn transcript with intents, confidence, slots, AVA tool calls and guardrail events. Card numbers, PINs and sensitive slot values are masked.

The definitions behind each number are at the bottom of the page.

**Check against Genesys** (top right) compares the dashboard's totals with Genesys's own analytics for the same org, time range and virtual agent: sessions, turns, exits, disconnects, recognition failures, self-served questions, conversations, conversations that reached an agent, and sessions per intent. Genesys's figures come from separate aggregate and conversation-detail queries (`server/verify.js`), so a mistake in how the dashboard merges or classifies sessions shows up as a difference.

## How it works

```
browser ── /api/dataset, /api/session ──▶ Node server ── OAuth client credentials ──▶ Genesys Cloud
```

The server is a small Node app with no dependencies. It holds the OAuth client secret and only makes read-only calls:

| Data | Genesys API |
| --- | --- |
| One row per bot session: turns, length, exit, intents, final intent, recognition failures, self-served queries | `POST /api/v2/analytics/bots/aggregates/query` grouped by `botSessionId` |
| Session start time and whether the conversation reached a queue or agent | `POST /api/v2/analytics/conversations/details/query` (segment `purpose=botflow`) |
| Drill-down conversation path | `GET /api/v2/analytics/conversations/{id}/details` |
| Bot response time per customer turn | `GET /api/v2/analytics/botflows/{botId}/reportingturns?interval=…` for each bot in the range |
| Drill-down transcript | `GET /api/v2/analytics/botflows/{botId}/reportingturns?sessionId=…` |

The browser receives the session rows for the selected date range once and computes every panel locally (`public/metrics.js`), so changing a filter is instant and all panels agree. Results are cached on the server for two minutes.

Containment uses conversation detail: a session is **contained** when the conversation never reached a queue or an agent. Conversation detail is capped (5,000 conversations by default); beyond that, a disconnect inside the bot counts as contained and an exit back to the flow counts as escalated, and the dashboard says how many sessions were estimated.

Bot response time is measured per customer turn, from when Genesys captured the customer's input (`dateCreated`) to when the bot had its reply ready (`dateCompleted`). In testing, Genesys returned turn-level data for only about the last 10 days, and sessions where the customer never replied have no turn to time, so the dashboard says how many sessions the figures cover.

## Running it

Requires Node 20 or later.

```sh
cp .env.example .env   # fill in the Genesys OAuth client
node --env-file=.env server/index.js   # http://127.0.0.1:3000
```

The OAuth client needs read access to analytics (conversation details, bot aggregates and bot reporting turns), flows and users.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GENESYS_ORGS` and `GENESYS_<NAME>_*` | – | Orgs for the org picker (see [Several orgs](#several-orgs)) |
| `GENESYS_CLIENT_ID`, `GENESYS_CLIENT_SECRET` | – | Single-org client credentials |
| `GENESYS_REGION` | `mypurecloud.com` | Region domain, such as `usw2.pure.cloud` |
| `HOST`, `PORT` | `127.0.0.1`, `3000` | Where the server listens |
| `DASHBOARD_USER`, `DASHBOARD_PASSWORD` | unset | Turn on HTTP basic auth. Set these, or put the app behind SSO, before exposing it beyond your machine. |
| `MAX_RANGE_DAYS` | `92` | Longest date range allowed |
| `MAX_DETAIL_CONVERSATIONS` | `5000` | Conversation detail cap per request |
| `MAX_TURN_PAGES_PER_BOT` | `40` | Pages of 250 turns read per bot for response times |
| `EXCLUDE_BOT_TYPES` | `VOICESURVEY` | Bot flow types left out of the report |
| `MASK_SENSITIVE` | `true` | Mask long digit runs and sensitive slots in transcripts |
| `CACHE_TTL_SECONDS` | `120` | Server-side cache lifetime |

## Several orgs

List the orgs in `GENESYS_ORGS`, then give each name its own OAuth client (client credentials grant, same read permissions) in `.env`, and restart the server:

```sh
GENESYS_ORGS=SC12,Acme

GENESYS_SC12_CLIENT_ID=...
GENESYS_SC12_CLIENT_SECRET=...
GENESYS_SC12_REGION=mypurecloud.com

GENESYS_ACME_CLIENT_ID=...
GENESYS_ACME_CLIENT_SECRET=...
GENESYS_ACME_REGION=usw2.pure.cloud
GENESYS_ACME_LABEL=Acme Health   # optional longer name for the picker
```

Variable names use the org name in uppercase, with spaces and other symbols turned into `_`. The org picker shows the names in the order listed; credentials never reach the browser. With `GENESYS_ORGS` unset, the single-org `GENESYS_CLIENT_ID`, `GENESYS_CLIENT_SECRET` and `GENESYS_REGION` are used. `SNAPSHOT_ORG=acme npm run snapshot` snapshots a specific org.

## Static snapshot

`npm run snapshot -- 30 60` writes `dist/ava-dashboard-snapshot.html`: the last 30 days with drill-downs for the 60 most recent sessions, as one HTML file that works without the server. Use it for sharing a point-in-time view; it contains real conversation data.

## Tests

```sh
npm test
```
