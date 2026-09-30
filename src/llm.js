import { z } from "zod";

// One cheap model for everything; override per role via env if needed.
export const MODELS = {
  agent: process.env.AGENT_MODEL || process.env.LLM_MODEL || "deepseek/deepseek-v4.1-flash",
  judge: process.env.JUDGE_MODEL || process.env.LLM_MODEL || "deepseek/deepseek-v4.1-flash",
  analysis: process.env.ANALYSIS_MODEL || process.env.LLM_MODEL || "deepseek/deepseek-v4.1-flash",
};

// Some hosts of cheap open models occasionally return degenerate text; once seen, skip that host.
const badProviders = new Set((process.env.BAD_PROVIDERS ?? "OpenInference").split(",").filter(Boolean));

/** Heuristic check for degenerate agent output (word salad, run-on caps, emoji floods). */
export function looksDegenerate(text, finishReason) {
  if (!text) return true;
  if (finishReason === "length" || text.length >= 1190) return true;   // a 1-3 sentence reply never hits the token cap; word salad does
  if (/\S{32,}/.test(text.replace(/https?:\/\/\S+/g, ""))) return true;  // run-together "words"
  const letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length > 40 && (text.match(/[A-Z]/g) || []).length / letters.length > 0.35) return true;
  if ((text.match(/\p{Extended_Pictographic}/gu) || []).length > 3) return true;
  return false;
}

async function call(body, { retries = 2, timeoutMs = 180_000, validate } = {}) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.PUBLIC_URL || "https://agentic-assign.vercel.app",
          "X-Title": "Proxy Hearts",
        },
        // Providers for the same model differ up to 15x in price: always route to the cheapest,
        // and never to one above the ceiling ($ per million tokens).
        body: JSON.stringify({ ...body, provider: { sort: "price", max_price: { prompt: 0.15, completion: 0.8 }, ignore: [...badProviders], ...body.provider } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) {
        const msg = j.error?.message || `HTTP ${r.status}`;
        // 4xx other than rate limits won't get better on retry
        if (r.status >= 400 && r.status < 500 && r.status !== 429 && r.status !== 408) throw Object.assign(new Error(msg), { fatal: true });
        throw new Error(msg);
      }
      const text = j.choices?.[0]?.message?.content;
      if (!text?.trim()) throw new Error("Empty model response");
      if (validate && !validate(text.trim(), j.choices?.[0]?.finish_reason)) {
        if (j.provider) badProviders.add(j.provider);
        console.warn(`[llm] rejected degenerate output from ${j.provider}; retrying elsewhere`);
        throw new Error("Degenerate model output");
      }
      return text.trim();
    } catch (e) {
      last = e;
      if (e.fatal) break;
      await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
    }
  }
  throw last;
}

/** One free-text chat turn. */
export function chat({ system, messages, maxTokens = 320, model = MODELS.agent }) {
  return call({
    model,
    max_tokens: maxTokens,
    reasoning: { enabled: false }, // measured: reasoning adds ~30s and 10x cost per turn with no visible gain
    messages: [{ role: "system", content: system }, ...messages],
  }, { retries: 3, validate: (t, finish) => !looksDegenerate(t, finish) });
}

/** JSON output constrained by a JSON schema derived from zod, then validated with zod. */
export async function structured({ system, content, schema, name, model, maxTokens = 8000, timeoutMs = 100_000, reasoning = { effort: "low", exclude: true } }) {
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-7" });
  delete jsonSchema.$schema;
  const messages = [{ role: "system", content: system }, { role: "user", content }];
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await call({
      model,
      max_tokens: maxTokens,
      reasoning,
      response_format: { type: "json_schema", json_schema: { name, strict: true, schema: jsonSchema } },
      provider: { require_parameters: true },
      messages,
    }, { retries: 1, timeoutMs });
    try {
      const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
      return schema.parse(JSON.parse(cleaned));
    } catch (e) {
      lastErr = e;
      messages.push({ role: "assistant", content: text }, { role: "user", content: `That did not match the schema (${String(e.message).slice(0, 400)}). Return only valid JSON matching the schema.` });
    }
  }
  throw new Error(`Invalid structured output: ${lastErr.message.slice(0, 200)}`);
}
