// personalization.js - Self-learning & personalisation engine for AI Reply Assistant
//
// Used by background.js (via importScripts) and by profile.html.
// Everything is stored locally on the user's device (chrome.storage.local).
//
// How the extension "learns" (no model training needed):
//  1. Every reply becomes an INTERACTION: the message, the AI draft, what the user finally
//     sent, which refine buttons they used, 👍/👎, and the site.
//  2. RETRIEVAL: for a new message, the most similar past messages are found (embeddings from the
//     local LLM server when available, TF-IDF keyword similarity otherwise) and the user's REAL
//     replies to them are given to the model as examples (few-shot).
//  3. STYLE PROFILE: measurable writing habits (length, greeting, sign-off, emoji, contractions,
//     phrases the user always deletes/adds, per-site preferences) are computed and added to the prompt.
//  4. 5 PREFERENCES: after every reply the user sends, the LLM rewrites a list of exactly 5 writing
//     preferences from the current 5 + the new reply (draft vs. sent). The user can view, edit or pin them.
//  5. METRICS: edit distance and acceptance rate over time show whether the learning works.
//  The interaction log doubles as a training dataset (JSONL export) for a future fine-tuned model.

(function (global) {
  "use strict";

  const MAX_INTERACTIONS = 500;

  // ---------------------------------------------------------------------------
  // Text utilities
  // ---------------------------------------------------------------------------
  const STOPWORDS = new Set((
    "a an the and or but if then so to of in on at by for with from as is are was were be been being am " +
    "i me my we our you your he she it its they them their this that these those there here what which who " +
    "whom will would shall should can could may might must do does did doing have has had having not no yes " +
    "very just also than too more most some any all each other such only own same into over under again " +
    "about up down out off once hi hello dear thanks thank regards best please let know get got im ive ill"
  ).split(/\s+/));

  function tokenize(text) {
    const m = String(text || "")
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[’']/g, "")
      .match(/[\p{L}\p{N}]+/gu);
    return (m || []).filter((t) => t.length > 1 && !STOPWORDS.has(t));
  }

  function words(text) {
    return String(text || "").trim().split(/\s+/).filter(Boolean);
  }

  // TF-IDF cosine similarity of `query` against each doc in `docs`
  function tfidfScores(query, docs) {
    const qTok = tokenize(query);
    const dTok = docs.map(tokenize);
    if (!qTok.length) return docs.map(() => 0);
    const N = dTok.length + 1;
    const df = new Map();
    [qTok, ...dTok].forEach((toks) => new Set(toks).forEach((t) => df.set(t, (df.get(t) || 0) + 1)));
    const vec = (toks) => {
      const tf = new Map();
      toks.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
      const v = new Map();
      let norm = 0;
      tf.forEach((c, t) => {
        const w = (1 + Math.log(c)) * Math.log(1 + N / (df.get(t) || 1));
        v.set(t, w);
        norm += w * w;
      });
      return { v, norm: Math.sqrt(norm) || 1 };
    };
    const q = vec(qTok);
    return dTok.map((toks) => {
      if (!toks.length) return 0;
      const d = vec(toks);
      let dot = 0;
      q.v.forEach((w, t) => {
        const x = d.v.get(t);
        if (x) dot += w * x;
      });
      return dot / (q.norm * d.norm);
    });
  }

  function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
  }

  // Normalised word-level edit distance: 0 = identical, 1 = completely rewritten
  function editRatio(a, b) {
    const x = words(a).slice(0, 400);
    const y = words(b).slice(0, 400);
    if (!x.length && !y.length) return 0;
    if (!x.length || !y.length) return 1;
    let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
    for (let i = 1; i <= x.length; i++) {
      const cur = [i];
      for (let j = 1; j <= y.length; j++) {
        const cost = x[i - 1].toLowerCase() === y[j - 1].toLowerCase() ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      prev = cur;
    }
    return Math.min(1, prev[y.length] / Math.max(x.length, y.length));
  }

  // Whole phrases the user removed from / added to the AI draft.
  // Uses a word-level LCS alignment, so "I hope this email finds you well" comes out as ONE phrase.
  function phraseDiff(generated, final) {
    // keep sentence punctuation as separate tokens so removed passages split into phrases
    const norm = (t) => words(String(t || "").toLowerCase().replace(/[’]/g, "'").replace(/([.,!?;:\n])/g, " $1 ").replace(/[^\p{L}\p{N}\s'.,!?;:]/gu, " ")).slice(0, 300);
    const PUNCT = /^[.,!?;:]$/;
    const x = norm(generated), y = norm(final);
    const L = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--)
        L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const removed = [], added = [];
    let i = 0, j = 0, rem = [], add = [];
    const pieces = (toks, out) => {
      let cur = [];
      toks.forEach((t) => {
        if (PUNCT.test(t)) { if (cur.length) out.push(cur.join(" ")); cur = []; }
        else cur.push(t);
      });
      if (cur.length) out.push(cur.join(" "));
    };
    const flush = () => {
      pieces(rem, removed);
      pieces(add, added);
      rem = []; add = [];
    };
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) { flush(); i++; j++; }
      else if (j >= y.length || (i < x.length && L[i + 1][j] >= L[i][j + 1])) rem.push(x[i++]);
      else add.push(y[j++]);
    }
    flush();
    const meaningful = (g) => {
      const w = g.split(" ");
      return w.length >= 2 && w.length <= 10 && w.some((t) => t.length > 2 && !STOPWORDS.has(t));
    };
    return { removed: removed.filter(meaningful), added: added.filter(meaningful) };
  }

  // Merge near-identical phrases ("hope this email finds you well" / "i hope this email finds you well")
  function collapsePhrases(list) {
    const sorted = [...list].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);
    const kept = [];
    for (const [p, c] of sorted) {
      const hit = kept.find((k) => k[0].includes(p) || p.includes(k[0]));
      if (hit) { hit[1] += c; if (p.length < hit[0].length) hit[0] = p; }
      else kept.push([p, c]);
    }
    return kept;
  }

  // Guess who wrote the snipped message (used to prefer past replies to the same person)
  function extractSender(context) {
    const lines = String(context || "").split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return "";
    const closing = /^(thanks|thank you|regards|best|best regards|kind regards|warm regards|cheers|sincerely|yours|take care)[,!.]?$/i;
    for (let i = lines.length - 2; i >= Math.max(0, lines.length - 8); i--) {
      if (closing.test(lines[i])) {
        const name = lines[i + 1].replace(/[^\p{L}\s.'-]/gu, "").trim();
        if (name && words(name).length <= 4) return name;
      }
    }
    const dash = lines[lines.length - 1].match(/^[-–—~]\s*([\p{L}][\p{L}\s.'-]{1,40})$/u);
    if (dash) return dash[1].trim();
    return "";
  }

  // ---------------------------------------------------------------------------
  // Storage helpers (chrome.storage.local - stays on this device)
  // ---------------------------------------------------------------------------
  async function getInteractions() {
    const { interactions = [] } = await chrome.storage.local.get("interactions");
    return interactions;
  }
  async function saveInteractions(list) {
    await chrome.storage.local.set({ interactions: list.slice(-MAX_INTERACTIONS) });
  }
  async function upsertInteraction(record) {
    const list = await getInteractions();
    const i = list.findIndex((r) => r.id === record.id);
    if (i >= 0) list[i] = { ...list[i], ...record };
    else list.push(record);
    await saveInteractions(list);
    return list;
  }
  async function getRules() {
    const { learnedRules = [] } = await chrome.storage.local.get("learnedRules");
    return learnedRules;
  }
  async function saveRules(rules) {
    await chrome.storage.local.set({ learnedRules: rules });
  }
  async function getLearningSettings() {
    return chrome.storage.sync.get({
      personalizationEnabled: true,
      learningPaused: false,
      useEmbeddings: true,
      embedModel: "nomic-embed-text",
      autoLearnRules: true // "Update preferences automatically after every sent reply"
    });
  }

  // Interactions that represent a reply the user actually used
  function usable(list) {
    return list.filter((r) => r.final && r.final.trim() && r.outcome && r.outcome !== "discarded");
  }

  // ---------------------------------------------------------------------------
  // Retrieval: find similar past messages and the user's real replies to them
  // ---------------------------------------------------------------------------
  function retrieveExamples(query, interactions, opts = {}) {
    const { site = "", sender = "", queryEmb = null, embModel = "", k = 3, excludeId = null } = opts;
    const cands = usable(interactions).filter(
      (r) => r.id !== excludeId && r.rating !== -1 && r.context && r.context.trim().length > 10
    );
    if (!cands.length || !String(query || "").trim()) return [];
    const kw = tfidfScores(query, cands.map((r) => r.context));
    const scored = cands.map((r, i) => {
      const useEmb = queryEmb && r.emb && r.embModel === embModel;
      const sem = useEmb ? cosine(queryEmb, r.emb) : null;
      let score = useEmb ? 0.65 * Math.max(0, (sem - 0.3) / 0.7) + 0.35 * kw[i] : kw[i];
      if (site && r.site === site) score += 0.08;
      if (sender && r.sender && r.sender.toLowerCase() === sender.toLowerCase()) score += 0.15;
      if (r.rating === 1) score += 0.05;
      return { r, score, sem, kw: kw[i] };
    });
    return scored
      .filter((s) => s.score >= 0.12)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((s) => ({
        id: s.r.id,
        context: s.r.context,
        reply: s.r.final,
        site: s.r.site,
        score: Math.round(s.score * 100) / 100,
        method: s.sem != null ? "semantic+keyword" : "keyword"
      }));
  }

  // ---------------------------------------------------------------------------
  // Style profile
  // ---------------------------------------------------------------------------
  const CHIP_PREFS = {
    "Shorter": "prefers shorter, more concise replies",
    "More formal": "prefers a more formal, professional tone",
    "Friendlier": "prefers a warmer, friendlier tone"
  };

  function mostCommon(arr) {
    const m = new Map();
    arr.forEach((x) => x && m.set(x, (m.get(x) || 0) + 1));
    let best = null, n = 0;
    m.forEach((c, x) => { if (c > n) { best = x; n = c; } });
    return { value: best, count: n, share: arr.length ? n / arr.length : 0 };
  }

  function computeStyleStats(interactions) {
    const list = usable(interactions).slice(-60);
    const n = list.length;
    const stats = { n, perSite: {}, chipTotals: {} };
    if (!n) return stats;

    const lens = list.map((r) => words(r.final).length).sort((a, b) => a - b);
    stats.avgWords = Math.round(lens.reduce((a, b) => a + b, 0) / n);
    stats.medianWords = lens[Math.floor(n / 2)];

    const greetings = list.map((r) => {
      const first = (r.final.trim().split("\n")[0] || "").trim().toLowerCase();
      const m = first.match(/^(hi|hey|hello|dear|good morning|good afternoon|good evening|greetings|namaste)\b/);
      return m ? m[1] : "(none)";
    });
    stats.greeting = mostCommon(greetings);

    const closingRe = /^(thanks|thank you|thanks a lot|many thanks|regards|best|best regards|kind regards|warm regards|cheers|sincerely|take care|talk soon)[,!.]?$/i;
    const closings = list.map((r) => {
      const lines = r.final.trim().split("\n").map((l) => l.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
        if (closingRe.test(lines[i])) return lines[i].replace(/[.!]$/, "").replace(/,?$/, ",");
      }
      return "(none)";
    });
    stats.closing = mostCommon(closings);

    const share = (re) => list.filter((r) => re.test(r.final)).length / n;
    stats.emojiRate = share(/\p{Extended_Pictographic}/u);
    stats.exclamationRate = share(/!/);

    let contr = 0, expanded = 0;
    list.forEach((r) => {
      const t = r.final.toLowerCase();
      contr += (t.match(/\b(i'm|i'll|i've|i'd|don't|can't|won't|it's|that's|we're|you're|isn't|doesn't|didn't|let's)\b/g) || []).length;
      expanded += (t.match(/\b(i am|i will|i have|do not|cannot|will not|it is|that is|we are|you are|is not|does not|did not|let us)\b/g) || []).length;
    });
    stats.contractionRate = contr + expanded >= 3 ? contr / (contr + expanded) : null;

    // Phrases the user repeatedly deletes from / adds to drafts
    const removed = new Map(), added = new Map();
    // manualEditRatio = how much the user typed over the last AI version (refine buttons don't count)
    list.filter((r) => r.lastGenerated && (r.manualEditRatio ?? r.editRatio) > 0.02).forEach((r) => {
      const d = phraseDiff(r.lastGenerated, r.final);
      d.removed.forEach((g) => removed.set(g, (removed.get(g) || 0) + 1));
      d.added.forEach((g) => added.set(g, (added.get(g) || 0) + 1));
    });
    const top = (m) => collapsePhrases([...m.entries()]).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 5);
    stats.removedPhrases = top(removed);
    stats.addedPhrases = top(added);

    // Per-site habits and refine-button usage
    list.forEach((r) => {
      const s = (stats.perSite[r.site] = stats.perSite[r.site] || { n: 0, words: 0, chips: {} });
      s.n++;
      s.words += words(r.final).length;
      (r.chips || []).forEach((c) => {
        s.chips[c] = (s.chips[c] || 0) + 1;
        stats.chipTotals[c] = (stats.chipTotals[c] || 0) + 1;
      });
    });
    Object.values(stats.perSite).forEach((s) => (s.avgWords = Math.round(s.words / s.n)));
    return stats;
  }

  // Turns the style stats into prompt lines (only habits with enough evidence)
  function styleToPromptLines(stats, site, { hasSignoff = false } = {}) {
    const out = [];
    if (!stats || stats.n < 3) return out;
    const siteStats = site && stats.perSite[site];
    if (siteStats && siteStats.n >= 3) {
      out.push(`On ${site} the user's replies are usually about ${siteStats.avgWords} words long. Keep a similar length.`);
      Object.entries(siteStats.chips).forEach(([chip, c]) => {
        if (CHIP_PREFS[chip] && c / siteStats.n >= 0.4) out.push(`On ${site} the user ${CHIP_PREFS[chip]}.`);
      });
    } else {
      out.push(`The user's replies are usually about ${stats.medianWords} words long. Keep a similar length.`);
    }
    if (stats.greeting.share >= 0.6) {
      out.push(stats.greeting.value === "(none)"
        ? "The user usually starts directly, without a greeting line."
        : `The user usually opens with "${stats.greeting.value.replace(/^\w/, (c) => c.toUpperCase())}".`);
    }
    if (!hasSignoff && stats.closing.share >= 0.5) {
      out.push(stats.closing.value === "(none)"
        ? "The user usually does not add a sign-off."
        : `The user usually closes with "${stats.closing.value}".`);
    }
    if (stats.emojiRate >= 0.4) out.push("The user often uses an emoji.");
    else if (stats.emojiRate <= 0.1) out.push("The user does not use emoji.");
    if (stats.contractionRate != null) {
      if (stats.contractionRate >= 0.7) out.push("The user writes with contractions (I'm, I'll, don't).");
      else if (stats.contractionRate <= 0.3) out.push("The user avoids contractions (writes I am, I will).");
    }
    if (stats.exclamationRate >= 0.5) out.push("The user often uses exclamation marks.");
    if (stats.removedPhrases.length) {
      out.push(`Never use these phrases (the user always deletes them): ${stats.removedPhrases.map(([p]) => `"${p}"`).join(", ")}.`);
    }
    if (stats.addedPhrases.length) {
      out.push(`Phrases the user often adds: ${stats.addedPhrases.map(([p]) => `"${p}"`).join(", ")}.`);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Shared helpers for LLM-written preferences
  // ---------------------------------------------------------------------------
  function informative(r) {
    return r.outcome === "edited" || r.outcome === "refined" || r.rating === -1 || r.rating === 1;
  }

  function parseRules(text, max = 5) {
    let raw = String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "");
    let items = [];
    const m = raw.match(/\[[\s\S]*\]/);
    if (m) {
      try {
        const arr = JSON.parse(m[0]);
        if (Array.isArray(arr)) items = arr.map((x) => (typeof x === "string" ? x : x && (x.rule || x.text) || ""));
      } catch (e) {}
    }
    if (!items.length) {
      items = raw.split("\n").map((l) => l.replace(/^\s*([-*•]|\d+[.)])\s*/, "").replace(/^["']|["'],?$/g, ""));
    }
    return items
      .map((s) => String(s).trim().replace(/\s+/g, " "))
      .filter((s) => s.length >= 8 && s.length <= 180 && !/^(here|sure|rules?:|preferences?:|current|the reply)/i.test(s))
      .slice(0, max);
  }

  function similarRule(a, b) {
    const A = new Set(tokenize(a)), B = new Set(tokenize(b));
    if (!A.size || !B.size) return false;
    let inter = 0;
    A.forEach((t) => B.has(t) && inter++);
    return inter / (A.size + B.size - inter) >= 0.5;
  }

  // ---------------------------------------------------------------------------
  // The 5 PREFERENCES: a small memory of how the user likes to write, rewritten after every
  // reply the user sends. The LLM gets the current 5 + the new reply (AI draft vs. what was
  // really sent) and returns the updated 5: keep what is still supported, sharpen it, or
  // replace the weakest one. "Pinned" preferences (written or pinned by the user) never change.
  // ---------------------------------------------------------------------------
  const MAX_PREFERENCES = 5;

  async function getPreferences() {
    const { preferences = [] } = await chrome.storage.local.get("preferences");
    return preferences;
  }
  async function savePreferences(prefs) {
    await chrome.storage.local.set({ preferences: prefs.slice(0, MAX_PREFERENCES) });
  }
  async function getPreferenceLog() {
    const { preferenceLog = [] } = await chrome.storage.local.get("preferenceLog");
    return preferenceLog;
  }
  async function addPreferenceLog(entry) {
    const log = await getPreferenceLog();
    log.push(entry);
    await chrome.storage.local.set({ preferenceLog: log.slice(-30) });
  }

  function describeReply(r, maxLen = 600) {
    let s = `Message received (${r.site || "web"}):\n${(r.context || "(image only)").slice(0, 400)}\n` +
      `AI draft:\n${(r.lastGenerated || r.firstDraft || "").slice(0, maxLen)}\n` +
      `What the user actually sent:\n${(r.final || "").slice(0, maxLen)}`;
    if (r.chips && r.chips.length) s += `\nThe user asked the AI to: ${r.chips.join(", ")}`;
    if (r.rating === -1) s += "\nThe user rated the AI draft as BAD.";
    if (r.rating === 1) s += "\nThe user rated the AI draft as GOOD.";
    return s;
  }

  function buildPreferencePrompt(current, latest, earlier = []) {
    const system =
      "You maintain a short memory of one user's writing preferences for replies, learned from how they change replies an AI drafted for them. " +
      "You output only a JSON array of exactly 5 strings.";
    const list = current.length
      ? current.map((p, i) => `${i + 1}. ${p.text}${p.locked ? "  [pinned: keep word for word]" : ""}`).join("\n")
      : "(none yet)";
    const user =
      `CURRENT PREFERENCES:\n${list}\n\n` +
      `THE REPLY THE USER JUST SENT:\n${describeReply(latest)}\n\n` +
      (earlier.length ? `EARLIER REPLIES (for context):\n${earlier.map((r, i) => `#${i + 1}\n${describeReply(r, 300)}`).join("\n\n")}\n\n` : "") +
      "Update the list to the 5 most useful, general preferences about how this user writes replies " +
      "(tone, length, greeting, sign-off, structure, words or phrases to use or avoid). " +
      "Keep a preference that is still supported, sharpen it if the new reply adds detail, and replace the weakest one if the new reply shows something more important. " +
      "Keep pinned preferences word for word. Each preference: one instruction, at most 15 words, " +
      "never about the facts of one specific message. " +
      'Output ONLY a JSON array of exactly 5 strings, like ["...", "...", "...", "...", "..."].';
    return { system, user };
  }

  function newPreference(text, source = "auto") {
    return { id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, text, source, locked: source === "user", updatedTs: Date.now() };
  }

  // Combine the LLM's proposal with the current list: pinned ones stay, near-duplicates are dropped,
  // unchanged texts keep their identity, and gaps are filled from the previous list.
  function mergePreferences(current, proposed) {
    const out = current.filter((p) => p.locked);
    for (const text of proposed) {
      if (out.length >= MAX_PREFERENCES) break;
      if (out.some((p) => similarRule(p.text, text))) continue;
      const same = current.find((p) => p.text.trim().toLowerCase() === text.trim().toLowerCase());
      out.push(same || newPreference(text, "auto"));
    }
    for (const p of current) {
      if (out.length >= MAX_PREFERENCES) break;
      if (!out.includes(p) && !out.some((q) => similarRule(q.text, p.text))) out.push(p);
    }
    const before = current.map((p) => p.text);
    const after = out.map((p) => p.text);
    return {
      prefs: out.slice(0, MAX_PREFERENCES),
      added: after.filter((t) => !before.includes(t)),
      removed: before.filter((t) => !after.includes(t))
    };
  }

  // One-time conversion of the older "learned rules" into preferences (user-written first, then newest)
  function rulesToPreferences(rules) {
    return [...rules]
      .filter((r) => r && r.text && r.enabled !== false)
      .sort((a, b) => (a.source === "user" ? -1 : 0) - (b.source === "user" ? -1 : 0) || (b.createdTs || 0) - (a.createdTs || 0))
      .slice(0, MAX_PREFERENCES)
      .map((r) => ({ id: r.id || newPreference(r.text).id, text: r.text, source: r.source === "user" ? "user" : "auto",
        locked: r.source === "user", updatedTs: r.createdTs || Date.now() }));
  }

  // ---------------------------------------------------------------------------
  // Metrics (for the dashboard / results chapter)
  // ---------------------------------------------------------------------------
  function computeMetrics(interactions) {
    const all = [...interactions].sort((a, b) => a.ts - b.ts);
    const done = usable(all);
    const group = (list) => ({
      n: list.length,
      acceptRate: list.length ? list.filter((r) => r.outcome === "accepted").length / list.length : null,
      avgEdit: list.length ? list.reduce((a, r) => a + (r.editRatio || 0), 0) / list.length : null
    });
    const series = done.map((r, i) => {
      const win = done.slice(Math.max(0, i - 4), i + 1);
      return {
        i: i + 1,
        ts: r.ts,
        edit: r.editRatio || 0,
        rollingEdit: win.reduce((a, x) => a + (x.editRatio || 0), 0) / win.length,
        rollingAccept: win.filter((x) => x.outcome === "accepted").length / win.length
      };
    });
    const half = Math.floor(done.length / 2);
    return {
      total: all.length,
      used: done.length,
      discarded: all.filter((r) => r.outcome === "discarded").length,
      thumbsUp: all.filter((r) => r.rating === 1).length,
      thumbsDown: all.filter((r) => r.rating === -1).length,
      overall: group(done),
      personalized: group(done.filter((r) => r.personalized)),
      generic: group(done.filter((r) => !r.personalized)),
      byModel: [...new Set(done.map((r) => r.model || "unknown"))]
        .map((m) => ({ model: m, ...group(done.filter((r) => (r.model || "unknown") === m)) }))
        .sort((a, b) => b.n - a.n),
      firstHalf: group(done.slice(0, half)),
      secondHalf: group(done.slice(half)),
      series
    };
  }

  // ---------------------------------------------------------------------------
  // Export as a fine-tuning dataset (chat-format JSONL) for a future self-learned model
  // ---------------------------------------------------------------------------
  function toFineTuneJSONL(interactions, userName = "") {
    const system = `You write replies in the voice of ${userName || "the user"}, to the sender of the message.`;
    return usable(interactions)
      .filter((r) => r.rating !== -1 && r.context && r.context.trim())
      .map((r) => JSON.stringify({
        messages: [
          { role: "system", content: system },
          { role: "user", content: `MESSAGE THE USER RECEIVED (${r.site || "web"}):\n${r.context}` },
          { role: "assistant", content: r.final }
        ]
      }))
      .join("\n");
  }

  global.AIP = {
    tokenize, tfidfScores, cosine, editRatio, phraseDiff, extractSender,
    getInteractions, saveInteractions, upsertInteraction, getRules, saveRules, getLearningSettings,
    usable, retrieveExamples, computeStyleStats, styleToPromptLines,
    informative, parseRules, similarRule,
    getPreferences, savePreferences, getPreferenceLog, addPreferenceLog,
    buildPreferencePrompt, mergePreferences, rulesToPreferences, newPreference, MAX_PREFERENCES,
    computeMetrics, toFineTuneJSONL, MAX_INTERACTIONS
  };
})(typeof self !== "undefined" ? self : this);
