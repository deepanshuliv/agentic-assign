import "dotenv/config";
import { one, run } from "../src/db.js";
import { stepConversation } from "../src/dating.js";
const key = async () => (await (await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } })).json()).data.limit_remaining;
const [a, b] = process.argv.slice(2).map(Number);
const [x, y] = a < b ? [a, b] : [b, a];
await run("INSERT OR IGNORE INTO conversations (agent_a_id, agent_b_id, max_turns) VALUES (?, ?, ?)", [x, y, Number(process.env.MAX_TURNS) || 12]);
const c = await one("SELECT id FROM conversations WHERE agent_a_id=? AND agent_b_id=?", [x, y]);
const before = await key(); const t = Date.now();
for (;;) { const r = await stepConversation(c.id); if (r.message) console.log(`${r.message.sender_name}: ${r.message.content}`); if (r.status === "done" || r.status === "error") { console.log(r); break; } }
await new Promise((r) => setTimeout(r, 4000));
console.log(`cost $${(before - (await key())).toFixed(5)} in ${((Date.now() - t) / 1000).toFixed(0)}s`);
