
import "dotenv/config";
const fs = await import("node:fs");
const { all } = await import("../src/db.js");
const { createUser } = await import("../src/users.js");
const { beginIngest, advanceUser } = await import("../src/analyze.js");
const { stepConversation, getConversation } = await import("../src/dating.js");
const people = JSON.parse(fs.readFileSync(process.argv[2]));
const ids = []; for (const p of people) ids.push(await createUser(p));
let t = Date.now(); await beginIngest(ids);
for (;;) {
  for (const id of ids) await advanceUser(id);
  const s = await all("SELECT id, name, status, error FROM users");
  console.log(((Date.now()-t)/1000|0)+"s", s.map(x=>`${x.name}:${x.status}${x.error?' '+x.error:''}`).join(" | "));
  if (s.every(x => x.status === "ready" || x.status === "error")) break;
  await new Promise(r => setTimeout(r, 5000));
}
const a = await all("SELECT user_id, analysis FROM profiles");
console.log(JSON.stringify(JSON.parse(a[0].analysis), null, 1).slice(0, 2500));
const [c] = await all("SELECT id FROM conversations");
t = Date.now();
for (let i = 0; i < 10; i++) { const r = await stepConversation(c.id); console.log(((Date.now()-t)/1000).toFixed(1)+"s", r.status, r.message ? `${r.message.sender_name}: ${r.message.content}` : (r.rank ?? r.error ?? "")); if (r.status === "done" || r.status==="error") break; }
const conv = await getConversation(c.id);
console.log(JSON.stringify(conv.judge_report, null, 1), conv.rank, conv.judging_ms);
