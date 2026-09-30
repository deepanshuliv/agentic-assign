import { z } from "zod";
import { all, one, run, getUser, lease, release } from "./db.js";
import { MODELS, structured } from "./llm.js";
import { startRuns, checkRun, findLinkedIn, findInstagram, slimLinkedIn, slimInstagram, toDataUrl } from "./scrape.js";
import { scheduleDates } from "./dating.js";

const Trait = z.object({
  label: z.string().describe("short name of the trait, e.g. 'Ultramarathons'"),
  evidence: z.string().describe("the concrete caption, job, bio line or photo that supports it"),
  source: z.enum(["linkedin", "instagram", "both"]),
  confidence: z.enum(["high", "medium", "low"]),
});

export const AnalysisSchema = z.object({
  identity_check: z.object({
    same_person: z.enum(["yes", "unclear", "no"]).describe("do the LinkedIn and Instagram clearly belong to the same person?"),
    reason: z.string(),
  }),
  summary: z.string().describe("3-4 sentence portrait of the person as a potential partner"),
  age_estimate: z.number().nullable().describe("best guess from graduation years, career length etc; null if unknown"),
  location: z.string().nullable(),
  career: z.object({ current_role: z.string(), trajectory: z.string(), industry: z.string() }),
  education: z.string().nullable(),
  ambition: z.object({ level: z.enum(["very high", "high", "moderate", "relaxed"]), evidence: z.string() }),
  needs: z.array(Trait).describe("3-6 things this person needs from a partner and relationship, inferred with evidence"),
  hobbies: z.array(Trait).describe("3-6 hobbies"),
  interests: z.array(Trait).describe("3-6 interests"),
  values: z.array(Trait).describe("2-5 values"),
  personality: z.object({
    traits: z.array(z.string()),
    communication_style: z.string(),
    social_energy: z.enum(["introvert", "ambivert", "extrovert"]),
    humor: z.string(),
  }),
  lifestyle: z.string().describe("pace of life, travel, fitness, family, nightlife vs homebody"),
  green_flags: z.array(z.string()),
  potential_friction: z.array(z.string()).describe("things that could clash with a partner"),
  ideal_partner: z.string(),
  first_date_idea: z.string(),
  conversation_hooks: z.array(z.string()).describe("topics they would light up talking about"),
});

const ANALYST_SYSTEM = `You are an expert matchmaker-analyst. You read exactly two public sources about one person: their LinkedIn profile and their Instagram profile. From them you build a dating profile.

Rules:
- Use ONLY the two sources provided. No outside knowledge about the person, even if they are well known.
- Every need, hobby, interest and value cites concrete evidence (a caption, a job, a bio line, a photo you were shown) and names its source.
- "Needs" are inferred: what kind of partner and relationship would let this person thrive (for example "a partner who respects 5am podcast recordings", because of the evidence). Be honest about confidence.
- Be specific, not generic: "runs ultramarathons, 7 so far" beats "likes fitness".
- If a source is thin, say less rather than invent. Follower counts are not personality.
- identity_check: compare names, bios, photos and roles across the two sources. Keep the reason to 1-2 sentences.
- Keep every field concise: labels of 2-5 words, evidence of one sentence, career fields of one sentence each.
- Write plain prose without em-dashes.`;

async function buildContent(u, li, ig, withImages) {
  const content = [];
  if (withImages) {
    const imgs = (await Promise.all((ig.latestPosts || []).slice(0, 6).map((p) => toDataUrl(p.imageUrl)))).filter(Boolean).slice(0, 4);
    for (const url of imgs) content.push({ type: "image_url", image_url: { url } });
  }
  const igText = { ...ig, latestPosts: ig.latestPosts?.map(({ imageUrl, ...rest }) => rest) };
  content.push({
    type: "text",
    text: `Person: ${u.name}\n\n<linkedin>\n${JSON.stringify(li)}\n</linkedin>\n\n<instagram>\n${JSON.stringify(igText)}\n</instagram>\n\n${
      content.length ? `The ${content.length} image(s) above are their most recent Instagram posts.\n` : ""
    }Build their dating profile.`,
  });
  return content;
}

export function personaSystemPrompt(u, a) {
  const first = u.name.split(" ")[0];
  return `You are ${first}'s personal dating agent. You are on a first date, a text conversation, with another person's agent, and you speak AS ${first}, in first person, on ${first}'s behalf.

Everything you know about ${first} comes from their public LinkedIn and Instagram, analyzed here:
<profile>
Name: ${u.name}${u.age ? `, ${u.age}` : ""}. Sex: ${u.sex}.
${JSON.stringify(a)}
</profile>

Your goal: find out honestly whether ${first} and this person are genuinely compatible, and make a great impression while doing it.

How to date well:
- Every message: react to what they just said, share something real and specific about ${first} (a hobby, a project, a trip, an ambition from the profile), then ask ONE sharp question.
- Ask the best possible questions: ones that reveal hobbies, interests, background, ambition, values and lifestyle fit. No generic interview questions like "what do you do for fun?". Prefer "You mentioned X, what pulled you into it?" or "Where do you want to be in five years, and does a partner fit that picture?"
- Answer their questions directly, in ${first}'s own voice and communication style (${a.personality?.communication_style || "natural"}).
- Be warm, curious and a little playful, but truthful. Never invent facts about ${first} that the profile does not support. If asked something unknown, stay consistent with the profile or say you would rather share that in person.
- Probe gently for dealbreakers: pace of life, ambition, location, what they need from a partner.
- Keep each message short: 1 to 3 sentences, like real texting. No lists, no stage directions, no hashtags, no em-dashes, at most one emoji.
- Never share contact details and never commit ${first} to a real-world meeting.
- The date has a strict turn limit shown to you. On your final message, wrap up gracefully and say honestly whether you would like a second date.`;
}

async function fail(id, error) {
  await run("UPDATE users SET status = 'error', error = ?, locked_until = 0 WHERE id = ?", [String(error).slice(0, 500), id]);
}

/** Start scraping for a set of users (one Apify run batch for all of them). */
export async function beginIngest(ids) {
  if (!ids.length) return;
  const users = await all(`SELECT id, linkedin_url, instagram_handle FROM users WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
  try {
    const runs = await startRuns(users);
    for (const r of runs)
      await run("UPDATE users SET status='scraping', error=NULL, attempts=0, li_run_id=?, ig_run_id=?, locked_until=0 WHERE id=?", [r.li_run_id, r.ig_run_id, r.id]);
  } catch (e) {
    for (const u of users) await fail(u.id, `Could not start scraping: ${e.message}`);
  }
}

/**
 * Move one user forward through scraping -> analyzing -> ready. Idempotent and lease-guarded,
 * so the browser (or the cohort script) can call it repeatedly from any serverless instance.
 */
export async function advanceUser(id) {
  const u = await one("SELECT * FROM users WHERE id = ?", [id]);
  if (!u) throw new Error("Not found");
  if (u.status === "pending") { await beginIngest([id]); return; }
  if (u.status === "ready" || u.status === "error") return;
  if (!(await lease("users", id, 240_000))) return; // someone else is working on it

  try {
    if (u.status === "scraping") {
      const [li, ig] = await Promise.all([checkRun(u.li_run_id), checkRun(u.ig_run_id)]);
      if (li.state === "failed") return fail(id, `LinkedIn: ${li.error}`);
      if (ig.state === "failed") return fail(id, `Instagram: ${ig.error}`);
      if (li.state !== "done" || ig.state !== "done") return release("users", id);

      const liItem = findLinkedIn(li.items, u.linkedin_handle);
      const igItem = findInstagram(ig.items, u.instagram_handle);
      if (!liItem || liItem.error || !liItem.firstName) return fail(id, "LinkedIn profile not found or not public. Check the URL.");
      if (!igItem || igItem.error) return fail(id, "Instagram profile not found. Check the handle.");
      if (igItem.private) return fail(id, "This Instagram profile is private. Only public profiles can be read.");

      const sl = slimLinkedIn(liItem), si = slimInstagram(igItem);
      const photo = (await toDataUrl(igItem.profilePicUrl)) || (await toDataUrl(liItem.photo, 250_000));
      await run(
        `INSERT INTO profiles (user_id, linkedin_raw, instagram_raw, photo_url, headline) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET linkedin_raw=excluded.linkedin_raw, instagram_raw=excluded.instagram_raw,
           photo_url=excluded.photo_url, headline=excluded.headline`,
        [id, JSON.stringify(sl), JSON.stringify(si), photo, sl.headline || null]
      );
      await run("UPDATE users SET status = 'analyzing' WHERE id = ?", [id]);
    }
    await analyze(id);
  } catch (e) {
    console.error(`[advance ${id}]`, e);
    const cur = await one("SELECT status, attempts FROM users WHERE id = ?", [id]);
    // transient model/network hiccups: keep the profile and retry analysis on the next poll
    if (cur?.status === "analyzing" && cur.attempts < 3)
      await run("UPDATE users SET attempts = attempts + 1, locked_until = 0 WHERE id = ?", [id]);
    else await fail(id, e.message);
  }
}

async function analyze(id) {
  const u = await getUser(id);
  const p = await one("SELECT linkedin_raw, instagram_raw FROM profiles WHERE user_id = ?", [id]);
  const li = JSON.parse(p.linkedin_raw), ig = JSON.parse(p.instagram_raw);
  const ask = async (withImages) =>
    structured({ model: MODELS.analysis, system: ANALYST_SYSTEM, content: await buildContent(u, li, ig, withImages), schema: AnalysisSchema, name: "dating_profile" });
  let analysis;
  try { analysis = await ask(true); }
  catch (e) { console.warn(`[analyze ${id}] retry text-only: ${e.message}`); analysis = await ask(false); }

  await run("UPDATE profiles SET analysis = ?, analyzed_at = datetime('now') WHERE user_id = ?", [JSON.stringify(analysis), id]);
  const age = u.age || (analysis.age_estimate >= 18 && analysis.age_estimate <= 100 ? Math.round(analysis.age_estimate) : null);
  await run(
    `INSERT INTO agents (user_id, system_prompt) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET system_prompt = excluded.system_prompt`,
    [id, personaSystemPrompt({ ...u, age }, analysis)]
  );
  await run("UPDATE users SET status='ready', error=NULL, age=?, agent_initiated=1, attempts=0, locked_until=0 WHERE id=?", [age, id]);
  await scheduleDates(id); // the new agent immediately gets a date with every compatible agent
}
