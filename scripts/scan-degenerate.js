// Finds degenerate agent messages; with --repair, truncates each affected date at the first bad message
// and re-queues it so the remaining turns and the judge run again.
import "dotenv/config";
import { all, run } from "../src/db.js";
import { looksDegenerate } from "../src/llm.js";
const msgs = await all("SELECT id, conversation_id, content FROM messages ORDER BY id");
const firstBad = new Map();
for (const m of msgs) if (looksDegenerate(m.content) && !firstBad.has(m.conversation_id)) firstBad.set(m.conversation_id, m.id);
console.log(`${msgs.length} messages scanned, ${firstBad.size} dates affected:`, [...firstBad.keys()].join(", "));
if (process.argv.includes("--repair")) {
  for (const [cid, mid] of firstBad) {
    await run("DELETE FROM messages WHERE conversation_id = ? AND id >= ?", [cid, mid]);
    await run("UPDATE conversations SET status='dating', rank=NULL, judge_report=NULL, judge_model=NULL, judging_time=NULL, judging_ms=NULL, error=NULL, locked_until=0 WHERE id=?", [cid]);
  }
  console.log("repaired: truncated and re-queued");
}
