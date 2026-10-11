function getLatestThreadText() {
  const bodies = document.querySelectorAll(".a3s.aiL, .a3s");
  if (bodies.length === 0) return "No email content found.";
  const last = bodies[bodies.length - 1];
  return last.innerText.trim();
}

function closePanelIfNoComposeBox() {
  const composeBoxes = document.querySelectorAll('div[aria-label="Message Body"][role="textbox"]');
  const panel = document.getElementById("ai-reply-panel");

  if (panel) {
    let anyVisible = false;
    composeBoxes.forEach((box) => {
      // Gmail often hides compose boxes instead of removing them from the DOM
      if (box.getBoundingClientRect().width > 0) {
        anyVisible = true;
      }
    });

    if (!anyVisible) {
      panel.remove();
    }
  }
}

function insertIntoComposeBox(text, intent) {
  const composeBoxes = document.querySelectorAll('div[aria-label="Message Body"][role="textbox"]');
  for (let box of composeBoxes) {
    if (box.getBoundingClientRect().width > 0) {
      const sig = box.querySelector('.gmail_signature');
      
      // Fully replace the content instead of prepending, but preserve the signature if it exists
      if (text === "") {
        box.innerHTML = sig ? '<br><br>' + sig.outerHTML : '';
      } else {
        box.innerHTML = text.replace(/\n/g, '<br>') + (sig ? '<br><br>' + sig.outerHTML : '');
      }
      
      box.dispatchEvent(new Event('input', { bubbles: true }));
      
      // Store draft and intent on the compose box for Phase 2 learning
      box.dataset.aiDraft = text;
      box.dataset.aiIntent = intent || "Unknown";
      break;
    }
  }
}

async function togglePanel(contextOverride = null, toneOverride = null, lengthOverride = null) {
  let panel = document.getElementById("ai-reply-panel");
  
  // If it exists and we're NOT regenerating, just close it.
  if (panel && !contextOverride && !toneOverride && !lengthOverride) {
    panel.remove();
    return;
  }

  // If it doesn't exist, create it
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "ai-reply-panel";
    panel.style.position = "fixed";
    panel.style.top = "80px";
    panel.style.right = "20px";
    panel.style.width = "320px";
    panel.style.padding = "16px";
    panel.style.background = "white";
    panel.style.border = "1px solid #ccc";
    panel.style.borderRadius = "8px";
    panel.style.boxShadow = "0 4px 12px rgba(0,0,0,0.2)";
    panel.style.zIndex = "9999";

    // Make panel draggable
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let panelStartX = 0;
    let panelStartY = 0;

    panel.addEventListener('mousedown', (e) => {
      // Allow dragging if clicking on the header (strong tag)
      if (e.target.tagName.toLowerCase() === 'strong') {
        isDragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        
        const rect = panel.getBoundingClientRect();
        panelStartX = rect.left;
        panelStartY = rect.top;
        
        e.preventDefault(); // Prevent text selection
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      
      panel.style.right = 'auto'; // Disable right anchoring
      panel.style.left = `${panelStartX + dx}px`;
      panel.style.top = `${panelStartY + dy}px`;
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });

    document.body.appendChild(panel);
  }

  const emailContent = contextOverride || getLatestThreadText();
  const isRegenerating = toneOverride || lengthOverride || contextOverride;

  if (isRegenerating) {
    // Only show loading inside the specific parts of the UI, don't destroy the whole panel
    const draftBox = document.getElementById("ai-draft-text");
    if (draftBox) draftBox.innerHTML = `<em>Regenerating...</em>`;
    const missingBox = document.getElementById("ai-regenerate-btn");
    if (missingBox) missingBox.innerText = `Regenerating...`;
  } else {
    // Show a full loading state initially
    panel.innerHTML = `
      <strong style="display: block; margin-bottom: 8px; cursor: move;" title="Drag to move">AI Reply Panel ✥</strong>
      <div style="font-size: 13px; color: #666; max-height: 300px; overflow-y: auto;">
        <em>Generating reply...</em>
      </div>
    `;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "GENERATE_REPLY",
      emailContent: emailContent,
      tone: toneOverride,
      length: lengthOverride
    });

    console.log("Got response from background:", response);

    // Update panel with the background's response
    if (typeof response.reply === "string") {
      panel.innerHTML = `
        <strong style="display: block; margin-bottom: 8px; cursor: move;" title="Drag to move">AI Reply Panel ✥</strong>
        <div style="font-size: 13px; color: red; max-height: 300px; overflow-y: auto;">
          ${response.reply}
        </div>
      `;
      return;
    }

    const { intent, confidence, draft, missing_info } = response.reply;
    
    let html = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <strong style="cursor: move; flex-grow: 1;" title="Drag to move">AI Reply Panel ✥</strong>
        <span style="font-size: 11px; background: #eee; padding: 2px 6px; border-radius: 4px;">${intent || 'Unknown'} (${confidence || '?'})</span>
      </div>
    `;

    if (missing_info && missing_info.length > 0) {
      html += `<div style="font-size: 13px; color: #d93025; margin-bottom: 8px;"><strong>Missing Info Needed:</strong></div>`;
      missing_info.forEach((info, idx) => {
        html += `<div style="margin-bottom: 8px;">
          <label style="font-size: 12px; display: block; margin-bottom: 4px;">${info}</label>
          <input type="text" id="missing-info-${idx}" style="width: 100%; box-sizing: border-box; padding: 4px; border: 1px solid #ccc; border-radius: 4px;">
        </div>`;
      });
      html += `<button type="button" id="ai-regenerate-btn" style="width: 100%; padding: 6px; background: #4F46E5; color: white; border: none; border-radius: 4px; cursor: pointer; margin-top: 8px;">Answer & Regenerate</button>`;
    } else {
      html += `
        <div style="display: flex; gap: 8px; margin-bottom: 8px;">
          <select id="ai-override-tone" style="flex: 1; padding: 4px; font-size: 12px; border-radius: 4px; border: 1px solid #ccc;">
            <option value="" ${!toneOverride ? 'selected' : ''}>Default Tone</option>
            <option value="Professional" ${toneOverride === 'Professional' ? 'selected' : ''}>Professional</option>
            <option value="Friendly" ${toneOverride === 'Friendly' ? 'selected' : ''}>Friendly</option>
            <option value="Direct" ${toneOverride === 'Direct' ? 'selected' : ''}>Direct</option>
            <option value="Casual" ${toneOverride === 'Casual' ? 'selected' : ''}>Casual</option>
          </select>
          <select id="ai-override-length" style="flex: 1; padding: 4px; font-size: 12px; border-radius: 4px; border: 1px solid #ccc;">
            <option value="" ${!lengthOverride ? 'selected' : ''}>Default Length</option>
            <option value="Short" ${lengthOverride === 'Short' ? 'selected' : ''}>Short</option>
            <option value="Medium" ${lengthOverride === 'Medium' ? 'selected' : ''}>Medium</option>
            <option value="Detailed" ${lengthOverride === 'Detailed' ? 'selected' : ''}>Detailed</option>
          </select>
          <button type="button" id="ai-re-roll-btn" style="padding: 4px 8px; background: #6B7280; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;" title="Regenerate">↻</button>
        </div>
        <div style="font-size: 13px; color: #333; max-height: 200px; overflow-y: auto; margin-bottom: 12px; padding: 8px; border: 1px solid #e5e7eb; border-radius: 4px; background: #f9fafb; white-space: pre-wrap;" id="ai-draft-text">${draft || "No draft generated."}</div>
        <div style="display: flex; gap: 8px;">
          <button type="button" id="ai-insert-btn" style="flex: 2; padding: 8px; background: #10B981; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">Insert into Gmail</button>
          <button type="button" id="ai-clear-btn" style="flex: 1; padding: 8px; background: #EF4444; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">Clear Box</button>
        </div>
      `;
    }

    panel.innerHTML = html;

    // Attach event listeners
    if (missing_info && missing_info.length > 0) {
      document.getElementById("ai-regenerate-btn").addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        let answers = [];
        missing_info.forEach((info, idx) => {
          const val = document.getElementById(`missing-info-${idx}`).value;
          if (val) answers.push(`Q: ${info}\nA: ${val}`);
        });
        
        let newContent = emailContent;
        if (answers.length > 0) {
          newContent += "\n\nUser provided additional info for the reply:\n" + answers.join("\n");
        }
        
        // Regenerate using the same panel
        togglePanel(newContent, toneOverride, lengthOverride);
      });
    } else {
      document.getElementById("ai-re-roll-btn")?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const tone = document.getElementById("ai-override-tone").value;
        const length = document.getElementById("ai-override-length").value;
        togglePanel(contextOverride, tone || null, length || null);
      });

      document.getElementById("ai-insert-btn").addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const draftText = document.getElementById("ai-draft-text").innerText;
        insertIntoComposeBox(draftText, intent);
        // Panel remains open
      });
      
      document.getElementById("ai-clear-btn")?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        insertIntoComposeBox("", intent);
      });
    }
  } catch (error) {
    console.error("Error sending message to background:", error);
    panel.innerHTML = `
      <strong style="display: block; margin-bottom: 8px; cursor: move;" title="Drag to move">AI Reply Panel ✥</strong>
      <div style="font-size: 13px; color: red; max-height: 300px; overflow-y: auto;">
        Error communicating with background script. (Make sure you reloaded the extension)
      </div>
    `;
  }
}

function scanForComposeBoxes() {
  const composeBoxes = document.querySelectorAll('div[aria-label="Message Body"][role="textbox"]');

  composeBoxes.forEach((box) => {
    if (box.getAttribute("data-ai-reply-processed")) {
      return; // already handled, skip
    }

    // Climb up from the message body to the compose dialog/container
    const composeContainer = box.closest("div[role='dialog'], table.Bs-mZ, div.aoI, body");

    // Find Gmail's own Send button inside that container
    const sendBtn = composeContainer.querySelector('div[role="button"][aria-label^="Send"]');

    if (!sendBtn) {
      return; // toolbar not rendered yet, we'll catch it on the next mutation
    }

    // Attach listener to capture AI draft vs final sent text for Phase 2
    // Use mousedown instead of click, because Gmail often intercepts clicks or tears down the DOM too fast
    sendBtn.addEventListener("mousedown", () => {
      console.log("Send button mousedown detected!");
      const draft = box.dataset.aiDraft;
      const intent = box.dataset.aiIntent;
      
      console.log("AI Draft stored on this box:", draft);
      console.log("AI Intent stored on this box:", intent);
      
      if (draft) {
        const finalSentText = box.innerText.trim();
        console.log("Final text about to be sent:", finalSentText);
        
        chrome.runtime.sendMessage({
          type: "LEARNING_CAPTURE",
          payload: {
            intent: intent,
            draft: draft,
            finalText: finalSentText,
            timestamp: Date.now()
          }
        });
      }
    });

    // sendBtn is inside a container that has the blue background in the new Gmail UI
    const sendBtnGroup = sendBtn.parentElement;
    const toolbar = sendBtnGroup.parentElement;

    const button = document.createElement("div");
    button.innerText = "AI Reply";
    button.className = "ai-reply-button"; // Add class for outside click detection
    button.style.border = "1px solid #d93025";
    button.style.color = "#d93025";
    button.style.borderRadius = "18px";
    button.style.padding = "0 16px";
    button.style.height = "36px";
    button.style.marginRight = "12px"; // Increased slightly for breathing room
    button.style.cursor = "pointer";
    button.style.display = "inline-flex";
    button.style.alignItems = "center";
    button.style.fontWeight = "500";
    button.style.fontSize = "14px";
    button.style.backgroundColor = "white";
    button.style.transition = "background-color 0.2s";

    // Add slight hover effect for better UX
    button.onmouseover = () => button.style.backgroundColor = "#fce8e6";
    button.onmouseout = () => button.style.backgroundColor = "white";

    // Insert right before the blue Send button group
    toolbar.insertBefore(button, sendBtnGroup);

    button.addEventListener("click", (e) => {
      e.stopPropagation(); // Stop event so the document click listener doesn't instantly close it
      togglePanel();
    });

    box.setAttribute("data-ai-reply-processed", "true");
  });
}

// The document click listener that removes the panel has been entirely deleted 
// so the panel stays open indefinitely until manually toggled via toolbar.

const observer = new MutationObserver(() => {
  scanForComposeBoxes();
  closePanelIfNoComposeBox();
});

observer.observe(document.body, { childList: true, subtree: true });

scanForComposeBoxes();