import "dotenv/config";
import { run } from "../src/db.js";
import { advanceUser } from "../src/analyze.js";
const id = Number(process.argv[2] || 1);
await run("UPDATE users SET status='analyzing', locked_until=0 WHERE id=?", [id]);
const t = Date.now();
await advanceUser(id);
console.log(`analysis took ${((Date.now() - t) / 1000).toFixed(1)}s`);
