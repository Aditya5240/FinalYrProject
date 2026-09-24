function togglePanel() {
  let panel = document.getElementById("ai-reply-panel");

  if (panel) {
    panel.remove();
    return;
  }

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

  panel.innerHTML = "<strong>AI Reply Panel</strong><p>Content coming soon.</p>";

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

    const toolbar = sendBtn.parentElement;

    const button = document.createElement("div");
    button.innerText = "AI Reply";
    button.style.border = "2px solid red";
    button.style.padding = "4px 10px";
    button.style.marginRight = "8px";
    button.style.cursor = "pointer";
    button.style.display = "inline-flex";
    button.style.alignItems = "center";

    toolbar.insertBefore(button, toolbar.firstChild);

    button.addEventListener("click", () => {
      togglePanel();
    });

    box.setAttribute("data-ai-reply-processed", "true");
  });
}

const observer = new MutationObserver(() => {
  scanForComposeBoxes();
});

observer.observe(document.body, { childList: true, subtree: true });

scanForComposeBoxes();