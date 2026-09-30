import { ApifyClient } from "apify-client";

export const LINKEDIN_ACTOR = process.env.APIFY_LINKEDIN_ACTOR || "harvestapi/linkedin-profile-scraper";
export const INSTAGRAM_ACTOR = process.env.APIFY_INSTAGRAM_ACTOR || "apify/instagram-profile-scraper";
const LI_BATCH = 10; // Apify free plan caps this actor at 10 items per run

const apify = () => {
  if (!process.env.APIFY_API_TOKEN) throw new Error("APIFY_API_TOKEN is not set");
  return new ApifyClient({ token: process.env.APIFY_API_TOKEN });
};

// ---- URL parsing -------------------------------------------------------------------
const RESERVED_IG = new Set(["p", "reel", "reels", "stories", "explore", "tv", "accounts", "direct", "about", "legal", "developer"]);

export function linkedinHandle(input) {
  const s = String(input || "").trim();
  const m = s.match(/^(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/(?:mwlite\/)?in\/([^/?#\s]+)/i);
  if (!m) throw new Error("Enter a LinkedIn profile URL like https://www.linkedin.com/in/your-name");
  const h = decodeURIComponent(m[1]).toLowerCase();
  if (!/^[\p{L}\p{N}_-]{3,100}$/u.test(h)) throw new Error("That LinkedIn profile URL looks malformed");
  return h;
}

export function instagramHandle(input) {
  const s = String(input || "").trim();
  const m = s.match(/^(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/([^/?#\s]+)/i) || s.match(/^@([A-Za-z0-9._]{1,30})$/);
  if (!m) throw new Error("Enter an Instagram profile URL like https://www.instagram.com/yourhandle");
  const h = m[1].toLowerCase();
  if (RESERVED_IG.has(h)) throw new Error("That is an Instagram post or page link, not a profile. Paste the profile URL.");
  if (!/^[a-z0-9._]{1,30}$/.test(h)) throw new Error("That Instagram handle looks malformed");
  return h;
}

// ---- Apify runs (started async, polled later: serverless friendly) ------------------------
export async function startRuns(users) {
  const client = apify();
  const liRuns = [];
  for (let i = 0; i < users.length; i += LI_BATCH) {
    const batch = users.slice(i, i + LI_BATCH);
    const run = await client.actor(LINKEDIN_ACTOR).start({
      profileScraperMode: "Profile details no email ($4 per 1k)",
      queries: batch.map((u) => u.linkedin_url),
    });
    liRuns.push(...batch.map(() => run.id));
  }
  const ig = await client.actor(INSTAGRAM_ACTOR).start({ usernames: users.map((u) => u.instagram_handle) });
  return users.map((u, i) => ({ id: u.id, li_run_id: liRuns[i], ig_run_id: ig.id }));
}

const TERMINAL_FAIL = new Set(["FAILED", "ABORTED", "TIMED-OUT", "TIMED_OUT"]);

/** Returns {state: 'running'|'failed'|'done', items?} */
export async function checkRun(runId) {
  const client = apify();
  const run = await client.run(runId).get();
  if (!run) return { state: "failed", error: "Scrape run not found" };
  if (TERMINAL_FAIL.has(run.status)) return { state: "failed", error: `Scrape run ${run.status.toLowerCase()}` };
  if (run.status !== "SUCCEEDED") return { state: "running" };
  const { items } = await client.dataset(run.defaultDatasetId).listItems({ clean: true });
  return { state: "done", items };
}

export function findLinkedIn(items, handle) {
  return items.find((it) => {
    if (it.publicIdentifier?.toLowerCase() === handle) return true;
    const q = it.originalQuery?.query || it.query || "";
    try { return linkedinHandle(q) === handle; } catch { return false; }
  });
}
export const findInstagram = (items, handle) => items.find((it) => it.username?.toLowerCase() === handle);

// ---- normalisation: keep only what the analyst needs ---------------------------------------
export function slimLinkedIn(p) {
  const pick = (arr, n, f) => (Array.isArray(arr) ? arr.slice(0, n).map(f) : []);
  return {
    name: [p.firstName, p.lastName].filter(Boolean).join(" "),
    headline: p.headline,
    about: p.about?.slice(0, 2500),
    location: p.location?.linkedinText || p.location?.parsed?.text,
    experiences: pick(p.experience, 10, (e) => ({
      title: e.position, company: e.companyName, duration: e.duration, dates: [e.startDate?.text, e.endDate?.text].filter(Boolean).join(" to "),
      description: e.description?.slice(0, 500),
    })),
    education: pick(p.education, 5, (e) => ({ school: e.schoolName, degree: [e.degree, e.fieldOfStudy].filter(Boolean).join(", "), period: e.period || [e.startDate?.text, e.endDate?.text].filter(Boolean).join(" to ") })),
    skills: pick(p.skills, 25, (s) => s.name),
    languages: pick(p.languages, 6, (l) => l.name || l.language || l),
    honors: pick(p.honorsAndAwards, 5, (h) => [h.title, h.issuedBy, h.issuedAt].filter(Boolean).join(", ")),
    volunteering: pick(p.volunteering, 5, (v) => [v.role || v.position, v.organizationName || v.companyName].filter(Boolean).join(" at ")),
    causes: p.causes,
    followers: p.followerCount,
  };
}

export function slimInstagram(p) {
  return {
    username: p.username,
    fullName: p.fullName,
    biography: p.biography,
    externalUrl: p.externalUrl,
    followers: p.followersCount,
    posts: p.postsCount,
    category: p.businessCategoryName,
    verified: p.verified,
    latestPosts: (p.latestPosts || []).slice(0, 12).map((x) => ({
      type: x.type,
      caption: x.caption?.slice(0, 500),
      hashtags: x.hashtags?.slice(0, 10),
      location: x.locationName,
      date: x.timestamp?.slice(0, 10),
      alt: x.alt,
      imageUrl: x.displayUrl,
    })),
  };
}

/** Download an image and return a data: URL (Instagram/LinkedIn CDN links expire within days). */
export async function toDataUrl(url, maxBytes = 400_000) {
  if (!url) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes) return null;
    return `data:${r.headers.get("content-type") || "image/jpeg"};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}
