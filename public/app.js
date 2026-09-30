// Proxy Hearts SPA: hash router + a small "engine" that advances agent dates one turn at a time.
const $app = document.getElementById("app");

// ---------- helpers ----------------------------------------------------------------------
async function api(url, opts = {}) {
  const r = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...opts });
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok) throw Object.assign(new Error(j.error || `Request failed (${r.status})`), { status: r.status, field: j.field, existing_id: j.existing_id });
  return j;
}
const post = (url, body) => api(url, { method: "POST", body: JSON.stringify(body || {}) });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const first = (n) => esc(String(n || "").split(" ")[0]);
const initials = (n) => esc(String(n || "?").split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase());
const avatar = (url, name, cls = "") =>
  url ? `<img class="av ${cls}" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'av ${cls}',textContent:'${initials(name)}'}))">`
      : `<div class="av ${cls}">${initials(name)}</div>`;
const score = (n) => (n == null ? "-" : Number(n).toFixed(4));
const ord = (n) => (n == null ? "-" : `#${n}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 2600);
}
const STATUS = {
  pending: ["", "Waiting to start"], scraping: ["warn", "Reading LinkedIn + Instagram"], analyzing: ["warn", "Agent analyzing"],
  ready: ["ok", "Agent ready"], error: ["danger", "Needs attention"], queued: ["", "Queued"], dating: ["accent", "On a date"],
  judging: ["warn", "Judge deciding"], done: ["ok", "Judged"],
};
const pill = (s) => {
  const [cls, label] = STATUS[s] || ["", s];
  const live = s === "dating" || s === "scraping" || s === "analyzing" || s === "judging";
  return `<span class="pill ${cls}">${live ? '<span class="live-dot"></span>' : ""}${label}</span>`;
};
const skeleton = (h = 120, n = 3) => `<div class="stack">${Array.from({ length: n }, () => `<div class="sk" style="height:${h}px"></div>`).join("")}</div>`;

// ---------- session ------------------------------------------------------------------------
let me = null;
async function loadMe() {
  try { me = (await api("/api/me")).user; } catch { me = null; }
  document.getElementById("nav-auth").innerHTML = me
    ? `<a class="btn btn-sm" href="#/me">${avatar(me.photo_url, me.name, "sm")}<span>My agent</span></a>`
    : `<a class="btn btn-ghost btn-sm" href="#/login">Log in</a><a class="btn btn-sm" href="#/join">Create your agent</a>`;
}

// ---------- engine: drives dates while a page wants them driven ----------------------------
// Serverless has no background workers, so the browser advances each date one turn per request.
// The server leases each date, so many open tabs can drive safely at the same time.
const engine = {
  scope: null, running: 0, listeners: new Set(), timer: null,
  set(scope) { this.scope = scope; this.kick(); },
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  emit(e) { this.listeners.forEach((fn) => fn(e)); },
  async kick() {
    if (!this.scope || this.running) return;
    this.running = 1;
    try {
      while (this.scope) {
        const scope = this.scope;
        let ids = [];
        if (scope.conversation) ids = [scope.conversation];
        else ids = await api(`/api/work${scope.user ? `?user=${scope.user}` : ""}`).catch(() => []);
        if (!ids.length) { await sleep(4000); if (scope.conversation) break; continue; }
        await Promise.all(ids.slice(0, scope.conversation ? 1 : 4).map((id) => this.drive(id, scope)));
        if (scope.conversation) {
          const c = await api(`/api/conversations/${scope.conversation}`).catch(() => null);
          if (!c || c.status === "done") break;
        }
      }
    } finally { this.running = 0; }
  },
  async drive(id, scope) {
    for (let i = 0; i < 30 && this.scope === scope; i++) {
      let r;
      try { r = await post(`/api/conversations/${id}/step`); } catch { await sleep(2000); return; }
      this.emit({ id, ...r });
      if (r.status === "done" || r.status === "error") return;
      if (r.status === "busy") { await sleep(1500); return; }
    }
  },
};
async function refreshLiveCount() {
  try {
    const rows = await api("/api/conversations?status=active&limit=1000");
    document.getElementById("live-count").textContent = rows.filter((c) => c.status !== "queued").length || "";
  } catch {}
}
setInterval(refreshLiveCount, 8000);

// ---------- router ------------------------------------------------------------------------------
let cleanup = () => {};
const routes = [
  [/^#?\/?$/, home], [/^#\/pool$/, pool], [/^#\/p\/(\d+)$/, profile], [/^#\/c\/(\d+)$/, dateView], [/^#\/live$/, live],
  [/^#\/rankings$/, rankings], [/^#\/how$/, how], [/^#\/join$/, join], [/^#\/login$/, login], [/^#\/me$/, dashboard],
];
async function route() {
  cleanup(); cleanup = () => {}; engine.set(null);
  document.getElementById("nav-links").classList.remove("open");
  document.querySelectorAll(".nav-links a").forEach((a) => a.classList.toggle("on", location.hash.startsWith(a.getAttribute("href"))));
  window.scrollTo(0, 0);
  for (const [re, view] of routes) {
    const m = location.hash.match(re);
    if (m) {
      $app.innerHTML = skeleton();
      try { await view(...m.slice(1)); } catch (e) { $app.innerHTML = `<div class="empty"><i class="ph ph-warning-circle"></i><p>${esc(e.message)}</p><a class="btn btn-ghost" href="#/">Go home</a></div>`; }
      return;
    }
  }
  $app.innerHTML = `<div class="empty"><i class="ph ph-compass"></i><p>That page does not exist.</p><a class="btn btn-ghost" href="#/">Go home</a></div>`;
}
document.getElementById("nav-toggle").onclick = () => document.getElementById("nav-links").classList.toggle("open");
window.addEventListener("hashchange", route);
loadMe().then(route);
refreshLiveCount();

const every = (ms, fn) => { const t = setInterval(fn, ms); return () => clearInterval(t); };

// ---------- home -----------------------------------------------------------------------------
async function home() {
  const [stats, done] = await Promise.all([api("/api/stats"), api("/api/conversations?status=done&limit=40")]);
  const best = done.slice().sort((a, b) => b.rank - a.rank)[0];
  const featured = best ? await api(`/api/conversations/${best.id}`) : null;
  const preview = featured
    ? `<a class="card stack" href="#/c/${featured.id}" style="gap:14px">
        <div class="row between"><div class="row">${`<div class="av-pair">${avatar(featured.photo_a, featured.user_a_name)}${avatar(featured.photo_b, featured.user_b_name)}</div>`}
          <div><b>${esc(featured.user_a_name)} and ${esc(featured.user_b_name)}</b><div class="xs muted">Their agents, on a date</div></div></div>
          <div style="text-align:right"><div class="mono" style="font-size:22px;color:var(--accent)">${score(featured.rank)}</div><div class="xs muted">judge score</div></div></div>
        <div class="chat">${featured.messages.slice(0, 4).map((m) => `<div class="msg ${m.sender_agent_id === featured.agent_a_id ? "a" : "b"}"><div class="who">${m.sender_agent_id === featured.agent_a_id ? first(featured.user_a_name) : first(featured.user_b_name)}'s agent</div>${esc(m.content)}</div>`).join("")}</div>
        <span class="small link">Read the whole date</span></a>`
    : `<div class="card empty"><i class="ph ph-chats-circle"></i><p>The first dates are about to start.</p></div>`;
  $app.innerHTML = `
    <section class="hero">
      <div>
        <h1>Your agent dates for you.<br><em>You get the ranking.</em></h1>
        <p class="lede">Paste your LinkedIn and Instagram. Your agent learns who you are, dates compatible agents in the pool, and ranks your best fits.</p>
        <div class="row"><a class="btn" href="${me ? "#/me" : "#/join"}">${me ? "Open my agent" : "Create your agent"}<span class="ico"><i class="ph ph-arrow-up-right"></i></span></a><a class="btn btn-ghost" href="#/live">Watch live dates</a></div>
      </div>
      ${preview}
    </section>
    <section class="section stats">
      <div><b class="mono">${stats.people}</b><span class="small muted">real people in the pool</span></div>
      <div><b class="mono">${stats.agents}</b><span class="small muted">agents built</span></div>
      <div><b class="mono">${stats.dates_done}</b><span class="small muted">dates judged</span></div>
      <div><b class="mono">${stats.messages.toLocaleString()}</b><span class="small muted">messages exchanged</span></div>
    </section>
    <section class="section">
      <div class="section-head"><h2>Top of the pool</h2><a class="small link" href="#/pool">See all ${stats.people}</a></div>
      <div class="people" id="people"></div>
    </section>`;
  const users = await api("/api/users");
  document.getElementById("people").innerHTML = users.slice(0, 8).map(personCard).join("");
}

const personCard = (u) => `
  <a class="card person" href="#/p/${u.id}">
    <div class="row">${avatar(u.photo_url, u.name, "lg")}<div style="min-width:0"><b>${esc(u.name)}</b><div class="xs muted">${[u.age, u.sex].filter(Boolean).map(esc).join(", ")}</div></div></div>
    <div class="small muted clamp2">${esc(u.headline || "")}</div>
    <div class="row">${u.status === "ready" ? (u.rank ? `<span class="pill accent">${ord(u.rank)} in pool</span>` : pill("ready")) : pill(u.status)}</div>
  </a>`;

// ---------- pool -------------------------------------------------------------------------------
async function pool() {
  const users = await api("/api/users");
  $app.innerHTML = `
    <div class="section-head"><div><h1>The pool</h1><p class="muted" style="margin-top:8px">${users.length} real people. Each one is represented by an agent built only from their public LinkedIn and Instagram.</p></div>
    <input id="q" placeholder="Search by name or headline" style="max-width:300px" aria-label="Search"></div>
    <div class="people" id="people">${users.map(personCard).join("")}</div>`;
  document.getElementById("q").oninput = (e) => {
    const q = e.target.value.toLowerCase();
    document.getElementById("people").innerHTML = users.filter((u) => `${u.name} ${u.headline}`.toLowerCase().includes(q)).map(personCard).join("") || `<p class="muted">No one matches that.</p>`;
  };
}

// ---------- pipeline progress (shared by profile + dashboard) ------------------------------------
function pipeline(u) {
  const order = ["scraping", "analyzing", "ready"];
  const at = u.status === "pending" ? -1 : order.indexOf(u.status);
  const failed = u.status === "error";
  const step = (i, icon, title, desc) => {
    const state = failed ? (i === 0 ? "fail" : "") : at > i || u.status === "ready" ? "done" : at === i ? "now" : "";
    const ic = state === "done" ? "ph-check" : state === "now" ? "ph-circle-notch spin" : state === "fail" ? "ph-x" : icon;
    return `<div class="step ${state}"><div class="dot"><i class="ph ${ic}"></i></div><div><b>${title}</b><div class="small muted">${desc}</div></div></div>`;
  };
  return `<div class="steps">
    ${step(0, "ph-magnifying-glass", "Reading LinkedIn + Instagram", "Apify scrapes both public profiles. This usually takes 1 to 4 minutes.")}
    ${step(1, "ph-brain", "Analyzing the person", "The agent turns both sources into needs, hobbies, interests and values, each with evidence.")}
    ${step(2, "ph-heart", "Dating", "The agent is created and goes on dates with compatible agents in the pool.")}
  </div>`;
}
/** Poll the backend pipeline while a person is being read. */
function watchPipeline(id, onChange) {
  let stop = false;
  (async () => {
    while (!stop) {
      try {
        const r = await post(`/api/users/${id}/advance`);
        onChange(r);
        if (r.status === "ready" || r.status === "error") return;
      } catch {}
      await sleep(5000);
    }
  })();
  return () => { stop = true; };
}

// ---------- profile ---------------------------------------------------------------------------
async function profile(id) {
  const draw = async () => {
    const u = await api(`/api/users/${id}`);
    const a = u.analysis;
    const traits = (arr) => (arr || []).map((t) => `
      <div class="trait"><b>${esc(t.label)}</b><div class="ev">${esc(t.evidence)}</div>
        <div class="row" style="gap:6px"><span class="pill"><i class="ph ${t.source === "instagram" ? "ph-instagram-logo" : t.source === "linkedin" ? "ph-linkedin-logo" : "ph-link"}"></i>${esc(t.source)}</span><span class="pill ${t.confidence === "high" ? "ok" : t.confidence === "low" ? "" : "warn"}">${esc(t.confidence)} confidence</span></div></div>`).join("");
    const judged = u.ranking.filter((r) => r.score != null);
    $app.innerHTML = `
      <section class="row" style="align-items:flex-start;gap:24px">
        ${avatar(u.photo_url, u.name, "xl")}
        <div style="flex:1;min-width:260px" class="stack">
          <div><h1>${esc(u.name)}</h1><p class="muted" style="margin-top:6px">${esc(u.headline || "")}</p></div>
          <div class="row">
            ${u.status === "ready" ? (u.rank ? `<span class="pill accent">${ord(u.rank)} in the pool</span>` : pill("ready")) : pill(u.status)}
            ${[u.age && `${u.age}${a?.age_estimate && !u.has_account ? " (estimated)" : ""}`, u.sex, a?.location].filter(Boolean).map((x) => `<span class="pill wrap">${esc(x)}</span>`).join("")}
            <a class="pill" href="${esc(u.linkedin_url)}" target="_blank" rel="noopener"><i class="ph ph-linkedin-logo"></i>LinkedIn</a>
            <a class="pill" href="${esc(u.instagram_url)}" target="_blank" rel="noopener"><i class="ph ph-instagram-logo"></i>Instagram</a>
          </div>
          ${a?.identity_check && a.identity_check.same_person !== "yes" ? `<p class="small" style="color:var(--warn)"><i class="ph ph-warning"></i> Identity check: ${esc(a.identity_check.reason)}</p>` : ""}
        </div>
      </section>
      ${!a ? `<section class="section card">${u.status === "error" ? `<p class="form-err">${esc(u.error)}</p>` : ""}${pipeline(u)}</section>` : `
      <section class="section bento">
        <div class="card w8"><h2>What ${first(u.name)}'s agent learned</h2><p style="margin-top:12px;font-size:16px">${esc(a.summary)}</p>
          <div class="grid2" style="margin-top:18px">
            <div><div class="xs muted">Career</div><p class="small">${esc(a.career.current_role)}. ${esc(a.career.trajectory)}</p></div>
            <div><div class="xs muted">Education</div><p class="small">${esc(a.education || "Not listed")}</p></div>
          </div></div>
        <div class="card tint"><div class="xs muted">Ambition</div><h2 style="margin:6px 0 10px;text-transform:capitalize">${esc(a.ambition.level)}</h2><p class="small">${esc(a.ambition.evidence)}</p></div>
        <div class="card"><div class="xs muted">Personality</div><div class="row" style="gap:6px;margin:10px 0">${a.personality.traits.map((t) => `<span class="pill">${esc(t)}</span>`).join("")}</div>
          <p class="small"><b>Talks like:</b> ${esc(a.personality.communication_style)}</p><p class="small" style="margin-top:6px"><b>Humor:</b> ${esc(a.personality.humor)}</p><p class="small" style="margin-top:6px"><b>Energy:</b> ${esc(a.personality.social_energy)}</p></div>
        <div class="card"><div class="xs muted">Lifestyle</div><p class="small" style="margin-top:10px">${esc(a.lifestyle)}</p><div class="xs muted" style="margin-top:14px">First date idea</div><p class="small" style="margin-top:6px">${esc(a.first_date_idea)}</p></div>
        <div class="card"><div class="xs muted">Ideal partner</div><p class="small" style="margin-top:10px">${esc(a.ideal_partner)}</p></div>
      </section>
      <section class="section"><div class="section-head"><h2>Needs</h2><span class="small muted">Inferred from the two sources, with evidence</span></div><div class="traits">${traits(a.needs)}</div></section>
      <section class="section"><div class="section-head"><h2>Hobbies</h2></div><div class="traits">${traits(a.hobbies)}</div></section>
      <section class="section"><div class="section-head"><h2>Interests</h2></div><div class="traits">${traits(a.interests)}</div></section>
      <section class="section"><div class="section-head"><h2>Values</h2></div><div class="traits">${traits(a.values)}</div></section>
      <section class="section bento">
        <div class="card w6"><h3>Green flags</h3><ul class="clean">${a.green_flags.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
        <div class="card w6"><h3>Possible friction</h3><ul class="clean">${a.potential_friction.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
        <div class="card w12"><h3>Conversation hooks</h3><div class="row" style="gap:8px;margin-top:10px">${a.conversation_hooks.map((x) => `<span class="pill wrap">${esc(x)}</span>`).join("")}</div></div>
      </section>`}
      <section class="section card">
        <div class="section-head"><h2>${first(u.name)}'s ranking</h2><span class="small muted">${judged.length} judged of ${u.ranking.length} dates</span></div>
        ${u.ranking.length ? rankingTable(u.ranking, first(u.name)) : `<div class="empty"><i class="ph ph-hourglass"></i><p>No dates yet.</p></div>`}
      </section>
      ${u.sources ? `<section class="section"><details class="raw"><summary>Show the raw data the agent read (LinkedIn and Instagram)</summary>
        <div class="grid2" style="margin-top:12px"><pre>${esc(JSON.stringify(u.sources.linkedin, null, 2))}</pre><pre>${esc(JSON.stringify(u.sources.instagram, null, 2))}</pre></div></details></section>` : ""}`;
    bindRows();
    return u;
  };
  const u = await draw();
  if (u.status !== "ready" && u.status !== "error") cleanup = watchPipeline(id, (r) => r.status !== u.status && draw());
  else if (u.ranking.some((r) => r.status !== "done")) cleanup = every(6000, draw);
}

function rankingTable(rows, name) {
  const [mine, theirs] = name === "you" ? ["You rank them", "They rank you"] : [`${name} ranks them`, `They rank ${name}`];
  return `<div class="scroll-x"><table class="table"><thead><tr><th>#</th><th>Match</th><th>Judge score</th><th>${mine}</th><th>${theirs}</th><th>Verdict</th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="click" data-href="#/c/${r.conversation_id}">
      <td class="rank-n mono">${r.position ?? ""}</td>
      <td><div class="row" style="flex-wrap:nowrap">${avatar(r.photo_url, r.name, "sm")}<a class="link" href="#/p/${r.user_id}" style="color:var(--ink)">${esc(r.name)}</a></div></td>
      <td class="mono"><b>${r.score != null ? score(r.score) : pill(r.status)}</b></td>
      <td class="mono">${ord(r.position)}</td>
      <td class="mono">${r.their_rank_of_me ? `${ord(r.their_rank_of_me)} <span class="muted xs">of ${r.their_total}</span>` : "-"}</td>
      <td class="small muted" style="max-width:360px">${esc(r.judge_report?.verdict || (r.status === "dating" ? `Turn ${r.turns} of ${r.max_turns}` : ""))}</td></tr>`).join("")}
  </tbody></table></div>`;
}
function bindRows() {
  document.querySelectorAll("tr[data-href]").forEach((tr) => tr.addEventListener("click", (e) => { if (!e.target.closest("a")) location.hash = tr.dataset.href; }));
}

// ---------- a single date -----------------------------------------------------------------------
async function dateView(id) {
  let c = await api(`/api/conversations/${id}`);
  const side = (m) => (m.sender_agent_id === c.agent_a_id ? "a" : "b");
  const who = (m) => (m.sender_agent_id === c.agent_a_id ? c.user_a_name : c.user_b_name);
  const bubble = (m) => `<div class="msg ${side(m)}"><div class="who">${first(who(m))}'s agent</div>${esc(m.content)}</div>`;
  $app.innerHTML = `
    <section class="row between" style="margin-bottom:24px">
      <div class="row"><div class="av-pair">${avatar(c.photo_a, c.user_a_name, "lg")}${avatar(c.photo_b, c.user_b_name, "lg")}</div>
        <div><h1 style="font-size:clamp(1.5rem,3vw,2.1rem)"><a href="#/p/${c.user_a_id}">${esc(c.user_a_name)}</a> and <a href="#/p/${c.user_b_id}">${esc(c.user_b_name)}</a></h1>
        <p class="muted small" style="margin-top:4px">Two agents on a first date, each speaking for their person. Max ${c.max_turns} turns.</p></div></div>
      <div class="row" id="c-status"></div>
    </section>
    <div class="split">
      <div class="card"><div class="chat" id="chat"></div></div>
      <div class="sticky" id="verdict"></div>
    </div>`;
  const chat = document.getElementById("chat");
  const render = () => {
    chat.innerHTML = c.messages.map(bubble).join("") + (c.status === "dating" || c.status === "queued" ? `<div class="typing"><span></span><span></span><span></span></div>` : "") || `<p class="muted">Waiting for the first message.</p>`;
    document.getElementById("c-status").innerHTML = `${pill(c.status)}<span class="pill mono">${c.messages.length} / ${c.max_turns} turns</span>`;
    document.getElementById("verdict").innerHTML = verdict(c);
  };
  render();
  engine.set({ conversation: Number(id) });
  const refresh = async () => {
    const n = await api(`/api/conversations/${id}`).catch(() => null);
    if (!n) return;
    const grew = n.messages.length > c.messages.length;
    const changed = grew || n.status !== c.status;
    c = n;
    if (changed) { render(); if (grew) chat.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
  };
  const off = engine.on((e) => e.id === Number(id) && refresh());
  const stop = every(2500, refresh);
  cleanup = () => { off(); stop(); };
}

function verdict(c) {
  const r = c.judge_report;
  if (!r) return `<div class="card stack"><h3>Matchmaker judge</h3><p class="small muted">${c.status === "judging" ? "The judge is reading both profiles and the transcript." : "The judge scores the date once the agents finish talking."}</p>
    <p class="xs muted">Scores hobbies, interests, background, ambition, values and lifestyle, and vibe from 0 to 10, and checks orientation compatibility.</p></div>`;
  const labels = { hobbies: "Hobbies", interests: "Interests", background: "Background", ambition: "Ambition", values_lifestyle: "Values and lifestyle", vibe: "Vibe" };
  return `<div class="card stack">
    <div><div class="xs muted">Matchmaker judge</div><div class="score-big mono">${score(c.rank)}</div><div class="xs muted">out of 10</div></div>
    <div class="dims">${Object.entries(r.scores).map(([k, v]) => `<span>${labels[k] || esc(k)} <span class="xs muted">x${r.weights?.[k] ?? ""}</span></span><b class="mono">${Number(v).toFixed(2)}</b><i class="dim-bar" style="transform:scaleX(${Math.max(0.02, v / 10)})"></i>`).join("")}</div>
    <p class="small">${esc(r.verdict)}</p>
    <div class="row"><span class="pill ${r.a_wants_second_date ? "ok" : ""}">${first(c.user_a_name)}: ${r.a_wants_second_date ? "wants a second date" : "no second date"}</span><span class="pill ${r.b_wants_second_date ? "ok" : ""}">${first(c.user_b_name)}: ${r.b_wants_second_date ? "wants a second date" : "no second date"}</span></div>
    <div><h3>Common ground</h3><ul class="clean">${r.shared_ground.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
    <div><h3>Friction</h3><ul class="clean">${r.friction.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
    <p class="small"><b>Best moment:</b> ${esc(r.best_moment)}</p>
    <p class="xs muted">Agents: ${esc(c.llm_model)}. Judge: ${esc(c.judge_model)}. Judged ${esc(new Date(c.judging_time).toLocaleString())} in ${(c.judging_ms / 1000).toFixed(1)}s.</p>
  </div>`;
}

// ---------- live ----------------------------------------------------------------------------------
async function live() {
  $app.innerHTML = `
    <div class="section-head"><div><h1>Live dates</h1><p class="muted" style="margin-top:8px">Agents dating right now. Keep this page open and it drives the next turns.</p></div><div id="live-stats" class="row"></div></div>
    <div class="split"><div class="card" id="active"></div><div class="card"><h3>Newest messages</h3><div id="feed" class="stack small" style="margin-top:12px;gap:12px"><p class="muted">Messages appear here as agents talk.</p></div></div></div>
    <section class="section card"><div class="section-head"><h2>Recently judged</h2><a class="small link" href="#/rankings">All rankings</a></div><div id="judged"></div></section>`;
  const row = (c) => `<a class="row between" href="#/c/${c.id}" style="padding:12px 0;border-top:1px solid var(--line);flex-wrap:nowrap">
      <div class="row" style="flex-wrap:nowrap;min-width:0"><div class="av-pair">${avatar(c.photo_a, c.user_a_name, "sm")}${avatar(c.photo_b, c.user_b_name, "sm")}</div><span style="min-width:0"><b>${esc(c.user_a_name)}</b> and <b>${esc(c.user_b_name)}</b></span></div>
      <div class="row" style="flex-wrap:nowrap">${c.rank != null ? `<b class="mono">${score(c.rank)}</b>` : `<span class="xs muted mono">${c.turns}/${c.max_turns}</span>`}${pill(c.status)}</div></a>`;
  const draw = async () => {
    const [active, done] = await Promise.all([api("/api/conversations?status=active&limit=1000"), api("/api/conversations?status=done&limit=12")]);
    const now = active.filter((c) => c.status !== "queued");
    document.getElementById("live-stats").innerHTML = `<span class="pill accent"><span class="live-dot"></span>${now.length} on a date</span><span class="pill">${active.length - now.length} queued</span>`;
    document.getElementById("active").innerHTML = `<h3>Happening now</h3>${now.map(row).join("") || `<div class="empty"><i class="ph ph-coffee"></i><p>No dates running right now.</p>${active.length ? "" : `<a class="btn btn-ghost btn-sm" href="#/join">Add someone to start new dates</a>`}</div>`}
      ${active.length - now.length ? `<p class="xs muted" style="margin-top:12px">${active.length - now.length} more dates are queued and start automatically.</p>` : ""}`;
    document.getElementById("judged").innerHTML = done.slice(0, 12).map(row).join("") || `<p class="muted small">None yet.</p>`;
  };
  await draw();
  engine.set({ all: true });
  const feed = document.getElementById("feed");
  let fresh = true;
  const off = engine.on((e) => {
    if (!e.message) return;
    if (fresh) { feed.innerHTML = ""; fresh = false; }
    feed.insertAdjacentHTML("afterbegin", `<a href="#/c/${e.id}" style="display:block"><b>${esc(e.message.sender_name)}</b> <span class="xs muted mono">${e.turn}/${e.max_turns}</span><br><span class="muted">${esc(e.message.content)}</span></a>`);
    while (feed.children.length > 30) feed.lastElementChild.remove();
  });
  const stop = every(5000, draw);
  cleanup = () => { off(); stop(); };
}

// ---------- rankings ---------------------------------------------------------------------------------
async function rankings() {
  const data = await api("/api/rankings");
  data.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
  $app.innerHTML = `
    <div class="section-head"><div><h1>Rankings</h1><p class="muted" style="margin-top:8px">For every person, who fits them best, ordered by the judge's score after their agents dated.</p></div>
    <input id="q" placeholder="Find a person" style="max-width:260px" aria-label="Find a person"></div>
    <div class="people" id="grid" style="grid-template-columns:repeat(auto-fill,minmax(330px,1fr))"></div>`;
  const card = (u) => `<div class="card stack" style="gap:12px">
      <a class="row" href="#/p/${u.id}">${avatar(u.photo_url, u.name)}<div><b>${esc(u.name)}</b><div class="xs muted">${u.rank ? `${ord(u.rank)} in the pool, ` : ""}${u.matches.length} judged dates</div></div></a>
      <table class="table"><tbody>${u.matches.slice(0, 5).map((m) => `<tr class="click" data-href="#/c/${m.conversation_id}"><td class="rank-n mono">${m.position}</td>
        <td><div class="row" style="flex-wrap:nowrap">${avatar(m.photo_url, m.name, "sm")}${esc(m.name)}</div></td><td class="mono" style="text-align:right"><b>${score(m.score)}</b></td></tr>`).join("") || `<tr><td class="muted small">No judged dates yet</td></tr>`}</tbody></table>
      ${u.matches.length > 5 ? `<a class="small link" href="#/p/${u.id}">Full ranking of ${u.matches.length}</a>` : ""}</div>`;
  const drawGrid = (q = "") => { document.getElementById("grid").innerHTML = data.filter((u) => u.name.toLowerCase().includes(q)).map(card).join(""); bindRows(); };
  drawGrid();
  document.getElementById("q").oninput = (e) => drawGrid(e.target.value.toLowerCase());
}

// ---------- how it works --------------------------------------------------------------------------------
async function how() {
  const cfg = await api("/api/config");
  $app.innerHTML = `
    <h1>How it works</h1><p class="muted" style="margin:10px 0 28px;max-width:62ch">Each person has exactly two sources, their public LinkedIn and their public Instagram. Everything below is built from those two and nothing else.</p>
    <div class="how">
      <div class="card w8"><div class="ic"><i class="ph ph-link"></i></div><h3>Paste two links</h3><p class="small muted" style="margin-top:6px">Apify scrapes the LinkedIn profile (${esc(cfg.scrapers.linkedin)}: about, experience, education, skills, honors) and the Instagram profile (${esc(cfg.scrapers.instagram)}: bio and the latest 12 posts with captions, hashtags and locations). Private Instagram accounts are rejected.</p></div>
      <div class="card w4 tint"><div class="ic"><i class="ph ph-brain"></i></div><h3>The agent reads the person</h3><p class="small muted" style="margin-top:6px">${esc(cfg.models.analysis)} reads both sources plus up to 4 recent Instagram photos. It writes needs, hobbies, interests and values, each with evidence, source and confidence.</p></div>
      <div class="card w4"><div class="ic"><i class="ph ph-user-focus"></i></div><h3>The agent becomes them</h3><p class="small muted" style="margin-top:6px">The analysis becomes the agent's persona prompt. It speaks in first person, in the person's style, and never invents facts.</p></div>
      <div class="card w8"><div class="ic"><i class="ph ph-chats-circle"></i></div><h3>Agents date each other</h3><p class="small muted" style="margin-top:6px">Every agent goes on ${cfg.dates_per_agent} dates, with partners picked to spread dates evenly across the pool. Orientation is checked both ways. Each date is a real alternating conversation between two separate agents, neither of which sees the other's profile. At most ${cfg.max_turns} turns (hard cap ${cfg.hard_cap}). Every turn: react, share something real, ask one sharp question.</p></div>
      <div class="card w6"><div class="ic"><i class="ph ph-scales"></i></div><h3>A judge scores the date</h3><p class="small muted" style="margin-top:6px">An independent matchmaker model reads both profiles and the transcript. It scores hobbies, interests, background, ambition, values and lifestyle, and vibe from 0 to 10, and says whether each side wants a second date. The weighted score is saved to 4 decimal places: ${Object.entries(cfg.weights).map(([k, w]) => `${esc(k.replace("_", " and "))} ${w}`).join(", ")}.</p></div>
      <div class="card w6"><div class="ic"><i class="ph ph-ranking"></i></div><h3>Everyone gets a ranking</h3><p class="small muted" style="margin-top:6px">Each person's matches are sorted by judge score, and you also see where they rank you. Averaging all of a person's scores gives their rank in the pool.</p></div>
    </div>
    <section class="section card"><h2>Tech stack</h2><ul class="clean" style="margin-top:12px">
      <li><b>Scraping:</b> Apify, using ${esc(cfg.scrapers.linkedin)} (no cookies) for LinkedIn and ${esc(cfg.scrapers.instagram)} for Instagram, with runs started asynchronously and polled.</li>
      <li><b>LLM:</b> OpenRouter with ${esc(cfg.models.agent)} for agents, judge and analysis, using JSON-schema structured outputs validated with Zod.</li>
      <li><b>App:</b> Express API on Vercel serverless functions, Turso (serverless SQLite) for storage, and a vanilla JS frontend. The browser drives dates one leased turn at a time, so nothing depends on background workers.</li>
    </ul></section>`;
}

// ---------- auth forms ---------------------------------------------------------------------------------
function formErrors(form, e) {
  form.querySelectorAll(".field").forEach((f) => { f.classList.remove("bad"); const er = f.querySelector(".err"); if (er) er.textContent = ""; });
  const box = form.querySelector(".form-err");
  const f = e.field && form.querySelector(`[name="${e.field}"]`)?.closest(".field");
  if (f) { f.classList.add("bad"); f.querySelector(".err").textContent = e.message; f.querySelector("input,select")?.focus(); box.innerHTML = ""; }
  else box.textContent = e.message;
  if (e.existing_id && !f) box.innerHTML += ` <a class="link" href="#/p/${e.existing_id}">View their profile</a>`;
  else if (e.existing_id) f.querySelector(".err").innerHTML += ` <a class="link" href="#/p/${e.existing_id}">View profile</a>`;
}
const field = (name, label, attrs = "", help = "") =>
  `<div class="field"><label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" ${attrs}>${help ? `<div class="help">${help}</div>` : ""}<div class="err"></div></div>`;

async function join() {
  if (me) { location.hash = "#/me"; return; }
  $app.innerHTML = `<div class="auth-wrap stack-lg">
    <div><h1>Create your agent</h1><p class="muted" style="margin-top:8px">Two public links are all your agent gets. It reads them, builds your profile, then goes on dates with compatible agents in the pool.</p></div>
    <form class="card form" id="f" novalidate>
      <h3>Your two sources</h3>
      ${field("linkedin_url", "LinkedIn profile URL", 'required placeholder="https://www.linkedin.com/in/your-name" autocomplete="url"')}
      ${field("instagram_url", "Instagram profile URL", 'required placeholder="https://www.instagram.com/yourhandle"', "Must be a public account.")}
      <h3 style="margin-top:8px">About you</h3>
      ${field("name", "Full name", 'required autocomplete="name"')}
      <div class="grid2">
        <div class="field"><label for="f-sex">Sex</label><select id="f-sex" name="sex"><option value="female">Female</option><option value="male">Male</option></select><div class="err"></div></div>
        <div class="field"><label for="f-orientation">Interested in</label><select id="f-orientation" name="orientation"><option value="straight">The opposite sex (straight)</option><option value="gay">The same sex (gay or lesbian)</option><option value="bisexual">Everyone (bisexual)</option><option value="unspecified">Prefer not to say (open to everyone)</option></select><div class="err"></div></div>
      </div>
      ${field("age", "Age (optional)", 'type="number" min="18" max="100" inputmode="numeric"', "Leave empty and your agent will estimate it.")}
      <h3 style="margin-top:8px">Your login</h3>
      <div class="grid2">${field("email", "Email", 'type="email" required autocomplete="email"')}${field("password", "Password", 'type="password" required minlength="8" autocomplete="new-password"', "At least 8 characters.")}</div>
      <p class="form-err"></p>
      <div class="row between"><span class="small muted">Already have an agent? <a class="link" href="#/login">Log in</a></span><button class="btn" type="submit">Create my agent<span class="ico"><i class="ph ph-arrow-right"></i></span></button></div>
    </form></div>`;
  const form = document.getElementById("f");
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true; btn.firstChild.textContent = "Creating your agent";
    try {
      await post("/api/signup", Object.fromEntries(new FormData(form)));
      await loadMe();
      toast("Your agent is reading your profiles");
      location.hash = "#/me";
    } catch (e) { formErrors(form, e); btn.disabled = false; btn.firstChild.textContent = "Create my agent"; }
  };
}

async function login() {
  if (me) { location.hash = "#/me"; return; }
  $app.innerHTML = `<div class="auth-wrap stack-lg" style="max-width:420px">
    <div><h1>Log in</h1><p class="muted" style="margin-top:8px">See your agent, its dates, and where everyone ranks you.</p></div>
    <form class="card form" id="f" novalidate>
      ${field("email", "Email", 'type="email" required autocomplete="email"')}
      ${field("password", "Password", 'type="password" required autocomplete="current-password"')}
      <p class="form-err"></p>
      <div class="row between"><a class="small link" href="#/join">Create an agent instead</a><button class="btn" type="submit">Log in</button></div>
    </form></div>`;
  const form = document.getElementById("f");
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    try { await post("/api/login", Object.fromEntries(new FormData(form))); await loadMe(); location.hash = "#/me"; }
    catch (e) { formErrors(form, e); }
  };
}

// ---------- dashboard ---------------------------------------------------------------------------------
async function dashboard() {
  const data = await api("/api/me");
  if (!data.user) { location.hash = "#/login"; return; }
  const draw = (d) => {
    const u = d.user, conns = d.connections;
    const judged = conns.filter((c) => c.score != null);
    const pending = conns.length - judged.length;
    const best = judged[0];
    const lovesMe = judged.filter((c) => c.their_rank_of_me === 1).length;
    $app.innerHTML = `
      <section class="row between" style="align-items:flex-start">
        <div class="row">${avatar(u.photo_url, u.name, "lg")}<div><h1 style="font-size:clamp(1.6rem,3vw,2.2rem)">${first(u.name)}'s agent</h1><div class="row" style="margin-top:8px">${pill(u.status)}${u.rank ? `<span class="pill accent">${ord(u.rank)} in the pool</span>` : ""}</div></div></div>
        <div class="row"><a class="btn btn-ghost btn-sm" href="#/p/${u.id}">My public profile</a><button class="btn btn-ghost btn-sm" id="logout">Log out</button></div>
      </section>
      ${u.status !== "ready" ? `<section class="section card stack">${u.status === "error" ? `<p class="form-err"><i class="ph ph-warning-circle"></i> ${esc(u.error)}</p>` : ""}${pipeline(u)}
        ${u.status === "error" ? `<form class="form" id="fix" novalidate><h3>Fix your links and try again</h3>
          ${field("linkedin_url", "LinkedIn profile URL", `required value="${esc(u.linkedin_url)}"`)}${field("instagram_url", "Instagram profile URL", `required value="${esc(u.instagram_url)}"`, "Must be a public account.")}
          <p class="form-err"></p><div><button class="btn" type="submit">Read my profiles again</button></div></form>` : ""}</section>` : `
      <section class="section stats">
        <div><b class="mono">${conns.length}</b><span class="small muted">agents connected with</span></div>
        <div><b class="mono">${judged.length}</b><span class="small muted">dates judged${pending ? `, ${pending} to go` : ""}</span></div>
        <div><b class="mono">${best ? score(best.score) : "-"}</b><span class="small muted">best match${best ? `: ${esc(best.name)}` : ""}</span></div>
        <div><b class="mono">${lovesMe}</b><span class="small muted">people rank you #1</span></div>
      </section>
      ${pending ? `<p class="small muted" style="margin-top:14px"><span class="pill accent"><span class="live-dot"></span>Dating</span> Your agent is on dates right now. Keep this page open to speed them along.</p>` : ""}
      <section class="section card">
        <div class="section-head"><h2>Your connections</h2><span class="small muted">Everyone your agent dated, best fit first. Click a row to read the date.</span></div>
        ${conns.length ? rankingTable(conns, "you") : `<div class="empty"><i class="ph ph-users-three"></i><p>No compatible agents in the pool yet for your preferences.</p><button class="btn btn-ghost btn-sm" id="rescan">Check again</button></div>`}
      </section>`}`;
    bindRows();
    document.getElementById("logout").onclick = async () => { await post("/api/logout"); me = null; await loadMe(); location.hash = "#/"; };
    const rescan = document.getElementById("rescan");
    if (rescan) rescan.onclick = async () => { await post("/api/me/retry"); refresh(); };
    const fix = document.getElementById("fix");
    if (fix) fix.onsubmit = async (ev) => {
      ev.preventDefault();
      try { await post("/api/me/links", Object.fromEntries(new FormData(fix))); toast("Reading your profiles again"); refresh(); watch(); }
      catch (e) { formErrors(fix, e); }
    };
  };
  let last = JSON.stringify(data);
  const refresh = async () => {
    const d = await api("/api/me").catch(() => null);
    if (!d?.user) return;
    const snap = JSON.stringify(d);
    if (snap !== last) { last = snap; draw(d); } // never clobber a half-typed form with an identical redraw
    if (d.user.status === "ready" && !engine.scope) engine.set({ user: d.user.id });
  };
  let unwatch = () => {};
  const watch = () => { unwatch(); unwatch = watchPipeline(data.user.id, () => refresh()); };
  draw(data);
  if (data.user.status === "ready") engine.set({ user: data.user.id });
  else if (data.user.status !== "error") watch();
  const off = engine.on((e) => (e.status === "done" || e.message) && refreshSoon());
  let t; const refreshSoon = () => { clearTimeout(t); t = setTimeout(refresh, 700); };
  const stop = every(8000, refresh);
  cleanup = () => { off(); stop(); unwatch(); };
}
