// options.js - Settings page: simple, auto-saving.
// Storage keys (chrome.storage.sync) are the same as before, so nothing else in the extension changes.

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  provider: "local",
  apiKey: "",
  model: "",
  localLlmUrl: "http://localhost:11434",
  localModel: "",
  userName: "",
  userSignoff: "",
  customRules: "",
  contextLevels: 5
};
const PRESETS = { ollama: "http://localhost:11434", lmstudio: "http://localhost:1234" };
const isEmbeddingModel = (m) => /embed|bge-|bge:|minilm|\be5-|gte-|arctic|mxbai|paraphrase/i.test(m);

let savedLocalModel = "";

// ---- saving ----
let savedTimer = null;
function save(values) {
  chrome.storage.sync.set(values, () => {
    $("saved").classList.add("on");
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => $("saved").classList.remove("on"), 1400);
  });
}
const debounce = (fn, ms = 400) => {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

function setStatus(boxId, kind, text) {
  const box = $(boxId);
  box.className = `status ${kind || ""}`;
  box.querySelector(".txt").textContent = text;
}

// ---- provider ----
function showProvider(provider) {
  document.querySelector(`input[name=provider][value=${provider === "openrouter" ? "openrouter" : "local"}]`).checked = true;
  $("localBox").hidden = provider === "openrouter";
  $("cloudBox").hidden = provider !== "openrouter";
}

// ---- local server & models ----
function serverUrl() {
  if ($("server").value === "custom") return $("customUrl").value.trim() || PRESETS.ollama;
  return PRESETS[$("server").value];
}

async function findModels() {
  const select = $("localModel");
  const url = serverUrl();
  setStatus("localStatus", "busy", `Looking for models at ${url}…`);
  $("refreshBtn").disabled = true;
  let models = [];
  try {
    const res = await chrome.runtime.sendMessage({ type: "FETCH_LOCAL_MODELS", url });
    models = (res && res.success && res.models) || [];
  } catch (e) {}
  $("refreshBtn").disabled = false;

  const chat = models.filter((m) => !isEmbeddingModel(m));
  select.innerHTML = "";
  if (!chat.length) {
    select.add(new Option("No models found", ""));
    select.disabled = true;
    setStatus("localStatus", "bad", models.length
      ? "Only an embedding model is installed. Install a chat model, e.g. ollama pull llama3.2"
      : `Can't reach ${url}. Is ${$("server").value === "lmstudio" ? "LM Studio's server" : "Ollama"} running?`);
    return;
  }
  select.disabled = false;
  chat.forEach((m) => select.add(new Option(m, m)));
  select.value = chat.includes(savedLocalModel) ? savedLocalModel : chat[0];
  if (select.value !== savedLocalModel) {
    savedLocalModel = select.value;
    save({ localModel: select.value });
  }
  const embed = models.some(isEmbeddingModel) ? " · matching past replies by meaning" : "";
  setStatus("localStatus", "ok", `Connected · ${chat.length} model${chat.length === 1 ? "" : "s"} installed${embed}`);
}

async function testConnection(provider) {
  const box = provider === "local" ? "localStatus" : "cloudStatus";
  setStatus(box, "busy", "Testing… (the first test can take a few seconds while the model loads)");
  try {
    const res = await chrome.runtime.sendMessage(provider === "local"
      ? { type: "TEST_API_CONNECTION", provider: "local", localLlmUrl: serverUrl(), localModel: $("localModel").value }
      : { type: "TEST_API_CONNECTION", provider: "openrouter", apiKey: $("apiKey").value.trim(), model: $("cloudModel").value.trim() });
    if (res && res.success) {
      const ms = (String(res.message).match(/(\d+)ms/) || [])[1];
      const model = provider === "local" ? $("localModel").value : $("cloudModel").value.trim() || "default free model";
      setStatus(box, "ok", `Working · ${model} answered${ms ? ` in ${ms} ms` : ""}`);
    } else {
      setStatus(box, "bad", (res && res.error) || "Connection failed");
    }
  } catch (e) {
    setStatus(box, "bad", e.message || String(e));
  }
}

// ---- init ----
async function init() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  savedLocalModel = s.localModel || "";

  showProvider(s.provider);
  const preset = Object.keys(PRESETS).find((k) => PRESETS[k] === s.localLlmUrl);
  $("server").value = preset || "custom";
  $("customUrl").value = s.localLlmUrl;
  $("customUrl").hidden = $("server").value !== "custom";

  $("apiKey").value = s.apiKey;
  $("cloudModel").value = s.model === "openrouter/free" ? "" : s.model;
  $("userName").value = s.userName;
  $("userSignoff").value = s.userSignoff;
  $("customRules").value = s.customRules;
  $("contextLevels").value = s.contextLevels || 5;

  if (s.provider !== "openrouter") findModels();
  else if (s.apiKey) setStatus("cloudStatus", "", "Key saved · press Test to check it");
}

// ---- events ----
document.querySelectorAll("input[name=provider]").forEach((r) => r.addEventListener("change", () => {
  const provider = document.querySelector("input[name=provider]:checked").value;
  showProvider(provider);
  save({ provider });
  if (provider === "local") findModels();
}));

$("server").addEventListener("change", () => {
  $("customUrl").hidden = $("server").value !== "custom";
  if ($("server").value === "custom") { $("customUrl").focus(); return; }
  save({ localLlmUrl: serverUrl() });
  findModels();
});
$("customUrl").addEventListener("change", () => {
  save({ localLlmUrl: serverUrl() });
  findModels();
});
$("localModel").addEventListener("change", () => {
  savedLocalModel = $("localModel").value;
  save({ localModel: savedLocalModel });
});
$("refreshBtn").addEventListener("click", findModels);
$("testLocal").addEventListener("click", () => testConnection("local"));
$("testCloud").addEventListener("click", () => testConnection("openrouter"));

$("apiKey").addEventListener("input", debounce(() => save({ apiKey: $("apiKey").value.trim() })));
$("cloudModel").addEventListener("input", debounce(() => save({ model: $("cloudModel").value.trim() })));
$("userName").addEventListener("input", debounce(() => save({ userName: $("userName").value.trim() })));
$("userSignoff").addEventListener("input", debounce(() => save({ userSignoff: $("userSignoff").value.trim() })));
$("customRules").addEventListener("input", debounce(() => save({ customRules: $("customRules").value.trim() })));
$("contextLevels").addEventListener("change", () => {
  const v = Math.min(10, Math.max(1, parseInt($("contextLevels").value, 10) || 5));
  $("contextLevels").value = v;
  save({ contextLevels: v });
});

$("openProfile").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("profile.html") }));
$("openShortcuts").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));

// ---- Your writing preferences (same data as the "What I've learned" page) ----
let prefs = [];
const fmtWhen = (ts) => new Date(ts).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const escAttr = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function loadPrefs() {
  prefs = await AIP.getPreferences();
  const [log, { prefState = {} }] = await Promise.all([AIP.getPreferenceLog(), chrome.storage.local.get("prefState")]);
  renderPrefs(log, prefState);
}

function renderPrefs(log = [], prefState = {}) {
  const rows = [];
  for (let i = 0; i < 5; i++) {
    const p = prefs[i];
    rows.push(p
      ? `<div class="pref ${p.locked ? "pinned" : ""}" data-id="${escAttr(p.id)}">
           <span class="n">${i + 1}</span>
           <input type="text" value="${escAttr(p.text)}" data-act="edit" title="Click to edit">
           <span class="tag">${p.source === "user" ? "yours" : "learned"}</span>
           <button class="iconbtn ${p.locked ? "on" : ""}" data-act="pin" title="${p.locked ? "Pinned: never changed automatically" : "Pin to keep it unchanged"}">${p.locked ? "Pinned" : "Pin"}</button>
           <button class="iconbtn" data-act="remove" title="Remove (your next reply fills this slot)">✕</button>
         </div>`
      : `<div class="pref empty">${i + 1}. Empty: learned from your next sent reply</div>`);
  }
  $("prefList").innerHTML = rows.join("");
  $("addPrefRow").hidden = prefs.length >= 5;
  const last = log[log.length - 1];
  $("prefInfo").textContent = !prefs.length
    ? "None yet: send a reply with the extension and the first ones appear here."
    : last
      ? `Last updated ${fmtWhen(last.ts)}${last.site ? ` after a reply on ${last.site}` : ""}`
      : "";
}

async function savePrefs() {
  await AIP.savePreferences(prefs);
  $("saved").classList.add("on");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => $("saved").classList.remove("on"), 1400);
}

$("prefList").addEventListener("change", async (e) => {
  if (e.target.dataset.act !== "edit") return;
  const p = prefs.find((x) => x.id === e.target.closest(".pref").dataset.id);
  const v = e.target.value.trim();
  if (!p || !v || v === p.text) return;
  Object.assign(p, { text: v, source: "user", locked: true, updatedTs: Date.now() }); // your own wording is kept
  await savePrefs();
  loadPrefs();
});
$("prefList").addEventListener("click", async (e) => {
  const act = e.target.dataset.act;
  if (act !== "pin" && act !== "remove") return;
  const id = e.target.closest(".pref").dataset.id;
  if (act === "pin") { const p = prefs.find((x) => x.id === id); p.locked = !p.locked; }
  if (act === "remove") prefs = prefs.filter((x) => x.id !== id);
  await savePrefs();
  loadPrefs();
});
$("addPref").addEventListener("click", async () => {
  const v = $("newPref").value.trim();
  if (!v || prefs.length >= 5) return $("newPref").focus();
  prefs.push(AIP.newPreference(v, "user"));
  $("newPref").value = "";
  await savePrefs();
  loadPrefs();
});
$("newPref").addEventListener("keydown", (e) => { if (e.key === "Enter") $("addPref").click(); });
$("updatePrefs").addEventListener("click", async () => {
  const btn = $("updatePrefs");
  btn.disabled = true;
  $("prefInfo").textContent = "Updating from your latest sent reply… (up to a minute on a local model)";
  try {
    const res = await chrome.runtime.sendMessage({ type: "LEARN_NOW" });
    if (!res || !res.success) throw new Error(res ? res.error : "No response");
    await loadPrefs();
    $("prefInfo").textContent = res.added.length
      ? `Updated: ${res.added.length} preference${res.added.length === 1 ? "" : "s"} changed`
      : "Your preferences still fit your latest reply";
  } catch (err) {
    $("prefInfo").textContent = err.message || String(err);
  } finally {
    btn.disabled = false;
  }
});
$("prefHistory").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("profile.html#rules") }));

// Refresh when the background updates them after a sent reply
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.preferences || changes.preferenceLog)) {
    if (!document.activeElement || !document.activeElement.closest(".pref")) loadPrefs();
  }
});

init();
loadPrefs();
if (location.hash === "#preferences") setTimeout(() => $("preferences").scrollIntoView({ behavior: "smooth" }), 300);
