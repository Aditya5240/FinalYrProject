// background.js - General-Purpose AI Reply Assistant Service Worker

// Self-learning / personalisation engine (defines self.AIP)
importScripts("personalization.js");

// ---------------------------------------------------------------------------
// Popup "session": the last snip / reply / status live in chrome.storage.session, which Chrome
// wipes when the browser is closed. They are also cleared when the tab that was snipped is closed,
// or when the user presses "Clear" in the popup. (Settings, card position and reply history are
// in sync/local storage and are NOT affected.)
// ---------------------------------------------------------------------------
const SESSION_KEYS = ["currentStatus", "lastError", "lastReply", "lastSnippetImage", "lastSnippetText", "lastInstructions", "lastSnipTabId", "lastInteractionId", "pendingInteractions", "lastKeyPoints"];

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const { lastSnipTabId } = await chrome.storage.session.get("lastSnipTabId");
    if (lastSnipTabId === tabId) await chrome.storage.session.remove(SESSION_KEYS);
  } catch (e) {}
});

// Older versions kept this state in chrome.storage.local (so it survived restarts) - remove leftovers
function removeLegacyLocalState() {
  chrome.storage.local.remove(SESSION_KEYS.filter((k) => k !== "lastSnipTabId")).catch(() => {});
}
chrome.runtime.onStartup.addListener(removeLegacyLocalState);

// On install / reload / update, Chrome disconnects the content script from every tab that is
// already open. Re-inject it into those tabs so snipping works without refreshing each page.
// Earlier versions logged copy/insert events as "replyHistory"; convert them into learning interactions
async function migrateReplyHistory() {
  try {
    const { replyHistory = [], interactions = [] } = await chrome.storage.local.get(["replyHistory", "interactions"]);
    if (!replyHistory.length) return;
    const converted = replyHistory
      .filter((h) => h && h.final)
      .map((h, i) => {
        const manual = AIP.editRatio(h.generated || "", h.final);
        return {
          id: `legacy_${h.ts || i}_${i}`, ts: h.ts || Date.now(), site: (h.site || "").replace(/^www\./, ""),
          sender: AIP.extractSender(h.context || ""), context: h.context || "", instruction: h.instruction || "",
          firstDraft: h.generated || "", lastGenerated: h.generated || "", chips: [], regenerations: 0, rating: 0,
          personalized: false, final: h.final, action: h.action || "copy",
          outcome: manual > 0.02 ? "edited" : "accepted", editRatio: manual, manualEditRatio: manual
        };
      });
    await AIP.saveInteractions([...converted, ...interactions].sort((a, b) => a.ts - b.ts));
    await chrome.storage.local.remove("replyHistory");
  } catch (e) {
    console.warn("replyHistory migration skipped:", e);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  removeLegacyLocalState();
  migrateReplyHistory();
  migrateRulesToPreferences();
  try {
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    for (const t of tabs) {
      if (t.id == null || t.discarded) continue;
      chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content.js"] }).catch(() => {
        // restricted pages (Chrome Web Store, PDF viewer, etc.) can't be scripted - ignore
      });
    }
  } catch (e) {}
});

// Shortcut command listener (e.g. Alt+S)
chrome.commands.onCommand.addListener(async (command) => {
  // Alt+S = pick a message on the page (DOM);  Alt+Shift+S = screenshot snip (backup for images, PDFs, canvas)
  const type = command === "snip-image" ? "START_SNIP" : command === "pick-message" || command === "toggle-snip" ? "START_PICK" : null;
  if (type) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      // Shortcut starts fresh, with no leftover custom instructions from the popup
      const msg = { type, instructions: "" };
      try {
        await chrome.tabs.sendMessage(tab.id, msg);
      } catch (e) {
        // Content script not loaded yet (e.g. tab was open before the extension was installed) - inject it
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
          await chrome.tabs.sendMessage(tab.id, msg);
        } catch (injectErr) {
          console.warn("Cannot snip on this page (internal or restricted page):", injectErr);
        }
      }
    } catch (err) {
      console.warn("Failed to trigger snip from command:", err);
    }
  }
});

// Normalize local LLM URLs (e.g. http://localhost:11434 -> http://localhost:11434/v1/chat/completions)
function normalizeLocalUrl(rawUrl, target = "chat") {
  if (!rawUrl || typeof rawUrl !== "string") {
    rawUrl = "http://localhost:11434";
  }
  let url = rawUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) {
    url = "http://" + url;
  }

  // Strip trailing endpoints to get pure origin/base
  const base = url
    .replace(/\/v1\/chat\/completions\/?$/i, "")
    .replace(/\/v1\/completions\/?$/i, "")
    .replace(/\/v1\/models\/?$/i, "")
    .replace(/\/api\/chat\/?$/i, "")
    .replace(/\/api\/tags\/?$/i, "")
    .replace(/\/api\/generate\/?$/i, "")
    .replace(/\/v1\/?$/i, "");

  if (target === "models") {
    return {
      base: base,
      v1Models: `${base}/v1/models`,
      ollamaTags: `${base}/api/tags`
    };
  }

  // Target === "chat"
  if (url.includes("/chat/completions") || url.includes("/generate") || url.includes("/api/chat")) {
    return url;
  }
  return `${base}/v1/chat/completions`;
}

// ---------------------------------------------------------------------------
// Fix for Ollama HTTP 403:
// Ollama rejects requests whose "Origin" header is chrome-extension://<id>, because that origin is
// not in its default allow-list (OLLAMA_ORIGINS). GET requests (Detect Models) don't carry an Origin,
// which is why detection works but generation (POST) fails.
// We add a session rule that rewrites the Origin of THIS extension's background requests to the
// local server to the server's own origin (e.g. http://localhost:11434), which Ollama allows by default.
// Only requests made by the extension (not by any web page / tab) are affected.
// ---------------------------------------------------------------------------
const LOCAL_ORIGIN_RULE_ID = 1;
let lastRuleOrigin = null;

async function ensureLocalOriginRule(rawUrl) {
  try {
    const { base } = normalizeLocalUrl(rawUrl, "models");
    const origin = new URL(base).origin;
    if (origin === lastRuleOrigin) return;
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [LOCAL_ORIGIN_RULE_ID],
      addRules: [
        {
          id: LOCAL_ORIGIN_RULE_ID,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [{ header: "Origin", operation: "set", value: origin }]
          },
          condition: {
            urlFilter: `|${origin}/`,
            tabIds: [chrome.tabs.TAB_ID_NONE], // only requests not coming from a web page
            resourceTypes: ["xmlhttprequest", "other"]
          }
        }
      ]
    });
    lastRuleOrigin = origin;
  } catch (err) {
    console.warn("Could not install local Origin rule:", err);
  }
}

// Queries local LLM server to auto-detect installed models
async function fetchLocalModels(rawUrl) {
  await ensureLocalOriginRule(rawUrl);
  const { v1Models, ollamaTags } = normalizeLocalUrl(rawUrl, "models");
  let models = [];

  // 1. Try OpenAI-compatible /v1/models (Ollama 0.1.24+, LM Studio, vLLM, LocalAI)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(v1Models, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data?.data)) {
        models = data.data.map((m) => m.id || m.name).filter(Boolean);
      }
    }
  } catch (e) {
    // try next
  }

  // 2. Try native Ollama /api/tags
  if (models.length === 0) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(ollamaTags, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data?.models)) {
          models = data.models.map((m) => m.name || m.model).filter(Boolean);
        }
      }
    } catch (e) {
      // ignore
    }
  }

  return Array.from(new Set(models));
}

// Embedding-only models (used for semantic search) can't write replies
function isEmbeddingModel(name) {
  return /embed|bge-|bge:|minilm|\be5-|gte-|arctic|mxbai|paraphrase/i.test(String(name || ""));
}

// The model to use for writing replies: the one chosen in Settings, otherwise the first installed chat model.
async function resolveLocalModel(localLlmUrl, preferred) {
  const want = String(preferred || "").trim();
  if (want) return want;
  const chat = (await fetchLocalModels(localLlmUrl)).filter((m) => !isEmbeddingModel(m));
  if (!chat.length) {
    throw new Error(
      "Couldn't find an installed chat model on your local server. Make sure Ollama/LM Studio is running, then open Settings → Local LLM → Detect Models, pick a model and click Save."
    );
  }
  return chat[0];
}

// If the saved model isn't installed (HTTP 404 "model not found"), pick another installed chat model
async function fallbackLocalModel(localLlmUrl, failedModel) {
  const chat = (await fetchLocalModels(localLlmUrl)).filter((m) => !isEmbeddingModel(m) && m !== failedModel);
  if (!chat.length) return null;
  // Save it so the next reply doesn't hit the same error
  await chrome.storage.sync.set({ localModel: chat[0] });
  console.warn(`Model "${failedModel}" is not installed; switched Settings to "${chat[0]}".`);
  return chat[0];
}

const isModelMissing = (status, text) => status === 404 && /not found|no such model|does not exist/i.test(text || "");

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CONTEXT_PICKED") {
    handleContextPicked(message, sender.tab);
    return false; // no direct response: the reply arrives later as REPLY_READY
  }

  if (message.type === "SNIP_RECT_CAPTURED") {
    handleSnipCaptured(message, sender.tab);
    return false; // no direct response: the reply arrives later as REPLY_READY
  }

  if (message.type === "REGENERATE_REPLY") {
    handleRegenerate(message.instructions, sender.tab, message.currentDraft, {
      interactionId: message.interactionId,
      chip: message.chip,
      context: message.context // set when the user changed the context level (DOM pick mode)
    });
    return false; // no direct response: the reply arrives later as REPLY_READY
  }

  // Learning signals from the reply card / popup (copy, insert, 👍/👎, closed)
  if (message.type === "INTERACTION_EVENT") {
    handleInteractionEvent(message)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  // Profile page: "Update preferences now"
  if (message.type === "LEARN_NOW") {
    runPreferenceUpdate({ force: true })
      .then((res) => sendResponse({ success: true, added: res.added, removed: res.removed, prefs: res.prefs }))
      .catch((err) => sendResponse({ success: false, error: err.message || String(err) }));
    return true;
  }

  // Profile page: test semantic search (embedding model)
  if (message.type === "CHECK_EMBEDDINGS") {
    checkEmbeddings(message.model)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (message.type === "TEST_API_CONNECTION") {
    testApiConnection(message)
      .then((res) => sendResponse({ success: true, message: res }))
      .catch((err) => sendResponse({ success: false, error: err.message || err }));
    return true;
  }

  if (message.type === "FETCH_LOCAL_MODELS") {
    fetchLocalModels(message.url)
      .then((models) => sendResponse({ success: true, models }))
      .catch((err) => sendResponse({ success: false, error: err.message || err }));
    return true;
  }
});

// ===========================================================================
// SELF-LEARNING & PERSONALISATION (see personalization.js for the algorithms)
// ===========================================================================
// Lifecycle of one reply ("interaction"):
//   snip -> AI draft (pending, kept in session storage)
//        -> refine buttons / rewrites update the pending record
//        -> Copy / Insert  => saved to the learning history with the user's FINAL text
//        -> 👍/👎           => rating saved
//        -> closed without using it => saved as "discarded"
// After every sent reply, the LLM rewrites the user's 5 writing preferences (old 5 + the new reply).

let embedDownUntil = 0;
let lastUsedModel = ""; // which model wrote the last reply (stored per interaction, for per-model comparison)
let lastEmbedError = "";

function siteOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
}

function newInteractionId() {
  return `x_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function getPending(id) {
  const { pendingInteractions = {}, lastInteractionId } = await chrome.storage.session.get(["pendingInteractions", "lastInteractionId"]);
  return pendingInteractions[id || lastInteractionId] || null;
}

async function savePending(record) {
  const { pendingInteractions = {} } = await chrome.storage.session.get("pendingInteractions");
  pendingInteractions[record.id] = record;
  const ids = Object.keys(pendingInteractions).sort((a, b) => pendingInteractions[a].ts - pendingInteractions[b].ts);
  while (ids.length > 10) delete pendingInteractions[ids.shift()]; // keep the session small
  await chrome.storage.session.set({ pendingInteractions });
}

// Embedding vector for semantic search, from the user's local LLM server (Ollama / LM Studio).
// Returns null (=> keyword search is used instead) if no embedding model is available.
async function embedText(text, model) {
  if (!text || !text.trim() || Date.now() < embedDownUntil) return null;
  const { localLlmUrl } = await chrome.storage.sync.get({ localLlmUrl: "http://localhost:11434" });
  const { base } = normalizeLocalUrl(localLlmUrl, "models");
  await ensureLocalOriginRule(localLlmUrl);
  const input = String(text).slice(0, 2000);

  const attempt = async (url, body, pick) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) return { err: `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}` };
      const v = pick(await res.json());
      return Array.isArray(v) && v.length ? { v } : { err: "no embedding returned" };
    } catch (e) {
      return { err: e.name === "AbortError" ? "timed out" : e.message };
    } finally {
      clearTimeout(timer);
    }
  };

  let r = await attempt(`${base}/v1/embeddings`, { model, input }, (d) => d?.data?.[0]?.embedding);
  if (!r.v) r = await attempt(`${base}/api/embed`, { model, input }, (d) => d?.embeddings?.[0]);
  if (!r.v) {
    embedDownUntil = Date.now() + 5 * 60 * 1000; // don't retry for 5 minutes
    lastEmbedError = r.err || "unavailable";
    return null;
  }
  lastEmbedError = "";
  return { vector: r.v.map((x) => Math.round(x * 1e5) / 1e5), model };
}

// Builds everything the prompt needs to sound like this user
async function buildPersonalization({ context, site, sender, queryEmb = null, embModel = "", excludeId = null }) {
  const ls = await AIP.getLearningSettings();
  const [interactions, preferences, { userSignoff }] = await Promise.all([
    AIP.getInteractions(),
    AIP.getPreferences(),
    chrome.storage.sync.get({ userSignoff: "" })
  ]);

  let emb = queryEmb, model = embModel;
  if (!emb && ls.useEmbeddings && context) {
    const e = await embedText(context, ls.embedModel);
    if (e) { emb = e.vector; model = e.model; }
  }

  const history = AIP.usable(interactions).length;
  if (!ls.personalizationEnabled) {
    return { active: false, examples: [], styleLines: [], prefLines: [], queryEmb: emb, embModel: model,
      summary: { enabled: false, examples: 0, preferences: 0, style: 0, history } };
  }

  const examples = AIP.retrieveExamples(context, interactions, { site, sender, queryEmb: emb, embModel: model, k: 3, excludeId });
  const styleLines = AIP.styleToPromptLines(AIP.computeStyleStats(interactions), site, { hasSignoff: Boolean(userSignoff) });
  const prefLines = preferences.map((p) => p.text).filter(Boolean).slice(0, AIP.MAX_PREFERENCES);
  return {
    active: examples.length + styleLines.length + prefLines.length > 0,
    examples, styleLines, prefLines, queryEmb: emb, embModel: model,
    summary: {
      enabled: true,
      examples: examples.length,
      preferences: prefLines.length,
      style: styleLines.length,
      history,
      method: emb ? "semantic" : "keyword",
      exampleSnippets: examples.map((e) => ({ context: e.context.slice(0, 80), score: e.score }))
    }
  };
}

// Plain text LLM call (used for learning rules), with the user's configured provider
async function callTextLLM(system, user, maxTokens = 400) {
  const s = await chrome.storage.sync.get({ provider: "local", apiKey: "", model: "", localLlmUrl: "http://localhost:11434", localModel: "" });
  const messages = [{ role: "system", content: system }, { role: "user", content: user }];
  const post = async (url, headers, body, ms) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const res = await fetch(url, { method: "POST", signal: controller.signal, headers, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
      const d = await res.json();
      return d?.choices?.[0]?.message?.content || d?.response || "";
    } finally {
      clearTimeout(timer);
    }
  };

  if (s.provider !== "openrouter") {
    const url = normalizeLocalUrl(s.localLlmUrl, "chat");
    await ensureLocalOriginRule(s.localLlmUrl);
    let model = await resolveLocalModel(s.localLlmUrl, s.localModel);
    try {
      return await post(url, { "Content-Type": "application/json" }, { model, messages, max_tokens: maxTokens, temperature: 0.2 }, 120000);
    } catch (e) {
      if (!/HTTP 404/.test(e.message) || !/not found/i.test(e.message)) throw e;
      const fb = await fallbackLocalModel(s.localLlmUrl, model);
      if (!fb) throw e;
      return post(url, { "Content-Type": "application/json" }, { model: fb, messages, max_tokens: maxTokens, temperature: 0.2 }, 120000);
    }
  }
  if (!s.apiKey) throw new Error("No OpenRouter API key configured.");
  let lastErr = null;
  for (const model of [s.model, "google/gemma-4-31b-it:free", "openai/gpt-4o-mini"].filter(Boolean)) {
    try {
      return await post("https://openrouter.ai/api/v1/chat/completions",
        { "Content-Type": "application/json", Authorization: `Bearer ${s.apiKey}` },
        { model, messages, max_tokens: maxTokens, temperature: 0.2 }, 60000);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("All models failed");
}

// ---------------------------------------------------------------------------
// The 5 PREFERENCES are rewritten after every reply the user sends.
// Events can arrive in quick succession (Insert, then Send a few seconds later), so updates are
// debounced: the newest sent reply is used once things settle. Pending ids are stored, so an
// update interrupted by the service worker going to sleep still happens on the next event.
// ---------------------------------------------------------------------------
let isUpdatingPrefs = false;
let prefTimer = null;

async function schedulePreferenceUpdate(interactionId) {
  const ls = await AIP.getLearningSettings();
  if (!ls.autoLearnRules || ls.learningPaused) return;
  const { prefState = {} } = await chrome.storage.local.get("prefState");
  prefState.pendingIds = [...new Set([...(prefState.pendingIds || []), interactionId])].slice(-10);
  await chrome.storage.local.set({ prefState });
  clearTimeout(prefTimer);
  prefTimer = setTimeout(() => {
    runPreferenceUpdate().catch((e) => console.warn("Preference update skipped:", e.message || e));
  }, 8000);
}

// Returns { prefs, added, removed }
async function runPreferenceUpdate({ force = false } = {}) {
  if (isUpdatingPrefs) return { prefs: await AIP.getPreferences(), added: [], removed: [], busy: true };
  isUpdatingPrefs = true;
  try {
    const interactions = AIP.usable(await AIP.getInteractions());
    const { prefState = {} } = await chrome.storage.local.get("prefState");
    const pendingIds = prefState.pendingIds || [];
    // The reply to learn from: the newest pending one, or (on "Update now") the newest used reply
    let latest = [...interactions].reverse().find((r) => pendingIds.includes(r.id));
    if (!latest && force) latest = interactions[interactions.length - 1];
    if (!latest) {
      if (force) throw new Error("No sent replies yet. Use (Insert/Copy) a reply first.");
      return { prefs: await AIP.getPreferences(), added: [], removed: [] };
    }
    const earlier = interactions.filter((r) => r.id !== latest.id).slice(-3);
    const current = await AIP.getPreferences();
    const { system, user } = AIP.buildPreferencePrompt(current, latest, earlier);
    const text = await callTextLLM(system, user, 400);
    const proposed = AIP.parseRules(text, AIP.MAX_PREFERENCES);
    if (!proposed.length) throw new Error("The model did not return any preferences. Try again, or use a larger model.");
    const result = AIP.mergePreferences(current, proposed);
    await AIP.savePreferences(result.prefs);
    await AIP.addPreferenceLog({
      ts: Date.now(),
      interactionId: latest.id,
      site: latest.site,
      trigger: force ? "manual" : latest.action || "sent",
      added: result.added,
      removed: result.removed,
      after: result.prefs.map((p) => p.text)
    });
    await chrome.storage.local.set({ prefState: { pendingIds: [], lastTs: Date.now(), lastChanged: result.added.length } });
    return result;
  } finally {
    isUpdatingPrefs = false;
  }
}

// One-time: older versions kept up to 12 "learned rules"; turn them into the 5 preferences
async function migrateRulesToPreferences() {
  try {
    const { preferences, learnedRules } = await chrome.storage.local.get(["preferences", "learnedRules"]);
    if ((!preferences || !preferences.length) && Array.isArray(learnedRules) && learnedRules.length) {
      await AIP.savePreferences(AIP.rulesToPreferences(learnedRules));
    }
    await chrome.storage.local.remove(["learnedRules", "learnState"]);
  } catch (e) {
    console.warn("Rule migration skipped:", e);
  }
}

async function handleInteractionEvent(msg) {
  const ls = await AIP.getLearningSettings();
  const pending = await getPending(msg.interactionId);
  if (!pending) {
    // Session data is gone (e.g. tab closed right after sending): update the saved record directly
    if (msg.event !== "final" || ls.learningPaused) return { ok: false, reason: "unknown interaction" };
    const list = await AIP.getInteractions();
    const r = list.find((x) => x.id === msg.interactionId);
    const final = String(msg.text || "").trim();
    if (!r || !final) return { ok: false, reason: "unknown interaction" };
    r.final = final;
    r.action = msg.action || r.action;
    r.manualEditRatio = AIP.editRatio(r.lastGenerated || r.firstDraft || "", final);
    r.editRatio = AIP.editRatio(r.firstDraft || "", final);
    r.outcome = (r.chips || []).length || r.regenerations ? "refined" : r.manualEditRatio > 0.02 ? "edited" : "accepted";
    r.finalizedTs = Date.now();
    await AIP.saveInteractions(list);
    schedulePreferenceUpdate(r.id);
    return { ok: true, outcome: r.outcome };
  }

  if (msg.event === "rating") {
    pending.rating = msg.rating;
    await savePending(pending);
    if (ls.learningPaused) return { ok: true, paused: true };
    const list = await AIP.getInteractions();
    const r = list.find((x) => x.id === pending.id);
    if (r) {
      r.rating = msg.rating;
      await AIP.saveInteractions(list);
      if (r.final) schedulePreferenceUpdate(r.id);
    }
    return { ok: true };
  }

  if (ls.learningPaused) return { ok: true, paused: true };

  if (msg.event === "final") {
    const final = String(msg.text || "").trim();
    if (!final) return { ok: false };
    const manualEditRatio = AIP.editRatio(pending.lastGenerated, final);
    const record = {
      id: pending.id, ts: pending.ts, site: pending.site, sender: pending.sender,
      context: pending.context, instruction: pending.instruction,
      firstDraft: pending.firstDraft, lastGenerated: pending.lastGenerated,
      chips: pending.chips, regenerations: pending.regenerations, rating: pending.rating || 0,
      personalized: pending.personalized, personalization: pending.personalization, model: pending.model || "",
      emb: pending.emb || null, embModel: pending.embModel || "",
      final, action: msg.action || "copy",
      outcome: pending.chips.length || pending.regenerations ? "refined" : manualEditRatio > 0.02 ? "edited" : "accepted",
      editRatio: AIP.editRatio(pending.firstDraft, final),
      manualEditRatio,
      finalizedTs: Date.now()
    };
    const firstTime = !pending.finalized;
    await AIP.upsertInteraction(record);
    pending.finalized = true;
    await savePending(pending);
    // Every used reply (and its later "sent" version) updates the 5 preferences
    schedulePreferenceUpdate(record.id);
    return { ok: true, outcome: record.outcome };
  }

  if (msg.event === "dismiss") {
    if (pending.finalized) return { ok: true };
    await AIP.upsertInteraction({
      id: pending.id, ts: pending.ts, site: pending.site, sender: pending.sender, context: pending.context,
      firstDraft: pending.firstDraft, lastGenerated: pending.lastGenerated, chips: pending.chips,
      regenerations: pending.regenerations, rating: pending.rating || 0, personalized: pending.personalized,
      model: pending.model || "", outcome: "discarded", final: "", editRatio: 1
    });
    pending.finalized = true;
    await savePending(pending);
    return { ok: true };
  }
  return { ok: false };
}

// Settings page: test the embedding model, and add embeddings to older history entries
async function checkEmbeddings(model) {
  embedDownUntil = 0;
  const ls = await AIP.getLearningSettings();
  const useModel = model || ls.embedModel;
  const e = await embedText("embedding test", useModel);
  if (!e) return { ok: false, model: useModel, error: lastEmbedError };
  const list = await AIP.getInteractions();
  let filled = 0;
  for (const r of list) {
    if (filled >= 60) break;
    if (r.context && (!r.emb || r.embModel !== useModel)) {
      const v = await embedText(r.context, useModel);
      if (!v) break;
      r.emb = v.vector;
      r.embModel = useModel;
      filled++;
    }
  }
  if (filled) await AIP.saveInteractions(list);
  return { ok: true, model: useModel, dims: e.vector.length, backfilled: filled };
}

// Handles screenshot capture, cropping, and reply generation
async function handleSnipCaptured(message, tab) {
  const { rect, domText, instructions } = message;

  try {
    await chrome.storage.session.set({
      currentStatus: "generating",
      lastError: "",
      lastReply: "",
      lastSnipTabId: tab?.id ?? null
    });

    const windowId = tab ? tab.windowId : null;
    const fullScreenshotUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });

    // Tell the page the screenshot is taken, so it can now show the loading pill
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: "CAPTURE_DONE" }).catch(() => {});
    }

    // Crop screenshot using OffscreenCanvas
    const croppedDataUrl = await cropScreenshot(fullScreenshotUrl, rect);

    await chrome.storage.session.set({
      lastSnippetImage: croppedDataUrl,
      lastSnippetText: domText || "",
      lastInstructions: instructions || ""
    });

    await generateAndShow({ tab, imageDataUrl: croppedDataUrl, text: domText || "", keyPoints: [], instructions });
  } catch (err) {
    console.warn("handleSnipCaptured:", err.message || err); // warn, not error: these are shown to the user already
    const errMsg = err.message || String(err);
    await chrome.storage.session.set({
      currentStatus: "error",
      lastError: errMsg
    });

    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        type: "REPLY_ERROR",
        error: errMsg
      }).catch(() => {});
    }
  }
}

// Shared by both ways of choosing a message (DOM pick and screenshot snip):
// personalise -> generate -> remember the interaction -> show the reply card.
async function generateAndShow({ tab, imageDataUrl = null, text = "", keyPoints = [], instructions = "" }) {
  // Personalisation: similar past replies, style profile, learned rules
  const context = (text || "").trim();
  const site = siteOf(tab?.url);
  const sender = AIP.extractSender(context);
  let personalization = null;
  try {
    personalization = await buildPersonalization({ context, site, sender });
  } catch (e) {
    console.warn("Personalisation skipped:", e.message || e);
  }

  // Generate AI reply using Vision or Local LLM
  const replyText = await callVisionAPI({
    imageDataUrl,
    extractedText: text || "",
    keyPoints,
    userInstructions: instructions || "",
    personalization
  });

  const pending = {
    id: newInteractionId(),
    ts: Date.now(),
    site,
    sender,
    context: context.slice(0, 1500),
    instruction: instructions || "",
    firstDraft: replyText,
    lastGenerated: replyText,
    chips: [],
    regenerations: 0,
    rating: 0,
    personalized: Boolean(personalization && personalization.active),
    personalization: personalization ? personalization.summary : null,
    emb: personalization?.queryEmb || null,
    embModel: personalization?.embModel || "",
    model: lastUsedModel
  };
  await savePending(pending);

  await chrome.storage.session.set({
    lastReply: replyText,
    currentStatus: "ready",
    lastError: "",
    lastInteractionId: pending.id
  });

  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, {
      type: "REPLY_READY",
      reply: replyText,
      snippetImage: imageDataUrl || null,
      interactionId: pending.id,
      personalization: pending.personalization
    }).catch(() => {});
  }
}

// DOM pick mode: the page script sends the chosen message's text (with **bold**/_italic_ markers)
// and its key points. No screenshot is needed.
async function handleContextPicked(message, tab) {
  const text = String(message.text || "");
  const keyPoints = Array.isArray(message.keyPoints) ? message.keyPoints.slice(0, 12) : [];
  const instructions = message.instructions || "";
  try {
    await chrome.storage.session.set({
      currentStatus: "generating",
      lastError: "",
      lastReply: "",
      lastSnipTabId: tab?.id ?? null,
      lastSnippetImage: "",
      lastSnippetText: text,
      lastKeyPoints: keyPoints,
      lastInstructions: instructions
    });
    if (!text.trim()) {
      throw new Error("Nothing readable there. Press Alt+S and click a larger part of the message, or use Alt+Shift+S to snip it as an image.");
    }
    await generateAndShow({ tab, imageDataUrl: null, text, keyPoints, instructions });
  } catch (err) {
    console.warn("handleContextPicked:", err.message || err); // shown to the user already
    const errMsg = err.message || String(err);
    await chrome.storage.session.set({ currentStatus: "error", lastError: errMsg });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "REPLY_ERROR", error: errMsg }).catch(() => {});
  }
}

// Regenerates reply using existing stored snippet
// currentDraft (optional): the reply as it is now in the card, possibly edited by the user.
// When given, the model revises that draft instead of starting from scratch.
// meta.chip: which refine button was used (a learning signal, e.g. "Shorter").
async function handleRegenerate(newInstructions, senderTab = null, currentDraft = "", meta = {}) {
  let tab = senderTab;
  try {
    if (!tab?.id) {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    }
    let { lastSnippetImage, lastSnippetText, lastKeyPoints = [] } = await chrome.storage.session.get([
      "lastSnippetImage",
      "lastSnippetText",
      "lastKeyPoints"
    ]);

    // Context level changed in the card: use the new text and write a fresh reply for it
    const contextChanged = Boolean(meta.context && String(meta.context.text || "").trim());
    if (contextChanged) {
      lastSnippetText = String(meta.context.text);
      lastKeyPoints = Array.isArray(meta.context.keyPoints) ? meta.context.keyPoints.slice(0, 12) : [];
      lastSnippetImage = "";
      currentDraft = "";
      await chrome.storage.session.set({ lastSnippetText, lastKeyPoints, lastSnippetImage });
    }

    if (!lastSnippetImage && !lastSnippetText) {
      throw new Error("No previous snippet found. Please snip an area first.");
    }

    await chrome.storage.session.set({
      currentStatus: "generating",
      lastError: "",
      lastReply: "",
      lastInstructions: newInstructions || ""
    });

    let combinedInstructions = (newInstructions || "").trim();
    if (currentDraft && currentDraft.trim()) {
      combinedInstructions =
        `Revise the current draft of the reply below${combinedInstructions ? `: ${combinedInstructions}` : " and improve it"}. ` +
        `Keep its meaning and any details the user added.\nCurrent draft:\n"""\n${currentDraft.trim().slice(0, 3000)}\n"""`;
    }

    const pending = await getPending(meta.interactionId);
    let personalization = null;
    try {
      personalization = await buildPersonalization({
        context: (lastSnippetText || "").trim(),
        site: pending?.site || siteOf(tab?.url),
        sender: pending?.sender || "",
        queryEmb: contextChanged ? null : pending?.emb || null,
        embModel: contextChanged ? "" : pending?.embModel || "",
        excludeId: pending?.id
      });
    } catch (e) {
      console.warn("Personalisation skipped:", e.message || e);
    }

    const replyText = await callVisionAPI({
      imageDataUrl: lastSnippetImage,
      extractedText: lastSnippetText || "",
      keyPoints: lastKeyPoints,
      userInstructions: combinedInstructions,
      personalization
    });

    if (pending && contextChanged) {
      // A new context is a new starting point: reset the draft baseline used for the edit metrics
      pending.context = lastSnippetText.slice(0, 1500);
      pending.sender = AIP.extractSender(lastSnippetText);
      pending.firstDraft = replyText;
      pending.lastGenerated = replyText;
      pending.chips = [];
      pending.regenerations = 0;
      pending.emb = personalization?.queryEmb || null;
      pending.embModel = personalization?.embModel || "";
      pending.model = lastUsedModel || pending.model;
      await savePending(pending);
    } else if (pending) {
      pending.lastGenerated = replyText;
      pending.regenerations = (pending.regenerations || 0) + 1;
      pending.model = lastUsedModel || pending.model;
      if (meta.chip) pending.chips.push(meta.chip);
      else pending.chips.push(currentDraft ? "Custom rewrite" : "Fresh reply");
      await savePending(pending);
    }

    await chrome.storage.session.set({
      lastReply: replyText,
      currentStatus: "ready",
      lastError: ""
    });

    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        type: "REPLY_READY",
        reply: replyText,
        snippetImage: lastSnippetImage,
        interactionId: pending?.id,
        personalization: personalization ? personalization.summary : null
      }).catch(() => {});
    }
  } catch (err) {
    console.warn("handleRegenerate:", err.message || err); // warn, not error: these are shown to the user already
    await chrome.storage.session.set({
      currentStatus: "error",
      lastError: err.message || String(err)
    });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: "REPLY_ERROR", error: err.message || String(err) }).catch(() => {});
    }
  }
}

// Crops screenshot using OffscreenCanvas
async function cropScreenshot(dataUrl, rect) {
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);

    const dpr = rect.dpr || 1;
    const sx = Math.max(0, Math.round(rect.left * dpr));
    const sy = Math.max(0, Math.round(rect.top * dpr));
    const sw = Math.min(bitmap.width - sx, Math.max(1, Math.round(rect.width * dpr)));
    const sh = Math.min(bitmap.height - sy, Math.max(1, Math.round(rect.height * dpr)));

    if (sw <= 0 || sh <= 0) {
      bitmap.close();
      return dataUrl;
    }

    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    bitmap.close();

    const croppedBlob = await canvas.convertToBlob({ type: "image/png" });
    // "return await" so a FileReader failure is caught below and falls back to the full screenshot
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Failed to convert cropped image to dataUrl"));
      reader.readAsDataURL(croppedBlob);
    });
  } catch (err) {
    console.warn("OffscreenCanvas crop failed, falling back to full capture:", err);
    return dataUrl;
  }
}

// Cleans up model output so only a sendable reply is left
function cleanReply(raw, signoff = "") {
  let text = String(raw || "");
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();             // reasoning traces
  text = text.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim();   // code fences
  const signoffRe = /^(best( regards)?|kind regards|regards|warm regards|thanks|thank you|sincerely|cheers)[,!.]?$/i;
  const signoffFirstLine = (signoff || "").split("\n")[0].trim().toLowerCase();
  // Repeat a few times because junk can be stacked (e.g. "Best regards,\nHere is a reply:\n...")
  for (let i = 0; i < 3; i++) {
    const before = text;
    // Preface lines like "Here is a reply:" / "Sure! Here's a draft:"
    text = text.replace(/^(sure[!,.]?\s*)?(here('s| is)|below is)[^\n]{0,80}:\s*\n+/i, "").trim();
    // Wrapping quotes
    if (/^["“][\s\S]*["”]$/.test(text)) text = text.slice(1, -1).trim();
    // A sign-off wrongly placed on the first line (e.g. "Best regards,\nI've checked...")
    const lines = text.split("\n");
    const firstLine = (lines[0] || "").trim();
    if (lines.length > 1 && (signoffRe.test(firstLine) || (signoffFirstLine && firstLine.toLowerCase() === signoffFirstLine))) {
      lines.shift();
      text = lines.join("\n").trim();
    }
    if (text === before) break;
  }

  // Make sure the user's chosen sign-off is at the end
  if (signoff && signoff.trim() && !text.toLowerCase().includes(signoff.trim().split("\n")[0].toLowerCase())) {
    text = `${text}\n\n${signoff.trim()}`;
  }
  return text;
}

// Calls Local LLM or OpenRouter Vision API
// Long messages: keep the start and the end (where the question and sign-off usually are) within the limit
function fitText(text, max) {
  const t = String(text || "").trim();
  if (t.length <= max) return t;
  const head = t.slice(0, Math.floor(max * 0.7));
  const tail = t.slice(-Math.floor(max * 0.25));
  return `${head}\n[… middle of a long message omitted …]\n${tail}`;
}

async function callVisionAPI({ imageDataUrl, extractedText = "", keyPoints = [], userInstructions = "", personalization = null }) {
  // Defaults must match options.js so the extension works before Settings is ever saved.
  const {
    provider,
    apiKey,
    model: openRouterModel,
    localLlmUrl,
    localModel,
    userName,
    userSignoff,
    customRules
  } = await chrome.storage.sync.get({
    provider: "local",
    apiKey: "",
    model: "",
    localLlmUrl: "http://localhost:11434",
    localModel: "",
    userName: "",
    userSignoff: "",
    customRules: ""
  });

  const isLocal = provider !== "openrouter";

  if (!isLocal && !apiKey) {
    throw new Error("No API key configured. Please set your OpenRouter API key in Settings, or switch to Local LLM (Ollama/LM Studio).");
  }

  // ---------------------------------------------------------------------------
  // Prompt design (important for small local models like llama3.2 3B):
  // - Make the PERSPECTIVE explicit: the model writes AS the user, TO the sender.
  //   The old prompt ("you are a reply assistant") made small models answer the user
  //   as a helpful assistant ("Would you like help with your resume?").
  // - Forbid invented actions ("I've checked the eligibility...").
  // - Sign-off goes at the END only.
  // - Put the final instruction LAST (small models follow the most recent text best).
  // - One short worked example (few-shot) shows the exact output format.
  // ---------------------------------------------------------------------------
  const rules = [
    "Write in first person as the user (\"I\", \"me\"), addressed to whoever wrote the message.",
    "You are NOT an assistant talking to the user. Never offer the user help, never ask the user questions, never give the user advice or tell them what to do.",
    "Only use facts that are in the message or in the user's instruction. Do not claim the user has done anything (for example \"I've applied\" or \"I've checked the criteria\") unless the instruction says so.",
    "Match the channel: short and natural for chats and comments, polite and well-structured for emails.",
    "Unless the user's instruction says otherwise, write the most helpful, positive and constructive reply: show interest, agree, accept or say thanks where that makes sense. Only decline, refuse or disagree if the user's instruction for THIS reply asks for it.",
    "Output ONLY the reply text, ready to send. No preface like \"Here is a reply\", no quotation marks around it, no placeholders like [Name], no notes after it."
  ];
  if (keyPoints && keyPoints.length) {
    rules.push("The message keeps its formatting: **double asterisks** mark bold text, _underscores_ italic, ## a heading. Its KEY POINTS (what the sender emphasised) are listed after it; make sure the reply responds to the ones that need a response (deadlines, questions, requests).");
  }
  if (userName) rules.push(`The user's name is ${userName}.`);
  // A learned sign-off habit (incl. "no sign-off") replaces the generic default below
  const learnedSignoff = Boolean(
    personalization && personalization.active &&
    (personalization.styleLines || []).some((l) => /sign-off|closes with/i.test(l))
  );
  if (userSignoff) {
    rules.push(`End the reply with this exact sign-off on its own line(s): "${userSignoff}". Never put the sign-off at the start.`);
  } else if (userName && !learnedSignoff) {
    rules.push(`For emails, end with a short sign-off and the name ${userName}. Never put the sign-off at the start.`);
  }
  if (customRules) rules.push(`The user's personal style rules: ${customRules}`);

  let systemPrompt = `You are a ghost-writer. You write the reply that the USER will send, in the user's own voice.

The user has received a message on a website (an email, chat message, post, or comment). Your task is to write the reply the user sends BACK to the sender of that message.

Rules:
${rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}`;

  // ---- Personalisation: what the extension has learned about this user ----
  const examples = personalization && personalization.active ? personalization.examples || [] : [];
  if (personalization && personalization.active) {
    const prefs = personalization.prefLines || [];
    const habits = personalization.styleLines || [];
    if (prefs.length) {
      systemPrompt += `\n\nTHE USER'S 5 PREFERENCES (learned from replies they actually sent; follow them closely):\n${prefs.map((l, i) => `${i + 1}. ${l}`).join("\n")}`;
    }
    if (habits.length) {
      systemPrompt += `\n\nMeasured writing habits:\n${habits.map((l) => `- ${l}`).join("\n")}`;
    }
    if (prefs.length || habits.length) {
      systemPrompt += "\nIf anything here conflicts with the numbered rules above, the rules above win.";
    }
    if (examples.length) {
      systemPrompt += "\n\nThe example conversations before the new message are REAL replies this user wrote to similar messages. Imitate their tone, length, greeting and sign-off, but reply only to the content of the NEW message.";
    }
  }
  // Leave room for the examples in small context windows (Ollama's default is about 4,000 tokens)
  const maxMessageChars = examples.length ? 4500 : 6000;

  const buildUserTurn = (messageText, instruction, hasImage, points = []) => {
    let t = "";
    if (messageText && messageText.trim()) {
      t += `MESSAGE THE USER RECEIVED:\n"""\n${fitText(messageText, maxMessageChars)}\n"""\n`;
      if (points && points.length) {
        t += `KEY POINTS (emphasised in the original message):\n${points.map((k) => `- ${k}`).join("\n")}\n`;
      }
      if (hasImage) t += "(A screenshot of the same message is also attached.)\n";
    } else {
      t += "MESSAGE THE USER RECEIVED: see the attached screenshot.\n";
    }
    if (instruction && instruction.trim()) {
      t += `\nThe user's instruction for this reply: "${instruction.trim()}"\n`;
    }
    t += "\nNow write the user's reply to the sender of this message. Output only the reply.";
    return t;
  };

  const textPrompt = buildUserTurn(extractedText, userInstructions, Boolean(imageDataUrl), keyPoints); // sent together with the image
  const textOnlyPrompt = buildUserTurn(extractedText, userInstructions, false, keyPoints);            // sent without the image

  // Worked examples (few-shot): the user's own past replies when we have them,
  // otherwise one generic example so small models copy the right perspective and format.
  // Most similar example goes LAST (closest to the new message).
  const personalShots = examples
    .slice()
    .reverse()
    .flatMap((ex) => [
      { role: "user", content: buildUserTurn(ex.context.slice(0, 600), "", false) },
      { role: "assistant", content: ex.reply.slice(0, 600) }
    ]);
  const genericShot = [
    {
      role: "user",
      content: buildUserTurn(
        "Hi Sam,\nWe're hosting a cloud computing workshop this Friday at 3 PM in Lab 2. Seats are limited, please confirm if you'll attend.\nRegards,\nTech Club",
        "",
        false
      )
    },
    {
      role: "assistant",
      content: "Hi Tech Club team,\n\nThank you for the invitation. I'd like to attend the cloud computing workshop this Friday at 3 PM in Lab 2. Please reserve a seat for me.\n\nBest regards,\nSam"
    }
  ];
  const fewShot = personalShots.length ? personalShots : genericShot;

  // -------------------------------------------------------------
  // Path A: Local LLM (Ollama, LM Studio, LocalAI, vLLM)
  // -------------------------------------------------------------
  if (isLocal) {
    const targetUrl = normalizeLocalUrl(localLlmUrl || "http://localhost:11434", "chat");
    await ensureLocalOriginRule(localLlmUrl || "http://localhost:11434");
    // Model chosen in Settings, or the first installed chat model
    let modelName = await resolveLocalModel(localLlmUrl, localModel);
    const visionRe = /vision|llava|vl|omni|minicpm|pixtral|moondream|gemma3|gemma-3|llama4/i;
    let isVisionCapable = visionRe.test(modelName);

    // Multimodal payload with image
    const multimodalContent = [{ type: "text", text: textPrompt }];
    if (imageDataUrl && imageDataUrl.startsWith("data:image/")) {
      multimodalContent.push({
        type: "image_url",
        image_url: { url: imageDataUrl }
      });
    }

    const hasText = Boolean(extractedText && extractedText.trim().length >= 3);
    const hasImage = Boolean(imageDataUrl && imageDataUrl.startsWith("data:image/"));

    if (!hasText && !hasImage) {
      throw new Error("Nothing was captured. Please snip an area containing a message.");
    }

    // Order attempts:
    // - vision model: image first, text-only as fallback (only if we actually have text)
    // - text model WITH page text: text-only first, image as fallback
    // - text model with NO page text (canvas, image, PDF viewer...): a text-only request would just
    //   make up a reply, so only try the image request; if the model can't take images, explain why.
    const buildAttempts = () => {
      if (isVisionCapable) {
        const a = [{ name: "multimodal", content: multimodalContent }];
        if (hasText) a.push({ name: "text-only", content: textOnlyPrompt });
        return a;
      }
      if (hasText) {
        const a = [{ name: "text-only", content: textOnlyPrompt }];
        if (hasImage) a.push({ name: "multimodal", content: multimodalContent });
        return a;
      }
      return [{ name: "multimodal", content: multimodalContent }];
    };

    let lastLocalError = null;
    let modelMissing = false;

    // Round 2 only happens if the saved model isn't installed: retry with an installed one
    for (let round = 0; round < 2; round++) {
    modelMissing = false;
    for (const attempt of buildAttempts()) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);

      try {
        const bodyPayload = {
          model: modelName,
          messages: [
            { role: "system", content: systemPrompt },
            ...fewShot,
            { role: "user", content: attempt.content }
          ],
          max_tokens: 1000,
          temperature: 0.4
        };

        const response = await fetch(targetUrl, {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bodyPayload)
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const errText = await response.text();
          if (response.status === 403) {
            lastLocalError = `HTTP 403 (Ollama blocked the extension's origin). Run: setx OLLAMA_ORIGINS "chrome-extension://*" in PowerShell, then fully quit Ollama from the system tray and start it again`;
            break;
          }
          lastLocalError = `HTTP ${response.status}: ${errText.slice(0, 160)}`;
          if (isModelMissing(response.status, errText)) {
            modelMissing = true;
            break;
          }
          // If 400 with multimodal, try text-only fallback
          continue;
        }

        const data = await response.json();
        let text = data?.choices?.[0]?.message?.content || data?.response;
        if (typeof text !== "string" || !text.trim()) {
          lastLocalError = "Empty response from local model.";
          continue;
        }

        lastUsedModel = modelName;
        return cleanReply(text, userSignoff);
      } catch (err) {
        clearTimeout(timeout);
        lastLocalError = err.name === "AbortError" ? "Local LLM request timed out" : (err.message || String(err));
      }
    }
    if (round === 0 && modelMissing) {
      const failed = modelName;
      const fb = await fallbackLocalModel(localLlmUrl, failed);
      if (fb) {
        modelName = fb;
        isVisionCapable = visionRe.test(modelName);
        continue;
      }
      lastLocalError = `The model "${failed}" is not installed. Open Settings → Detect Models, pick one of your installed models and click Save (or run 'ollama pull ${failed}').`;
    }
    break;
    }

    if (!hasText && !isVisionCapable) {
      throw new Error(
        `No readable text was found in the snipped area, and "${modelName}" looks like a text-only model, so it can't read the image. ` +
        `Install a vision model (e.g. 'ollama pull llava' or 'llama3.2-vision') and select it in Settings. (Details: ${lastLocalError || "unknown"})`
      );
    }
    throw new Error(
      `Local LLM Error (${modelName} at ${targetUrl}): ${lastLocalError || "Could not connect"}. Make sure Ollama or LM Studio is running.`
    );
  }

  // -------------------------------------------------------------
  // Path B: OpenRouter Cloud Vision Fallback Chain
  // -------------------------------------------------------------
  const VISION_MODELS = [
    "google/gemma-4-31b-it:free",
    "google/gemma-4-26b-a4b-it:free",
    "qwen/qwen3.8-27b:free",
    "nvidia/nemotron-3-nano-omni:free",
    "meta-llama/llama-3.2-11b-vision-instruct:free",
    "openai/gpt-4o-mini"
  ];

  let models;
  if (openRouterModel && openRouterModel.trim()) {
    const pref = openRouterModel.trim();
    models = [pref, ...VISION_MODELS.filter((m) => m !== pref)];
  } else {
    models = [...VISION_MODELS];
  }

  const contentParts = [{ type: "text", text: textPrompt }];
  if (imageDataUrl && imageDataUrl.startsWith("data:image/")) {
    contentParts.push({
      type: "image_url",
      image_url: { url: imageDataUrl }
    });
  }

  const apiUrl = "https://openrouter.ai/api/v1/chat/completions";
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };

  let lastError = null;

  // Try up to 4 models from the chain, but always keep the paid gpt-4o-mini fallback as the last resort
  const LAST_RESORT = "openai/gpt-4o-mini";
  const chain = models.filter((m) => m !== LAST_RESORT).slice(0, 4);
  chain.push(LAST_RESORT);

  for (const model of chain) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 40000);

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        signal: controller.signal,
        headers,
        body: JSON.stringify({
          model: model,
          messages: [
            { role: "system", content: systemPrompt },
            ...fewShot,
            { role: "user", content: contentParts }
          ],
          max_tokens: 1000,
          temperature: 0.4
        })
      });

      if (!response.ok) {
        if (response.status === 401) {
          const e = new Error("Invalid OpenRouter API Key. Please update it in Settings.");
          e.fatal = true; // no point trying other models with a bad key
          throw e;
        }
        if (response.status === 402) {
          // Out of credits: this model needs payment, a free model may still work, so try the next one
          lastError = "Your OpenRouter account lacks credits or model quota. Check your balance or choose a free model.";
          continue;
        }
        lastError = `Status ${response.status} from ${model}`;
        continue;
      }

      const data = await response.json();
      let text = data?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) {
        lastError = `Empty response from ${model}`;
        continue;
      }

      lastUsedModel = model;
      return cleanReply(text, userSignoff);
    } catch (err) {
      if (err.fatal) throw err;
      lastError = err.name === "AbortError" ? `Timed out on ${model}` : (err.message || String(err));
      console.warn(`Model ${model} failed:`, lastError);
      continue;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`Failed to generate reply. Last error: ${lastError || "All models failed"}`);
}

// Tests API connection (Local LLM or OpenRouter)
async function testApiConnection(params = {}) {
  const { provider = "local", apiKey, model, localLlmUrl, localModel } = params;

  // 1. Testing Local LLM
  if (provider === "local") {
    const targetUrl = normalizeLocalUrl(localLlmUrl || "http://localhost:11434", "chat");
    await ensureLocalOriginRule(localLlmUrl || "http://localhost:11434");
    let modelName = (localModel || "").trim();

    // Auto-discover model if not explicitly set
    if (!modelName) {
      const detected = (await fetchLocalModels(localLlmUrl)).filter((m) => !isEmbeddingModel(m));
      if (detected.length > 0) {
        modelName = detected[0];
      }
    }

    if (!modelName) {
      // If we couldn't detect models, try a basic check on /v1/models
      const { v1Models } = normalizeLocalUrl(localLlmUrl, "models");
      try {
        const res = await fetch(v1Models);
        if (res.ok) {
          return `Connected to local server at ${targetUrl}, but no chat models were detected. Please install a model (e.g. 'ollama pull llama3.2' or download one in LM Studio).`;
        }
      } catch (e) {
        throw new Error(`Could not connect to local server at ${targetUrl}. Please ensure Ollama or LM Studio is running.`);
      }
      throw new Error(`Could not list the models on ${targetUrl}. Please ensure Ollama or LM Studio is running.`);
    }

    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    try {
      const res = await fetch(targetUrl, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: "user", content: "Ping. Respond with pong." }],
          max_tokens: 10
        })
      });
      clearTimeout(timeout);

      const latency = Date.now() - startTime;
      if (!res.ok) {
        const errText = await res.text();
        if (res.status === 403) {
          const e = new Error(`HTTP 403 (Ollama blocked the extension's origin). Run: setx OLLAMA_ORIGINS "chrome-extension://*" in PowerShell, then fully quit Ollama from the system tray and start it again.`);
          e.handled = true;
          throw e;
        }
        throw new Error(`Local server returned HTTP ${res.status}: ${errText.slice(0, 160)}`);
      }

      return `Connected successfully to local LLM (${modelName} at ${targetUrl}, ${latency}ms)`;
    } catch (err) {
      clearTimeout(timeout);
      if (err.handled) throw err; // already a clear, specific message
      throw new Error(`Connection failed to ${targetUrl}: ${err.message || err}. Check that your local server is running.`);
    }
  }

  // 2. Testing OpenRouter
  if (!apiKey) {
    throw new Error("No OpenRouter API key provided. Please enter your key.");
  }

  const targetModel = model || "google/gemma-4-31b-it:free";
  const startTime = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: targetModel,
        messages: [{ role: "user", content: "Ping. Respond with pong." }],
        max_tokens: 10
      })
    });
    clearTimeout(timeout);

    const latency = Date.now() - startTime;
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenRouter HTTP ${res.status}: ${errText.slice(0, 160)}`);
    }

    return `Connected successfully to OpenRouter (${targetModel}, ${latency}ms)`;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}
