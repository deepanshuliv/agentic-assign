// Edge-case tests for the API and core logic. Uses a throwaway SQLite file; no Apify/LLM calls.
//   npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const DB = "data/test.db";
fs.rmSync(DB, { force: true });
process.env.DATABASE_URL = `file:${DB}`;
process.env.TURSO_DATABASE_URL = "";
process.env.APIFY_API_TOKEN = ""; // scraping must fail cleanly, never hit the network
process.env.SESSION_SECRET = "test-secret";
process.env.MAX_TURNS = "99"; // must be capped to 25

const { app } = await import("../src/app.js");
const { run, one, lease, release } = await import("../src/db.js");
const { linkedinHandle, instagramHandle } = await import("../src/scrape.js");
const { orientationCompatible, scheduleDates, MAX_TURNS, HARD_TURN_CAP } = await import("../src/dating.js");

let server, base;
before(async () => {
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(DB, { force: true }); });

const call = async (path, { method = "GET", body, cookie } = {}) => {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null), cookie: r.headers.get("set-cookie")?.split(";")[0] };
};
const person = (n, extra = {}) => ({
  name: `Test Person ${n}`, sex: "female", orientation: "straight", email: `p${n}@example.com`, password: "hunter2hunter2",
  linkedin_url: `https://www.linkedin.com/in/test-person-${n}/`, instagram_url: `https://www.instagram.com/test.person${n}/`, ...extra,
});

test("LinkedIn URL parsing: accepts variants, rejects non-profiles", () => {
  assert.equal(linkedinHandle("https://www.linkedin.com/in/Jane-Doe-123/?utm_source=x"), "jane-doe-123");
  assert.equal(linkedinHandle("linkedin.com/in/janedoe"), "janedoe");
  assert.equal(linkedinHandle("https://in.linkedin.com/in/janedoe#about"), "janedoe");
  assert.equal(linkedinHandle("https://www.linkedin.com/in/j%C3%B6rg-m/"), "jörg-m");
  for (const bad of ["", "https://www.linkedin.com/company/acme", "https://example.com/in/jane", "https://www.linkedin.com/in/a/", "not a url"])
    assert.throws(() => linkedinHandle(bad), /LinkedIn/);
});

test("Instagram URL parsing: accepts profiles and @handles, rejects posts/reels", () => {
  assert.equal(instagramHandle("https://www.instagram.com/Some.User_1/?hl=en"), "some.user_1");
  assert.equal(instagramHandle("instagram.com/someuser"), "someuser");
  assert.equal(instagramHandle("https://m.instagram.com/someuser"), "someuser");
  assert.equal(instagramHandle("@someuser"), "someuser");
  for (const bad of ["https://www.instagram.com/p/Cx123/", "https://www.instagram.com/reel/abc", "https://instagram.com/explore", "https://facebook.com/someuser", ""])
    assert.throws(() => instagramHandle(bad), /Instagram/);
});

test("orientation compatibility is checked in both directions", () => {
  const f = (o) => ({ sex: "female", orientation: o }), m = (o) => ({ sex: "male", orientation: o });
  assert.equal(orientationCompatible(f("straight"), m("straight")), true);
  assert.equal(orientationCompatible(f("straight"), f("straight")), false);
  assert.equal(orientationCompatible(m("gay"), m("gay")), true);
  assert.equal(orientationCompatible(m("gay"), f("straight")), false);
  assert.equal(orientationCompatible(f("bisexual"), f("gay")), true);
  assert.equal(orientationCompatible(f("bisexual"), m("gay")), false); // he is not interested in her
  assert.equal(orientationCompatible(f("unspecified"), m("straight")), true);
  assert.equal(orientationCompatible(f("unspecified"), f("straight")), false);
});

test("turn limit is hard-capped at 25", () => {
  assert.equal(HARD_TURN_CAP, 25);
  assert.equal(MAX_TURNS, 25);
});

test("signup validates every field with a field-specific error", async () => {
  const cases = [
    [{ name: "" }, "name"], [{ sex: "other" }, "sex"], [{ orientation: "x" }, "orientation"], [{ age: 17 }, "age"], [{ age: "abc" }, "age"],
    [{ linkedin_url: "https://linkedin.com/company/x" }, "linkedin_url"], [{ instagram_url: "https://instagram.com/p/abc" }, "instagram_url"],
    [{ email: "nope" }, "email"], [{ password: "short" }, "password"],
  ];
  for (const [patch, field] of cases) {
    const r = await call("/api/signup", { method: "POST", body: person(1, patch) });
    assert.equal(r.status, 400, JSON.stringify(patch));
    assert.equal(r.body.field, field);
  }
});

test("signup succeeds, sets a session, and scraping failure is reported cleanly", async () => {
  const r = await call("/api/signup", { method: "POST", body: person(1) });
  assert.equal(r.status, 201);
  assert.ok(r.cookie?.startsWith("ph_session="));
  const me = await call("/api/me", { cookie: r.cookie });
  assert.equal(me.body.user.name, "Test Person 1");
  assert.equal(me.body.user.status, "error"); // no Apify token in tests
  assert.match(me.body.user.error, /APIFY_API_TOKEN/);
  assert.equal(me.body.user.email, undefined, "email never leaks through the API");
});

test("duplicates: same email, same LinkedIn, same Instagram are rejected", async () => {
  let r = await call("/api/signup", { method: "POST", body: person(2, { email: "P1@example.com" }) });
  assert.equal(r.status, 409); assert.equal(r.body.field, "email");
  r = await call("/api/signup", { method: "POST", body: person(3, { linkedin_url: "https://www.linkedin.com/in/TEST-PERSON-1" }) });
  assert.equal(r.status, 409); assert.ok(r.body.existing_id);
  r = await call("/api/signup", { method: "POST", body: person(4, { instagram_url: "@test.person1" }) });
  assert.equal(r.status, 409);
});

test("login: wrong password and unknown email get the same 401", async () => {
  const a = await call("/api/login", { method: "POST", body: { email: "p1@example.com", password: "wrong-password" } });
  const b = await call("/api/login", { method: "POST", body: { email: "ghost@example.com", password: "whatever123" } });
  assert.equal(a.status, 401); assert.equal(b.status, 401); assert.equal(a.body.error, b.body.error);
  const ok = await call("/api/login", { method: "POST", body: { email: " P1@Example.com ", password: "hunter2hunter2" } });
  assert.equal(ok.status, 200);
});

test("tampered or missing session cookies are treated as logged out", async () => {
  const ok = await call("/api/login", { method: "POST", body: { email: "p1@example.com", password: "hunter2hunter2" } });
  const [name, val] = ok.cookie.split("=");
  const [uid, exp, sig] = val.split(".");
  assert.equal((await call("/api/me", { cookie: `${name}=${Number(uid) + 1}.${exp}.${sig}` })).body.user, null);
  assert.equal((await call("/api/me", { cookie: `${name}=garbage` })).body.user, null);
  assert.equal((await call("/api/me/retry", { method: "POST" })).status, 401);
});

test("fixing links re-validates and blocks stealing someone else's profile", async () => {
  const s = await call("/api/signup", { method: "POST", body: person(5) });
  const me = await call("/api/login", { method: "POST", body: { email: "p1@example.com", password: "hunter2hunter2" } });
  let r = await call("/api/me/links", { method: "POST", cookie: me.cookie, body: { linkedin_url: "https://www.linkedin.com/in/test-person-5/", instagram_url: "@fresh.handle" } });
  assert.equal(r.status, 409);
  r = await call("/api/me/links", { method: "POST", cookie: me.cookie, body: { linkedin_url: "bad", instagram_url: "@fresh.handle" } });
  assert.equal(r.status, 400); assert.equal(r.body.field, "linkedin_url");
  r = await call("/api/me/links", { method: "POST", cookie: me.cookie, body: { linkedin_url: "https://www.linkedin.com/in/new-slug/", instagram_url: "@fresh.handle" } });
  assert.equal(r.status, 200);
  assert.ok(s.cookie);
});

test("bad ids and unknown routes return clean JSON errors", async () => {
  assert.equal((await call("/api/users/abc")).status, 400);
  assert.equal((await call("/api/users/999999")).status, 404);
  assert.equal((await call("/api/conversations/0")).status, 400);
  assert.equal((await call("/api/conversations/424242")).status, 404);
});

test("stepping a missing date is a 4xx/5xx JSON error, never a crash", async () => {
  const r = await call("/api/conversations/424242/step", { method: "POST" });
  assert.ok(r.status >= 400); assert.ok(r.body.error);
  assert.equal((await call("/api/nope")).status, 404);
});

test("schema: conversations enforce a < b, uniqueness, rank range and the 25-turn cap", async () => {
  for (const [n, sex] of [[10, "female"], [11, "male"], [12, "male"]]) {
    const { id } = await run(`INSERT INTO users (name, sex, orientation, instagram_handle, linkedin_handle, linkedin_url, instagram_url, status)
      VALUES (?, ?, 'straight', ?, ?, 'x', 'y', 'ready')`, [`U${n}`, sex, `ig${n}`, `li${n}`]);
    await run("INSERT INTO agents (user_id, system_prompt) VALUES (?, 'p')", [id]);
  }
  const ids = (await import("../src/db.js")).all;
  const agents = (await ids("SELECT id FROM agents ORDER BY id")).map((r) => r.id);
  const [a, b] = agents.slice(-3);
  await assert.rejects(run("INSERT INTO conversations (agent_a_id, agent_b_id) VALUES (?, ?)", [b, a]), /CHECK/);
  await run("INSERT INTO conversations (agent_a_id, agent_b_id) VALUES (?, ?)", [a, b]);
  await assert.rejects(run("INSERT INTO conversations (agent_a_id, agent_b_id) VALUES (?, ?)", [a, b]), /UNIQUE/);
  await assert.rejects(run("UPDATE conversations SET rank = 10.5 WHERE agent_a_id = ?", [a]), /CHECK/);
  await assert.rejects(run("UPDATE conversations SET max_turns = 26 WHERE agent_a_id = ?", [a]), /CHECK/);
});

test("scheduleDates only pairs orientation-compatible agents and is idempotent", async () => {
  await run("DELETE FROM conversations");
  const first = await scheduleDates(null);
  assert.equal(first, 2); // U10 (f) with U11 and U12 (m); U11 and U12 are straight men, no date
  assert.equal(await scheduleDates(null), 0);
});

test("leases: only one worker can hold a date at a time", async () => {
  const c = await one("SELECT id FROM conversations LIMIT 1");
  assert.equal(await lease("conversations", c.id, 10_000), true);
  assert.equal(await lease("conversations", c.id, 10_000), false);
  await release("conversations", c.id);
  assert.equal(await lease("conversations", c.id, 10_000), true);
  await release("conversations", c.id);
});

test("rankings and work queue endpoints respond with arrays", async () => {
  const w = await call("/api/work");
  assert.ok(Array.isArray(w.body) && w.body.length >= 1);
  assert.ok(Array.isArray((await call("/api/rankings")).body));
  assert.ok(Array.isArray((await call("/api/conversations?status=active")).body));
});
