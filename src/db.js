import { createClient } from "@libsql/client";

// Turso in production (libsql://…), a local SQLite file in dev. Same SQL either way.
export const client = createClient({
  url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || "file:data/app.db",
  authToken: process.env.TURSO_AUTH_TOKEN || process.env.DATABASE_AUTH_TOKEN,
});

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  age              INTEGER CHECK (age IS NULL OR age BETWEEN 18 AND 100),
  sex              TEXT    NOT NULL CHECK (sex IN ('male','female')),
  orientation      TEXT    NOT NULL DEFAULT 'unspecified'
                   CHECK (orientation IN ('straight','gay','bisexual','unspecified')),
  rank             INTEGER,                      -- pool-wide rank by average judge score (1 = best)
  instagram_handle TEXT    NOT NULL UNIQUE,
  linkedin_handle  TEXT    NOT NULL UNIQUE,
  linkedin_url     TEXT    NOT NULL,
  instagram_url    TEXT    NOT NULL,
  agent_initiated  INTEGER NOT NULL DEFAULT 0 CHECK (agent_initiated IN (0,1)),
  email            TEXT    UNIQUE COLLATE NOCASE, -- NULL for seeded cohort members (no login)
  password_hash    TEXT,
  status           TEXT    NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','scraping','analyzing','ready','error')),
  error            TEXT,
  li_run_id        TEXT,
  ig_run_id        TEXT,
  locked_until     INTEGER NOT NULL DEFAULT 0,
  attempts         INTEGER NOT NULL DEFAULT 0,  -- analysis retries after transient model/network errors
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  linkedin_raw  TEXT,
  instagram_raw TEXT,
  analysis      TEXT,
  photo_url     TEXT,
  headline      TEXT,
  analyzed_at   TEXT
);

CREATE TABLE IF NOT EXISTS agents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  system_prompt TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_a_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  agent_b_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status       TEXT    NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','dating','judging','done','error')),
  max_turns    INTEGER NOT NULL DEFAULT 12 CHECK (max_turns BETWEEN 2 AND 25),
  rank         REAL    CHECK (rank IS NULL OR rank BETWEEN 0 AND 10),  -- judge score, 4 dp
  llm_model    TEXT,
  judge_model  TEXT,
  judging_time TEXT,
  judging_ms   INTEGER,
  judge_report TEXT,
  error        TEXT,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (agent_a_id < agent_b_id),
  UNIQUE (agent_a_id, agent_b_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_b ON conversations(agent_b_id);
CREATE INDEX IF NOT EXISTS idx_conv_status ON conversations(status);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  content         TEXT    NOT NULL,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_msg_sender ON messages(sender_agent_id);
`;

let ready;
export const init = () =>
  (ready ??= (async () => {
    await client.execute("PRAGMA foreign_keys = ON");
    await client.executeMultiple(SCHEMA);
    // additive migrations for databases created by earlier versions
    await client.execute("ALTER TABLE users ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0").catch(() => {});
  })());

const plain = (rs) => rs.rows.map((r) => Object.fromEntries(rs.columns.map((c) => [c, r[c]])));

export async function all(sql, args = []) {
  await init();
  return plain(await client.execute({ sql, args }));
}
export async function one(sql, args = []) {
  return (await all(sql, args))[0] ?? null;
}
export async function run(sql, args = []) {
  await init();
  const r = await client.execute({ sql, args });
  return { changes: r.rowsAffected, id: r.lastInsertRowid != null ? Number(r.lastInsertRowid) : null };
}

export const json = (s) => (s ? JSON.parse(s) : null);

/** Row-level lease so concurrent serverless invocations never double-process a row. */
export async function lease(table, id, ms) {
  const now = Date.now();
  const r = await run(`UPDATE ${table} SET locked_until = ? WHERE id = ? AND locked_until < ?`, [now + ms, id, now]);
  return r.changes === 1;
}
export const release = (table, id) => run(`UPDATE ${table} SET locked_until = 0 WHERE id = ?`, [id]);

const USER_COLS = `u.id, u.name, u.age, u.sex, u.orientation, u.rank, u.status, u.error, u.linkedin_url, u.instagram_url,
  u.instagram_handle, u.linkedin_handle, u.agent_initiated, u.created_at, (u.email IS NOT NULL) AS has_account,
  p.photo_url, p.headline, a.id AS agent_id`;
const USER_JOIN = `FROM users u LEFT JOIN profiles p ON p.user_id = u.id LEFT JOIN agents a ON a.user_id = u.id`;

export async function getUser(id) {
  const u = await one(`SELECT ${USER_COLS}, p.analysis ${USER_JOIN} WHERE u.id = ?`, [id]);
  if (u) u.analysis = json(u.analysis);
  return u;
}

export const listUsers = () => all(`SELECT ${USER_COLS} ${USER_JOIN} ORDER BY u.rank IS NULL, u.rank, u.id`);

/** Every date this user took part in, best match first. */
export async function rankingFor(userId) {
  const rows = await all(
    `SELECT c.id AS conversation_id, c.rank AS score, c.status, c.judge_report,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS turns, c.max_turns,
            o.id AS user_id, o.name, o.age, o.sex, o.rank AS pool_rank, p.photo_url, p.headline
     FROM users me
     JOIN agents ma ON ma.user_id = me.id
     JOIN conversations c ON ma.id IN (c.agent_a_id, c.agent_b_id)
     JOIN agents oa ON oa.id = CASE WHEN c.agent_a_id = ma.id THEN c.agent_b_id ELSE c.agent_a_id END
     JOIN users o ON o.id = oa.user_id
     LEFT JOIN profiles p ON p.user_id = o.id
     WHERE me.id = ?
     ORDER BY c.rank IS NULL, c.rank DESC, o.id`,
    [userId]
  );
  let pos = 0;
  return rows.map((r) => {
    const report = json(r.judge_report);
    return { ...r, judge_report: report, position: r.score != null ? ++pos : null };
  });
}

/** users.rank = position in the whole pool by average judge score. */
export async function recomputeUserRanks() {
  const rows = await all(
    `SELECT u.id, AVG(c.rank) AS avg FROM users u JOIN agents a ON a.user_id = u.id
     JOIN conversations c ON a.id IN (c.agent_a_id, c.agent_b_id) AND c.rank IS NOT NULL
     GROUP BY u.id ORDER BY avg DESC`
  );
  await init();
  await client.batch(rows.map((r, i) => ({ sql: "UPDATE users SET rank = ? WHERE id = ?", args: [i + 1, r.id] })), "write");
}

/** For each person `userId` dated: where I rank them, and where they rank me (both 1 = best). */
export async function mutualPositions(userId) {
  const rows = await all(
    `WITH pairs AS (
       SELECT a.user_id AS me, b.user_id AS other, c.rank FROM conversations c
         JOIN agents a ON a.id = c.agent_a_id JOIN agents b ON b.id = c.agent_b_id WHERE c.rank IS NOT NULL
       UNION ALL
       SELECT b.user_id, a.user_id, c.rank FROM conversations c
         JOIN agents a ON a.id = c.agent_a_id JOIN agents b ON b.id = c.agent_b_id WHERE c.rank IS NOT NULL
     ), pos AS (
       SELECT me, other, ROW_NUMBER() OVER (PARTITION BY me ORDER BY rank DESC, other) AS position,
              COUNT(*) OVER (PARTITION BY me) AS total FROM pairs
     )
     SELECT mine.other AS user_id, mine.position AS my_rank_of_them, theirs.position AS their_rank_of_me, theirs.total AS their_total
     FROM pos mine JOIN pos theirs ON theirs.me = mine.other AND theirs.other = mine.me
     WHERE mine.me = ?`,
    [userId]
  );
  return Object.fromEntries(rows.map((r) => [r.user_id, r]));
}
