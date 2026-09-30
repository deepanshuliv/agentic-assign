import { z } from "zod";
import { all, one, run, getUser, json, lease, release, recomputeUserRanks } from "./db.js";
import { MODELS, chat, structured } from "./llm.js";

export const HARD_TURN_CAP = 25;
export const MAX_TURNS = Math.max(2, Math.min(Number(process.env.MAX_TURNS) || 12, HARD_TURN_CAP));

/** Does A want B and B want A? 'unspecified' (seeded public figures) is treated as open to anyone. */
export function orientationCompatible(a, b) {
  const wants = (x, y) =>
    x.orientation === "bisexual" || x.orientation === "unspecified" ||
    (x.orientation === "straight" ? x.sex !== y.sex : x.sex === y.sex);
  return wants(a, b) && wants(b, a);
}

export const DATES_PER_AGENT = Math.max(1, Number(process.env.DATES_PER_AGENT) || 4);

/**
 * Queue dates so every agent gets up to DATES_PER_AGENT compatible partners. Partners with the fewest
 * dates so far are picked first, which spreads dates evenly across the pool (and keeps LLM spend bounded).
 * With userId, only that person's missing dates are added.
 */
export async function scheduleDates(userId = null) {
  const ready = await all("SELECT u.id, u.sex, u.orientation, a.id AS agent_id FROM users u JOIN agents a ON a.user_id = u.id WHERE u.status = 'ready' ORDER BY u.id");
  const pairs = await all("SELECT agent_a_id, agent_b_id FROM conversations");
  const key = (x, y) => (x < y ? `${x}-${y}` : `${y}-${x}`);
  const have = new Set(pairs.map((p) => key(p.agent_a_id, p.agent_b_id)));
  const count = new Map(ready.map((r) => [r.agent_id, 0]));
  for (const p of pairs) { count.set(p.agent_a_id, (count.get(p.agent_a_id) || 0) + 1); count.set(p.agent_b_id, (count.get(p.agent_b_id) || 0) + 1); }
  const people = userId ? ready.filter((r) => r.id === Number(userId)) : ready;
  let created = 0;
  for (let round = 0; round < DATES_PER_AGENT; round++) {
    for (const me of [...people].sort((a, b) => count.get(a.agent_id) - count.get(b.agent_id) || a.id - b.id)) {
      if (count.get(me.agent_id) >= DATES_PER_AGENT) continue;
      const partner = ready
        .filter((o) => o.agent_id !== me.agent_id && !have.has(key(me.agent_id, o.agent_id)) && orientationCompatible(me, o))
        .filter((o) => userId || count.get(o.agent_id) < DATES_PER_AGENT)
        .sort((a, b) => count.get(a.agent_id) - count.get(b.agent_id) || (a.sex === me.sex) - (b.sex === me.sex) || a.id - b.id)[0];
      if (!partner) continue;
      const [a, b] = me.agent_id < partner.agent_id ? [me.agent_id, partner.agent_id] : [partner.agent_id, me.agent_id];
      created += (await run("INSERT OR IGNORE INTO conversations (agent_a_id, agent_b_id, max_turns) VALUES (?, ?, ?)", [a, b, MAX_TURNS])).changes;
      have.add(key(a, b));
      count.set(a, count.get(a) + 1); count.set(b, count.get(b) + 1);
    }
  }
  return created;
}

/** The transcript as one agent sees it: its own lines are "assistant", the other side is "user". */
function perspective(transcript, meAgentId, otherName, turnNo, maxTurns) {
  const msgs = transcript.map((m) => ({
    role: m.sender_agent_id === meAgentId ? "assistant" : "user",
    content: m.sender_agent_id === meAgentId ? m.content : `${otherName}: ${m.content}`,
  }));
  const cue = turnNo >= maxTurns - 1
    ? `[Turn ${turnNo} of ${maxTurns}. This is YOUR LAST message on this date: wrap up warmly and say honestly whether you want a second date.]`
    : `[Turn ${turnNo} of ${maxTurns}]`;
  if (!msgs.length) msgs.push({ role: "user", content: `[The date begins. You are meeting ${otherName} for coffee. You speak first: open with something specific and inviting.] ${cue}` });
  else msgs[msgs.length - 1].content += `\n\n${cue}`;
  return msgs;
}

const clean = (t) =>
  t.replace(/^\s*\[[^\]]*\]\s*/, "")        // echoed turn cue
   .replace(/^\s*[\p{L} .'-]{1,40}:\s+/u, "") // "Name: " prefix
   .replace(/\s*[—–]\s*/g, ", ")            // house style: no em-dashes
   .replace(/^["']|["']$/g, "")
   .trim()
   .slice(0, 1200);

async function loadDate(id) {
  const c = await one("SELECT * FROM conversations WHERE id = ?", [id]);
  if (!c) throw new Error("Date not found");
  const agents = await all("SELECT id, user_id, system_prompt FROM agents WHERE id IN (?, ?)", [c.agent_a_id, c.agent_b_id]);
  const A = agents.find((x) => x.id === c.agent_a_id), B = agents.find((x) => x.id === c.agent_b_id);
  const [ua, ub] = await Promise.all([getUser(A.user_id), getUser(B.user_id)]);
  const transcript = await all("SELECT id, sender_agent_id, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id", [id]);
  return { c, A, B, ua, ub, transcript };
}

/**
 * Advance a date by exactly one step: one agent speaks, or (after the last turn) the judge scores it.
 * Lease-guarded so many browsers / instances can drive dates concurrently without double turns.
 */
export async function stepConversation(id) {
  const pre = await one("SELECT status FROM conversations WHERE id = ?", [id]);
  if (!pre) throw Object.assign(new Error("Date not found"), { status: 404 });
  if (pre.status === "done") return { status: "done" };
  if (!(await lease("conversations", id, 150_000))) return { status: "busy" };
  try {
    const { c, A, B, ua, ub, transcript } = await loadDate(id);
    const turn = transcript.length + 1;
    if (turn <= c.max_turns) {
      if (c.status !== "dating") await run("UPDATE conversations SET status='dating', llm_model=?, error=NULL WHERE id=?", [MODELS.agent, id]);
      // the lower agent id opens, then they strictly alternate
      const [me, meU, otherU] = turn % 2 ? [A, ua, ub] : [B, ub, ua];
      const first = (u) => u.name.split(" ")[0];
      let text = "";
      for (let tries = 0; tries < 2 && !text; tries++)
        text = clean(await chat({ system: me.system_prompt, messages: perspective(transcript, me.id, first(otherU), turn, c.max_turns), maxTokens: 320 }));
      if (!text) throw new Error("Agent produced an empty message");
      const m = await run("INSERT INTO messages (conversation_id, sender_agent_id, content) VALUES (?, ?, ?)", [id, me.id, text]);
      return { status: "dating", turn, max_turns: c.max_turns, message: { id: m.id, sender_agent_id: me.id, sender_name: meU.name, content: text } };
    }
    await run("UPDATE conversations SET status='judging' WHERE id=?", [id]);
    const rank = await judge(c, ua, ub, transcript, A.id);
    return { status: "done", rank };
  } catch (e) {
    console.error(`[date ${id}]`, e);
    await run("UPDATE conversations SET error=? WHERE id=?", [String(e.message).slice(0, 300), id]);
    return { status: "error", error: e.message };
  } finally {
    await release("conversations", id);
  }
}

const Score = z.number().describe("0.00 to 10.00 with two decimals");
export const JudgeSchema = z.object({
  orientation_compatible: z.boolean(),
  scores: z.object({ hobbies: Score, interests: Score, background: Score, ambition: Score, values_lifestyle: Score, vibe: Score }),
  shared_ground: z.array(z.string()).describe("specific common ground found in the profiles or surfaced during the date"),
  friction: z.array(z.string()),
  best_moment: z.string().describe("quote or paraphrase of the moment the date clicked, or failed to"),
  a_wants_second_date: z.boolean(),
  b_wants_second_date: z.boolean(),
  verdict: z.string().describe("2-3 sentence matchmaker verdict in plain words. Do not state any numeric score. No em-dashes."),
});

export const WEIGHTS = { hobbies: 0.15, interests: 0.15, background: 0.1, ambition: 0.2, values_lifestyle: 0.15, vibe: 0.25 };

const JUDGE_SYSTEM = `You are an impartial, experienced matchmaker judging a first date between two AI agents, each speaking for a real person. Your one goal: decide how compatible the two PEOPLE are, by finding real common ground and reading the vibe.

You get both profiles (derived only from each person's LinkedIn and Instagram), their sex and orientation, and the full transcript.

Score each dimension from 0.00 to 10.00 with two decimals. Use the full range and discriminate: 5 is average, 8+ is rare, below 3 means a real mismatch.
- hobbies: overlap or complementary fit of what they actually do
- interests: shared curiosities, topics and taste
- background: education, career, culture, location and life stage
- ambition: do their drive and life goals point the same way at the same pace?
- values_lifestyle: values, pace of life, social energy, priorities
- vibe: chemistry in the conversation itself: curiosity, humor, reciprocity, whether each one lit up

orientation_compatible is false if either person's orientation excludes the other's sex ("unspecified" means open). Judge the people, not the agents' charm. Penalise claims the profiles do not support.`;

async function judge(c, ua, ub, transcript, agentAId) {
  const t0 = Date.now();
  const lines = transcript.map((m) => `${m.sender_agent_id === agentAId ? ua.name : ub.name}: ${m.content}`).join("\n");
  const person = (u) => `Name: ${u.name} | age: ${u.age ?? "unknown"} | sex: ${u.sex} | orientation: ${u.orientation}\n${JSON.stringify(u.analysis)}`;
  const report = await structured({
    model: MODELS.judge, system: JUDGE_SYSTEM, name: "date_verdict", schema: JudgeSchema, reasoning: { enabled: false },
    content: `<person_a>\n${person(ua)}\n</person_a>\n\n<person_b>\n${person(ub)}\n</person_b>\n\n<date_transcript>\n${lines}\n</date_transcript>`,
  });
  const clamp = (v) => Math.max(0, Math.min(10, Number(v) || 0));
  let score = Object.entries(WEIGHTS).reduce((s, [k, w]) => s + w * clamp(report.scores[k]), 0);
  if (report.a_wants_second_date && report.b_wants_second_date) score += 0.25;
  else if (!report.a_wants_second_date && !report.b_wants_second_date) score -= 0.25;
  if (!report.orientation_compatible || !orientationCompatible(ua, ub)) score = 0;
  const rank = Number(clamp(score).toFixed(4));
  await run(
    `UPDATE conversations SET status='done', rank=?, judge_model=?, judging_time=?, judging_ms=?, judge_report=?, error=NULL WHERE id=?`,
    [rank, MODELS.judge, new Date().toISOString(), Date.now() - t0, JSON.stringify({ ...report, weights: WEIGHTS }), c.id]
  );
  await recomputeUserRanks();
  return rank;
}

const CONV_LIST = `SELECT c.id, c.status, c.rank, c.max_turns, c.error, c.created_at, c.agent_a_id, c.agent_b_id,
    ua.id AS user_a_id, ua.name AS user_a_name, ub.id AS user_b_id, ub.name AS user_b_name,
    CASE WHEN pa.photo_url IS NULL THEN NULL ELSE '/api/photo/' || ua.id END AS photo_a,
    CASE WHEN pb.photo_url IS NULL THEN NULL ELSE '/api/photo/' || ub.id END AS photo_b,
    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS turns
  FROM conversations c
  JOIN agents aa ON aa.id = c.agent_a_id JOIN users ua ON ua.id = aa.user_id LEFT JOIN profiles pa ON pa.user_id = ua.id
  JOIN agents ab ON ab.id = c.agent_b_id JOIN users ub ON ub.id = ab.user_id LEFT JOIN profiles pb ON pb.user_id = ub.id`;

export const listConversations = (where = "", args = []) =>
  all(`${CONV_LIST} ${where} ORDER BY CASE c.status WHEN 'dating' THEN 0 WHEN 'judging' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END, c.rank DESC, c.id`, args);

export async function getConversation(id) {
  const [c] = await all(`${CONV_LIST} WHERE c.id = ?`, [id]);
  if (!c) return null;
  const full = await one("SELECT llm_model, judge_model, judging_time, judging_ms, judge_report FROM conversations WHERE id = ?", [id]);
  return { ...c, ...full, judge_report: json(full.judge_report), messages: await all("SELECT id, sender_agent_id, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id", [id]) };
}
