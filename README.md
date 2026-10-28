# ava-reporting

Reporting for Genesys Cloud Agentic Virtual Agents (AVAs). This is dashboard v2: it covers only the AVA part of each session. For every AVA session it lists the intents the customer raised and whether the AVA gave a valid response to each one. Classic bot metrics (containment, recognition failures, exit reasons) and the Escalations tab are in v1, kept on the `release-v1.0.0` branch.

## What's on the dashboard

- **Filters**: Genesys org, date range (up to the last 10 days, since that is all the turn data Genesys keeps), AVA, channel, intent, valid response to all intents (yes, no, customer left first, no request, not analyzed yet), intent response (has a valid, partly valid or not valid one), Genesys flags, and preview sessions (left out by default). Filters apply to every panel and are kept in the URL.
- **Key metrics**: AVA sessions, sessions with a valid response to all intents, intents with a valid response, intents detected (and per session), tool call success, guardrail blocks, sessions where the customer asked for a person, and median AVA reply time.
- **Intents**: each intent with its sessions and how many responses were valid, partly valid, not valid, or cut off because the customer left. Select a row to filter.
- **How the AVA responded to each intent**: the four verdicts across all intents. Select one to filter.
- **AVAs**: the same per AVA (all versions together), with tool calls, tool failures and guardrail blocks.
- **AVA sessions**: sortable, searchable by conversation ID, exportable to CSV. Each row shows the intents in the order raised, colored by verdict (hover for Claude's reason), and whether every intent got a valid response. Selecting a session opens each intent with its verdict and reason, and the AVA-only transcript with tool calls, guardrail events and reply times.

These are on the **Overview** tab. The definitions behind each number are at the bottom of the page.

**Journey Flows** (second tab) draws every session's intents as a flow graph: from Start, through the first, second, third intent and so on in the order the customer raised them, to the session's outcome (valid to all intents, not valid to all, or customer left first). Node and line thickness is the number of sessions, and each node shows its share of all sessions with intents. Hover a node or line to trace its sessions through the rest of the graph and see counts in a tooltip. Click it to focus the graph on just those sessions; it re-lays itself out, and focuses can be stacked or removed. Intent chips above the graph show only the sessions that include any (or all) of the selected intents. Steps beyond the chosen number fold into "More intents", and less common intents at each step fold into "Other intents". Below the graph, the most common full journeys are listed with their share and valid-to-all rate; selecting one focuses the graph on it. The same filters apply to both tabs.

### Where the intents and verdicts come from

Genesys does not record an intent on AVA turns (it only does for classic NLU bot steps), so `server/ava.js` sends each session's AVA transcript to Claude, which lists the intents and judges the response to each as valid, partly valid, not valid, or customer left first. The transcript includes what Genesys recorded on each turn (tool calls and their status, guardrail blocks, errors, the customer saying nothing). Long digit runs such as card numbers and PINs are masked first. Claude is shown the intent names already used for the same AVA so a request keeps the same name across sessions.

This only runs when `ANTHROPIC_API_KEY` is set. Analyses run in the background, newest sessions first, up to `MAX_AVA_ANALYSES` per date range load (press Refresh to continue), and the page fills in as they finish. Each session is analyzed once and saved in `data/ava-analyses.json`; it is redone only if more turns arrive. Without a key, sessions still show Genesys's own flags.

## How it works

```
browser ── /api/ava, /api/ava/session ──▶ Node server ── OAuth client credentials ──▶ Genesys Cloud
                                                   └──── masked AVA transcripts ──▶ Claude (optional)
```

| Data | Genesys API |
| --- | --- |
| Bot names and flow types; preview sessions | `POST /api/v2/analytics/bots/aggregates/query` |
| Every AVA turn in the range (turns whose ask action carries `agentDetails`) | `GET /api/v2/analytics/botflows/{botId}/reportingturns?interval=…` for each bot |
| Drill-down transcript | `GET /api/v2/analytics/botflows/{botId}/reportingturns?sessionId=…` |

The browser receives the AVA session rows for the date range and computes every panel locally (`public/metrics.js`). Turn data is cached on the server for two minutes.

## Running it

Requires Node 20 or later.

```sh
npm install            # the Anthropic SDK, used for the intent analysis
cp .env.example .env   # fill in the Genesys OAuth client
npm start              # same as: node --env-file=.env server/index.js → http://127.0.0.1:3000
```

The OAuth client needs read access to analytics (bot aggregates and bot reporting turns).

| Variable | Default | Purpose |
| --- | --- | --- |
| `GENESYS_ORGS` and `GENESYS_<NAME>_*` | – | Orgs for the org picker (see [Several orgs](#several-orgs)) |
| `GENESYS_CLIENT_ID`, `GENESYS_CLIENT_SECRET` | – | Single-org client credentials |
| `GENESYS_REGION` | `mypurecloud.com` | Region domain, such as `usw2.pure.cloud` |
| `HOST`, `PORT` | `127.0.0.1`, `3000` | Where the server listens |
| `DASHBOARD_USER`, `DASHBOARD_PASSWORD` | unset | Turn on HTTP basic auth. Set these, or put the app behind SSO, before exposing it beyond your machine. |
| `MAX_RANGE_DAYS` | `92` | Longest date range allowed |
| `MAX_TURN_PAGES_PER_BOT` | `40` | Pages of 250 turns read per bot |
| `EXCLUDE_BOT_TYPES` | `VOICESURVEY` | Bot flow types left out of the report |
| `MASK_SENSITIVE` | `true` | Mask long digit runs and sensitive slots in transcripts |
| `CACHE_TTL_SECONDS` | `120` | Server-side cache lifetime |
| `ANTHROPIC_API_KEY` | unset | Turns on the intent analysis (sends masked AVA transcripts to Anthropic) |
| `AVA_MODEL` | `claude-opus-5-5` | Claude model used for the analysis |
| `AVA_ANALYSIS` | on | Set to `off` to stop sending transcripts even when a key is set |
| `MAX_AVA_ANALYSES` | `300` | Sessions analyzed per date range load, newest first |
| `AVA_CACHE_FILE` | `data/ava-analyses.json` | Where saved analyses are kept |

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

Variable names use the org name in uppercase, with spaces and other symbols turned into `_`. The org picker shows the names in the order listed; credentials never reach the browser. With `GENESYS_ORGS` unset, the single-org `GENESYS_CLIENT_ID`, `GENESYS_CLIENT_SECRET` and `GENESYS_REGION` are used.

## Tests

```sh
npm test
```
