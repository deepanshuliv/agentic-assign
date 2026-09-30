// Records the demo video: one clip per segment (with captions), live signup of a real person,
// a live agent date, the judge, rankings and the dashboard. Output: video/clips/*.webm + video/clips/meta.json
//   node scripts/record-demo.js
import "dotenv/config";
import fs from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:3000";
const OUT = "video/clips";
const W = 1280, H = 720;
const DUR = JSON.parse(fs.readFileSync("video/durations.json", "utf8"));
const NEW = {
  linkedin_url: "https://www.linkedin.com/in/stevenbartlett-123/", instagram_url: "https://www.instagram.com/steven/",
  name: "Steven Bartlett", sex: "male", orientation: "unspecified", email: "demo@proxyhearts.app", password: "proxyhearts2026",
};
const CAPTIONS = {
  home: "Every real person gets an AI agent that dates on their behalf",
  pool: "Real people. Exactly two sources each: LinkedIn and a public Instagram",
  join: "Paste two links to create an agent (live, real person)",
  pipeline: "Apify scrapes both profiles, then the agent analyzes the person",
  profile: "The analysis: needs, hobbies, interests and values, each with evidence and source",
  raw: "The exact raw data the agent read, and nothing else",
  date: "Live: two agents on a date, one real LLM turn at a time",
  verdict: "The judge LLM scores six dimensions, saved to 4 decimal places",
  cohort: "A finished date from the 26-person pool",
  rankings: "Every person gets a ranking of who fits them best",
  me: "Logged-in dashboard: every connection, ranked both ways",
  how: "Apify for scraping, DeepSeek via OpenRouter for agents and judge, Vercel for hosting",
};

const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null; // re-record just these clips
const want = (n) => !ONLY || ONLY.has(n);
const RESUME = process.env.RESUME_FROM; // e.g. RESUME_FROM=date NEW_ID=27 to redo only the later clips
if (!RESUME) fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const meta = RESUME && fs.existsSync(`${OUT}/meta.json`) ? JSON.parse(fs.readFileSync(`${OUT}/meta.json`, "utf8")) : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, opts = {}) => (await fetch(BASE + path, { headers: { "Content-Type": "application/json" }, ...opts })).json();

const browser = await chromium.launch();
let storage;

async function segment(name, fn, { auth = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: "light",
    recordVideo: { dir: OUT, size: { width: W, height: H } }, ...(auth && storage ? { storageState: storage } : {}),
  });
  await ctx.addInitScript((cap) => {
    const put = () => {
      if (document.getElementById("__cap")) return;
      const el = document.createElement("div");
      el.id = "__cap"; el.textContent = cap;
      el.style.cssText = "position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:rgba(24,24,27,.9);color:#fff;padding:11px 20px;border-radius:14px;font:500 17px Geist,system-ui,sans-serif;max-width:1040px;text-align:center;z-index:99999;box-shadow:0 10px 30px rgba(0,0,0,.25);letter-spacing:-.01em";
      document.body.appendChild(el);
    };
    document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", put) : put();
  }, CAPTIONS[name]);
  const start = Date.now();
  const page = await ctx.newPage();
  const ready = async () => { meta[name] = { lead: (Date.now() - start) / 1000 }; return Date.now(); };
  const hold = async (t0, extra = 0.9) => { const left = (DUR[name] + extra) * 1000 - (Date.now() - t0); if (left > 0) await sleep(left); };
  await fn(page, { ready, hold });
  const video = page.video();
  await ctx.close();
  fs.renameSync(await video.path(), `${OUT}/${name}.webm`);
  meta[name].total = (Date.now() - start) / 1000;
  console.log(`recorded ${name} (${meta[name].total.toFixed(1)}s, lead ${meta[name].lead.toFixed(1)}s)`);
}

const scroll = (page, px, ms) =>
  page.evaluate(async ({ px, ms }) => {
    const steps = Math.max(1, Math.round(ms / 16)), dy = px / steps;
    for (let i = 0; i < steps; i++) { window.scrollBy(0, dy); await new Promise((r) => setTimeout(r, 16)); }
  }, { px, ms });
// pages that drive dates poll forever, so wait for rendered content rather than network idle
const goto = async (page, hash) => {
  await page.goto(`${BASE}/${hash}`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector("#app") && !document.querySelector("#app .sk"), null, { timeout: 20000 });
  await page.evaluate(() => document.fonts.ready); await sleep(700);
};

let newId = Number(process.env.NEW_ID);
if (RESUME) {
  // log back in to get the demo user's session for the dashboard clip
  const r = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: NEW.email, password: NEW.password }) });
  const [name, value] = r.headers.get("set-cookie").split(";")[0].split("=");
  storage = { cookies: [{ name, value, domain: new URL(BASE).hostname, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] };
} else {
// 1. home
await segment("home", async (page, { ready, hold }) => {
  await goto(page, "#/"); const t0 = await ready();
  await sleep(3500); await scroll(page, 520, 2200); await sleep(1200); await hold(t0);
});

// 2. pool
await segment("pool", async (page, { ready, hold }) => {
  await goto(page, "#/pool"); const t0 = await ready();
  await sleep(1200); await scroll(page, 1500, 7000); await hold(t0);
});

// 3. live signup
await segment("join", async (page, { ready, hold }) => {
  await goto(page, "#/join"); const t0 = await ready();
  await page.click("#f-linkedin_url"); await page.keyboard.type(NEW.linkedin_url, { delay: 22 });
  await page.click("#f-instagram_url"); await page.keyboard.type(NEW.instagram_url, { delay: 22 });
  await page.click("#f-name"); await page.keyboard.type(NEW.name, { delay: 40 });
  await page.selectOption("#f-sex", NEW.sex); await page.selectOption("#f-orientation", NEW.orientation);
  await scroll(page, 380, 900);
  await page.click("#f-email"); await page.keyboard.type(NEW.email, { delay: 25 });
  await page.click("#f-password"); await page.keyboard.type(NEW.password, { delay: 25 });
  await sleep(600);
  await page.click("button[type=submit]");
  await page.waitForURL(/#\/me/); await sleep(1800);
  storage = await page.context().storageState();
  await hold(t0, 0.3);
});
newId = (await (await fetch(`${BASE}/api/me`, { headers: { Cookie: storage.cookies.map((c) => `${c.name}=${c.value}`).join("; ") } })).json()).user.id;

// 4. pipeline progress
await segment("pipeline", async (page, { ready, hold }) => {
  await goto(page, "#/me"); const t0 = await ready();
  await sleep(2000); await hold(t0, 1.5);
}, { auth: true });

// (not recorded) wait for scrape + analysis to finish
for (let i = 0; i < 120; i++) {
  const r = await api(`/api/users/${newId}/advance`, { method: "POST" });
  if (i % 6 === 0) console.log("  pipeline:", r.status, r.error || "");
  if (r.status === "ready") break;
  if (r.status === "error") throw new Error(`Signup pipeline failed: ${r.error}`);
  await sleep(5000);
}

// 5. profile analysis
await segment("profile", async (page, { ready, hold }) => {
  await goto(page, `#/p/${newId}`); const t0 = await ready();
  await sleep(2500);
  const h = await page.evaluate(() => document.body.scrollHeight);
  await scroll(page, Math.min(h - 1400, 3400), 13000); await sleep(800); await hold(t0);
});

// 6. raw sources
await segment("raw", async (page, { ready, hold }) => {
  await goto(page, `#/p/${newId}`);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await sleep(500);
  const t0 = await ready();
  await page.click("details.raw summary"); await sleep(700);
  await scroll(page, 520, 2000); await hold(t0);
});

}

// 7. a live date for the new agent
const convs = await api(`/api/conversations?user=${newId}`);
const liveId = (convs.find((c) => c.status === "queued" && c.turns === 0) || convs[0]).id; // record a date from its first message
if (want("date")) await segment("date", async (page, { ready, hold }) => {
  await goto(page, `#/c/${liveId}`); const t0 = await ready();
  for (let i = 0; i < 90; i++) {
    const c = await api(`/api/conversations/${liveId}`);
    if (c.messages.length >= c.max_turns) break;
    await sleep(1000);
  }
  await sleep(1500); await hold(t0);
});

// 8. judge verdict
for (let i = 0; i < 60; i++) { const c = await api(`/api/conversations/${liveId}`); if (c.status === "done") break; if (c.status !== "judging") await api(`/api/conversations/${liveId}/step`, { method: "POST" }); await sleep(1500); }
if (want("verdict")) await segment("verdict", async (page, { ready, hold }) => {
  await goto(page, `#/c/${liveId}`); const t0 = await ready();
  await sleep(2500); await scroll(page, 500, 5000); await sleep(1000); await scroll(page, -500, 2500); await hold(t0);
});

// (not recorded) finish the new agent's other dates so the dashboard is complete
for (const c of convs.filter((c) => c.id !== liveId)) {
  for (let i = 0; i < 30; i++) { const r = await api(`/api/conversations/${c.id}/step`, { method: "POST" }); if (r.status === "done" || r.status === "error") break; }
}

// 9. a finished cohort date
const done = (await api("/api/conversations?status=done")).filter((c) => c.user_a_id !== newId && c.user_b_id !== newId).sort((a, b) => b.rank - a.rank);
if (want("cohort")) await segment("cohort", async (page, { ready, hold }) => {
  await goto(page, `#/c/${done[0].id}`); const t0 = await ready();
  await sleep(1500); await scroll(page, 900, 4000); await hold(t0);
});

// 10. rankings
if (want("rankings")) await segment("rankings", async (page, { ready, hold }) => {
  await goto(page, "#/rankings"); const t0 = await ready();
  await sleep(1500); await scroll(page, 1300, 4500); await hold(t0);
});

// 11. dashboard
if (want("me")) await segment("me", async (page, { ready, hold }) => {
  await goto(page, "#/me"); const t0 = await ready();
  await sleep(2500); await scroll(page, 380, 2500); await hold(t0);
}, { auth: true });

// 12. how it works
if (want("how")) await segment("how", async (page, { ready, hold }) => {
  await goto(page, "#/how"); const t0 = await ready();
  await sleep(1500); await scroll(page, 700, 4000); await hold(t0);
});

await browser.close();
fs.writeFileSync(`${OUT}/meta.json`, JSON.stringify(meta, null, 1));
console.log("done", Object.values(meta).reduce((s, m) => s + m.total - m.lead, 0).toFixed(1), "s of footage");
