// content.js
// Gmail AI Reply Assistant - Content Script

let activeComposeBox = null;   // compose box the panel was opened from
let panelRequestId = 0;        // bumped on every generation and on close; stale responses are ignored
let lastGenerateOptions = {};  // options of the last generation, reused by "Try again"

// ---------------------------------------------------------------------------
// Attachments (files & photos)
// Files live in memory while the panel is open. They are (1) sent to the model
// as context and (2) optionally attached to the Gmail compose window on Insert.
// ---------------------------------------------------------------------------
const ATTACH_LIMITS = {
  maxFiles: 5,
  maxFileBytes: 10 * 1024 * 1024,           // 10 MB per file
  maxTotalBytes: 25 * 1024 * 1024,          // Gmail's total attachment cap
  maxTextChars: 30000,                      // per text file sent to the model
  maxImageDim: 1600,                        // longest edge of images sent to the model
  maxImageBytesUnscaled: 1.5 * 1024 * 1024  // smaller images are sent untouched
};
const IMAGE_MIME_TYPES = { "image/png": "image/png", "image/jpeg": "image/jpeg", "image/jpg": "image/jpeg", "image/webp": "image/webp", "image/gif": "image/gif" };
const IMAGE_EXTENSIONS = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
const TEXT_MIME_TYPES = ["text/plain", "text/csv", "text/markdown", "application/json"];
const TEXT_EXTENSIONS = { txt: "text/plain", csv: "text/csv", md: "text/markdown", markdown: "text/markdown", json: "application/json" };
const ATTACH_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,application/pdf,.pdf,.txt,.csv,.md,.markdown,.json";

let attachedFiles = []; // { id, file, name, size, kind, mimeType, status, dataUrl, text, truncated, attachedTo, ready }
let attachToEmail = true;
let attachIdCounter = 0;

// ---------------------------------------------------------------------------
// Panel UI: design tokens, styles and icons
// All panel styles live in one injected stylesheet scoped to the panel IDs, so
// Gmail's CSS can't leak in and ours can't leak out. Icons are inline SVG
// (not emoji) so they render identically on every OS.
// ---------------------------------------------------------------------------
const ICON_PATHS = {
  sparkle: '<path d="M12 2C12.8 8 16 11.2 22 12C16 12.8 12.8 16 12 22C11.2 16 8 12.8 2 12C8 11.2 11.2 8 12 2Z"/>',
  minus: '<path d="M6 12h12"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  paperclip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  decline: '<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="2"/><path d="M16 2.5v4"/><path d="M8 2.5v4"/><path d="M3 10h18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  alertCircle: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  fileText: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>'
};

function icon(name, size = 14, filled = false) {
  return `<svg class="ai-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${filled ? "currentColor" : "none"}" stroke="${filled ? "none" : "currentColor"}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name] || ""}</svg>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// "follow_up" -> "follow up" (displayed uppercase via CSS)
function formatIntent(intent) {
  return String(intent || "general").replace(/[_-]+/g, " ").trim();
}

const QUICK_ACTIONS = [
  { label: "Agree", icon: "check", prompt: "Sounds good, I agree and confirm." },
  { label: "Decline", icon: "decline", prompt: "Politely decline this request with apologies." },
  { label: "Propose Meet", icon: "calendar", prompt: "Propose a 30-minute meeting to discuss next week." },
  { label: "Need Time", icon: "clock", prompt: "Need a bit more time to review and will follow up shortly." }
];

const PANEL_STYLES = `
#ai-reply-panel, #ai-reply-min-pill {
  --ai-accent: #3451b2;
  --ai-accent-hover: #2b4496;
  --ai-accent-active: #233a7f;
  --ai-accent-soft: #eef1fb;
  --ai-ring: rgba(52, 81, 178, 0.28);
  --ai-text: #1f2328;
  --ai-text-2: #57606a;
  --ai-text-3: #6e7781;
  --ai-border: #d0d7de;
  --ai-border-strong: #afb8c1;
  --ai-border-soft: #dfe3e8;
  --ai-divider: #e7eaee;
  --ai-surface: #ffffff;
  --ai-surface-2: #f6f8fa;
  --ai-hover: #f0f2f5;
  --ai-danger: #cf222e;
  --ai-danger-soft: #ffebe9;
  --ai-warn: #9a6700;
  --ai-success: #1a7f37;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 13px;
  line-height: 1.4;
  color: var(--ai-text);
  text-align: left;
  -webkit-font-smoothing: antialiased;
}
#ai-reply-panel {
  background: var(--ai-surface);
  border: 1px solid var(--ai-border);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(31, 35, 40, 0.12), 0 1px 2px rgba(31, 35, 40, 0.06);
}
#ai-reply-panel *, #ai-reply-panel *::before, #ai-reply-panel *::after { box-sizing: border-box; }
#ai-reply-panel button, #ai-reply-panel input, #ai-reply-panel select { font-family: inherit; margin: 0; }
#ai-reply-panel svg { display: block; flex-shrink: 0; }
#ai-reply-panel button:focus-visible, #ai-reply-min-pill:focus-visible { outline: 2px solid var(--ai-accent); outline-offset: 1px; }

/* Header */
#ai-reply-panel .ai-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 40px; padding: 0 6px 0 12px; background: var(--ai-surface-2); border-bottom: 1px solid var(--ai-divider); cursor: move; user-select: none; }
#ai-reply-panel .ai-header-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ai-brand-mark { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 5px; background: #3451b2; color: #fff; flex-shrink: 0; }
#ai-reply-panel .ai-title { font-size: 13px; font-weight: 600; color: var(--ai-text); white-space: nowrap; }
#ai-reply-panel .ai-mode { padding-left: 8px; border-left: 1px solid var(--ai-border); font-size: 12px; line-height: 14px; color: var(--ai-text-3); white-space: nowrap; }
#ai-reply-panel .ai-mode.is-error { color: var(--ai-danger); }
#ai-reply-panel .ai-header-actions { display: flex; align-items: center; gap: 2px; }
#ai-reply-panel .ai-header-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--ai-text-2); cursor: pointer; }
#ai-reply-panel .ai-header-btn:hover { background: rgba(31, 35, 40, 0.07); color: var(--ai-text); }

/* Body */
#ai-reply-panel .ai-body { max-height: min(500px, calc(100vh - 185px)); overflow-y: auto; padding: 12px 14px 14px; }
#ai-reply-panel .ai-section { margin-bottom: 14px; }
#ai-reply-panel .ai-context { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--ai-divider); }
#ai-reply-panel .ai-context-text { flex: 1; min-width: 0; }
#ai-reply-panel .ai-subject { font-size: 13px; font-weight: 600; line-height: 18px; color: var(--ai-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#ai-reply-panel .ai-recipient { margin-top: 2px; font-size: 12px; line-height: 16px; color: var(--ai-text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#ai-reply-panel .ai-intent { flex-shrink: 0; max-width: 42%; margin-top: 1px; padding: 0 6px; border-radius: 4px; background: var(--ai-surface-2); font-size: 10.5px; font-weight: 600; line-height: 16px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ai-text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* Form controls */
#ai-reply-panel .ai-input, #ai-reply-panel .ai-select { display: block; width: 100%; height: 32px; padding: 0 10px; border: 1px solid var(--ai-border); border-radius: 6px; background: var(--ai-surface); color: var(--ai-text); font-size: 13px; box-shadow: none; transition: border-color 0.12s ease, box-shadow 0.12s ease; }
#ai-reply-panel .ai-input::placeholder { color: var(--ai-text-3); opacity: 1; }
#ai-reply-panel .ai-input:hover, #ai-reply-panel .ai-select:hover { border-color: var(--ai-border-strong); }
#ai-reply-panel .ai-input:focus, #ai-reply-panel .ai-select:focus { outline: none; border-color: var(--ai-accent); box-shadow: 0 0 0 3px var(--ai-ring); }
#ai-reply-panel .ai-select { padding: 0 6px 0 8px; font-size: 12.5px; cursor: pointer; }

/* Buttons */
#ai-reply-panel .ai-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 12px; border: 1px solid transparent; border-radius: 6px; font-size: 13px; font-weight: 500; line-height: 1; white-space: nowrap; cursor: pointer; transition: background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease; }
#ai-reply-panel .ai-btn:disabled { cursor: default; opacity: 0.65; }
#ai-reply-panel .ai-btn-primary { background: var(--ai-accent); color: #fff; }
#ai-reply-panel .ai-btn-primary:hover:not(:disabled) { background: var(--ai-accent-hover); }
#ai-reply-panel .ai-btn-primary:active:not(:disabled) { background: var(--ai-accent-active); }
#ai-reply-panel .ai-btn-primary:focus-visible { outline-offset: 2px; }
#ai-reply-panel .ai-btn-secondary { background: var(--ai-surface); border-color: var(--ai-border); color: var(--ai-text); }
#ai-reply-panel .ai-btn-secondary:hover { background: var(--ai-surface-2); border-color: var(--ai-border-strong); }
#ai-reply-panel .ai-btn-secondary .ai-icon { color: var(--ai-text-2); }
#ai-reply-panel .ai-btn-tertiary { padding: 0 10px; background: transparent; color: var(--ai-text-2); }
#ai-reply-panel .ai-btn-tertiary:hover { background: var(--ai-danger-soft); color: var(--ai-danger); }
#ai-reply-panel .ai-btn-ghost { height: 28px; margin-left: -6px; padding: 0 6px; background: transparent; color: var(--ai-accent); font-size: 12.5px; }
#ai-reply-panel .ai-btn-ghost:hover { background: var(--ai-accent-soft); }
#ai-reply-panel .ai-btn-block { width: 100%; }
#ai-reply-panel .ai-icon-btn { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; width: 32px; height: 32px; padding: 0; border: 1px solid var(--ai-border); border-radius: 6px; background: var(--ai-surface); color: var(--ai-text-2); cursor: pointer; transition: background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease; }
#ai-reply-panel .ai-icon-btn:hover { background: var(--ai-surface-2); border-color: var(--ai-border-strong); color: var(--ai-text); }

/* Quick actions */
#ai-reply-panel .ai-quick { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
#ai-reply-panel .ai-chip { flex: 1 1 auto; display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 26px; padding: 0 8px; border: 1px solid var(--ai-border-soft); border-radius: 6px; background: var(--ai-surface); color: var(--ai-text-2); font-size: 12px; font-weight: 500; white-space: nowrap; cursor: pointer; transition: background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease; }
#ai-reply-panel .ai-chip .ai-icon { color: var(--ai-text-3); }
#ai-reply-panel .ai-chip:hover { background: var(--ai-hover); border-color: var(--ai-border); color: var(--ai-text); }
#ai-reply-panel .ai-chip:hover .ai-icon { color: var(--ai-text-2); }

/* Attachments */
#ai-reply-panel .ai-attach-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
#ai-reply-panel .ai-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ai-text-2); white-space: nowrap; cursor: pointer; user-select: none; }
#ai-reply-panel .ai-check input { width: 14px; height: 14px; margin: 0; accent-color: var(--ai-accent); cursor: pointer; }
#ai-reply-panel .ai-check input:focus-visible { outline: 2px solid var(--ai-accent); outline-offset: 2px; }
#ai-reply-panel .ai-attach-hint { margin-top: 2px; font-size: 11.5px; line-height: 16px; color: var(--ai-text-3); }
#ai-reply-panel .ai-attach-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
#ai-reply-panel .ai-attach-list:empty { display: none; }
#ai-reply-panel .ai-attach-chip { display: flex; align-items: center; gap: 8px; max-width: 100%; height: 36px; padding: 0 4px; border: 1px solid var(--ai-border-soft); border-radius: 6px; background: var(--ai-surface); font-size: 12px; }
#ai-reply-panel .ai-attach-thumb { display: flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 4px; background: var(--ai-surface-2); color: var(--ai-text-3); object-fit: cover; flex-shrink: 0; }
#ai-reply-panel .ai-attach-meta { display: flex; flex-direction: column; min-width: 0; line-height: 15px; }
#ai-reply-panel .ai-attach-name { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; color: var(--ai-text); }
#ai-reply-panel .ai-attach-sub { font-size: 11px; color: var(--ai-text-3); white-space: nowrap; }
#ai-reply-panel .ai-attach-sub.is-attached { color: var(--ai-success); }
#ai-reply-panel .ai-attach-remove { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--ai-text-3); cursor: pointer; }
#ai-reply-panel .ai-attach-remove:hover { background: var(--ai-hover); color: var(--ai-text); }
#ai-reply-panel .ai-attach-msg { margin-top: 6px; font-size: 12px; line-height: 16px; }

/* Draft */
#ai-reply-panel .ai-controls { display: flex; gap: 6px; margin-bottom: 8px; }
#ai-reply-panel .ai-controls .ai-select { flex: 1 1 0; min-width: 0; }
#ai-reply-panel .ai-draft { min-height: 96px; max-height: 220px; overflow-y: auto; padding: 10px 12px; border: 1px solid var(--ai-border); border-radius: 6px; background: var(--ai-surface); color: var(--ai-text); font-size: 13px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
#ai-reply-panel .ai-draft:focus-visible { outline: none; border-color: var(--ai-accent); box-shadow: 0 0 0 3px var(--ai-ring); }
#ai-reply-panel .ai-draft-loading { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 74px; color: var(--ai-text-2); white-space: normal; }

/* Footer */
#ai-reply-panel .ai-footer { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--ai-divider); background: var(--ai-surface); }
#ai-reply-panel #ai-insert-btn { flex: 1 1 auto; }

/* Missing info, loading, errors */
#ai-reply-panel .ai-notice { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; font-size: 12px; font-weight: 600; color: var(--ai-warn); }
#ai-reply-panel .ai-field { margin-bottom: 12px; }
#ai-reply-panel .ai-label { display: block; margin-bottom: 6px; font-size: 12.5px; line-height: 1.4; color: var(--ai-text); }
#ai-reply-panel .ai-loading { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 32px 16px; font-size: 13px; color: var(--ai-text-2); }
#ai-reply-panel .ai-spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--ai-border); border-top-color: var(--ai-accent); border-radius: 50%; animation: ai-spin 0.8s linear infinite; flex-shrink: 0; }
#ai-reply-panel .ai-spinner-sm { width: 12px; height: 12px; border-width: 1.5px; }
#ai-reply-panel .ai-btn-primary .ai-spinner { border-color: rgba(255, 255, 255, 0.4); border-top-color: #fff; }
#ai-reply-panel .ai-error { display: flex; align-items: flex-start; gap: 8px; max-height: 250px; overflow-y: auto; padding: 14px; font-size: 13px; line-height: 1.5; color: var(--ai-danger); }
#ai-reply-panel .ai-error .ai-icon { margin-top: 2px; }
#ai-reply-panel .ai-error-text { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
#ai-reply-panel .ai-error code { padding: 1px 4px; border-radius: 4px; background: var(--ai-surface-2); color: var(--ai-text); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }

/* Minimized state */
#ai-reply-min-pill { position: fixed; bottom: 24px; right: 24px; z-index: 10000; display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 10px 0 9px; border: 1px solid var(--ai-border); border-radius: 8px; background: var(--ai-surface); box-shadow: 0 4px 12px rgba(31, 35, 40, 0.12); font-weight: 600; cursor: pointer; user-select: none; }
#ai-reply-min-pill:hover { background: var(--ai-surface-2); }
#ai-reply-min-pill .ai-icon:last-child { color: var(--ai-text-3); }

@keyframes ai-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  #ai-reply-panel .ai-spinner { animation-duration: 2.4s; }
  #ai-reply-panel * { transition: none !important; }
}
`;

function ensurePanelStyles() {
  if (document.getElementById("ai-panel-styles")) return;
  const style = document.createElement("style");
  style.id = "ai-panel-styles";
  style.textContent = PANEL_STYLES;
  (document.head || document.documentElement).appendChild(style);
}

function renderPanelHeader({ meta = "", metaClass = "", showMinimize = true } = {}) {
  return `
    <div id="ai-panel-header" class="ai-header">
      <div class="ai-header-title">
        <span class="ai-brand-mark">${icon("sparkle", 11, true)}</span>
        <span class="ai-title">AI Assistant</span>
        ${meta ? `<span class="ai-mode ${metaClass}">${escapeHtml(meta)}</span>` : ""}
      </div>
      <div class="ai-header-actions">
        ${showMinimize ? `<button type="button" id="ai-min-btn" class="ai-header-btn" title="Minimize" aria-label="Minimize">${icon("minus", 14)}</button>` : ""}
        <button type="button" id="ai-close-btn" class="ai-header-btn" title="Close" aria-label="Close">${icon("x", 14)}</button>
      </div>
    </div>
  `;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileExtension(name) {
  const idx = (name || "").lastIndexOf(".");
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
}

// Returns { kind: "image" | "pdf" | "text", mimeType } or null if unsupported
function classifyFile(file) {
  const ext = getFileExtension(file.name);
  const type = (file.type || "").toLowerCase();

  if (IMAGE_MIME_TYPES[type]) return { kind: "image", mimeType: IMAGE_MIME_TYPES[type] };
  if (!type && IMAGE_EXTENSIONS[ext]) return { kind: "image", mimeType: IMAGE_EXTENSIONS[ext] };
  if (type === "application/pdf" || ext === "pdf") return { kind: "pdf", mimeType: "application/pdf" };
  if (TEXT_EXTENSIONS[ext]) return { kind: "text", mimeType: TEXT_EXTENSIONS[ext] };
  if (TEXT_MIME_TYPES.includes(type)) return { kind: "text", mimeType: type };
  return null;
}

function readBlobAsDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("could not read file"));
    reader.readAsDataURL(blob);
  });
}

// Downscale large images before sending them to the model (keeps requests fast
// and within provider limits). The ORIGINAL file is still what gets attached to Gmail.
async function prepareImageForModel(file, mimeType) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (err) {
    throw new Error("image could not be decoded");
  }

  const { width, height } = bitmap;
  const scale = Math.min(1, ATTACH_LIMITS.maxImageDim / Math.max(width, height));

  if (scale === 1 && file.size <= ATTACH_LIMITS.maxImageBytesUnscaled) {
    bitmap.close();
    return readBlobAsDataURL(new Blob([file], { type: mimeType }));
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; // JPEG has no alpha; avoid black backgrounds on transparent PNGs
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

async function processAttachment(item) {
  if (item.kind === "image") {
    item.dataUrl = await prepareImageForModel(item.file, item.mimeType);
  } else if (item.kind === "pdf") {
    // Force the correct MIME prefix even if the browser reported an empty type
    item.dataUrl = await readBlobAsDataURL(new Blob([item.file], { type: "application/pdf" }));
  } else {
    let text = await item.file.text();
    if (text.length > ATTACH_LIMITS.maxTextChars) {
      text = text.slice(0, ATTACH_LIMITS.maxTextChars);
      item.truncated = true;
    }
    item.text = text;
  }
  item.status = "ready";
}

function addAttachments(fileList) {
  const incoming = Array.from(fileList || []).filter(Boolean);
  if (incoming.length === 0) return;

  const errors = [];
  for (const file of incoming) {
    if (attachedFiles.length >= ATTACH_LIMITS.maxFiles) {
      errors.push(`You can attach up to ${ATTACH_LIMITS.maxFiles} files.`);
      break;
    }
    const info = classifyFile(file);
    if (!info) {
      errors.push(`"${file.name}" isn't supported (use images, PDF, TXT, CSV, MD or JSON).`);
      continue;
    }
    if (file.size === 0) {
      errors.push(`"${file.name}" is empty.`);
      continue;
    }
    if (file.size > ATTACH_LIMITS.maxFileBytes) {
      errors.push(`"${file.name}" is larger than ${formatBytes(ATTACH_LIMITS.maxFileBytes)}.`);
      continue;
    }
    const totalBytes = attachedFiles.reduce((sum, a) => sum + a.size, 0);
    if (totalBytes + file.size > ATTACH_LIMITS.maxTotalBytes) {
      errors.push(`Adding "${file.name}" would exceed Gmail's 25 MB attachment limit.`);
      continue;
    }
    const isDuplicate = attachedFiles.some(
      (a) => a.name === file.name && a.size === file.size && a.file.lastModified === file.lastModified
    );
    if (isDuplicate) continue;

    const item = {
      id: `att-${++attachIdCounter}`,
      file,
      name: file.name,
      size: file.size,
      kind: info.kind,
      mimeType: info.mimeType,
      status: "processing",
      dataUrl: null,
      text: null,
      truncated: false,
      attachedTo: new WeakSet(), // compose boxes this file has already been attached to
      ready: null
    };
    item.ready = processAttachment(item)
      .catch((err) => {
        attachedFiles = attachedFiles.filter((a) => a !== item);
        showAttachMessage(`Couldn't read "${item.name}": ${err.message}`, "error");
      })
      .finally(renderAttachmentList);
    attachedFiles.push(item);
  }

  renderAttachmentList();
  showAttachMessage(errors.join(" "), "error");
}

function removeAttachment(id) {
  attachedFiles = attachedFiles.filter((a) => a.id !== id);
  renderAttachmentList();
  showAttachMessage("");
}

function clearAttachments() {
  attachedFiles = [];
}

function hasDraggedFiles(e) {
  return Boolean(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files"));
}

function showAttachMessage(message, type = "error") {
  const el = document.getElementById("ai-attach-msg");
  if (!el) return;
  if (!message) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  const colors = { error: "#cf222e", warn: "#9a6700", success: "#1a7f37" };
  el.style.color = colors[type] || colors.error;
  el.textContent = message;
  el.style.display = "block";
}

function renderAttachmentSection() {
  return `
    <div id="ai-attach-section" class="ai-section">
      <div class="ai-attach-row">
        <button type="button" id="ai-attach-btn" class="ai-btn ai-btn-ghost" title="Attach files or photos">${icon("paperclip", 14)}Attach files / photos</button>
        <label class="ai-check" title="When you click Insert, also attach these files to the Gmail message">
          <input type="checkbox" id="ai-attach-to-email" ${attachToEmail ? "checked" : ""}>Also attach to email
        </label>
      </div>
      <input type="file" id="ai-attach-input" multiple accept="${ATTACH_ACCEPT}" style="display: none;">
      <div id="ai-attach-hint" class="ai-attach-hint">Drop or paste (Ctrl+V) here · Images, PDF, TXT, CSV, MD, JSON · up to ${ATTACH_LIMITS.maxFiles} files, ${formatBytes(ATTACH_LIMITS.maxFileBytes)} each</div>
      <div id="ai-attach-list" class="ai-attach-list"></div>
      <div id="ai-attach-msg" class="ai-attach-msg" role="status" aria-live="polite" style="display: none;"></div>
    </div>
  `;
}

// Built with DOM APIs (not innerHTML) so file names can never inject markup
function renderAttachmentList() {
  const list = document.getElementById("ai-attach-list");
  if (!list) return;
  list.textContent = "";
  const activeBox = getActiveComposeBox();

  attachedFiles.forEach((item) => {
    const chip = document.createElement("div");
    chip.className = "ai-attach-chip";

    if (item.kind === "image" && item.dataUrl) {
      const img = document.createElement("img");
      img.src = item.dataUrl;
      img.alt = "";
      img.className = "ai-attach-thumb";
      chip.appendChild(img);
    } else {
      const thumb = document.createElement("span");
      thumb.className = "ai-attach-thumb";
      // Static icon markup only; the file name is never put through innerHTML
      thumb.innerHTML = icon(item.kind === "image" ? "image" : item.kind === "pdf" ? "file" : "fileText", 14);
      chip.appendChild(thumb);
    }

    const meta = document.createElement("div");
    meta.className = "ai-attach-meta";
    const nameEl = document.createElement("span");
    nameEl.className = "ai-attach-name";
    nameEl.textContent = item.name;
    nameEl.title = item.name;
    const sub = document.createElement("span");
    sub.className = "ai-attach-sub";
    if (item.status === "processing") {
      sub.textContent = "Processing…";
    } else {
      let label = formatBytes(item.size);
      if (item.truncated) label += " · truncated for AI";
      if (activeBox && item.attachedTo.has(activeBox)) {
        label += " · ✓ in email";
        sub.classList.add("is-attached");
      }
      sub.textContent = label;
    }
    meta.appendChild(nameEl);
    meta.appendChild(sub);
    chip.appendChild(meta);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "ai-attach-remove";
    removeBtn.innerHTML = icon("x", 12);
    removeBtn.title = "Remove (does not remove it from an email it was already attached to)";
    removeBtn.setAttribute("aria-label", `Remove ${item.name}`);
    removeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeAttachment(item.id);
    });
    chip.appendChild(removeBtn);

    list.appendChild(chip);
  });

  const hint = document.getElementById("ai-attach-hint");
  if (hint) hint.style.display = attachedFiles.length ? "none" : "block";
}

function bindAttachmentControls() {
  const input = document.getElementById("ai-attach-input");
  document.getElementById("ai-attach-btn")?.addEventListener("click", (e) => {
    e.preventDefault();
    input?.click();
  });
  input?.addEventListener("change", () => {
    addAttachments(input.files);
    input.value = ""; // allow picking the same file again after removing it
  });
  document.getElementById("ai-attach-to-email")?.addEventListener("change", (e) => {
    attachToEmail = e.target.checked;
  });
  renderAttachmentList();
}

function getActiveComposeBox() {
  // Prefer the compose box the panel was opened from, as long as it's still on the page
  if (activeComposeBox && activeComposeBox.isConnected && activeComposeBox.getBoundingClientRect().width > 0) {
    return activeComposeBox;
  }
  const composeBoxes = document.querySelectorAll('div[aria-label="Message Body"][role="textbox"]');
  for (const box of composeBoxes) {
    if (box.getBoundingClientRect().width > 0) return box;
  }
  return null;
}

// Walk up from the message body to the element that also contains this compose's Send button
function getComposeRoot(box) {
  let node = box;
  while (node && node !== document.body) {
    if (node.querySelector('div[role="button"][aria-label^="Send"]')) return node;
    node = node.parentElement;
  }
  return box.parentElement || box;
}

const QUOTED_HISTORY_SELECTORS = ".gmail_quote, .gmail_quote_container, .gmail_extra";
const SIGNATURE_SELECTORS = ".gmail_signature, [data-smartmail='gmail_signature']";

// Visible text of an element with the matching descendants removed. The clone is
// attached off-screen while reading because innerText on a detached node loses
// its line breaks. (opacity, not visibility: innerText skips visibility:hidden text.)
function getVisibleTextWithout(element, removeSelectors) {
  if (!element) return "";
  const clone = element.cloneNode(true);
  if (removeSelectors) {
    clone.querySelectorAll(removeSelectors).forEach((node) => node.remove());
  }
  // Don't let the temporary clone look like another compose box to Gmail or to us
  ["id", "role", "aria-label", "contenteditable"].forEach((attr) => clone.removeAttribute(attr));
  clone.setAttribute("aria-hidden", "true");

  const width = element.getBoundingClientRect().width;
  const styles = { position: "fixed", left: "-100000px", top: "0", opacity: "0", "pointer-events": "none" };
  if (width > 0) styles.width = `${width}px`;
  Object.entries(styles).forEach(([prop, value]) => clone.style.setProperty(prop, value, "important"));

  (document.body || document.documentElement).appendChild(clone);
  try {
    return (clone.innerText || "").trim();
  } finally {
    clone.remove();
  }
}

// Only what the user (or the AI) wrote in a compose box: no quoted thread, signature or blockquotes
function getUserAuthoredText(box) {
  return getVisibleTextWithout(box, `${QUOTED_HISTORY_SELECTORS}, ${SIGNATURE_SELECTORS}, blockquote`);
}

function countComposeAttachments(root, box) {
  const fileChips = root.querySelectorAll(
    'input[name="attach"], [aria-label^="Attachment"], [aria-label*="attachment" i], div.dL'
  ).length;
  const inlineImages = Array.from(box.querySelectorAll("img")).filter(
    (img) => !img.closest(".gmail_signature, .gmail_quote")
  ).length;
  return fileChips + inlineImages;
}

async function waitForComposeAttachments(root, box, before, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (countComposeAttachments(root, box) > before) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// Gmail's hidden file input often sits a few levels above the message body's
// compose root, so start at the compose dialog and walk up (max 4 parents, never past <body>)
function getAttachmentContainer(box) {
  const start = box.closest('div[role="dialog"]') || getComposeRoot(box);
  let node = start;
  for (let i = 0; i <= 4 && node && node !== document.body; i++) {
    if (node.querySelector('input[type="file"]')) return node;
    node = node.parentElement;
  }
  return start;
}

// Attach the panel's files to the currently open Gmail compose window
async function attachFilesToGmailCompose() {
  const box = getActiveComposeBox();
  if (!box) return { status: "error", message: "No open Gmail compose window to attach files to." };

  await Promise.allSettled(attachedFiles.map((a) => a.ready));
  const pending = attachedFiles.filter((a) => a.status === "ready" && !a.attachedTo.has(box));
  if (pending.length === 0) return { status: "noop" };

  const root = getAttachmentContainer(box);
  const before = countComposeAttachments(root, box);
  const dt = new DataTransfer();
  pending.forEach((a) => dt.items.add(a.file));

  let delivered = false;
  // Strategy 1: Gmail's own file input inside this compose window
  const fileInput = root.querySelector('input[type="file"]');
  if (fileInput) {
    try {
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      delivered = true;
    } catch (err) {
      console.warn("Attaching via Gmail file input failed, falling back to drop:", err);
    }
  }
  // Strategy 2: simulate a drag-and-drop onto the compose body (handled natively by Gmail)
  if (!delivered) {
    ["dragenter", "dragover", "drop"].forEach((type) => {
      box.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
  }

  const confirmed = await waitForComposeAttachments(root, box, before, 5000);
  const n = pending.length;
  const label = `${n} file${n > 1 ? "s" : ""}`;
  if (confirmed) {
    // Mark as attached so clicking Insert again doesn't add duplicates
    pending.forEach((a) => a.attachedTo.add(box));
    return { status: "success", message: `Attached ${label} to the email.` };
  }
  return {
    status: "warn",
    message: `Sent ${label} to Gmail but couldn't confirm the upload. Check the compose window; if they're missing, click Insert again or use Gmail's attach button.`
  };
}

function closePanel() {
  // Invalidate any in-flight generation so its response is ignored
  panelRequestId++;
  document.getElementById("ai-reply-panel")?.remove();
  document.getElementById("ai-reply-min-pill")?.remove();
  clearAttachments();
}

// The signed-in address, read from the Gmail tab title ("Inbox (3) - name@example.com - Gmail")
function getOwnEmailAddress() {
  const matches = document.title.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  return matches ? matches[matches.length - 1].toLowerCase() : "";
}

function isThreadOnScreen() {
  return Array.from(document.querySelectorAll("h2.hP, .a3s")).some((el) => el.getBoundingClientRect().width > 0);
}

function getThreadDetails(composeBox) {
  const dialog = composeBox ? composeBox.closest('div[role="dialog"]') : null;

  // 1. Subject from this compose dialog's subject field, if it has one
  let subject = dialog?.querySelector('input[name="subjectbox"]')?.value.trim() || "";

  // 2. Reply or brand-new email?
  const quotedInCompose = composeBox ? composeBox.querySelector(QUOTED_HISTORY_SELECTORS) : null;
  const isReply =
    Boolean(quotedInCompose) ||
    /^(re|aw|sv)\s*:/i.test(subject) ||
    (Boolean(composeBox) && !dialog && isThreadOnScreen());

  if (!isReply) {
    return { subject, senderName: "", threadText: "", isNewCompose: true };
  }

  if (!subject) {
    subject = document.querySelector("h2.hP")?.innerText.trim() || "";
  }

  // 3. Last 3 message bodies on the page, without their quoted history and signatures
  const bodies = Array.from(document.querySelectorAll(".a3s.aiL, .a3s")).slice(-3);
  const messages = [];
  bodies.forEach((bodyEl) => {
    const container = bodyEl.closest(".adn, .gE, .gs, div[role='listitem']");
    const senderEl = container ? container.querySelector("span.gD, .gD") : null;
    const name = senderEl ? (senderEl.getAttribute("name") || senderEl.innerText.trim()) : "";
    const email = (senderEl?.getAttribute("email") || "").trim();
    const text = getVisibleTextWithout(bodyEl, `${QUOTED_HISTORY_SELECTORS}, ${SIGNATURE_SELECTORS}`);
    if (!text) return;

    let label = name;
    if (email && !label.includes(email)) label = label ? `${label} <${email}>` : email;
    messages.push({ name, email: email.toLowerCase(), label, text });
  });

  let threadText = messages
    .map((m) => (m.label ? `[From: ${m.label}]:\n${m.text}` : m.text))
    .join("\n\n---\n\n");

  // Pop-out replies don't show the thread on the page; use the quote inside the compose box
  if (!threadText && quotedInCompose) {
    threadText = getVisibleTextWithout(quotedInCompose, "");
  }
  threadText = threadText.slice(-12000);

  // 4. Reply to the most recent message that wasn't sent by the user
  const ownEmail = getOwnEmailAddress();
  const replyTo =
    [...messages].reverse().find((m) => !ownEmail || m.email !== ownEmail) ||
    messages[messages.length - 1];
  const senderName = replyTo ? (replyTo.name || replyTo.email) : "";

  return {
    subject,
    senderName,
    threadText: threadText || "No email content found.",
    isNewCompose: false
  };
}

function closePanelIfNoComposeBox() {
  const composeBoxes = document.querySelectorAll('div[aria-label="Message Body"][role="textbox"]');
  const panel = document.getElementById("ai-reply-panel");
  const minPill = document.getElementById("ai-reply-min-pill");

  if (panel || minPill) {
    let anyVisible = false;
    composeBoxes.forEach((box) => {
      if (box.getBoundingClientRect().width > 0) {
        anyVisible = true;
      }
    });

    if (!anyVisible) {
      closePanel();
    }
  }
}

function insertIntoComposeBox(text, intent) {
  const box = getActiveComposeBox();
  if (!box) return false;
  const draft = String(text ?? "");

  // Keep the signature, quoted thread and inline images (e.g. photos attached from
  // the AI panel). The actual nodes are moved, not copied as HTML, so re-inserting
  // or clearing the draft doesn't delete them or break Gmail's references to them.
  const candidates = Array.from(
    box.querySelectorAll(`${SIGNATURE_SELECTORS}, ${QUOTED_HISTORY_SELECTORS}, img`)
  );
  const preserved = candidates.filter(
    (node) => !candidates.some((other) => other !== node && other.contains(node))
  );

  const fragment = document.createDocumentFragment();
  if (draft) {
    // Escape before adding line breaks so the draft can't inject markup into the email
    const template = document.createElement("template");
    template.innerHTML = escapeHtml(draft).replace(/\r?\n/g, "<br>");
    fragment.appendChild(template.content);
  }
  if (preserved.length > 0) {
    fragment.appendChild(document.createElement("br"));
    fragment.appendChild(document.createElement("br"));
    preserved.forEach((node) => {
      fragment.appendChild(node); // moves the node, in original document order
      if (node.tagName === "IMG") fragment.appendChild(document.createElement("br"));
    });
  }

  box.replaceChildren(fragment);
  box.dispatchEvent(new Event("input", { bubbles: true }));

  // Store draft and intent on the compose box for Phase 2 learning
  box.dataset.aiDraft = draft;
  box.dataset.aiIntent = intent || "Unknown";
  return true;
}

function expandPanel() {
  document.getElementById("ai-reply-min-pill")?.remove();
  const panel = document.getElementById("ai-reply-panel");
  if (panel) panel.style.display = "";
  else togglePanel();
}

function createMinimizedPill() {
  ensurePanelStyles();
  if (document.getElementById("ai-reply-min-pill")) return;

  const minPill = document.createElement("div");
  minPill.id = "ai-reply-min-pill";
  minPill.setAttribute("role", "button");
  minPill.tabIndex = 0;
  minPill.title = "Expand AI Assistant";
  minPill.setAttribute("aria-label", "Expand AI Assistant");
  minPill.innerHTML = `
    <span class="ai-brand-mark">${icon("sparkle", 11, true)}</span>
    <span>AI Assistant</span>
    ${icon("chevronUp", 14)}
  `;

  minPill.addEventListener("click", () => expandPanel());
  minPill.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      expandPanel();
    }
  });

  document.body.appendChild(minPill);
}

// ---------------------------------------------------------------------------
// Panel: open/close, generation and rendering
// ---------------------------------------------------------------------------
const TONE_OPTIONS = [
  ["", "Tone: Default"], ["Professional", "Professional"], ["Friendly", "Friendly"],
  ["Direct", "Direct"], ["Casual", "Casual"]
];
const LENGTH_OPTIONS = [
  ["", "Length: Default"], ["Short", "Short"], ["Medium", "Medium"], ["Detailed", "Detailed"]
];

function renderSelectOptions(options, selected) {
  return options
    .map(([value, label]) =>
      `<option value="${escapeHtml(value)}"${(selected || "") === value ? " selected" : ""}>${escapeHtml(label)}</option>`
    )
    .join("");
}

function togglePanel() {
  const panel = document.getElementById("ai-reply-panel");
  const minPill = document.getElementById("ai-reply-min-pill");

  if (minPill || (panel && panel.style.display === "none")) {
    expandPanel();
    return;
  }
  if (panel) {
    closePanel();
    return;
  }
  if (!getActiveComposeBox()) return;

  createPanelShell();
  generateReply();
}

// Entry point for the AI Reply button and the keyboard shortcut
function launchPanel(composeBox) {
  if (composeBox) {
    const panelOpen = document.getElementById("ai-reply-panel") || document.getElementById("ai-reply-min-pill");
    if (panelOpen && activeComposeBox !== composeBox) closePanel();
    activeComposeBox = composeBox;
  }
  togglePanel();
}

function createPanelShell() {
  ensurePanelStyles();

  const panel = document.createElement("div");
  panel.id = "ai-reply-panel";
  panel.style.position = "fixed";
  panel.style.top = "70px";
  panel.style.right = "24px";
  panel.style.width = "360px";
  panel.style.zIndex = "9999";
  panel.style.overflow = "hidden";

  // Header dragging. Document listeners exist only while a drag is in progress.
  panel.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const header = e.target.closest("#ai-panel-header");
    if (!header || e.target.closest(".ai-header-btn")) return;
    e.preventDefault();

    const rect = panel.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    const drag = new AbortController();

    document.addEventListener("mousemove", (ev) => {
      const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
      const left = Math.min(Math.max(0, ev.clientX - offsetX), maxLeft);
      const top = Math.min(Math.max(0, ev.clientY - offsetY), maxTop);
      panel.style.right = "auto";
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    }, { signal: drag.signal });

    document.addEventListener("mouseup", () => drag.abort(), { signal: drag.signal });
  });

  // Drag & drop files onto the panel. stopPropagation keeps Gmail's own
  // compose drop-zone from also grabbing the files.
  const resetDropHighlight = () => { panel.style.outline = ""; };
  ["dragenter", "dragover"].forEach((type) => {
    panel.addEventListener(type, (e) => {
      if (!hasDraggedFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      panel.style.outline = "2px dashed #6366f1";
    });
  });
  panel.addEventListener("dragleave", (e) => {
    if (!panel.contains(e.relatedTarget)) resetDropHighlight();
  });
  panel.addEventListener("drop", (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    resetDropHighlight();
    addAttachments(e.dataTransfer.files);
  });

  // Paste screenshots / copied files while focus is inside the panel
  panel.addEventListener("paste", (e) => {
    const items = Array.from(e.clipboardData?.items || []).filter((i) => i.kind === "file");
    if (items.length === 0) return; // normal text paste
    e.preventDefault();
    e.stopPropagation();
    const stamp = Date.now();
    const files = items
      .map((i) => i.getAsFile())
      .filter(Boolean)
      .map((f, idx) => {
        // Clipboard images usually arrive as a generic "image.png"; give them unique names
        if (f.name && f.name !== "image.png") return f;
        const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
        return new File([f], `pasted-image-${stamp}-${idx + 1}.${ext}`, { type: f.type, lastModified: stamp });
      });
    addAttachments(files);
  });

  document.body.appendChild(panel);
  return panel;
}

function bindPanelHeader(panel) {
  panel.querySelector("#ai-close-btn")?.addEventListener("click", () => closePanel());
  panel.querySelector("#ai-min-btn")?.addEventListener("click", () => {
    panel.style.display = "none";
    createMinimizedPill();
  });
}

function renderLoadingView(panel, isNewCompose) {
  const n = attachedFiles.length;
  const message = n ? `Analyzing context and ${n} attachment${n > 1 ? "s" : ""}…` : "Drafting…";
  panel.innerHTML = `
    ${renderPanelHeader({ meta: isNewCompose ? "New email" : "Reply" })}
    <div class="ai-loading" role="status" aria-live="polite">
      <span class="ai-spinner"></span>
      <span>${escapeHtml(message)}</span>
    </div>
  `;
  bindPanelHeader(panel);
}

function renderErrorView(panel, message) {
  panel.innerHTML = `
    ${renderPanelHeader({ meta: "Error", metaClass: "is-error" })}
    <div class="ai-error" role="alert">
      ${icon("alertCircle", 16)}
      <div class="ai-error-text">${escapeHtml(message)}</div>
    </div>
    <div class="ai-footer">
      <button type="button" id="ai-retry-btn" class="ai-btn ai-btn-secondary">${icon("refresh", 14)}Try again</button>
    </div>
  `;
  bindPanelHeader(panel);
  panel.querySelector("#ai-retry-btn")?.addEventListener("click", (e) => {
    e.preventDefault();
    generateReply(lastGenerateOptions);
  });
}

async function generateReply(options = {}) {
  const {
    toneOverride = null,
    lengthOverride = null,
    userInstructions = "",
    contextOverride = null
  } = options;
  lastGenerateOptions = { toneOverride, lengthOverride, userInstructions, contextOverride };
  const requestId = ++panelRequestId;
  const isStale = () => requestId !== panelRequestId || !document.getElementById("ai-reply-panel");

  const panel = document.getElementById("ai-reply-panel") || createPanelShell();
  const threadInfo = getThreadDetails(getActiveComposeBox());
  const emailContent = contextOverride || threadInfo.threadText;
  renderLoadingView(panel, threadInfo.isNewCompose);

  try {
    // Make sure every attachment has finished processing before sending
    await Promise.allSettled(attachedFiles.map((a) => a.ready));
    if (isStale()) return;

    const aiAttachments = attachedFiles
      .filter((a) => a.status === "ready")
      .map((a) => ({
        name: a.name,
        kind: a.kind,
        mimeType: a.mimeType,
        size: a.size,
        dataUrl: a.kind === "text" ? undefined : a.dataUrl,
        text: a.kind === "text" ? a.text : undefined,
        truncated: a.truncated
      }));

    const response = await chrome.runtime.sendMessage({
      type: "GENERATE_REPLY",
      emailContent: emailContent,
      tone: toneOverride,
      length: lengthOverride,
      userInstructions: userInstructions,
      subject: threadInfo.subject,
      senderName: threadInfo.senderName,
      isNewCompose: threadInfo.isNewCompose,
      attachments: aiAttachments,
      attachToEmail: attachToEmail
    });

    // A newer request started, or the panel was closed, while we were waiting
    if (isStale()) return;

    if (!response || response.error) {
      renderErrorView(panel, response?.error || "No response from the extension's background worker.");
      return;
    }

    renderResult(panel, response.reply, threadInfo, {
      toneOverride,
      lengthOverride,
      userInstructions,
      contextOverride,
      emailContent
    });
  } catch (error) {
    if (isStale()) return;
    console.error("Error communicating with background:", error);
    renderErrorView(
      panel,
      "Couldn't reach the extension's background worker. Reload the extension on chrome://extensions, then refresh Gmail."
    );
  }
}

function renderResult(panel, reply, threadInfo, ctx) {
  const { toneOverride, lengthOverride, userInstructions, contextOverride, emailContent } = ctx;

  const data = typeof reply === "string" ? { draft: reply } : (reply && typeof reply === "object" ? reply : {});
  const intent = typeof data.intent === "string" && data.intent.trim() ? data.intent : "general";
  const draft = typeof data.draft === "string" ? data.draft : "";
  const missingInfo = Array.isArray(data.missing_info)
    ? data.missing_info.filter((q) => typeof q === "string" && q.trim())
    : [];

  if (!draft.trim() && missingInfo.length === 0) {
    renderErrorView(panel, "The AI returned an empty draft. Try again, or pick a different model in Settings.");
    return;
  }

  const modeLabel = threadInfo.isNewCompose ? "New email" : "Reply";
  const subject = threadInfo.subject || "(No subject)";
  const recipientLine = threadInfo.senderName
    ? `To ${threadInfo.senderName}`
    : (threadInfo.isNewCompose ? "New message" : "");

  let body = `
    <div class="ai-context">
      <div class="ai-context-text">
        <div class="ai-subject" title="${escapeHtml(subject)}">${escapeHtml(subject)}</div>
        ${recipientLine ? `<div class="ai-recipient" title="${escapeHtml(recipientLine)}">${escapeHtml(recipientLine)}</div>` : ""}
      </div>
      <span class="ai-intent" title="${escapeHtml(intent)}">${escapeHtml(formatIntent(intent))}</span>
    </div>
  `;
  let footer = "";

  if (missingInfo.length > 0) {
    body += `
      <div class="ai-notice">${icon("alert", 14)}<span>A few details are needed to write this</span></div>
      ${missingInfo.map((question, idx) => `
        <div class="ai-field">
          <label class="ai-label" for="missing-info-${idx}">${escapeHtml(question)}</label>
          <input type="text" id="missing-info-${idx}" class="ai-input" autocomplete="off">
        </div>
      `).join("")}
      ${renderAttachmentSection()}
      <button type="button" id="ai-regenerate-btn" class="ai-btn ai-btn-primary ai-btn-block">Answer &amp; regenerate</button>
    `;
  } else {
    const chips = QUICK_ACTIONS.map((action) => `
      <button type="button" class="ai-chip" data-prompt="${escapeHtml(action.prompt)}" title="${escapeHtml(action.prompt)}">${icon(action.icon, 12)}${escapeHtml(action.label)}</button>
    `).join("");

    body += `
      <div class="ai-section">
        <input type="text" id="ai-user-instructions" class="ai-input" value="${escapeHtml(userInstructions)}" placeholder="Instructions (e.g. 'Politely decline', 'Propose Friday')" aria-label="Instructions for the AI" autocomplete="off">
        <div class="ai-quick">${chips}</div>
      </div>
      ${renderAttachmentSection()}
      <div class="ai-controls">
        <select id="ai-override-tone" class="ai-select" aria-label="Tone">${renderSelectOptions(TONE_OPTIONS, toneOverride)}</select>
        <select id="ai-override-length" class="ai-select" aria-label="Length">${renderSelectOptions(LENGTH_OPTIONS, lengthOverride)}</select>
        <button type="button" id="ai-re-roll-btn" class="ai-icon-btn" title="Regenerate draft" aria-label="Regenerate draft">${icon("refresh", 14)}</button>
      </div>
      <div id="ai-draft-text" class="ai-draft" contenteditable="plaintext-only" role="textbox" aria-multiline="true" aria-label="Draft (editable)" spellcheck="true">${escapeHtml(draft)}</div>
    `;
    footer = `
      <div class="ai-footer">
        <button type="button" id="ai-insert-btn" class="ai-btn ai-btn-primary">Insert into Gmail</button>
        <button type="button" id="ai-copy-btn" class="ai-btn ai-btn-secondary" title="Copy to clipboard">${icon("copy", 14)}<span>Copy</span></button>
        <button type="button" id="ai-clear-btn" class="ai-btn ai-btn-tertiary" title="Clear the compose box">Clear</button>
      </div>
    `;
  }

  panel.innerHTML = `
    ${renderPanelHeader({ meta: modeLabel })}
    <div class="ai-body">${body}</div>
    ${footer}
  `;

  bindPanelHeader(panel);
  bindAttachmentControls();

  if (missingInfo.length > 0) {
    panel.querySelector("#ai-regenerate-btn")?.addEventListener("click", (e) => {
      e.preventDefault();
      const answers = [];
      missingInfo.forEach((question, idx) => {
        const value = panel.querySelector(`#missing-info-${idx}`)?.value.trim();
        if (value) answers.push(`Q: ${question}\nA: ${value}`);
      });

      let newContent = emailContent;
      if (answers.length > 0) {
        newContent += "\n\nUser provided additional info for the reply:\n" + answers.join("\n");
      }

      // Attached files are sent automatically with the regenerate request
      generateReply({ toneOverride, lengthOverride, userInstructions, contextOverride: newContent });
    });
    return;
  }

  const rerun = (instructions) => {
    const tone = panel.querySelector("#ai-override-tone")?.value || null;
    const length = panel.querySelector("#ai-override-length")?.value || null;
    const instr = instructions ?? (panel.querySelector("#ai-user-instructions")?.value.trim() || "");
    generateReply({ toneOverride: tone, lengthOverride: length, userInstructions: instr, contextOverride });
  };

  // Quick action chips supply their own instruction text
  panel.querySelectorAll(".ai-chip").forEach((chip) => {
    chip.addEventListener("click", (e) => {
      e.preventDefault();
      const promptText = chip.getAttribute("data-prompt") || "";
      const input = panel.querySelector("#ai-user-instructions");
      if (input) input.value = promptText;
      rerun(promptText);
    });
  });

  panel.querySelector("#ai-user-instructions")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      rerun();
    }
  });

  panel.querySelector("#ai-re-roll-btn")?.addEventListener("click", (e) => {
    e.preventDefault();
    rerun();
  });

  // Insert: put the (possibly edited) draft in the compose box, then optionally attach the files
  panel.querySelector("#ai-insert-btn")?.addEventListener("click", async (e) => {
    e.preventDefault();
    const box = getActiveComposeBox();
    if (!box) {
      showAttachMessage("No open Gmail compose window to insert into.", "error");
      return;
    }

    const draftText = panel.querySelector("#ai-draft-text")?.innerText || "";
    const normalize = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const existing = normalize(getUserAuthoredText(box));
    if (existing && existing !== normalize(box.dataset.aiDraft)) {
      const ok = window.confirm("Replace the text you've already written in this email with the AI draft?");
      if (!ok) return;
    }

    if (!insertIntoComposeBox(draftText, intent)) {
      showAttachMessage("No open Gmail compose window to insert into.", "error");
      return;
    }

    if (attachToEmail && attachedFiles.length > 0) {
      showAttachMessage("Attaching files to the email…", "warn");
      const result = await attachFilesToGmailCompose();
      if (result.status === "noop") showAttachMessage("");
      else showAttachMessage(result.message, result.status);
      renderAttachmentList();
    }
  });

  // Copy to clipboard
  let copyResetTimer = null;
  panel.querySelector("#ai-copy-btn")?.addEventListener("click", async (e) => {
    e.preventDefault();
    const btn = e.currentTarget;
    const draftText = panel.querySelector("#ai-draft-text")?.innerText || "";
    try {
      await navigator.clipboard.writeText(draftText);
      btn.innerHTML = `${icon("check", 14)}<span>Copied</span>`;
      clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => {
        btn.innerHTML = `${icon("copy", 14)}<span>Copy</span>`;
      }, 1800);
    } catch (err) {
      showAttachMessage("Couldn't copy to the clipboard. Select the draft and copy it manually.", "error");
    }
  });

  // Clear the compose box (signature, quoted thread and inline images are kept)
  panel.querySelector("#ai-clear-btn")?.addEventListener("click", (e) => {
    e.preventDefault();
    if (!insertIntoComposeBox("", intent)) {
      showAttachMessage("No open Gmail compose window to clear.", "error");
    }
  });
}

// ---------------------------------------------------------------------------
// Compose boxes: AI Reply button + learning capture
// ---------------------------------------------------------------------------

// Send the AI draft vs. the final sent text for Phase 2 Levenshtein learning
function sendLearningCapture(box) {
  const draft = box.dataset.aiDraft;
  if (!draft) return;

  const payload = {
    intent: box.dataset.aiIntent || "Unknown",
    draft: draft,
    finalText: getUserAuthoredText(box),
    timestamp: Date.now()
  };
  try {
    chrome.runtime.sendMessage({ type: "LEARNING_CAPTURE", payload }).catch(() => {});
  } catch (err) {
    // Extension context invalidated (e.g. the extension was reloaded); nothing to do
  }
  // Prevent capturing the same draft twice (e.g. mousedown followed by Ctrl+Enter)
  delete box.dataset.aiDraft;
}

function scanForComposeBoxes() {
  const composeBoxes = document.querySelectorAll('div[aria-label="Message Body"][role="textbox"]');

  composeBoxes.forEach((box) => {
    if (box.getAttribute("data-ai-reply-processed")) {
      return;
    }

    const root = getComposeRoot(box);
    const sendBtn = root.querySelector('div[role="button"][aria-label^="Send"]');
    const sendBtnGroup = sendBtn?.parentElement;
    const toolbar = sendBtnGroup?.parentElement;

    // Toolbar not rendered yet; try again on the next DOM change
    if (!sendBtn || !sendBtnGroup || !toolbar) {
      return;
    }

    sendBtn.addEventListener("mousedown", () => sendLearningCapture(box));
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) sendLearningCapture(box);
    });

    const button = document.createElement("div");
    button.innerText = "✨ AI Reply";
    button.className = "ai-reply-button";
    button.style.border = "1px solid #4F46E5";
    button.style.color = "#4F46E5";
    button.style.borderRadius = "18px";
    button.style.padding = "0 14px";
    button.style.height = "36px";
    button.style.marginRight = "10px";
    button.style.cursor = "pointer";
    button.style.display = "inline-flex";
    button.style.alignItems = "center";
    button.style.fontWeight = "600";
    button.style.fontSize = "13px";
    button.style.backgroundColor = "#F5F3FF";
    button.style.transition = "all 0.2s ease";

    button.onmouseover = () => {
      button.style.backgroundColor = "#4F46E5";
      button.style.color = "white";
    };
    button.onmouseout = () => {
      button.style.backgroundColor = "#F5F3FF";
      button.style.color = "#4F46E5";
    };

    toolbar.insertBefore(button, sendBtnGroup);

    button.addEventListener("click", (e) => {
      e.stopPropagation();
      launchPanel(box);
    });

    box.setAttribute("data-ai-reply-processed", "true");
  });
}

// Global Keyboard Shortcut: Alt + R to toggle AI assistant.
// e.code is the physical key, so this also works on macOS where Option+R types "®".
document.addEventListener("keydown", (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.code !== "KeyR") return;
  if (!getActiveComposeBox()) return;
  e.preventDefault();
  const focusedBox = document.activeElement?.closest?.('div[aria-label="Message Body"][role="textbox"]') || null;
  launchPanel(focusedBox);
});

// Batch DOM mutations: scan at most once per animation frame
let scanScheduled = false;
const observer = new MutationObserver(() => {
  if (scanScheduled) return;
  scanScheduled = true;
  requestAnimationFrame(() => {
    scanScheduled = false;
    scanForComposeBoxes();
    closePanelIfNoComposeBox();
  });
});

observer.observe(document.body, { childList: true, subtree: true });
scanForComposeBoxes();
