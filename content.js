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
      console.log("Button clicked!");
    });

    box.setAttribute("data-ai-reply-processed", "true");
  });
}

const observer = new MutationObserver(() => {
  scanForComposeBoxes();
});

observer.observe(document.body, { childList: true, subtree: true });

scanForComposeBoxes();