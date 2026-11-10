// popup.js - AI Reply Assistant

document.addEventListener("DOMContentLoaded", () => {
  const snipBtn = document.getElementById("snipBtn");
  const instructionsInput = document.getElementById("instructionsInput");
  const errorBanner = document.getElementById("errorBanner");
  const statusCard = document.getElementById("statusCard");
  const statusMessage = document.getElementById("statusMessage");
  const contextCard = document.getElementById("contextCard");
  const snippetThumb = document.getElementById("snippetThumb");
  const snippetTextPreview = document.getElementById("snippetTextPreview");
  const replySection = document.getElementById("replySection");
  const replyText = document.getElementById("replyText");
  const copyBtn = document.getElementById("copyBtn");
  const copyBtnText = document.getElementById("copyBtnText");
  const regenerateBtn = document.getElementById("regenerateBtn");
  const openSettingsBtn = document.getElementById("openSettingsBtn");
  const activeProviderBadge = document.getElementById("activeProviderBadge");

  // The popup opens clean: an earlier message and reply are not shown again
  // (the reply card on the page is where replies live). Only a reply being written right now,
  // or one that arrives while the popup is open, is shown here.
  loadStoredState(true);
  updateProviderBadge();

  // Listen for storage updates
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session") {
      loadStoredState();
    } else if (area === "sync") {
      updateProviderBadge();
    }
  });

  // Clicking the provider badge opens settings
  activeProviderBadge?.addEventListener("click", () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL("options.html"));
    }
  });

  // Start choosing a message on the current page.
  // type = "START_PICK" (main: click a message, read from the page) or "START_SNIP" (backup: screenshot an area)
  const startOnPage = async (type) => {
    const instructions = instructionsInput.value.trim();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      showError("Cannot access active tab. Open a standard webpage and try again.");
      return;
    }
    if (tab.url && (tab.url.startsWith("chrome://") || tab.url.startsWith("edge://") || tab.url.startsWith("about:"))) {
      showError("Chrome does not allow extensions on internal browser pages. Please open any normal website.");
      return;
    }
    const msg = { type, instructions };
    try {
      await chrome.tabs.sendMessage(tab.id, msg);
      window.close(); // close the popup so the user can click/drag on the page
    } catch (err) {
      // Expected after the extension is reloaded/updated: already-open tabs lose their content script
      // ("Receiving end does not exist"). Not an error - just inject a fresh copy and continue.
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
        await chrome.tabs.sendMessage(tab.id, msg);
        window.close();
      } catch (injectionErr) {
        showError("Please refresh this webpage and try again.");
      }
    }
  };
  snipBtn.addEventListener("click", () => startOnPage("START_PICK"));
  document.getElementById("snipImageLink")?.addEventListener("click", (e) => {
    e.preventDefault();
    startOnPage("START_SNIP");
  });

  // Copy button
  let copyTimer = null;
  copyBtn.addEventListener("click", async () => {
    const text = replyText.value;
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      // Learning signal: the user used this reply (possibly after editing it here)
      const { lastInteractionId } = await chrome.storage.session.get("lastInteractionId");
      if (lastInteractionId) {
        chrome.runtime.sendMessage({ type: "INTERACTION_EVENT", event: "final", interactionId: lastInteractionId, text, action: "popup-copy" });
      }
      copyBtn.classList.add("copied");
      copyBtnText.textContent = "Copied";
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copyBtn.classList.remove("copied");
        copyBtnText.textContent = "Copy";
      }, 1800);
    } catch (err) {
      showError("Could not copy to clipboard. Select and copy manually.");
    }
  });

  // Regenerate button
  regenerateBtn.addEventListener("click", async () => {
    const instructions = instructionsInput.value.trim();
    setLoading(true, "Regenerating reply...");

    chrome.runtime.sendMessage({
      type: "REGENERATE_REPLY",
      instructions: instructions
    });
  });

  // Writing preferences at a glance (full list and editing in Settings)
  chrome.storage.local.get("preferences", ({ preferences = [] }) => {
    const n = preferences.length;
    document.getElementById("prefLineText").textContent = n
      ? `${n} writing preference${n === 1 ? "" : "s"} active`
      : "No writing preferences yet";
  });
  document.getElementById("prefLineLink")?.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html#preferences") });
  });

  // "What I've learned about you" page
  document.getElementById("openProfileBtn")?.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("profile.html") });
  });

  // Settings button
  openSettingsBtn.addEventListener("click", () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL("options.html"));
    }
  });

  // Clear button: wipe the current session (last snip + reply) and start fresh
  const clearSessionBtn = document.getElementById("clearSessionBtn");
  clearSessionBtn?.addEventListener("click", async () => {
    await chrome.storage.session.remove([
      "currentStatus", "lastError", "lastReply", "lastSnippetImage", "lastSnippetText", "lastInstructions", "lastSnipTabId"
    ]);
    instructionsInput.value = "";
    replyText.value = "";
    hideError();
    setLoading(false);
    contextCard.style.display = "none";
    replySection.style.display = "none";
  });

  // Helper to read and render state from chrome.storage.session (cleared when the browser closes)
  function loadStoredState(opening = false) {
    chrome.storage.session.get(
      ["lastSnippetImage", "lastSnippetText", "lastReply", "currentStatus", "lastError"],
      (res) => {
        if (opening && res.currentStatus !== "generating") {
          hideError();
          setLoading(false);
          contextCard.style.display = "none";
          replySection.style.display = "none";
          return;
        }
        // The instruction box is intentionally NOT pre-filled from the last snip:
        // an old instruction like "decline politely" must never silently apply to a new snip.

        // Error handling
        if (res.currentStatus === "error" || res.lastError) {
          setLoading(false);
          showError(res.lastError || "An error occurred generating the reply.");
          return;
        } else {
          hideError();
        }

        // Loading status
        if (res.currentStatus === "generating") {
          setLoading(true, "Analyzing screen capture and drafting reply...");
        } else {
          setLoading(false);
        }

        // Snippet Context Card
        if (res.lastSnippetImage || res.lastSnippetText) {
          contextCard.style.display = "block";
          if (res.lastSnippetImage) {
            snippetThumb.src = res.lastSnippetImage;
            snippetThumb.style.display = "block";
          } else {
            snippetThumb.style.display = "none";
          }
          // show the message as plain text (the **bold** / _italic_ / ## markers are for the model)
          snippetTextPreview.textContent = (res.lastSnippetText || "").replace(/\*\*|(^|\s)_|_(?=\s|$)|^##\s*/gm, "$1").replace(/\s+/g, " ").trim() || "Screenshot of the message";
        } else {
          contextCard.style.display = "none";
        }

        // Generated Reply Section
        if (res.lastReply) {
          replySection.style.display = "flex";
          replyText.value = res.lastReply;
        } else if (res.currentStatus !== "generating") {
          replySection.style.display = "none";
        }
      }
    );
  }

  function setLoading(isLoading, message = "") {
    if (isLoading) {
      statusCard.style.display = "flex";
      statusMessage.textContent = message || "Processing...";
    } else {
      statusCard.style.display = "none";
    }
  }

  function showError(msg) {
    errorBanner.style.display = "block";
    if (msg.includes("API key")) {
      errorBanner.innerHTML = `${msg} <a id="errSettingsLink">Open Settings</a>`;
      document.getElementById("errSettingsLink")?.addEventListener("click", () => {
        chrome.runtime.openOptionsPage();
      });
    } else {
      errorBanner.textContent = msg;
    }
  }

  function updateProviderBadge() {
    if (!activeProviderBadge) return;
    chrome.storage.sync.get({ provider: "local", apiKey: "", model: "", localLlmUrl: "http://localhost:11434", localModel: "" }, (res) => {
      const isLocal = res.provider !== "openrouter";
      if (isLocal) {
        const modelName = res.localModel || "Local";
        activeProviderBadge.textContent = modelName === "Local" ? "Local model" : modelName.replace(/:latest$/, "");
        activeProviderBadge.title = `Active: Local LLM (${modelName})\nClick to configure`;

      } else {
        const modelName = res.model ? res.model.split("/").pop() : "Cloud";
        activeProviderBadge.textContent = modelName === "Cloud" ? "Cloud model" : modelName;
        activeProviderBadge.title = `Active: OpenRouter (${res.model || "openrouter/free"})\nClick to configure`;

      }
    });
  }

  function hideError() {
    errorBanner.style.display = "none";
    errorBanner.textContent = "";
  }
});

