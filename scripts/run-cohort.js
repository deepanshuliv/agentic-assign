// Scrape + analyze the cohort in data/cohort.json, then run every compatible date.
//   node scripts/run-cohort.js              full run (resumable: re-run to continue)
//   node scripts/run-cohort.js --dates-only
import "dotenv/config";
import fs from "node:fs";
import { all, one, run } from "../src/db.js";
import { createUser } from "../src/users.js";
import { beginIngest, advanceUser } from "../src/analyze.js";
import { scheduleDates, stepConversation } from "../src/dating.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONC = Number(process.env.DATE_CONCURRENCY) || 12;
const FLOOR = Number(process.env.CREDIT_FLOOR) || 0.05; // keep this much OpenRouter credit for the live site
async function creditLeft() {
  try {
    const r = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } });
    return (await r.json()).data.limit_remaining ?? Infinity;
  } catch { return Infinity; }
}

async function pool(items, n, fn) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) await fn(q.shift()); }));
}

if (!process.argv.includes("--dates-only")) {
  const cohort = JSON.parse(fs.readFileSync("data/cohort.json", "utf8"));
  for (const p of cohort) {
    try { await createUser(p); } catch (e) { if (e.status !== 409) throw e; }
  }
  // already-scraped people who failed analysis only need the analysis step again
  await run("UPDATE users SET status='analyzing', error=NULL, attempts=0 WHERE status='error' AND email IS NULL AND id IN (SELECT user_id FROM profiles)");
  const pending = await all("SELECT id FROM users WHERE status IN ('pending','error') AND email IS NULL");
  if (pending.length) { console.log(`Scraping ${pending.length} people…`); await beginIngest(pending.map((r) => r.id)); }
  for (;;) {
    const todo = await all("SELECT id, name, status FROM users WHERE status IN ('scraping','analyzing')");
    if (!todo.length) break;
    await pool(todo.map((t) => t.id), 6, (id) => advanceUser(id));
    const s = await all("SELECT status, COUNT(*) n FROM users GROUP BY status");
    console.log(s.map((r) => `${r.status}:${r.n}`).join("  "));
    if (todo.every((t) => t.status === "scraping")) await sleep(8000);
  }
  for (const u of await all("SELECT name, error FROM users WHERE status='error'")) console.log(`  ✗ ${u.name}: ${u.error}`);
}

if (process.argv.includes("--ingest-only")) process.exit(0);
await scheduleDates(null);
for (;;) {
  const open = await all("SELECT id FROM conversations WHERE status != 'done' AND (error IS NULL OR error NOT LIKE 'Invalid%')");
  if (!open.length) break;
  console.log(`${open.length} dates still running…`);
  await pool(open.map((c) => c.id), CONC, async (id) => {
    if ((await creditLeft()) < FLOOR) { console.log(`Stopping: OpenRouter credit below $${FLOOR}`); process.exit(1); }
    for (let i = 0; i < 30; i++) {
      const r = await stepConversation(id);
      if (r.status === "done") { if (r.rank != null) console.log(`  ★ date ${id} judged ${r.rank.toFixed(4)}`); return; }
      if (r.status === "error" || r.status === "busy") return;
    }
  });
}
const d = await one("SELECT COUNT(*) n, AVG(rank) avg FROM conversations WHERE status='done'");
console.log(`Done: ${d.n} judged dates, average score ${Number(d.avg).toFixed(4)}`);
