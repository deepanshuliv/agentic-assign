// Copy the local SQLite demo run into Turso (same schema, same ids).
//   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/migrate-to-turso.js data/app.db
import { createClient } from "@libsql/client";
import { SCHEMA } from "../src/db.js";
const src = createClient({ url: `file:${process.argv[2] || "data/app.db"}` });
const dst = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
await dst.executeMultiple(SCHEMA);
await dst.execute("ALTER TABLE users ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0").catch(() => {});
for (const t of ["messages", "conversations", "agents", "profiles", "users"]) await dst.execute(`DELETE FROM ${t}`);
for (const t of ["users", "profiles", "agents", "conversations", "messages"]) {
  const rs = await src.execute(`SELECT * FROM ${t}`);
  const cols = rs.columns;
  const stmts = rs.rows.map((r) => ({ sql: `INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, args: cols.map((c) => r[c]) }));
  for (let i = 0; i < stmts.length; i += 50) await dst.batch(stmts.slice(i, i + 50), "write");
  const n = (await dst.execute(`SELECT COUNT(*) n FROM ${t}`)).rows[0].n;
  console.log(`${t}: ${rs.rows.length} -> ${n}`);
}
