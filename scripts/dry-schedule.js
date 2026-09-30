import "dotenv/config";
import { all } from "../src/db.js";
import { scheduleDates } from "../src/dating.js";
console.log("created", await scheduleDates(null));
const rows = await all(`SELECT u.name, COUNT(c.id) n FROM users u JOIN agents a ON a.user_id=u.id LEFT JOIN conversations c ON a.id IN (c.agent_a_id,c.agent_b_id) GROUP BY u.id ORDER BY n`);
console.log(rows.map((r) => `${r.name}:${r.n}`).join(", "));
const mix = await all(`SELECT SUM(ua.sex<>ub.sex) mixed, COUNT(*) total FROM conversations c JOIN agents a ON a.id=c.agent_a_id JOIN users ua ON ua.id=a.user_id JOIN agents b ON b.id=c.agent_b_id JOIN users ub ON ub.id=b.user_id`);
console.log(mix[0]);
