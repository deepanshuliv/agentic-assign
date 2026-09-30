import express from "express";
import { all, one, run, getUser, listUsers, rankingFor, mutualPositions } from "./db.js";
import { advanceUser, beginIngest } from "./analyze.js";
import { stepConversation, getConversation, listConversations, scheduleDates, MAX_TURNS, HARD_TURN_CAP, WEIGHTS, DATES_PER_AGENT } from "./dating.js";
import { createUser, HttpError } from "./users.js";
import { session, setSession, clearSession, verifyPassword } from "./auth.js";
import { MODELS } from "./llm.js";

export const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(session);

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    if (!(e instanceof HttpError)) console.error(e);
    res.status(e.status || 500).json({ error: e.status ? e.message : "Something went wrong. Please try again.", field: e.field, existing_id: e.existing_id });
  });
const idParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Invalid id");
  return n;
};
const publicUser = ({ email, password_hash, li_run_id, ig_run_id, locked_until, ...u }) => u;

app.get("/api/config", (req, res) =>
  res.json({ max_turns: MAX_TURNS, hard_cap: HARD_TURN_CAP, dates_per_agent: DATES_PER_AGENT, weights: WEIGHTS, models: MODELS, scrapers: { linkedin: "harvestapi/linkedin-profile-scraper", instagram: "apify/instagram-profile-scraper" } })
);

app.get("/api/stats", wrap(async (req, res) => {
  const s = await one(`SELECT (SELECT COUNT(*) FROM users) AS people, (SELECT COUNT(*) FROM users WHERE status='ready') AS agents,
    (SELECT COUNT(*) FROM conversations WHERE status='done') AS dates_done, (SELECT COUNT(*) FROM conversations) AS dates_total,
    (SELECT COUNT(*) FROM messages) AS messages`);
  res.json(s);
}));

// ---- people ------------------------------------------------------------------------
// Profile photos are stored as data URLs (CDN links expire); serve them as cacheable images.
app.get("/api/photo/:id", wrap(async (req, res) => {
  const row = await one("SELECT photo_url FROM profiles WHERE user_id = ?", [idParam(req.params.id)]);
  const m = row?.photo_url?.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new HttpError(404, "No photo");
  res.set("Cache-Control", "public, max-age=86400, s-maxage=604800").type(m[1]).send(Buffer.from(m[2], "base64"));
}));

app.get("/api/users", wrap(async (req, res) => res.json(await listUsers())));

app.get("/api/users/:id", wrap(async (req, res) => {
  const id = idParam(req.params.id);
  const u = await getUser(id);
  if (!u) throw new HttpError(404, "Person not found");
  const [raw, ranking, mutual] = await Promise.all([
    one("SELECT linkedin_raw, instagram_raw FROM profiles WHERE user_id = ?", [id]), rankingFor(id), mutualPositions(id),
  ]);
  const strip = (ig) => ig && { ...ig, latestPosts: ig.latestPosts?.map(({ imageUrl, ...p }) => p) };
  res.json({
    ...u, is_me: req.userId === id,
    sources: raw?.linkedin_raw ? { linkedin: JSON.parse(raw.linkedin_raw), instagram: strip(JSON.parse(raw.instagram_raw)) } : null,
    ranking: ranking.map((r) => ({ ...r, their_rank_of_me: mutual[r.user_id]?.their_rank_of_me ?? null, their_total: mutual[r.user_id]?.their_total ?? null })),
  });
}));

// progress the scrape -> analyze pipeline (the page polls this while it waits)
app.post("/api/users/:id/advance", wrap(async (req, res) => {
  const id = idParam(req.params.id);
  await advanceUser(id);
  const u = await one("SELECT id, status, error FROM users WHERE id = ?", [id]);
  res.json(u);
}));

// ---- auth ----------------------------------------------------------------------------
app.post("/api/signup", wrap(async (req, res) => {
  const id = await createUser(req.body || {}, { account: true });
  setSession(res, id);
  await beginIngest([id]);
  res.status(201).json({ id });
}));

app.post("/api/login", wrap(async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const u = email && (await one("SELECT id, password_hash FROM users WHERE email = ?", [email]));
  if (!u || !verifyPassword(String(req.body?.password || ""), u.password_hash)) throw new HttpError(401, "Email or password is incorrect");
  setSession(res, u.id);
  res.json({ id: u.id });
}));

app.post("/api/logout", (req, res) => { clearSession(res); res.json({ ok: true }); });

app.get("/api/me", wrap(async (req, res) => {
  if (!req.userId) return res.json({ user: null });
  const u = await getUser(req.userId);
  if (!u) { clearSession(res); return res.json({ user: null }); }
  const [ranking, mutual] = await Promise.all([rankingFor(u.id), mutualPositions(u.id)]);
  res.json({
    user: u,
    connections: ranking.map((r) => ({ ...r, their_rank_of_me: mutual[r.user_id]?.their_rank_of_me ?? null, their_total: mutual[r.user_id]?.their_total ?? null })),
  });
}));

// fix links after an error (e.g. private Instagram), then re-read
app.post("/api/me/links", wrap(async (req, res) => {
  if (!req.userId) throw new HttpError(401, "Log in first");
  const { linkedinHandle, instagramHandle } = await import("./scrape.js");
  let li, ig;
  try { li = linkedinHandle(req.body?.linkedin_url); } catch (e) { throw new HttpError(400, e.message, { field: "linkedin_url" }); }
  try { ig = instagramHandle(req.body?.instagram_url); } catch (e) { throw new HttpError(400, e.message, { field: "instagram_url" }); }
  const clash = await one("SELECT id FROM users WHERE (linkedin_handle = ? OR instagram_handle = ?) AND id != ?", [li, ig, req.userId]);
  if (clash) throw new HttpError(409, "Those profiles already belong to someone else in the pool", { field: "linkedin_url" });
  const me = await one("SELECT status FROM users WHERE id = ?", [req.userId]);
  if (me.status === "scraping" || me.status === "analyzing") throw new HttpError(409, "Your agent is still reading your profiles");
  await run(`UPDATE users SET linkedin_handle=?, instagram_handle=?, linkedin_url=?, instagram_url=?, status='pending', error=NULL WHERE id=?`,
    [li, ig, `https://www.linkedin.com/in/${li}/`, `https://www.instagram.com/${ig}/`, req.userId]);
  await beginIngest([req.userId]);
  res.json({ ok: true });
}));

app.post("/api/me/retry", wrap(async (req, res) => {
  if (!req.userId) throw new HttpError(401, "Log in first");
  const me = await one("SELECT status FROM users WHERE id = ?", [req.userId]);
  if (me.status === "error") await beginIngest([req.userId]);
  else if (me.status === "ready") await scheduleDates(req.userId); // pick up anyone who joined since
  res.json({ ok: true });
}));

// ---- dates ------------------------------------------------------------------------------
app.get("/api/conversations", wrap(async (req, res) => {
  const where = [], args = [];
  if (req.query.user) { where.push("(ua.id = ? OR ub.id = ?)"); args.push(idParam(req.query.user), idParam(req.query.user)); }
  if (req.query.status === "active") where.push("c.status IN ('queued','dating','judging')");
  if (req.query.status === "done") where.push("c.status = 'done'");
  const rows = await listConversations(where.length ? `WHERE ${where.join(" AND ")}` : "", args);
  const limit = Math.min(Number(req.query.limit) || 500, 1000);
  res.json(rows.slice(0, limit));
}));

app.get("/api/conversations/:id", wrap(async (req, res) => {
  const c = await getConversation(idParam(req.params.id));
  if (!c) throw new HttpError(404, "Date not found");
  res.json(c);
}));

app.post("/api/conversations/:id/step", wrap(async (req, res) => res.json(await stepConversation(idParam(req.params.id)))));

/** Dates that still need turns; the browser engine drives them one step at a time. */
app.get("/api/work", wrap(async (req, res) => {
  const args = [Date.now()];
  let filter = "";
  if (req.query.user) { filter = "AND (aa.user_id = ? OR ab.user_id = ?)"; args.push(idParam(req.query.user), idParam(req.query.user)); }
  const rows = await all(
    `SELECT c.id FROM conversations c JOIN agents aa ON aa.id = c.agent_a_id JOIN agents ab ON ab.id = c.agent_b_id
     WHERE c.status IN ('queued','dating','judging') AND c.locked_until < ? AND (c.error IS NULL OR c.error NOT LIKE 'Invalid%') ${filter}
     ORDER BY CASE c.status WHEN 'queued' THEN 1 ELSE 0 END, c.id LIMIT 8`,
    args
  );
  res.json(rows.map((r) => r.id));
}));

app.get("/api/rankings", wrap(async (req, res) => {
  const users = (await listUsers()).filter((u) => u.status === "ready");
  const top = await all(
    `WITH pairs AS (
       SELECT a.user_id AS me, b.user_id AS other, c.id AS cid, c.rank FROM conversations c JOIN agents a ON a.id=c.agent_a_id JOIN agents b ON b.id=c.agent_b_id WHERE c.rank IS NOT NULL
       UNION ALL
       SELECT b.user_id, a.user_id, c.id, c.rank FROM conversations c JOIN agents a ON a.id=c.agent_a_id JOIN agents b ON b.id=c.agent_b_id WHERE c.rank IS NOT NULL)
     SELECT p.me, p.other, p.cid, p.rank, u.name, CASE WHEN pr.photo_url IS NULL THEN NULL ELSE '/api/photo/' || p.other END AS photo_url,
            ROW_NUMBER() OVER (PARTITION BY p.me ORDER BY p.rank DESC, p.other) AS position, COUNT(*) OVER (PARTITION BY p.me) AS total
     FROM pairs p JOIN users u ON u.id = p.other LEFT JOIN profiles pr ON pr.user_id = p.other`
  );
  const by = {};
  for (const r of top) (by[r.me] ??= []).push(r);
  res.json(users.map((u) => ({ ...publicUser(u), matches: (by[u.id] || []).sort((a, b) => a.position - b.position).map((m) => ({ user_id: m.other, name: m.name, photo_url: m.photo_url, score: m.rank, conversation_id: m.cid, position: m.position })) })));
}));

app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));
