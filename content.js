// content.js - General-Purpose AI Reply Assistant Content Script
//
// Wrapped in a function so the file can be injected more than once into the same page
// (e.g. after the extension is reloaded) without "Identifier has already been declared" errors.
// If a copy that is still connected to the extension is already running, the new copy exits;
// a stale copy left over from before a reload is disconnected and is simply replaced.
(() => {
  const isAlive = () => {
    try { return Boolean(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  };
  if (typeof window.__aiReplyAssistantAlive === "function" && window.__aiReplyAssistantAlive()) {
    return; // a live copy is already running in this page
  }
  window.__aiReplyAssistantAlive = isAlive;


let isSnipping = false;
let currentInstructions = "";
let lastDomText = ""; // text of the most recent snip (used for local reply history)

// Listen for messages from popup or background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "START_PICK") {
    currentInstructions = message.instructions || "";
    startPickMode();
    sendResponse({ started: true });
    return true;
  }

  if (message.type === "START_SNIP") {
    currentInstructions = message.instructions || "";
    startScreenSnip();
    sendResponse({ started: true });
    return true;
  }

  if (message.type === "CAPTURE_DONE") {
    showStatusPill("Analyzing captured screen & generating reply...");
  }

  if (message.type === "REPLY_READY") {
    renderOnScreenReplyCard(message.reply, message.snippetImage, message.interactionId, message.personalization);
  }

  if (message.type === "REPLY_ERROR") {
    renderOnScreenError(message.error);
  }
});

// Keyboard shortcut (Alt+S) is handled by chrome.commands in manifest.json / background.js.
// It is NOT also captured here, because a page-level listener would hijack Alt+S on every site
// (and break typing on keyboards where Alt+S produces a character) and would reuse stale instructions.
// Users can change the shortcut at chrome://extensions/shortcuts.

// ---------------------------------------------------------------------------
// DOM PICK MODE (Alt+S): the main way to choose a message.
// Instead of a screenshot, the user clicks the message on the page and we read the page's
// structure (DOM) directly. This gives the FULL text however long it is, plus its formatting
// (bold, italic, headings, lists), which we pass to the model as "key points".
//
//   1. Hover: the block under the mouse is outlined.      2. Click: that block is "level 1".
//   3. Context levels: level 2, 3, ... are the enclosing elements that add more text
//      (wrappers that add nothing are skipped). The default is 5 levels (Settings).
//   4. The reply card has − / + buttons to narrow or widen the context; the page outline shows
//      exactly what is included.
// ---------------------------------------------------------------------------
let isPicking = false;
let pickSession = null; // { chain: [elements], index, sentIndex, outline } while a picked message's card is open
const MAX_CONTEXT_CHARS = 20000;
const OUR_UI = "#ai-reply-float-card, #ai-pick-ui, .ai-pick-outline, #ai-snip-overlay, #ai-reply-status-pill";
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "CANVAS", "BUTTON", "INPUT", "SELECT", "TEXTAREA",
  "IFRAME", "OBJECT", "TEMPLATE", "HEAD", "META", "LINK", "VIDEO", "AUDIO"]);
const BLOCK_TAGS = new Set(["P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE", "NAV", "BLOCKQUOTE",
  "PRE", "UL", "OL", "LI", "TABLE", "TBODY", "THEAD", "TR", "TD", "TH", "FORM", "FIGURE", "FIGCAPTION", "DL", "DT", "DD",
  "HR", "ADDRESS", "CENTER", "H1", "H2", "H3", "H4", "H5", "H6"]);

const isOurs = (el) => Boolean(el && el.closest && el.closest(OUR_UI));
const textLen = (el) => ((el && el.innerText) || "").trim().length;

// Nearest block-level element (so hovering a bold word selects its paragraph, not the word)
function blockOf(el) {
  let e = el;
  while (e && e !== document.body && e.parentElement) {
    const d = getComputedStyle(e).display;
    if (d && !d.startsWith("inline") && d !== "contents") return e;
    e = e.parentElement;
  }
  return el;
}

// Context levels: the clicked block, then each enclosing element that adds more text
function buildChain(base) {
  const chain = [base];
  let lastLen = textLen(base);
  let e = base.parentElement;
  while (e && e !== document.body && e !== document.documentElement && chain.length < 12) {
    const len = textLen(e);
    if (len > 60000) break;                 // whole-page containers are never useful context
    if (len > lastLen + 10) { chain.push(e); lastLen = len; }
    e = e.parentElement;
  }
  return chain;
}

// Page outline that shows what is selected / hovered
function makeOutline(kind) {
  const box = document.createElement("div");
  box.className = "ai-pick-outline";
  box.style.cssText = `position:fixed;pointer-events:none;z-index:2147483645;border-radius:6px;box-sizing:border-box;
    transition:all .08s ease-out;border:2px ${kind === "chosen" ? "dashed" : "solid"} #3B6BA5;
    background:rgba(59,107,165,${kind === "chosen" ? 0.03 : 0.06});display:none;`;
  const tag = document.createElement("div");
  tag.style.cssText = `position:absolute;top:-22px;left:-2px;background:#3B6BA5;color:#fff;font:600 11px -apple-system,Segoe UI,Roboto,sans-serif;
    padding:3px 8px;border-radius:5px 5px 5px 0;white-space:nowrap;`;
  box.appendChild(tag);
  document.documentElement.appendChild(box);
  return box;
}
function placeOutline(box, el, label) {
  if (!box || !el || !el.isConnected) { if (box) box.style.display = "none"; return; }
  const r = el.getBoundingClientRect();
  box.style.display = r.width && r.height ? "block" : "none";
  box.style.left = `${r.left - 3}px`;
  box.style.top = `${r.top - 3}px`;
  box.style.width = `${r.width + 6}px`;
  box.style.height = `${r.height + 6}px`;
  const tag = box.firstChild;
  tag.textContent = label || "";
  tag.style.display = label ? "block" : "none";
  tag.style.top = r.top < 26 ? "2px" : "-22px"; // keep the label visible at the top of the screen
}

function endPickSession() {
  if (!pickSession) return;
  pickSession.outline?.remove();
  window.removeEventListener("scroll", pickSession.reposition, true);
  window.removeEventListener("resize", pickSession.reposition);
  pickSession = null;
}

function startPickMode() {
  if (isPicking || isSnipping) return;
  isPicking = true;
  document.getElementById("ai-reply-float-card")?.remove();
  cardApi = null;
  endPickSession();
  document.getElementById("ai-reply-status-pill")?.remove();

  const bar = document.createElement("div");
  bar.id = "ai-pick-ui";
  bar.style.cssText = `position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;
    background:#1B2A41;color:#fff;padding:9px 18px;border-radius:10px;box-shadow:0 10px 25px rgba(27,42,65,.35);
    font:500 13px -apple-system,Segoe UI,Roboto,sans-serif;white-space:nowrap;`;
  bar.innerHTML = `Click the message you want to reply to. <span style="opacity:.65;margin-left:10px">Esc to cancel</span>`;
  document.documentElement.appendChild(bar);

  const cursor = document.createElement("style");
  cursor.id = "ai-pick-cursor";
  cursor.textContent = "* { cursor: crosshair !important; }";
  document.documentElement.appendChild(cursor);

  const box = makeOutline("hover");
  let hovered = null;

  const target = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    return el && !isOurs(el) && el !== document.documentElement && el !== document.body ? blockOf(el) : null;
  };
  const onMove = (e) => {
    const b = target(e);
    if (b && b !== hovered) {
      hovered = b;
      placeOutline(box, b, `About ${Math.max(1, Math.round(textLen(b) / 6))} words`);
    }
  };
  // Swallow the page's own reactions to this click (opening links, selecting messages, ...)
  const swallow = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
  const onClick = (e) => {
    swallow(e);
    const b = target(e) || hovered;
    if (!b) return;
    cleanup();
    choosePicked(b);
  };
  const onKey = (e) => {
    if (e.key === "Escape") { swallow(e); cleanup(); }
  };
  const cleanup = () => {
    isPicking = false;
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("mousedown", swallow, true);
    document.removeEventListener("mouseup", swallow, true);
    document.removeEventListener("pointerdown", swallow, true);
    document.removeEventListener("pointerup", swallow, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    bar.remove();
    cursor.remove();
    box.remove();
  };
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("mousedown", swallow, true);
  document.addEventListener("mouseup", swallow, true);
  document.addEventListener("pointerdown", swallow, true);
  document.addEventListener("pointerup", swallow, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
}

async function choosePicked(base) {
  let levels = 5;
  try { levels = (await chrome.storage.sync.get({ contextLevels: 5 })).contextLevels || 5; } catch (e) {}
  const chain = buildChain(base);
  let index = Math.min(Math.max(1, levels) - 1, chain.length - 1);
  while (index > 0 && textLen(chain[index]) > MAX_CONTEXT_CHARS) index--; // never default to a huge container
  const outline = makeOutline("chosen");
  const reposition = () => pickSession && placeOutline(outline, pickSession.chain[pickSession.index], `Reading ${pickSession.index + 1} of ${pickSession.chain.length}`);
  // sentIndex = the level the current reply was written for; -1 = no reply written yet
  pickSession = { chain, index, sentIndex: -1, outline, reposition };
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);
  reposition();

  // Open the card WITHOUT writing yet: the user first checks the context (− / +, outline, Show)
  // and then presses "Write reply". This saves an LLM call whenever the default level is wrong.
  lastDomText = currentPickContext().text;
  renderOnScreenReplyCard("", null, null, null);
}

function currentPickContext() {
  if (!pickSession) return null;
  const el = pickSession.chain[pickSession.index];
  return { ...extractContext(el), level: pickSession.index + 1, levels: pickSession.chain.length };
}

// Reads an element into Markdown-like text: **bold**, _italic_, ## headings, - list items, line breaks.
// Emphasised text (bold, italic, underline, highlight, headings) is also collected as "key points".
function extractContext(root) {
  const out = [];
  const keyPoints = [];
  let size = 0;
  const push = (s) => { if (size <= MAX_CONTEXT_CHARS) { out.push(s); size += s.length; } };
  const newline = () => { if (out.length && !String(out[out.length - 1]).endsWith("\n")) push("\n"); };
  const addKey = (t) => {
    t = String(t || "").replace(/\s+/g, " ").trim();
    if (t.length >= 3 && t.length <= 160 && !keyPoints.some((k) => k.toLowerCase() === t.toLowerCase())) keyPoints.push(t);
  };
  const walk = (node) => {
    if (size > MAX_CONTEXT_CHARS) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent.replace(/[\s ]+/g, " ");
      if (t.trim()) push(t);
      else if (t && out.length && !/[\s]$/.test(out[out.length - 1])) push(" ");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node, tag = el.tagName;
    if (SKIP_TAGS.has(tag) || isOurs(el) || el.getAttribute("aria-hidden") === "true") return;
    if (el.checkVisibility && !el.checkVisibility()) return; // hidden (e.g. collapsed quoted text)
    if (tag === "BR") { push("\n"); return; }
    if (tag === "IMG") { const alt = (el.alt || "").trim(); if (alt && alt.length < 80) push(`[image: ${alt}]`); return; }
    const heading = /^H[1-6]$/.test(tag);
    const block = BLOCK_TAGS.has(tag);
    const fw = el.style && el.style.fontWeight;
    const strong = tag === "B" || tag === "STRONG" || tag === "MARK" || fw === "bold" || (fw && parseInt(fw, 10) >= 600);
    const italic = !strong && (tag === "EM" || tag === "I");
    const underline = tag === "U";
    if (block) newline();
    if (tag === "LI") push("- ");
    if (heading) push("## ");
    const marker = heading ? "" : strong ? "**" : italic ? "_" : "";
    if (marker) push(marker);
    el.childNodes.forEach(walk);
    if (marker) push(marker);
    if (strong || italic || underline || heading) addKey(el.innerText || el.textContent);
    if (block) newline();
  };
  walk(root);
  let text = out.join("")
    .replace(/\*\*\s*\*\*/g, "")
    .replace(/\*\*\s*([^*\n]+?)\s*\*\*/g, "**$1**")
    .replace(/(^|\s)_\s*([^_\n]+?)\s*_(?=\s|$|[.,!?;:])/g, "$1_$2_")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // A "key point" that is (almost) the whole message isn't a highlight
  const total = text.length || 1;
  const keys = keyPoints.filter((k) => k.length < total * 0.5).slice(0, 12);
  const words = text ? text.split(/\s+/).length : 0;
  return { text, keyPoints: keys, words, truncated: size > MAX_CONTEXT_CHARS };
}

// ---------------------------------------------------------------------------
// Screen Snipping Mode (PrtSc-style Dragger)
// ---------------------------------------------------------------------------
function startScreenSnip() {
  if (isSnipping) return;
  isSnipping = true;

  // Remove any previous reply card / picked message while snipping
  document.getElementById("ai-reply-float-card")?.remove();
  cardApi = null;
  endPickSession();
  document.getElementById("ai-reply-status-pill")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "ai-snip-overlay";
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    cursor: crosshair;
    background: rgba(15, 23, 42, 0.35);
    user-select: none;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  `;

  overlay.innerHTML = `
    <div id="ai-snip-bar" style="
      position: fixed;
      top: 24px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 18px;
      background: #1B2A41;
      color: #fff;
      border-radius: 10px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.4);
      font-size: 13px;
      font-weight: 500;
      pointer-events: auto;
      z-index: 2147483647;
    ">
      <span style="display:inline-flex;align-items:center;gap:6px;">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>
        </svg>
        <strong>Drag a rectangle</strong> over the conversation or message to reply to
      </span>
      <span style="opacity:0.6;">•</span>
      <span>Press <kbd style="background:#334155;padding:1px 6px;border-radius:4px;font-size:11px;">Esc</kbd> to cancel</span>
    </div>
  `;

  document.body.appendChild(overlay);

  let startX = 0;
  let startY = 0;
  let dragging = false;
  let snipBox = null;
  let dimBadge = null;

  const cleanup = () => {
    isSnipping = false;
    overlay.remove();
    document.removeEventListener("keydown", onKeyDown, true);
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    }
  };
  document.addEventListener("keydown", onKeyDown, true);

  overlay.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    startX = e.clientX;
    startY = e.clientY;
    dragging = true;

    snipBox = document.createElement("div");
    snipBox.id = "ai-snip-box";
    snipBox.style.cssText = `
      position: fixed;
      left: ${startX}px;
      top: ${startY}px;
      width: 0px;
      height: 0px;
      border: 2px dashed #3B6BA5;
      background: rgba(59, 107, 165, 0.08);
      box-shadow: 0 0 0 9999px rgba(15, 23, 42, 0.45);
      pointer-events: none;
      border-radius: 4px;
      z-index: 2147483647;
    `;

    dimBadge = document.createElement("div");
    dimBadge.id = "ai-snip-dimensions";
    dimBadge.style.cssText = `
      position: absolute;
      bottom: -26px;
      left: 0;
      background: #1e293b;
      color: #f8fafc;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 4px;
      white-space: nowrap;
    `;
    dimBadge.textContent = "0 × 0 px";
    snipBox.appendChild(dimBadge);

    overlay.appendChild(snipBox);
  });

  overlay.addEventListener("mousemove", (e) => {
    if (!dragging || !snipBox) return;
    e.preventDefault();
    e.stopPropagation();

    const currentX = e.clientX;
    const currentY = e.clientY;

    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);

    snipBox.style.left = `${left}px`;
    snipBox.style.top = `${top}px`;
    snipBox.style.width = `${width}px`;
    snipBox.style.height = `${height}px`;

    if (dimBadge) {
      dimBadge.textContent = `${width} × ${height} px • Release to capture`;
    }
  });

  overlay.addEventListener("mouseup", (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = false;

    const currentX = e.clientX;
    const currentY = e.clientY;
    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);

    // Extract DOM text from the region as supplementary context
    let domText = "";
    if (width < 15 && height < 15) {
      overlay.style.display = "none";
      const targetEl = document.elementFromPoint(currentX, currentY);
      overlay.style.display = "";
      if (targetEl && !targetEl.closest("#ai-snip-overlay, #ai-reply-float-card, #ai-reply-status-pill")) {
        domText = (targetEl.innerText || targetEl.textContent || "").trim();
      }
    } else {
      domText = extractTextFromScreenRect({
        left: left,
        top: top,
        right: left + width,
        bottom: top + height
      });
    }

    lastDomText = domText;

    const rect = {
      left: Math.max(0, left),
      top: Math.max(0, top),
      width: Math.max(10, width),
      height: Math.max(10, height),
      dpr: window.devicePixelRatio || 1
    };

    // Remove overlay before screenshot so it doesn't appear in the captured image
    cleanup();

    // Wait two frames so the browser actually repaints without the overlay,
    // then ask the background to capture. The status pill is shown only after
    // the capture has been requested, so it can't end up in the screenshot.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        chrome.runtime.sendMessage({
          type: "SNIP_RECT_CAPTURED",
          rect: rect,
          domText: domText,
          instructions: currentInstructions
        });
      });
    });

    // The status pill is shown when the background replies with CAPTURE_DONE.
  });
}

// Extract visible text from bounding box.
// Also looks inside same-origin <iframe>s (many mail clients / portals render the message body in one).
function extractTextFromScreenRect({ left, top, right, bottom }) {
  const matches = [];
  collectTextInRect(document, { left, top, right, bottom }, 0, 0, matches, 0);

  if (matches.length === 0) return "";

  matches.sort((a, b) => {
    const diff = a.top - b.top;
    if (Math.abs(diff) > 8) return diff;
    return a.left - b.left;
  });

  let result = "";
  let lastTop = -9999;
  matches.forEach((item) => {
    const text = item.text.trim();
    if (!text) return;
    if (lastTop !== -9999 && (item.top - lastTop) > 12) {
      result += "\n";
    } else if (result.length > 0 && !result.endsWith("\n") && !result.endsWith(" ")) {
      result += " ";
    }
    result += text;
    lastTop = item.top;
  });

  return result.trim();
}

// Walks text nodes of `doc` whose on-screen box intersects the snip rect.
// offsetX/offsetY convert the document's own coordinates to top-page coordinates (non-zero inside iframes).
function collectTextInRect(doc, rect, offsetX, offsetY, matches, depth) {
  if (!doc || !doc.body || depth > 3) return;
  const win = doc.defaultView || window;
  const { left, top, right, bottom } = rect;

  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('#ai-snip-overlay, #ai-reply-float-card, #ai-reply-status-pill, script, style, noscript')) {
        return NodeFilter.FILTER_REJECT;
      }
      if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
      const style = win.getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const range = doc.createRange();
  let node;
  while ((node = walker.nextNode())) {
    try {
      range.selectNodeContents(node);
      const rects = range.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        const rl = r.left + offsetX, rr = r.right + offsetX, rt = r.top + offsetY, rb = r.bottom + offsetY;
        const intersects = !(rr < left || rl > right || rb < top || rt > bottom);
        if (intersects && r.width > 0 && r.height > 0) {
          matches.push({ text: node.textContent, top: rt, left: rl, bottom: rb });
          break;
        }
      }
    } catch (err) {}
  }

  // Recurse into iframes that overlap the snip (only same-origin ones are readable)
  doc.querySelectorAll("iframe, frame").forEach((frame) => {
    try {
      const fr = frame.getBoundingClientRect();
      const fl = fr.left + offsetX, ft = fr.top + offsetY;
      if (fl + fr.width < left || fl > right || ft + fr.height < top || ft > bottom) return;
      const innerDoc = frame.contentDocument; // null / throws for cross-origin frames
      if (!innerDoc) return;
      collectTextInRect(innerDoc, rect, fl + frame.clientLeft, ft + frame.clientTop, matches, depth + 1);
    } catch (err) {
      // cross-origin iframe: not readable from here
    }
  });
}

// ---------------------------------------------------------------------------
// On-Screen Floating Reply UI (Platform-Agnostic)
// ---------------------------------------------------------------------------
function showStatusPill(text) {
  document.getElementById("ai-reply-status-pill")?.remove();

  const pill = document.createElement("div");
  pill.id = "ai-reply-status-pill";
  pill.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 2147483646;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    background: #1B2A41;
    color: #fff;
    border-radius: 10px;
    box-shadow: 0 10px 25px rgba(0,0,0,0.3);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    font-weight: 500;
  `;
  pill.innerHTML = `
    <div style="width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:ai-spin 0.8s linear infinite;"></div>
    <span>${escapeHtml(text)}</span>
  `;

  ensureKeyframes();
  document.body.appendChild(pill);
}

// ---------------------------------------------------------------------------
// Remember the last text box the user typed in on the page, so "Insert" can put the reply there
// ---------------------------------------------------------------------------
let lastEditable = null;
let lastEditableRange = null;

function isEditable(el) {
  if (!el || el.id === "ai-reply-float-card") return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA") return !el.disabled && !el.readOnly;
  if (el.tagName === "INPUT") {
    const t = (el.type || "text").toLowerCase();
    return ["text", "search", "email", "url", ""].includes(t) && !el.disabled && !el.readOnly;
  }
  return false;
}

document.addEventListener("focusin", (e) => {
  const el = e.target;
  if (isEditable(el)) {
    lastEditable = el;
    if (cardApi && cardApi.host.isConnected) cardApi.clearHint(); // the "click a reply box first" tip is done
  }
}, true);

document.addEventListener("selectionchange", () => {
  const active = document.activeElement;
  if (active && active.isContentEditable && active === lastEditable) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) lastEditableRange = sel.getRangeAt(0).cloneRange();
  }
});

// ---------------------------------------------------------------------------
// Send tracking: after "Insert", follow the reply box until the user SENDS, so the extension
// learns from what was really sent (including edits made on the page after inserting).
//   - The text is snapshotted as the user edits.
//   - "Sent" = the box is emptied or removed shortly after a send action
//     (Enter in a chat box, Ctrl/Cmd+Enter, or clicking a Send/Post/Reply button).
//   - If no send is detected, the latest edited version is still saved when the user
//     leaves the box, closes the card, or leaves the page.
// ---------------------------------------------------------------------------
let sendTracker = null;

// Text of an editable element, without quoted email threads (Gmail/Outlook quotes, blockquotes)
function readEditable(el) {
  if (!el) return "";
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value || "";
  const clone = el.cloneNode(true);
  clone.querySelectorAll("blockquote, .gmail_quote, .gmail_extra, .gmail_signature_prefix, [data-smartmail], #divRplyFwdMsg, #appendonsend, .moz-cite-prefix")
    .forEach((n) => n.remove());
  const out = [];
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) { out.push(node.textContent); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;
    if (tag === "BR") { out.push("\n"); return; }
    const block = /^(DIV|P|LI|H[1-6]|TR|SECTION|ARTICLE)$/.test(tag);
    if (block && out.length && !String(out[out.length - 1]).endsWith("\n")) out.push("\n");
    node.childNodes.forEach(walk);
    if (block && !String(out[out.length - 1] || "").endsWith("\n")) out.push("\n");
  };
  clone.childNodes.forEach(walk);
  return out.join("").replace(/ /g, " ").replace(/\n{3,}/g, "\n\n");
}

function stopSendTracker(reason) {
  const t = sendTracker;
  if (!t) return;
  sendTracker = null;
  clearInterval(t.timer);
  clearTimeout(t.debounce);
  t.cleanup.forEach((fn) => { try { fn(); } catch (e) {} });
  // Save the latest edited version even if no "send" was detected
  if (reason !== "sent" && t.snapshot && t.snapshot.trim() !== t.lastReported.trim()) {
    sendInteraction({ event: "final", interactionId: t.interactionId, text: t.snapshot, action: "insert-edited" });
  }
}

function startSendTracker(el, interactionId, insertedText, beforeText) {
  stopSendTracker("restart");
  if (!el || !interactionId) return;

  // Text that was already in the box before inserting: keep a short greeting the user typed,
  // but drop long pre-filled content (e.g. a quoted thread) so it isn't learned as "the reply".
  const before = String(beforeText || "").trim();
  const extract = () => {
    let t = readEditable(el);
    if (before.length > 200) {
      const i = t.indexOf(before);
      if (i >= 0) t = t.slice(0, i) + t.slice(i + before.length);
    }
    return t.trim();
  };

  const t = {
    el, interactionId,
    snapshot: extract() || insertedText,
    lastReported: insertedText,
    sendIntentTs: 0,
    startedTs: Date.now(),
    cleanup: [],
    timer: null,
    debounce: null
  };
  sendTracker = t;

  const update = () => {
    const now = extract();
    if (now) t.snapshot = now;
  };
  const onInput = () => { clearTimeout(t.debounce); t.debounce = setTimeout(update, 250); };
  const markIntent = () => { update(); t.sendIntentTs = Date.now(); };
  const onKey = (e) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    // Enter sends in chat boxes; Ctrl/Cmd+Enter sends in mail clients
    markIntent();
  };
  const onClick = (e) => {
    if (sendTracker !== t) return;
    const b = e.target.closest && e.target.closest('button, [role="button"], input[type="submit"]');
    if (!b) return;
    const label = [b.getAttribute("aria-label"), b.getAttribute("data-tooltip"), b.title, b.value, b.innerText]
      .filter(Boolean).join(" ").slice(0, 80);
    if (/\b(send|post|reply|comment|submit|tweet|publish|share)\b/i.test(label)) markIntent();
  };
  const onBlur = () => {
    update();
    if (t.snapshot.trim() !== t.lastReported.trim()) {
      t.lastReported = t.snapshot;
      sendInteraction({ event: "final", interactionId: t.interactionId, text: t.snapshot, action: "insert-edited" });
    }
  };
  const onLeave = () => stopSendTracker("page-hidden");

  el.addEventListener("input", onInput, true);
  el.addEventListener("keydown", onKey, true);
  el.addEventListener("blur", onBlur, true);
  document.addEventListener("click", onClick, true);
  window.addEventListener("pagehide", onLeave);
  const mo = el.isContentEditable ? new MutationObserver(onInput) : null;
  mo?.observe(el, { childList: true, subtree: true, characterData: true });
  t.cleanup.push(
    () => el.removeEventListener("input", onInput, true),
    () => el.removeEventListener("keydown", onKey, true),
    () => el.removeEventListener("blur", onBlur, true),
    () => document.removeEventListener("click", onClick, true),
    () => window.removeEventListener("pagehide", onLeave),
    () => mo?.disconnect()
  );

  // Poll: did the box get emptied / removed right after a send action?
  t.timer = setInterval(() => {
    if (sendTracker !== t) return;
    const gone = !el.isConnected;
    const empty = gone || !extract();
    const recentIntent = Date.now() - t.sendIntentTs < 4000;
    if (empty && recentIntent && t.snapshot.trim()) {
      t.lastReported = t.snapshot;
      sendInteraction({ event: "final", interactionId: t.interactionId, text: t.snapshot, action: "sent" });
      stopSendTracker("sent");
      return;
    }
    if (gone) { stopSendTracker("removed"); return; }              // closed without sending
    if (Date.now() - t.startedTs > 30 * 60 * 1000) stopSendTracker("timeout");
  }, 500);
}

function insertIntoPage(text) {
  const el = lastEditable;
  if (!el || !el.isConnected) return false;
  el.focus();
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.setRangeText(text, start, end, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  // contenteditable (Gmail, LinkedIn, Slack, WhatsApp Web, ...)
  const sel = window.getSelection();
  if (lastEditableRange && el.contains(lastEditableRange.startContainer)) {
    sel.removeAllRanges();
    sel.addRange(lastEditableRange);
  }
  // execCommand is deprecated but is still the only way that keeps rich editors' internal state in sync.
  // Insert line by line with soft line breaks: inserting "\n" directly makes Chrome split the editor into blocks.
  const lines = text.split("\n");
  let ok = true;
  lines.forEach((line, i) => {
    if (i > 0) ok = document.execCommand("insertLineBreak") && ok;
    if (line) ok = document.execCommand("insertText", false, line) && ok;
  });
  return ok;
}

// Sends a learning signal to the background (copy / insert / rating / dismiss).
// The background stores it in the local learning history (see personalization.js).
function sendInteraction(payload) {
  try {
    chrome.runtime.sendMessage({ type: "INTERACTION_EVENT", ...payload }).catch(() => {});
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// On-Screen Floating Reply Card
// Rendered inside a Shadow DOM so the website's CSS can't break its layout.
// Draggable (position remembered), resizable, minimisable, with quick refine actions.
// ---------------------------------------------------------------------------
let cardApi = null;

const REFINE_CHIPS = [
  { label: "Shorter", short: "Shorter", instruction: "make it shorter and more concise" },
  { label: "More formal", short: "Formal", instruction: "make it more formal and professional" },
  { label: "Friendlier", short: "Friendlier", instruction: "make it warmer and friendlier" },
  { label: "Say yes", short: "Say yes", instruction: "accept / agree, positively" },
  { label: "Decline politely", short: "Decline", instruction: "politely decline" }
];

const CARD_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; }
  button { font-family: inherit; }
  .card {
    --ink: #1B2A41; --graphite: #5B6472; --faint: #8A93A0; --rule: #DCE1E8; --blotter: #F2F4F7; --paper: #FFFFFF;
    --accent: #3B6BA5; --good: #2E7D5B; --serif: Charter, "Iowan Old Style", "Palatino Linotype", Georgia, Cambria, serif;
    width: 372px; min-width: 310px; max-width: 92vw; min-height: 120px; max-height: 88vh;
    background: var(--paper); border: 1px solid var(--rule); border-radius: 12px;
    box-shadow: 0 1px 2px rgba(27,42,65,.08), 0 14px 36px rgba(27,42,65,.18);
    display: flex; flex-direction: column; overflow: hidden;
    color: var(--ink); font-size: 13px; resize: both;
    animation: open .16s ease-out;
  }
  @media (prefers-reduced-motion: reduce) { .card { animation: none; } }
  .card.min { resize: none; min-height: 0; height: auto !important; }
  .card.min .body, .card.min .footer { display: none; }
  @keyframes open { from { transform: translateY(6px); opacity: 0 } to { transform: none; opacity: 1 } }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

  /* header */
  .header { display: flex; align-items: baseline; gap: 8px; padding: 12px 10px 11px 16px; border-bottom: 1px solid var(--rule);
    cursor: move; user-select: none; touch-action: none; }
  .title { font-family: var(--serif); font-size: 16px; font-weight: 600; letter-spacing: .1px; }
  .site { flex: 1; font-size: 12px; color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .icon-btn { align-self: center; background: none; border: none; cursor: pointer; color: var(--faint); padding: 4px; border-radius: 6px; display: flex; }
  .icon-btn:hover { background: var(--blotter); color: var(--ink); }

  .body { padding: 0 16px 14px; display: flex; flex-direction: column; gap: 12px; flex: 1; min-height: 0; overflow-y: auto; }

  /* screenshot thumbnail (snip backup) */
  .ctx { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--graphite);
    margin: 0 -16px; padding: 10px 16px; background: var(--blotter); border-bottom: 1px solid var(--rule); }
  .ctx img { width: 44px; height: 28px; object-fit: cover; border-radius: 4px; border: 1px solid var(--rule); cursor: zoom-in; }
  .ctx img.big { width: 100%; height: auto; max-height: 220px; object-fit: contain; cursor: zoom-out; }
  .ctx.bigwrap { flex-direction: column; align-items: stretch; }

  /* what is being read (DOM pick): a strip across the card */
  .ctxbar { margin: 0 -16px; padding: 10px 16px; background: var(--blotter); border-bottom: 1px solid var(--rule); display: flex; flex-direction: column; gap: 8px; }
  .ctx-row { display: flex; align-items: center; gap: 10px; font-size: 12.5px; color: var(--graphite); flex-wrap: wrap; }
  .ctx-label { color: var(--graphite); }
  .stepper { display: inline-flex; align-items: center; background: var(--paper); border: 1px solid var(--rule); border-radius: 8px; overflow: hidden; }
  .lvl { width: 26px; height: 24px; border: none; background: none; color: var(--ink); font-size: 15px; line-height: 1; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center; }
  .lvl:hover { background: var(--blotter); }
  .lvl:disabled { color: #C3C9D2; cursor: default; background: none; }
  .ctx-level { font-size: 12.5px; color: var(--ink); padding: 0 8px; min-width: 52px; text-align: center; font-variant-numeric: tabular-nums;
    border-left: 1px solid var(--rule); border-right: 1px solid var(--rule); line-height: 24px; }
  .ctx-meta { color: var(--faint); }
  .link { background: none; border: none; padding: 0; cursor: pointer; font-size: 12.5px; color: var(--accent); }
  .link:hover { text-decoration: underline; }
  .ctx-row .link { margin-left: auto; }
  .ctx-changed { display: none; align-items: center; gap: 6px; font-size: 12.5px; color: var(--graphite); }
  .ctx-changed.on { display: flex; }
  .ctx-changed .link { font-weight: 600; }
  .ctx-write { display: none; align-items: center; gap: 12px; font-size: 12px; color: var(--faint); line-height: 1.4; }
  .ctx-write.on { display: flex; }
  .ctx-write .btn.primary { flex: 0 0 auto; height: 32px; padding: 0 16px; }
  .card.choosing .editor, .card.choosing .meta, .card.choosing .chips, .card.choosing .custom, .card.choosing .footer { display: none; }
  .card.choosing .body { padding-bottom: 0; }
  .card.choosing .ctxbar { border-bottom: none; }
  .ctx-preview { display: none; max-height: 170px; overflow: auto; white-space: pre-wrap; margin: 0; font: 12px/1.55 var(--serif);
    color: var(--ink); background: var(--paper); border: 1px solid var(--rule); border-radius: 6px; padding: 10px 12px; }
  .ctx-preview.on { display: block; }

  /* the draft: a sheet of letter paper with a faint margin line */
  .editor { position: relative; flex: 1; display: flex; min-height: 132px; }
  textarea { width: 100%; flex: 1; min-height: 132px; padding: 14px 16px 14px 26px; border: 1px solid var(--rule); border-radius: 6px;
    font: 15px/1.6 var(--serif); color: var(--ink); resize: none; outline: none; white-space: pre-wrap; overflow-x: hidden;
    background: var(--paper) linear-gradient(to right, transparent 15px, rgba(59,107,165,.22) 15px, rgba(59,107,165,.22) 16px, transparent 16px); }
  textarea:focus { border-color: #B7C2D0; box-shadow: 0 0 0 3px rgba(59,107,165,.10); }
  textarea::placeholder { color: var(--faint); font-style: italic; }
  .loading { position: absolute; inset: 0; background: rgba(255,255,255,.9); border-radius: 6px; display: none;
    align-items: center; justify-content: center; gap: 10px; color: var(--graphite); font: italic 14px var(--serif); }
  .loading.on { display: flex; }
  .spin { width: 14px; height: 14px; border: 2px solid var(--rule); border-top-color: var(--ink); border-radius: 50%; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg) } }

  .meta { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12px; color: var(--faint); margin-top: -4px; }
  .meta-left, .meta-right { display: flex; align-items: center; gap: 12px; }
  .meta .link { color: var(--graphite); font-size: 12px; }
  .meta .link:hover { color: var(--ink); }
  .pbadge { font-size: 12px; color: var(--faint); cursor: pointer; white-space: nowrap; background: none; border: none; padding: 0; }
  .pbadge:hover { color: var(--ink); text-decoration: underline; }
  .pbadge.on { color: var(--good); }
  .pbadge.on::before { content: ""; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--good); margin-right: 6px; vertical-align: 1px; }
  .rate { background: none; border: none; padding: 2px; cursor: pointer; color: var(--faint); display: inline-flex; border-radius: 4px; }
  .rate:hover, .rate.sel { color: var(--ink); }
  .rate.sel svg { fill: #DCE5F0; }

  .prefs-panel { display: none; background: var(--blotter); border-left: 2px solid var(--accent); border-radius: 0 6px 6px 0; padding: 10px 12px; font-size: 12.5px; color: var(--ink); }
  .prefs-panel.on { display: block; }
  .prefs-panel .ph { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; color: var(--graphite); font-size: 12px; }
  .prefs-panel ol { margin: 0; padding-left: 16px; list-style: disc; }
  .prefs-panel li { margin: 3px 0; line-height: 1.45; font-family: var(--serif); font-size: 13px; }
  .prefs-panel .none { color: var(--faint); font-family: inherit; font-size: 12px; }

  .err { display: none; align-items: flex-start; gap: 8px; padding: 9px 12px; background: #FBEDED; color: #9B2C2C; border-radius: 6px; font-size: 12.5px; line-height: 1.45; }
  .err.on { display: flex; }
  .err.hint { background: var(--blotter); color: var(--graphite); }
  .err .msg { flex: 1; }
  .err .x { background: none; border: none; cursor: pointer; color: inherit; font-size: 12px; padding: 0 2px; opacity: .6; }
  .err .x:hover { opacity: 1; }

  /* refine: one joined toolbar */
  .chips { display: flex; border: 1px solid var(--rule); border-radius: 8px; overflow: hidden; }
  .chip { flex: 1 1 auto; min-width: 0; height: 30px; padding: 0 6px; font-size: 12px; color: var(--ink); background: var(--paper); border: none;
    border-right: 1px solid var(--rule); cursor: pointer; white-space: nowrap; }
  .chip:last-child { border-right: none; }
  .chip:hover { background: var(--blotter); }
  .chip:disabled { color: #C3C9D2; cursor: default; background: var(--paper); }
  .custom { display: flex; gap: 8px; }
  .custom input { flex: 1; min-width: 0; height: 32px; padding: 0 10px; border: 1px solid var(--rule); border-radius: 8px; font-size: 12.5px; outline: none; color: var(--ink); background: var(--paper); }
  .custom input:focus { border-color: #B7C2D0; box-shadow: 0 0 0 3px rgba(59,107,165,.10); }
  .custom input::placeholder { color: var(--faint); }

  /* actions */
  .footer { display: flex; gap: 8px; padding: 12px 16px 14px; border-top: 1px solid var(--rule); background: var(--blotter); }
  .btn { height: 36px; padding: 0 14px; border-radius: 8px; font-weight: 500; font-size: 13px; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center; gap: 7px; border: 1px solid var(--rule); background: var(--paper); color: var(--ink); }
  .btn:hover { border-color: #B7C2D0; }
  .btn.primary { flex: 1; background: var(--ink); border-color: var(--ink); color: #fff; }
  .btn.primary:hover { background: #24375A; }
  .btn.ok { background: var(--good) !important; border-color: var(--good) !important; color: #fff !important; }
  .btn.small { height: 32px; padding: 0 12px; font-size: 12.5px; }
  .btn:disabled { opacity: .45; cursor: default; }
`;

const ICONS = {
  min: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/></svg>',
  max: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
  close: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
  insert: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>',
  redo: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  up: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M7 10v11H3V10z"/><path d="M7 10l4-7c1.7 0 2.7 1.2 2.4 2.9L13 9h6.2c1.3 0 2.2 1.2 1.9 2.4l-1.8 7.2c-.3 1.4-1.5 2.4-3 2.4H7"/></svg>',
  down: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M17 14V3h4v11z"/><path d="M17 14l-4 7c-1.7 0-2.7-1.2-2.4-2.9L11 15H4.8c-1.3 0-2.2-1.2-1.9-2.4l1.8-7.2C5 4 6.2 3 7.7 3H17"/></svg>'
};

function clampToViewport(host) {
  const r = host.getBoundingClientRect();
  const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - r.width - 8));
  // keep the whole card on screen (its buttons at the bottom must stay reachable)
  const top = Math.min(Math.max(8, r.top), Math.max(8, window.innerHeight - r.height - 8));
  host.style.left = `${left}px`;
  host.style.top = `${top}px`;
}

function renderOnScreenReplyCard(replyText, snippetImage, interactionId = null, personalization = null) {
  document.getElementById("ai-reply-status-pill")?.remove();

  // If the card is already open (e.g. after Regenerate), just update it in place
  if (cardApi && cardApi.host.isConnected) {
    cardApi.setReply(replyText, interactionId, personalization);
    return;
  }
  document.getElementById("ai-reply-float-card")?.remove();

  const host = document.createElement("div");
  host.id = "ai-reply-float-card";
  host.style.cssText = "position:fixed;z-index:2147483646;left:-9999px;top:-9999px;";
  const root = host.attachShadow({ mode: "open" });

  root.innerHTML = `
    <style>${CARD_CSS}</style>
    <div class="card${pickSession && !replyText ? " choosing" : ""}" part="card">
      <div class="header" title="Drag to move">
        <span class="title">Draft reply</span>
        <span class="site">${escapeHtml(location.hostname)}</span>
        <button class="icon-btn" data-act="min" title="Minimise">${ICONS.min}</button>
        <button class="icon-btn" data-act="close" title="Close (Esc)">${ICONS.close}</button>
      </div>
      <div class="body">
        ${pickSession ? `<div class="ctxbar">
            <div class="ctx-row">
              <span class="ctx-label">Reading</span>
              <span class="stepper">
                <button class="lvl" data-act="ctx-less" title="Less context">−</button>
                <span class="ctx-level"></span>
                <button class="lvl" data-act="ctx-more" title="More context">+</button>
              </span>
              <span class="ctx-meta"></span>
              <button class="link" data-act="ctx-show" title="Show exactly what the AI reads">Show text</button>
            </div>
            <div class="ctx-write"><button class="btn primary" data-act="ctx-write">Write reply</button><span>The outline on the page shows what will be read. Use − and + to change it.</span></div>
            <div class="ctx-changed"><span>You changed what is read.</span><button class="link" data-act="ctx-apply">Rewrite for it</button></div>
            <pre class="ctx-preview"></pre>
          </div>` : snippetImage ? `<div class="ctx"><img src="${snippetImage}" title="Click to enlarge"><span>From a screenshot</span></div>` : ""}
        <div class="err" role="status"><span class="msg"></span><button class="x" data-act="dismiss-msg" title="Dismiss">✕</button></div>
        <div class="editor">
          <textarea spellcheck="true" placeholder="Your reply appears here."></textarea>
          <div class="loading"><div class="spin"></div><span>Writing…</span></div>
        </div>
        <div class="meta">
          <span class="meta-left">
            <span class="count"></span>
            <button class="link" data-act="clear" title="Clear the reply (Ctrl+Z to undo)">Clear</button>
          </span>
          <span class="meta-right">
            <button class="pbadge" data-act="prefs" title="Show the preferences used for this reply"></button>
            <button class="rate" data-rate="1" title="Good reply (helps it learn)">${ICONS.up}</button>
            <button class="rate" data-rate="-1" title="Bad reply (helps it learn)">${ICONS.down}</button>
          </span>
        </div>
        <div class="prefs-panel">
          <div class="ph"><span>Followed in this reply</span><button class="link" data-act="edit-prefs">Edit preferences</button></div>
          <ol></ol>
        </div>
        <div class="chips">
          ${REFINE_CHIPS.map((c, i) => `<button class="chip" data-chip="${i}">${c.short || c.label}</button>`).join("")}
        </div>
        <div class="custom">
          <input type="text" placeholder="What should change?">
          <button class="btn small" data-act="custom" title="Rewrite with this instruction">Rewrite</button>
        </div>
      </div>
      <div class="footer">
        <button class="btn primary" data-act="insert" title="Insert into the reply box you clicked on the page">${ICONS.insert}<span class="insert-label">Insert into reply</span></button>
        <button class="btn" data-act="copy" title="Copy to clipboard">${ICONS.copy}<span class="copy-label">Copy</span></button>
        <button class="btn" data-act="regen" title="Write a fresh reply">${ICONS.redo}</button>
      </div>
    </div>
  `;
  document.body.appendChild(host);

  const card = root.querySelector(".card");
  const header = root.querySelector(".header");
  const textarea = root.querySelector("textarea");
  const loading = root.querySelector(".loading");
  const errBox = root.querySelector(".err");
  const count = root.querySelector(".count");
  const customInput = root.querySelector(".custom input");
  const allButtons = () => root.querySelectorAll("button.chip, .footer .btn, .custom .btn");
  let generatedText = replyText;
  let lastInstruction = currentInstructions || "";

  const updateCount = () => {
    const t = textarea.value.trim();
    const words = t ? t.split(/\s+/).length : 0;
    count.textContent = `${words} word${words === 1 ? "" : "s"}`;
  };
  const setLoading = (on, label = "Rewriting…") => {
    loading.classList.toggle("on", on);
    loading.querySelector("span").textContent = label;
    textarea.disabled = on;
    allButtons().forEach((b) => { if (b.dataset.act !== "min" && b.dataset.act !== "close") b.disabled = on; });
  };
  // kind: "error" (red, stays until dismissed / next action) or "hint" (blue tip, fades after 6s)
  let msgTimer = null;
  const clearMessage = () => {
    clearTimeout(msgTimer);
    errBox.classList.remove("on", "hint");
  };
  const showError = (msg, kind = "error") => {
    setLoading(false);
    if (kind === "error" && pickSession && !currentInteractionId) {
      pickSession.sentIndex = -1; // nothing was written: show "Write reply" again
      card.classList.add("choosing");
      renderCtx();
    }
    clearTimeout(msgTimer);
    errBox.querySelector(".msg").textContent = msg;
    errBox.classList.toggle("hint", kind === "hint");
    errBox.classList.add("on");
    if (kind === "hint") msgTimer = setTimeout(clearMessage, 6000);
  };
  let currentInteractionId = interactionId;
  let rating = 0;
  const badge = root.querySelector(".pbadge");
  const renderBadge = (p) => {
    if (!p) { badge.style.display = "none"; return; }
    badge.style.display = "";
    if (p.enabled === false) {
      badge.className = "pbadge";
      badge.textContent = "Not personalised";
      badge.title = "Turn it on in Settings → What I've learned";
      return;
    }
    const nPrefs = p.preferences ?? p.rules ?? 0;
    const used = (p.examples || 0) + nPrefs + (p.style || 0) > 0;
    badge.className = used ? "pbadge on" : "pbadge";
    badge.textContent = used ? "In your style" : "Learning your style";
    const lines = used
      ? [
          `Written in your style using:`,
          `• ${p.examples || 0} similar past repl${p.examples === 1 ? "y" : "ies"} (${p.method === "semantic" ? "semantic" : "keyword"} search)`,
          `• ${nPrefs} of your 5 preferences`,
          `• ${p.style || 0} style habit${p.style === 1 ? "" : "s"}`,
          `(${p.history || 0} replies in your history)`
        ]
      : [`Still learning your style: ${p.history || 0} replies so far.`, `Copy/Insert, edit and rate replies to teach it.`];
    badge.title = lines.join("\n");
  };
  const renderRating = () => {
    root.querySelectorAll(".rate").forEach((b) => b.classList.toggle("sel", Number(b.dataset.rate) === rating));
  };
  // ---- Context levels (DOM pick mode) ----
  const ctxBar = root.querySelector(".ctxbar");
  const renderCtx = () => {
    if (!ctxBar || !pickSession) return;
    const c = currentPickContext();
    ctxBar.querySelector(".ctx-level").textContent = `${c.level} of ${c.levels}`;
    ctxBar.querySelector(".ctx-level").title = `Level ${c.level} of ${c.levels}: the block you clicked is level 1`;
    ctxBar.querySelector(".ctx-meta").textContent =
      `${c.words.toLocaleString()} words${c.keyPoints.length ? `, ${c.keyPoints.length} highlighted` : ""}`;
    ctxBar.querySelector('[data-act="ctx-less"]').disabled = pickSession.index === 0;
    ctxBar.querySelector('[data-act="ctx-more"]').disabled = pickSession.index >= pickSession.chain.length - 1;
    const written = pickSession.sentIndex >= 0;
    ctxBar.querySelector(".ctx-write").classList.toggle("on", !written);
    ctxBar.querySelector(".ctx-changed").classList.toggle("on", written && pickSession.index !== pickSession.sentIndex);
    const pre = ctxBar.querySelector(".ctx-preview");
    if (pre.classList.contains("on")) {
      pre.textContent = c.text.slice(0, 4000) + (c.text.length > 4000 ? "\n…" : "") +
        (c.keyPoints.length ? `\n\nKEY POINTS (from bold/italic/headings):\n${c.keyPoints.map((k) => `• ${k}`).join("\n")}` : "");
    }
    pickSession.reposition();
  };

  const setReply = (text, newInteractionId = undefined, p = undefined) => {
    if (newInteractionId && newInteractionId !== currentInteractionId) {
      currentInteractionId = newInteractionId;
      rating = 0;
      renderRating();
    }
    if (p !== undefined) renderBadge(p);
    generatedText = text;
    textarea.value = text;
    clearMessage();
    setLoading(false);
    updateCount();
    card.classList.remove("min");
    if (pickSession) {
      if (newInteractionId) pickSession.sentIndex = pickSession.index;
      renderCtx();
    }
  };
  const flash = (btn, labelEl, text, original) => {
    btn.classList.add("ok");
    labelEl.textContent = text;
    setTimeout(() => { btn.classList.remove("ok"); labelEl.textContent = original; }, 1600);
  };
  const writeFirst = (instruction = "") => {
    if (!pickSession) return;
    const c = currentPickContext();
    lastDomText = c.text;
    lastInstruction = instruction || "";
    pickSession.sentIndex = pickSession.index;
    card.classList.remove("choosing");
    clearMessage();
    setLoading(true, "Writing…");
    renderCtx();
    try {
      chrome.runtime.sendMessage({
        type: "CONTEXT_PICKED",
        text: c.text,
        keyPoints: c.keyPoints,
        pageTitle: document.title,
        instructions: instruction || ""
      });
    } catch (e) {
      showError("The extension was reloaded. Please refresh this page (F5) and try again.");
    }
  };

  const requestRewrite = (instruction, useDraft, chip = null) => {
    // No reply yet (pick mode): the first press of any button writes the first reply
    if (!currentInteractionId) {
      if (pickSession) writeFirst(instruction);
      return;
    }
    lastInstruction = instruction || "";
    clearMessage();
    setLoading(true, useDraft ? "Rewriting…" : "Writing a fresh reply…");
    try {
      chrome.runtime.sendMessage({
        type: "REGENERATE_REPLY",
        instructions: instruction || "",
        currentDraft: useDraft ? textarea.value : "",
        interactionId: currentInteractionId,
        chip
      });
    } catch (e) {
      showError("The extension was reloaded. Please refresh this page (F5) and snip again.");
    }
  };

  setReply(replyText, interactionId, personalization);

  // ---- Position: restore last saved spot, else bottom-right ----
  // When the card grows (preview shown, longer reply, error message), move it back fully on screen
  let autoFit = null;
  const startAutoFit = () => {
    if (autoFit || typeof ResizeObserver === "undefined") return;
    autoFit = new ResizeObserver(() => host.isConnected && clampToViewport(host));
    autoFit.observe(card);
  };
  const placeDefault = () => {
    const r = host.getBoundingClientRect();
    host.style.left = `${window.innerWidth - r.width - 24}px`;
    host.style.top = `${window.innerHeight - r.height - 24}px`;
    clampToViewport(host);
    startAutoFit();
  };
  try {
    chrome.storage.local.get("cardPos", ({ cardPos }) => {
      if (cardPos && typeof cardPos.left === "number") {
        host.style.left = `${cardPos.left}px`;
        host.style.top = `${cardPos.top}px`;
        clampToViewport(host);
        startAutoFit();
      } else {
        placeDefault();
      }
    });
  } catch (e) {
    placeDefault();
  }

  // ---- Dragging by the header ----
  header.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button")) return;
    e.preventDefault();
    const r = host.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    header.setPointerCapture(e.pointerId);
    const move = (ev) => {
      host.style.left = `${ev.clientX - dx}px`;
      host.style.top = `${ev.clientY - dy}px`;
      clampToViewport(host);
    };
    const up = () => {
      header.removeEventListener("pointermove", move);
      header.removeEventListener("pointerup", up);
      header.removeEventListener("pointercancel", up);
      const p = host.getBoundingClientRect();
      try { chrome.storage.local.set({ cardPos: { left: Math.round(p.left), top: Math.round(p.top) } }); } catch (e) {}
    };
    header.addEventListener("pointermove", move);
    header.addEventListener("pointerup", up);
    header.addEventListener("pointercancel", up);
  });
  header.addEventListener("dblclick", (e) => {
    if (e.target.closest("button")) return;
    card.classList.toggle("min");
  });
  const onResize = () => host.isConnected ? clampToViewport(host) : window.removeEventListener("resize", onResize);
  window.addEventListener("resize", onResize);

  // ---- Buttons ----
  const close = () => {
    // Closed without Copy/Insert => "discarded" (ignored by the background if the reply was already used)
    if (currentInteractionId) sendInteraction({ event: "dismiss", interactionId: currentInteractionId });
    autoFit?.disconnect();
    host.remove();
    cardApi = null;
    endPickSession();
    window.removeEventListener("resize", onResize);
  };
  root.addEventListener("click", async (e) => {
    const img = e.target.closest(".ctx img");
    if (img) { img.classList.toggle("big"); img.parentElement.classList.toggle("bigwrap"); return; }

    const chip = e.target.closest("[data-chip]");
    if (chip) {
      const c = REFINE_CHIPS[Number(chip.dataset.chip)];
      requestRewrite(c.instruction, true, c.label);
      return;
    }

    const rateBtn = e.target.closest("[data-rate]");
    if (rateBtn) {
      const v = Number(rateBtn.dataset.rate);
      rating = rating === v ? 0 : v; // click again to undo
      renderRating();
      if (currentInteractionId) sendInteraction({ event: "rating", interactionId: currentInteractionId, rating });
      return;
    }

    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === "close") close();
    if (act === "prefs") {
      const panel = root.querySelector(".prefs-panel");
      if (!panel.classList.contains("on")) {
        let list = [];
        try { list = (await chrome.storage.local.get("preferences")).preferences || []; } catch (err) {}
        panel.querySelector("ol").innerHTML = list.length
          ? list.map((p) => `<li>${escapeHtml(p.text)}${p.locked ? " <span class=\"none\">(pinned)</span>" : ""}</li>`).join("")
          : `<li class="none">None yet. They are learned from the replies you send.</li>`;
      }
      panel.classList.toggle("on");
    }
    if (act === "edit-prefs") {
      try { chrome.runtime.sendMessage({ type: "OPEN_PREFERENCES" }); } catch (err) {}
    }
    if (act === "clear") {
      // execCommand keeps Ctrl+Z working; fall back to a plain reset
      textarea.focus();
      textarea.select();
      if (!document.execCommand("delete")) textarea.value = "";
      updateCount();
      clearMessage();
    }
    if (act === "ctx-less" || act === "ctx-more") {
      if (!pickSession) return;
      pickSession.index = Math.max(0, Math.min(pickSession.chain.length - 1, pickSession.index + (act === "ctx-more" ? 1 : -1)));
      renderCtx();
    }
    if (act === "ctx-show") {
      const pre = ctxBar.querySelector(".ctx-preview");
      pre.classList.toggle("on");
      btn.textContent = pre.classList.contains("on") ? "Hide" : "Show";
      renderCtx();
    }
    if (act === "ctx-write") {
      writeFirst(customInput.value.trim() || currentInstructions || "");
    }
    if (act === "ctx-apply" && !currentInteractionId) {
      writeFirst(currentInstructions || "");
      return;
    }
    if (act === "ctx-apply") {
      if (!pickSession) return;
      const c = currentPickContext();
      lastDomText = c.text;
      clearMessage();
      setLoading(true, "Reading the new context…");
      try {
        chrome.runtime.sendMessage({
          type: "REGENERATE_REPLY",
          instructions: currentInstructions || "",
          interactionId: currentInteractionId,
          context: { text: c.text, keyPoints: c.keyPoints }
        });
      } catch (err) {
        showError("The extension was reloaded. Please refresh this page (F5) and try again.");
      }
    }
    if (act === "dismiss-msg") clearMessage();
    if (act === "min") {
      card.classList.toggle("min");
      btn.innerHTML = card.classList.contains("min") ? ICONS.max : ICONS.min;
      btn.title = card.classList.contains("min") ? "Restore" : "Minimise";
    }
    // Fresh reply = start over with only the instruction given at snip time (not the last refine chip)
    if (act === "regen") requestRewrite(currentInstructions || "", false);
    if (act === "custom") {
      const v = customInput.value.trim();
      if (!v) { customInput.focus(); return; }
      requestRewrite(v, true);
    }
    if (act === "copy") {
      const text = textarea.value;
      if (!text.trim()) { showError("The reply is empty. Type one, or press ↻ to write a new one.", "hint"); return; }
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        textarea.select();
        document.execCommand("copy");
      }
      clearMessage();
      flash(btn, root.querySelector(".copy-label"), "Copied", "Copy");
      if (currentInteractionId) sendInteraction({ event: "final", interactionId: currentInteractionId, text, action: "copy" });
    }
    if (act === "insert") {
      const label = root.querySelector(".insert-label");
      const text = textarea.value;
      if (!text.trim()) { showError("The reply is empty. Type one, or press ↻ to write a new one.", "hint"); return; }
      const target = lastEditable;
      const before = readEditable(target);
      if (insertIntoPage(text)) {
        clearMessage();
        flash(btn, label, "Inserted", "Insert into reply");
        if (currentInteractionId) {
          sendInteraction({ event: "final", interactionId: currentInteractionId, text, action: "insert" });
          // Keep watching the box so we learn from what is actually SENT
          startSendTracker(target, currentInteractionId, text, before);
        }
      } else {
        showError("Click inside the reply box on the page first, then press Insert. (Or use Copy and paste with Ctrl+V.)", "hint");
      }
    }
  });

  customInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); root.querySelector('[data-act="custom"]').click(); }
    e.stopPropagation(); // don't let the site's keyboard shortcuts fire while typing here
  });
  textarea.addEventListener("input", updateCount);
  textarea.addEventListener("keydown", (e) => e.stopPropagation());
  root.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  const clearHint = () => { if (errBox.classList.contains("hint")) clearMessage(); };
  cardApi = { host, setReply, showError, clearMessage, clearHint };
}

function renderOnScreenError(errorMsg) {
  document.getElementById("ai-reply-status-pill")?.remove();
  // If the card is open (error during Rewrite), show it inside the card
  if (cardApi && cardApi.host.isConnected) {
    cardApi.showError(errorMsg || "Failed to generate reply");
    return;
  }
  const pill = document.createElement("div");
  pill.id = "ai-reply-status-pill";
  pill.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 2147483646;
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 420px;
    padding: 10px 16px;
    background: #FEF2F2;
    color: #DC2626;
    border: 1px solid #FECACA;
    border-radius: 8px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    box-shadow: 0 8px 20px rgba(0,0,0,0.12);
  `;
  pill.innerHTML = `
    <span>⚠️ ${escapeHtml(errorMsg || "Failed to generate reply")}</span>
    <button class="ai-error-close" style="margin-left:8px;background:none;border:none;cursor:pointer;color:#DC2626;font-weight:700;">✕</button>
  `;
  // Attach the handler in JS: inline onclick="" is blocked by the CSP on many sites (GitHub, Gmail, etc.)
  pill.querySelector(".ai-error-close")?.addEventListener("click", () => pill.remove());
  document.body.appendChild(pill);
  setTimeout(() => pill.remove(), 8000);
}

function ensureKeyframes() {
  if (document.getElementById("ai-reply-keyframes")) return;
  const style = document.createElement("style");
  style.id = "ai-reply-keyframes";
  style.textContent = `
    @keyframes ai-spin { to { transform: rotate(360deg); } }
    @keyframes ai-slide-up { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
})();
