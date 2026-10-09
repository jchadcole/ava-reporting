'use strict';
// Writes dist/ava-dashboard-snapshot.html: the dashboard with a dataset and recent
// session drill-downs embedded, so it can be shared as a single static file.
// Usage: node scripts/snapshot.js [days=30] [detailSessions=60]

const fs = require('node:fs');
const path = require('node:path');
const { buildDataset } = require('../server/dataset');
const { getSessionDetail } = require('../server/detail');
const { mapLimit } = require('../server/genesys');

async function main() {
  const days = Number(process.argv[2]) || 30;
  const detailCount = Number(process.argv[3] ?? 60);
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  const dataset = await buildDataset(start.toISOString(), end.toISOString());

  // Prefer sessions with a transcript-worthy story: most recent first, with turns.
  const picks = dataset.sessions.filter((s) => s.turns > 1 && s.conversationId).slice(0, detailCount);
  const details = {};
  await mapLimit(picks, 4, async (s) => {
    details[s.id] = await getSessionDetail({ conversationId: s.conversationId, botId: s.botId, sessionId: s.id });
  });

  const pub = path.join(__dirname, '..', 'public');
  const read = (f) => fs.readFileSync(path.join(pub, f), 'utf8');
  const data = JSON.stringify({ dataset, details }).replace(/</g, '\\u003c');
  const html = read('index.html')
    .replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${read('styles.css')}\n</style>`)
    .replace('<script src="metrics.js"></script>', () => `<script>window.AVA_SNAPSHOT = ${data};</script>\n<script>\n${read('metrics.js')}\n</script>`)
    .replace('<script src="app.js"></script>', () => `<script>\n${read('app.js')}\n</script>`);

  const out = path.join(__dirname, '..', 'dist', 'ava-dashboard-snapshot.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`Wrote ${out}: ${dataset.sessions.length} sessions, ${Object.keys(details).length} drill-downs, ${(html.length / 1024).toFixed(0)} KB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
