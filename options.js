// options.js - Settings & API Management

let currentProvider = "local";

// Restores user preferences from chrome.storage.sync
const restoreOptions = () => {
  chrome.storage.sync.get(
    {
      provider: "local",
      apiKey: "",
      model: "openrouter/free",
      localLlmUrl: "http://localhost:11434",
      localModel: "",
      userName: "",
      userSignoff: "",
      customRules: "",
      contextLevels: 5
    },
    (items) => {
      // If user had an API key and no local URL set previously, respect that
      if (!items.localLlmUrl && items.apiKey) {
        currentProvider = items.provider || "openrouter";
      } else {
        currentProvider = items.provider || "local";
      }

      setProvider(currentProvider);

      document.getElementById("apiKey").value = items.apiKey || "";
      document.getElementById("model").value = items.model || "openrouter/free";
      document.getElementById("localLlmUrl").value = items.localLlmUrl || "http://localhost:11434";
      document.getElementById("localModel").value = items.localModel || "";
      document.getElementById("userName").value = items.userName || "";
      document.getElementById("userSignoff").value = items.userSignoff || "";
      document.getElementById("customRules").value = items.customRules || "";
      document.getElementById("contextLevels").value = items.contextLevels || 5;
    }
  );
};

function setProvider(provider) {
  currentProvider = provider;
  const cardLocal = document.getElementById("cardLocal");
  const cardCloud = document.getElementById("cardCloud");
  const sectionLocal = document.getElementById("sectionLocal");
  const sectionCloud = document.getElementById("sectionCloud");
  const badge = document.getElementById("activeProviderBadge");

  if (provider === "local") {
    cardLocal.classList.add("active");
    cardCloud.classList.remove("active");
    sectionLocal.style.display = "block";
    sectionCloud.style.display = "none";
    badge.textContent = "💻 Local LLM";
    badge.style.background = "#EEF2FF";
    badge.style.color = "#4F46E5";
  } else {
    cardCloud.classList.add("active");
    cardLocal.classList.remove("active");
    sectionCloud.style.display = "block";
    sectionLocal.style.display = "none";
    badge.textContent = "☁️ OpenRouter";
    badge.style.background = "#EFF6FF";
    badge.style.color = "#2563EB";
  }
}

// Saves user preferences to chrome.storage.sync
const saveOptions = () => {
  const settings = {
    provider: currentProvider,
    apiKey: document.getElementById("apiKey").value.trim(),
    model: document.getElementById("model").value.trim() || "openrouter/free",
    localLlmUrl: document.getElementById("localLlmUrl").value.trim() || "http://localhost:11434",
    localModel: document.getElementById("localModel").value.trim(), // empty = use the first installed chat model
    userName: document.getElementById("userName").value.trim(),
    userSignoff: document.getElementById("userSignoff").value.trim(),
    customRules: document.getElementById("customRules").value.trim(),
    contextLevels: Math.min(10, Math.max(1, parseInt(document.getElementById("contextLevels").value, 10) || 5))
  };

  chrome.storage.sync.set(settings, () => {
    const status = document.getElementById("status");
    status.style.opacity = "1";
    setTimeout(() => {
      status.style.opacity = "0";
    }, 2000);
  });
};

// Auto-detect installed models on the local server
const detectLocalModels = async () => {
  const url = document.getElementById("localLlmUrl").value.trim() || "http://localhost:11434";
  const btn = document.getElementById("detectLocalModelsBtn");
  const resultBox = document.getElementById("detectedModelsBox");
  const select = document.getElementById("detectedModelsSelect");
  const input = document.getElementById("localModel");

  btn.disabled = true;
  btn.textContent = "Checking...";

  try {
    const res = await chrome.runtime.sendMessage({
      type: "FETCH_LOCAL_MODELS",
      url: url
    });

    if (res && res.success && Array.isArray(res.models) && res.models.length > 0) {
      select.innerHTML = "";
      res.models.forEach((m) => {
        const opt = document.createElement("option");
        opt.value = m;
        const embed = /embed|bge-|bge:|minilm|\be5-|gte-|arctic|mxbai|paraphrase/i.test(m);
        opt.textContent = embed ? `${m}  (embedding model, used for semantic search, not for replies)` : m;
        opt.disabled = embed;
        if (m === input.value.trim() && !embed) opt.selected = true;
        select.appendChild(opt);
      });
      // If nothing valid is selected yet, pick the first chat model
      if (!select.value || select.selectedOptions[0]?.disabled) {
        const firstChat = [...select.options].find((o) => !o.disabled);
        if (firstChat) firstChat.selected = true;
      }

      resultBox.style.display = "block";
      // Update input with selected
      input.value = select.value;
      btn.textContent = `✓ Found (${res.models.length})`;
      btn.style.color = "#10B981";

      select.onchange = () => {
        input.value = select.value;
      };
    } else {
      btn.textContent = "No models found";
      btn.style.color = "#EF4444";
      alert(`Connected to ${url}, but no models were returned. Have you pulled any models yet? (e.g. 'ollama pull llama3.2')`);
    }
  } catch (err) {
    btn.textContent = "Failed";
    btn.style.color = "#EF4444";
    alert(`Could not connect to ${url}. Make sure your local LLM server (Ollama or LM Studio) is running.`);
  } finally {
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = "🔍 Detect Models";
      btn.style.color = "";
    }, 3000);
  }
};

// Test Local Connection
const testLocalConnection = async () => {
  const resultEl = document.getElementById("localTestResult");
  const localUrl = document.getElementById("localLlmUrl").value.trim() || "http://localhost:11434";
  const localModel = document.getElementById("localModel").value.trim();

  resultEl.style.color = "#4F46E5";
  resultEl.innerText = "Connecting to local server...";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "TEST_API_CONNECTION",
      provider: "local",
      localLlmUrl: localUrl,
      localModel: localModel
    });

    if (response && response.success) {
      resultEl.style.color = "#10B981";
      resultEl.innerText = `✓ ${response.message}`;
    } else {
      resultEl.style.color = "#EF4444";
      resultEl.innerText = `✕ ${response ? response.error : 'Connection failed'}`;
    }
  } catch (err) {
    resultEl.style.color = "#EF4444";
    resultEl.innerText = `✕ Error: ${err.message || err}`;
  }
};

// Test Cloud Connection
const testCloudConnection = async () => {
  const resultEl = document.getElementById("cloudTestResult");
  const apiKey = document.getElementById("apiKey").value.trim();
  const model = document.getElementById("model").value.trim() || "openrouter/free";

  resultEl.style.color = "#4F46E5";
  resultEl.innerText = "Connecting to OpenRouter...";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "TEST_API_CONNECTION",
      provider: "openrouter",
      apiKey: apiKey,
      model: model
    });

    if (response && response.success) {
      resultEl.style.color = "#10B981";
      resultEl.innerText = `✓ ${response.message}`;
    } else {
      resultEl.style.color = "#EF4444";
      resultEl.innerText = `✕ ${response ? response.error : 'Connection failed'}`;
    }
  } catch (err) {
    resultEl.style.color = "#EF4444";
    resultEl.innerText = `✕ Error: ${err.message || err}`;
  }
};

// Setup Listeners
document.addEventListener("DOMContentLoaded", () => {
  restoreOptions();

  // Provider switcher
  document.getElementById("cardLocal")?.addEventListener("click", () => setProvider("local"));
  document.getElementById("cardCloud")?.addEventListener("click", () => setProvider("openrouter"));

  // Local preset chips
  document.getElementById("chipOllama")?.addEventListener("click", () => {
    document.getElementById("localLlmUrl").value = "http://localhost:11434";
    detectLocalModels();
  });
  document.getElementById("chipLmStudio")?.addEventListener("click", () => {
    document.getElementById("localLlmUrl").value = "http://localhost:1234";
    detectLocalModels();
  });
  document.getElementById("chipLocalAi")?.addEventListener("click", () => {
    document.getElementById("localLlmUrl").value = "http://localhost:8080";
  });

  // Cloud preset chips
  document.getElementById("chipOpenRouterFree")?.addEventListener("click", () => {
    document.getElementById("model").value = "openrouter/free";
  });
  document.getElementById("chipGemma")?.addEventListener("click", () => {
    document.getElementById("model").value = "google/gemma-4-31b-it:free";
  });
  document.getElementById("chipQwen")?.addEventListener("click", () => {
    document.getElementById("model").value = "qwen/qwen3.8-27b:free";
  });

  // Detect models
  document.getElementById("detectLocalModelsBtn")?.addEventListener("click", detectLocalModels);

  // Connection testers
  document.getElementById("testLocalBtn")?.addEventListener("click", testLocalConnection);
  document.getElementById("testCloudBtn")?.addEventListener("click", testCloudConnection);

  // Save button
  document.getElementById("saveBtn")?.addEventListener("click", saveOptions);

  // Personalisation dashboard
  document.getElementById("openProfileBtn")?.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("profile.html") });
  });
});
