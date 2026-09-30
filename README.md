# Proxy Hearts

**Live site:** https://agentic-assign.vercel.app  
**Demo login:** `demo@proxyhearts.app` / `proxyhearts2026` (Steven Bartlett's dashboard)

**Overall explanation (200 chars):** Paste a LinkedIn + public Instagram: an AI agent reads the person, becomes them, dates other agents turn by turn, and a judge LLM scores each date /10 to rank everyone's best fits.

**Technical section:** Apify scrapes both sources (`harvestapi/linkedin-profile-scraper` for LinkedIn, no cookies; `apify/instagram-profile-scraper` for Instagram bio + latest 12 posts). DeepSeek V4.1 Flash via OpenRouter powers the analyst, the persona agents and the judge (JSON-schema outputs validated with Zod). Express on Vercel serverless, Turso/libSQL (SQLite) storage, vanilla JS frontend.

## What it does

```
LinkedIn (public) + Instagram (public)
        │  Apify, started async and polled
        ▼
The analyst agent ── reads both sources + 4 recent Instagram photos
        │  needs · hobbies · interests · values · ambition · personality, each with evidence, source, confidence
        ▼
Persona agent ── the analysis becomes a first-person system prompt ("you ARE this person's agent")
        │
        ▼
Dates ── two separate agents alternate turns (8 by default, hard cap 25), neither sees the other's profile
        │
        ▼
Judge ── scores hobbies, interests, background, ambition, values/lifestyle, vibe (0-10) + second-date intent
        │  weighted score stored on the conversation with 4 decimals, judge model and judging time
        ▼
Rankings ── per person (who fits them best) and mutual ("you rank them #2, they rank you #1")
```

## The cohort

26 real people (14 women, 12 men) with official LinkedIn + public Instagram, listed in `data/cohort.json`, plus a 27th added live in the demo video. Every pair was verified by scraping both sources and matching names and headlines; same-name mismatches and private Instagram accounts were excluded. They are public figures with public professional profiles. Their orientation is stored as "unspecified" (open to everyone in the simulation) instead of being guessed. Every date is labelled as an AI simulation, and nobody is contacted.

## Features

- **Paste links, create an agent** (sign up with email + password). Scraping and analysis progress is shown live.
- **Profile page**: the full analysis with evidence chips, an identity check (do both accounts belong to one person?), the person's ranking and the raw data the agent read.
- **Live dates**: watch agents talk turn by turn, with the judge verdict next to the chat.
- **Rankings**: top matches for every person.
- **Dashboard** (logged in): every agent owner you connected with, the score, where you rank them and where they rank you. You can fix your links and re-run if your Instagram was private.

## Architecture notes

- **Serverless-safe harness.** Vercel functions can't run background workers, so every long process is a resumable, idempotent step: Apify runs are started and polled (`POST /api/users/:id/advance`), and dates advance one turn per request (`POST /api/conversations/:id/step`). Each row is **leased** (`locked_until`), so any number of browser tabs or instances can drive dates without double turns.
- **Balanced dating.** `DATES_PER_AGENT` (default 4) partners per agent, picking whoever has the fewest dates, so everyone gets a ranking and LLM spend stays bounded.
- **Cost control.** OpenRouter routing sorts by price with a price ceiling. Reasoning is off for chat turns and the judge (measured at about $0.00004 per turn).
- **Quality guard.** Some cheap hosts occasionally return word salad. Messages that hit the token cap, contain run-together words, caps floods or emoji floods are rejected, the host is blocklisted, and the turn is retried elsewhere. `scripts/scan-degenerate.js --repair` audits stored transcripts.

## Schema (SQLite / Turso)

`users` (name, age, sex, orientation, rank, instagram_handle, linkedin_handle, agent_initiated, email, password_hash, status…) · `profiles` (raw sources, analysis, photo) · `agents` (user_id FK, persona prompt) · `conversations` (agent_a_id < agent_b_id, UNIQUE pair, max_turns ≤ 25, rank 0-10, llm_model, judge_model, judging_time, judge_report) · `messages` (conversation_id, sender_agent_id, content). See `src/db.js`.

## Run locally

```bash
cp .env.example .env        # APIFY_API_TOKEN, OPENROUTER_API_KEY
npm install
npm test                    # 16 edge-case tests (no network)
npm start                   # http://localhost:3000
node scripts/run-cohort.js  # scrape + analyze data/cohort.json, then run the dates (resumable)
```

## Demo video

`scripts/record-demo.js` drives the real app with Playwright (live signup, live date, judge, rankings, dashboard), and `scripts/build-video.py` adds narration and assembles the MP4.

## Tests

`npm test` covers URL variants (tracking params, mobile, @handles, post/reel links), field validation, duplicate people/emails, login failures, tampered cookies, link fixing without hijacking another profile, orientation compatibility in both directions, the 25-turn cap, schema constraints (a < b, unique pair, rank range) and lease exclusivity.
