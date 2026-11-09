// profile.js - "What I've learned about you" page: dashboard, style, rules, history, data controls

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
const fmtDate = (ts) => new Date(ts).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

let state = { interactions: [], prefs: [], prefLog: [], settings: {}, prefState: {} };
let historyLimit = 30;

async function load() {
  const [interactions, prefs, prefLog, settings, { prefState = {} }] = await Promise.all([
    AIP.getInteractions(), AIP.getPreferences(), AIP.getPreferenceLog(), AIP.getLearningSettings(), chrome.storage.local.get("prefState")
  ]);
  state = { interactions, prefs, prefLog, settings, prefState };
  renderAll();
}

function renderAll() {
  renderPill();
  renderOverview();
  renderStyle();
  renderRules();
  renderHistory();
  renderSettings();
}

function renderPill() {
  const p = $("statePill");
  if (!state.settings.personalizationEnabled) { p.className = "pill off"; p.textContent = "Personalisation off"; }
  else if (state.settings.learningPaused) { p.className = "pill paused"; p.textContent = "Learning paused"; }
  else { p.className = "pill on"; p.textContent = "Personalisation on · learning"; }
}

// ---------------- Overview ----------------
function renderOverview() {
  const m = AIP.computeMetrics(state.interactions);
  const tiles = [
    { label: "Replies learned from", value: m.used, hint: `${m.discarded} discarded` },
    { label: "Sent without changes", value: pct(m.overall.acceptRate), hint: "share of used replies" },
    { label: "Average edit amount", value: pct(m.overall.avgEdit), hint: "of the AI first draft" },
    { label: "Preferences", value: `${state.prefs.length} / 5`, hint: `${(state.prefLog || []).length} updates so far` },
    { label: "Ratings", value: `👍 ${m.thumbsUp} · 👎 ${m.thumbsDown}`, hint: "from the reply card" }
  ];
  $("tiles").innerHTML = tiles.map((t) => `<div class="tile"><div class="label">${esc(t.label)}</div><div class="value" style="${String(t.value).length > 8 ? "font-size:20px" : ""}">${esc(t.value)}</div><div class="hint">${esc(t.hint)}</div></div>`).join("");

  $("chart").innerHTML = m.series.length >= 2
    ? lineChart(m.series)
    : `<div class="empty">Not enough data yet. Use the extension for a few replies (Copy or Insert them) and the trend will appear here.</div>`;

  const row = (name, g) => `<tr><td>${esc(name)}</td><td class="num">${g.n}</td><td class="num">${pct(g.acceptRate)}</td><td class="num">${pct(g.avgEdit)}</td></tr>`;
  $("compareTable").innerHTML =
    `<tr><th>Group</th><th class="num">Replies</th><th class="num">Sent unchanged</th><th class="num">Avg. edit</th></tr>` +
    row("Personalised", m.personalized) +
    row("Generic (no profile used)", m.generic) +
    row("First half of history", m.firstHalf) +
    row("Second half of history", m.secondHalf) +
    (m.byModel.length > 1 || (m.byModel[0] && m.byModel[0].model !== "unknown")
      ? m.byModel.map((g) => row(`Model: ${g.model}`, g)).join("")
      : "");
}

// Small dependency-free SVG line chart
function lineChart(series) {
  const W = 880, H = 220, L = 40, R = 12, T = 12, B = 28;
  const n = series.length;
  const x = (i) => L + (n === 1 ? 0 : (i / (n - 1)) * (W - L - R));
  const y = (v) => T + (1 - v) * (H - T - B);
  const path = (key) => series.map((s, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(s[key]).toFixed(1)}`).join(" ");
  const grid = [0, 0.25, 0.5, 0.75, 1].map((v) =>
    `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#EEF2F7"/><text x="${L - 6}" y="${y(v) + 4}" font-size="11" fill="#94A3B8" text-anchor="end">${v * 100}%</text>`
  ).join("");
  const ticks = series.filter((_, i) => n <= 12 || i % Math.ceil(n / 12) === 0 || i === n - 1)
    .map((s) => `<text x="${x(s.i - 1)}" y="${H - 8}" font-size="11" fill="#94A3B8" text-anchor="middle">${s.i}</text>`).join("");
  const dots = series.map((s, i) => `<circle cx="${x(i)}" cy="${y(s.edit)}" r="2.5" fill="#C7D2FE"><title>Reply ${s.i}: ${Math.round(s.edit * 100)}% edited</title></circle>`).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Edit amount over time">
      ${grid}${ticks}${dots}
      <path d="${path("rollingEdit")}" fill="none" stroke="#4F46E5" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="${path("rollingAccept")}" fill="none" stroke="#10B981" stroke-width="2" stroke-dasharray="5 4" stroke-linejoin="round"/>
    </svg>
    <div class="legend"><span style="--c:#4F46E5">Edit amount (rolling avg)</span><span style="--c:#10B981">Sent unchanged (rolling share)</span><span style="--c:#C7D2FE">Each reply</span><span>x-axis: reply number</span></div>`;
}

// ---------------- Style ----------------
function renderStyle() {
  const stats = AIP.computeStyleStats(state.interactions);
  const lines = AIP.styleToPromptLines(stats, "", {});
  $("styleLines").innerHTML = lines.length
    ? lines.map((l) => `<li>${esc(l)}</li>`).join("")
    : `<div class="empty">No habits detected yet. They appear after about 3 used replies.</div>`;

  if (!stats.n) {
    $("styleKv").innerHTML = `<div class="empty" style="grid-column:1/-1;background:none">No used replies yet.</div>`;
  } else {
    const kv = [
      ["Typical length", `${stats.medianWords} words (avg ${stats.avgWords})`],
      ["Usual opening", stats.greeting.value === "(none)" ? `No greeting (${pct(stats.greeting.share)})` : `"${stats.greeting.value}" (${pct(stats.greeting.share)})`],
      ["Usual closing", stats.closing.value === "(none)" ? `No sign-off (${pct(stats.closing.share)})` : `"${stats.closing.value}" (${pct(stats.closing.share)})`],
      ["Uses emoji", pct(stats.emojiRate)],
      ["Uses contractions", stats.contractionRate == null ? "not enough data" : pct(stats.contractionRate)],
      ["Uses exclamation marks", pct(stats.exclamationRate)],
      ["Replies analysed", stats.n]
    ];
    $("styleKv").innerHTML = kv.map(([k, v]) => `<div><b>${esc(k)}</b>${esc(v)}</div>`).join("");
  }
  const chips = (list, cls) => list.length
    ? list.map(([p, c]) => `<span class="chip ${cls}" title="${c} times">${esc(p)} ×${c}</span>`).join("")
    : `<span class="status">Nothing repeated yet (needs the same change in 2+ replies)</span>`;
  $("removedPhrases").innerHTML = chips(stats.removedPhrases || [], "red");
  $("addedPhrases").innerHTML = chips(stats.addedPhrases || [], "green");

  const sites = Object.entries(stats.perSite || {}).sort((a, b) => b[1].n - a[1].n);
  $("siteTable").innerHTML = sites.length
    ? `<tr><th>Website</th><th class="num">Replies</th><th class="num">Avg. words</th><th>Refine buttons used</th></tr>` +
      sites.map(([site, s]) => `<tr><td>${esc(site || "(unknown)")}</td><td class="num">${s.n}</td><td class="num">${s.avgWords}</td><td>${
        Object.entries(s.chips).map(([c, n]) => `<span class="chip">${esc(c)} ×${n}</span>`).join(" ") || '<span class="status">–</span>'
      }</td></tr>`).join("")
    : `<tr><td class="empty">No data yet.</td></tr>`;
}

// ---------------- Preferences (the 5 always-updated preferences) ----------------
function renderRules() {
  const ps = state.prefState || {};
  const info = [];
  if (ps.lastTs) info.push(`Last updated ${fmtDate(ps.lastTs)} (${ps.lastChanged || 0} changed)`);
  info.push(state.settings.autoLearnRules && !state.settings.learningPaused
    ? "Updates automatically after every reply you send"
    : "Automatic updates are off (Settings & data)");
  if (!$("learnStatus").dataset.busy) { $("learnStatus").className = "status"; $("learnStatus").textContent = info.join(" · "); }

  const list = $("rulesList");
  const slots = [];
  for (let i = 0; i < 5; i++) {
    const p = state.prefs[i];
    slots.push(p
      ? `<div class="rule" data-id="${esc(p.id)}">
          <span class="slot">${i + 1}</span>
          <input type="text" value="${esc(p.text)}" data-act="edit" title="Click to edit (an edited preference is pinned)">
          <label class="pin" title="Pinned preferences never change automatically"><input type="checkbox" data-act="pin" ${p.locked ? "checked" : ""}> 📌</label>
          <span class="src ${p.source === "user" ? "user" : ""}">${p.source === "user" ? "you" : "learned"}</span>
          <button class="btn icon danger" data-act="delete" title="Remove (the next update fills this slot)">✕</button>
        </div>`
      : `<div class="rule disabled"><span class="slot">${i + 1}</span><span class="status">Empty: filled after your next sent reply</span></div>`);
  }
  list.innerHTML = slots.join("");
  $("addRuleRow").style.display = state.prefs.length < 5 ? "" : "none";

  const log = [...(state.prefLog || [])].reverse().slice(0, 10);
  $("prefLog").innerHTML = log.length
    ? log.map((e) => `<li><div class="status">${esc(fmtDate(e.ts))} · after a reply on ${esc(e.site || "–")} (${esc(e.trigger || "")})</div>
        ${(e.added || []).map((t) => `<div class="chg add">+ ${esc(t)}</div>`).join("")}
        ${(e.removed || []).map((t) => `<div class="chg del">− ${esc(t)}</div>`).join("")}
        ${!(e.added || []).length && !(e.removed || []).length ? '<div class="status">No change: the reply confirmed the current preferences</div>' : ""}</li>`).join("")
    : `<div class="empty">No updates yet. Send a reply with the extension and the first preferences appear here.</div>`;
}

async function savePrefs() {
  await AIP.savePreferences(state.prefs);
  renderRules();
  renderOverview();
}

$("rulesList").addEventListener("change", async (e) => {
  const row = e.target.closest(".rule");
  const pref = row && state.prefs.find((p) => p.id === row.dataset.id);
  if (!pref) return;
  if (e.target.dataset.act === "pin") pref.locked = e.target.checked;
  if (e.target.dataset.act === "edit") {
    const v = e.target.value.trim();
    if (!v) return;
    pref.text = v;
    pref.source = "user";
    pref.locked = true; // the user's own wording is never overwritten automatically
  }
  pref.updatedTs = Date.now();
  await savePrefs();
});
$("rulesList").addEventListener("click", async (e) => {
  if (e.target.dataset.act !== "delete") return;
  const id = e.target.closest(".rule").dataset.id;
  state.prefs = state.prefs.filter((p) => p.id !== id);
  await savePrefs();
});
$("addRuleBtn").addEventListener("click", async () => {
  const v = $("newRule").value.trim();
  if (!v) return $("newRule").focus();
  if (state.prefs.length >= 5) return;
  state.prefs.push(AIP.newPreference(v, "user"));
  $("newRule").value = "";
  await savePrefs();
});
$("newRule").addEventListener("keydown", (e) => { if (e.key === "Enter") $("addRuleBtn").click(); });

$("learnNowBtn").addEventListener("click", async () => {
  const btn = $("learnNowBtn"), st = $("learnStatus");
  btn.disabled = true;
  st.dataset.busy = "1";
  st.className = "status";
  st.textContent = "Updating your preferences from your latest sent reply… (up to a minute on a local model)";
  try {
    const res = await chrome.runtime.sendMessage({ type: "LEARN_NOW" });
    if (!res || !res.success) throw new Error(res ? res.error : "No response");
    st.className = "status ok";
    st.textContent = res.added.length ? `✓ Updated: ${res.added.length} preference${res.added.length === 1 ? "" : "s"} changed` : "✓ Done: your current preferences still fit";
  } catch (err) {
    st.className = "status err";
    st.textContent = `✕ ${err.message || err}`;
  } finally {
    btn.disabled = false;
    delete st.dataset.busy;
    await load();
  }
});

// ---------------- History ----------------
const ACTION_LABELS = {
  sent: "✓ sent",
  "insert-edited": "inserted, edited on page",
  insert: "inserted",
  copy: "copied",
  "popup-copy": "copied (popup)"
};
const ACTION_TITLES = {
  sent: "Learned from the exact text you sent (including edits made on the page after inserting)",
  "insert-edited": "You edited it on the page after inserting; no send was detected, so the last edited version was used",
  insert: "Inserted into the page; learned from the inserted text",
  copy: "Copied; learned from the text in the card when you copied it",
  "popup-copy": "Copied from the popup"
};
function renderHistory() {
  const rows = [...state.interactions].sort((a, b) => b.ts - a.ts);
  const shown = rows.slice(0, historyLimit);
  $("moreHistory").style.display = rows.length > historyLimit ? "" : "none";
  if (!rows.length) {
    $("historyTable").innerHTML = `<tr><td class="empty">No replies yet. Snip a message (Alt+S), then Copy or Insert the reply.</td></tr>`;
    return;
  }
  $("historyTable").innerHTML =
    `<tr><th>When</th><th>Site</th><th>Message &amp; reply</th><th>Result</th><th class="num">Edit</th><th>Rating</th><th></th></tr>` +
    shown.map((r) => `
      <tr data-id="${esc(r.id)}">
        <td style="white-space:nowrap">${esc(fmtDate(r.ts))}</td>
        <td>${esc(r.site || "–")}</td>
        <td>
          <div class="clip" title="${esc(r.context)}">${esc((r.context || "(image only)").replace(/\s+/g, " "))}</div>
          <details><summary>AI draft vs. what you sent</summary>
            <div class="compare">
              <div><b>AI first draft</b><pre>${esc(r.firstDraft || "")}</pre></div>
              <div><b>You sent</b><pre>${esc(r.final || "(not used)")}</pre></div>
            </div>
            ${(r.chips || []).length ? `<div class="status" style="margin-top:6px">Refine steps: ${esc(r.chips.join(" → "))}</div>` : ""}
            ${r.personalization ? `<div class="status" style="margin-top:4px">Personalised with ${r.personalization.examples || 0} examples, ${r.personalization.preferences ?? r.personalization.rules ?? 0} preferences, ${r.personalization.style || 0} style habits</div>` : ""}
          </details>
        </td>
        <td><span class="outcome ${esc(r.outcome)}">${esc(r.outcome || "")}</span>${r.personalized ? ' <span title="Personalised">✨</span>' : ""}
          ${ACTION_LABELS[r.action] ? `<div class="status" style="margin-top:4px;white-space:nowrap" title="${esc(ACTION_TITLES[r.action] || "")}">${esc(ACTION_LABELS[r.action])}</div>` : ""}</td>
        <td class="num">${r.outcome === "discarded" ? "–" : pct(r.editRatio)}</td>
        <td>${r.rating === 1 ? "👍" : r.rating === -1 ? "👎" : ""}</td>
        <td><button class="btn icon danger" data-act="del" title="Delete from history">✕</button></td>
      </tr>`).join("");
}
$("historyTable").addEventListener("click", async (e) => {
  if (e.target.dataset.act !== "del") return;
  const id = e.target.closest("tr").dataset.id;
  state.interactions = state.interactions.filter((r) => r.id !== id);
  await AIP.saveInteractions(state.interactions);
  renderAll();
});
$("moreHistory").addEventListener("click", () => { historyLimit += 50; renderHistory(); });

// ---------------- Settings & data ----------------
function renderSettings() {
  $("optPersonalize").checked = state.settings.personalizationEnabled;
  $("optPaused").checked = state.settings.learningPaused;
  $("optAutoRules").checked = state.settings.autoLearnRules;
  $("optEmbed").checked = state.settings.useEmbeddings;
  if (document.activeElement !== $("embedModel")) $("embedModel").value = state.settings.embedModel || "nomic-embed-text";
}
const bindToggle = (id, key) => $(id).addEventListener("change", async (e) => {
  await chrome.storage.sync.set({ [key]: e.target.checked });
  await load();
});
bindToggle("optPersonalize", "personalizationEnabled");
bindToggle("optPaused", "learningPaused");
bindToggle("optAutoRules", "autoLearnRules");
bindToggle("optEmbed", "useEmbeddings");
$("embedModel").addEventListener("change", async (e) => {
  await chrome.storage.sync.set({ embedModel: e.target.value.trim() || "nomic-embed-text" });
});

$("testEmbedBtn").addEventListener("click", async () => {
  const st = $("embedStatus"), btn = $("testEmbedBtn");
  const model = $("embedModel").value.trim() || "nomic-embed-text";
  await chrome.storage.sync.set({ embedModel: model });
  btn.disabled = true;
  st.className = "status";
  st.textContent = "Testing…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "CHECK_EMBEDDINGS", model });
    if (res && res.ok) {
      st.className = "status ok";
      st.textContent = `✓ Working (${res.dims} dimensions). Indexed ${res.backfilled} older repl${res.backfilled === 1 ? "y" : "ies"}.`;
    } else {
      st.className = "status err";
      st.textContent = `✕ Not available: ${res?.error || "unknown error"}. Run 'ollama pull ${model}'. Keyword search is used meanwhile.`;
    }
  } catch (err) {
    st.className = "status err";
    st.textContent = `✕ ${err.message || err}`;
  } finally {
    btn.disabled = false;
  }
});

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const stamp = () => new Date().toISOString().slice(0, 10);

$("exportJsonBtn").addEventListener("click", () => {
  const data = { app: "AI Reply Assistant", version: 1, exportedAt: new Date().toISOString(),
    interactions: state.interactions.map(({ emb, ...r }) => r), preferences: state.prefs, preferenceLog: state.prefLog };
  download(`ai-reply-backup-${stamp()}.json`, JSON.stringify(data, null, 2), "application/json");
  setStatus(`✓ Exported ${state.interactions.length} replies and ${state.prefs.length} preferences.`, "ok");
});
$("exportJsonlBtn").addEventListener("click", async () => {
  const { userName = "" } = await chrome.storage.sync.get("userName");
  const jsonl = AIP.toFineTuneJSONL(state.interactions, userName);
  if (!jsonl) return setStatus("Nothing to export yet: use (Copy/Insert) some replies first.", "err");
  download(`ai-reply-training-${stamp()}.jsonl`, jsonl + "\n", "application/jsonl");
  setStatus(`✓ Exported ${jsonl.split("\n").length} training examples (chat-format JSONL).`, "ok");
});
$("importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.interactions)) throw new Error("This file is not an AI Reply Assistant backup.");
    const byId = new Map(state.interactions.map((r) => [r.id, r]));
    data.interactions.forEach((r) => r && r.id && !byId.has(r.id) && byId.set(r.id, r));
    const merged = [...byId.values()].sort((a, b) => a.ts - b.ts);
    let prefs = [...state.prefs];
    const incoming = Array.isArray(data.preferences) ? data.preferences : AIP.rulesToPreferences(data.learnedRules || []);
    incoming.forEach((p) => p && p.text && prefs.length < 5 && !prefs.some((x) => x.text === p.text) && prefs.push(p));
    await AIP.saveInteractions(merged);
    await AIP.savePreferences(prefs);
    setStatus(`✓ Imported. You now have ${Math.min(merged.length, AIP.MAX_INTERACTIONS)} replies and ${prefs.length} preferences.`, "ok");
    await load();
  } catch (err) {
    setStatus(`✕ Import failed: ${err.message}`, "err");
  } finally {
    e.target.value = "";
  }
});
$("resetBtn").addEventListener("click", async () => {
  if (!confirm("Delete all learned history, preferences and statistics? Your settings are kept. Consider exporting a backup first.")) return;
  await chrome.storage.local.remove(["interactions", "preferences", "preferenceLog", "prefState", "learnedRules", "learnState", "replyHistory"]);
  setStatus("✓ Everything learned has been reset.", "ok");
  await load();
});
function setStatus(text, kind) {
  $("dataStatus").className = `status ${kind || ""}`;
  $("dataStatus").textContent = text;
}

// ---------------- Tabs & live updates ----------------
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${t.dataset.tab}`));
  try { localStorage.setItem("profileTab", t.dataset.tab); } catch (e) {}
}));
try {
  const saved = localStorage.getItem("profileTab");
  if (saved) document.querySelector(`.tab[data-tab="${saved}"]`)?.click();
} catch (e) {}
const openHashTab = () => location.hash && document.querySelector(`.tab[data-tab="${location.hash.slice(1)}"]`)?.click();
openHashTab();
window.addEventListener("hashchange", openHashTab);

chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === "local" && (changes.interactions || changes.preferences || changes.preferenceLog || changes.prefState)) ||
      (area === "sync" && (changes.personalizationEnabled || changes.learningPaused || changes.autoLearnRules || changes.useEmbeddings))) {
    load();
  }
});

load();
