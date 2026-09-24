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

function togglePanel() {
  const existing = document.getElementById("ai-reply-panel");
  if (existing) {
    existing.remove();
    return; // Exit early to actually toggle (close) the panel
  }

  const panel = document.createElement("div");
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

  panel.innerHTML = `
    <strong style="display: block; margin-bottom: 8px;">AI Reply Panel</strong>
    <div style="font-size: 13px; color: #333; max-height: 300px; overflow-y: auto;">
      ${getLatestThreadText()}
    </div>
  `;

  document.body.appendChild(panel);
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

// Close panel when clicking outside of it
document.addEventListener("click", (event) => {
  const panel = document.getElementById("ai-reply-panel");
  if (!panel) return;

  // Ignore clicks inside the panel itself
  if (panel.contains(event.target)) return;

  // Ignore clicks on the AI Reply button (handled by button's click listener)
  if (event.target.closest(".ai-reply-button")) return;

  // Otherwise, we clicked outside, so remove the panel
  panel.remove();
});

const observer = new MutationObserver(() => {
  scanForComposeBoxes();
  closePanelIfNoComposeBox();
});

observer.observe(document.body, { childList: true, subtree: true });

scanForComposeBoxes();