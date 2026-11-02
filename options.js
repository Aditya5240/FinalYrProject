// options.js
// Settings and Adaptive Learning Management

// Tab Switching
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    const tabId = btn.getAttribute("data-tab");
    document.getElementById(tabId)?.classList.add("active");
  });
});

// Restores user preferences from chrome.storage.sync
const restoreOptions = () => {
  chrome.storage.sync.get(
    {
      apiKey: "",
      model: "",
      localLlmUrl: "",
      userName: "",
      userSignoff: "",
      customRules: "",
      defaultTone: "Professional",
      defaultLength: "Medium"
    },
    (items) => {
      document.getElementById("apiKey").value = items.apiKey || "";
      document.getElementById("model").value = items.model || "";
      document.getElementById("localLlmUrl").value = items.localLlmUrl || "";
      document.getElementById("userName").value = items.userName || "";
      document.getElementById("userSignoff").value = items.userSignoff || "";
      document.getElementById("customRules").value = items.customRules || "";
      document.getElementById("defaultTone").value = items.defaultTone || "Professional";
      document.getElementById("defaultLength").value = items.defaultLength || "Medium";
    }
  );
};

// Saves user preferences to chrome.storage.sync
const saveOptions = () => {
  const settings = {
    apiKey: document.getElementById("apiKey").value.trim(),
    model: document.getElementById("model").value.trim(),
    localLlmUrl: document.getElementById("localLlmUrl").value.trim(),
    userName: document.getElementById("userName").value.trim(),
    userSignoff: document.getElementById("userSignoff").value.trim(),
    customRules: document.getElementById("customRules").value.trim(),
    defaultTone: document.getElementById("defaultTone").value,
    defaultLength: document.getElementById("defaultLength").value
  };

  chrome.storage.sync.set(settings, () => {
    const status = document.getElementById("status");
    status.style.opacity = "1";
    setTimeout(() => {
      status.style.opacity = "0";
    }, 2000);
  });
};

// Test API Connection
const testApiConnection = async () => {
  const resultEl = document.getElementById("connectionResult");
  const apiKey = document.getElementById("apiKey").value.trim();
  const model = document.getElementById("model").value.trim();
  const localLlmUrl = document.getElementById("localLlmUrl").value.trim();

  resultEl.style.color = "#4F46E5";
  resultEl.innerText = "Connecting...";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "TEST_API_CONNECTION",
      apiKey: apiKey,
      model: model,
      localLlmUrl: localLlmUrl
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

// Renders Behavioral Stats (Levenshtein Distance Metrics)
function loadMetrics() {
  chrome.storage.local.get(["behavioralStats"], (result) => {
    const stats = result.behavioralStats;
    const metricsList = document.getElementById("metricsList");
    
    if (!stats || Object.keys(stats).length === 0) {
      metricsList.innerHTML = `
        <div style="font-size: 13px; color: #64748B; text-align: center; padding: 24px;">
          No learning data collected yet. Send some emails via Gmail to populate metrics!
        </div>
      `;
      return;
    }

    metricsList.innerHTML = "";

    for (const [intent, stat] of Object.entries(stats)) {
      const simPercent = Math.round(stat.avgSimilarity * 100);
      
      let barColor = "#4F46E5";
      if (simPercent < 50) barColor = "#EF4444";
      else if (simPercent > 85) barColor = "#10B981";
      
      const card = document.createElement("div");
      card.className = "metric-card";
      card.innerHTML = `
        <div class="metric-header">
          <span>Intent: <strong style="text-transform: capitalize;">${intent.replace(/_/g, " ")}</strong></span>
          <span style="color: ${barColor}">${simPercent}% Similarity</span>
        </div>
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" style="width: ${simPercent}%; background-color: ${barColor};"></div>
        </div>
        <div class="metric-stats">
          <span>Emails Processed: ${stat.count}</span>
          <span>Avg Edit Distance: ${Math.round(stat.totalEdits / stat.count)} chars</span>
        </div>
      `;
      metricsList.appendChild(card);
    }
  });
}

// Renders Learned Memory Items (Phase 2 & 3 Few-Shot Dataset)
function loadMemoryItems() {
  chrome.storage.local.get(["learningData"], (result) => {
    const list = result.learningData || [];
    const container = document.getElementById("memoryList");

    if (list.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 24px; color: #94A3B8; font-size: 13px;">
          No learning data captured yet. Send emails via Gmail to build your style profile!
        </div>
      `;
      return;
    }

    container.innerHTML = "";

    // Show recent items first
    list.slice().reverse().forEach((item, reversedIdx) => {
      const originalIdx = list.length - 1 - reversedIdx;
      const sim = Math.round((item.similarity || 0) * 100);
      const dateStr = item.timestamp ? new Date(item.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : "Past Session";

      const card = document.createElement("div");
      card.className = "memory-item";
      card.innerHTML = `
        <div class="memory-header">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="memory-badge">${item.intent || 'General'}</span>
            <span style="font-size: 11px; color: #64748B;">${dateStr}</span>
            <span style="font-size: 11px; font-weight: 600; color: ${sim >= 80 ? '#10B981' : '#F59E0B'};">${sim}% Match</span>
          </div>
          <button class="btn btn-danger btn-sm delete-mem-btn" data-index="${originalIdx}" title="Delete this sample">✕ Delete</button>
        </div>
        <div class="memory-diff">
          <div>
            <div class="diff-label">AI Proposed Draft:</div>
            <div class="diff-box">${escapeHtml(item.draft || "(Empty)")}</div>
          </div>
          <div>
            <div class="diff-label">Your Sent Version (Style Target):</div>
            <div class="diff-box">${escapeHtml(item.finalText || "(Empty)")}</div>
          </div>
        </div>
      `;
      container.appendChild(card);
    });

    // Attach individual delete listeners
    container.querySelectorAll(".delete-mem-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const idx = parseInt(e.target.getAttribute("data-index"), 10);
        deleteMemoryItem(idx);
      });
    });
  });
}

function deleteMemoryItem(idx) {
  chrome.storage.local.get(["learningData"], (result) => {
    let list = result.learningData || [];
    if (idx >= 0 && idx < list.length) {
      list.splice(idx, 1);
      // Recalculate behavioralStats
      const newStats = {};
      list.forEach((item) => {
        const intent = item.intent || "Unknown";
        if (!newStats[intent]) {
          newStats[intent] = { totalEdits: 0, avgSimilarity: 0, count: 0 };
        }
        const s = newStats[intent];
        s.count += 1;
        s.totalEdits += (item.editDistance || 0);
        s.avgSimilarity = ((s.avgSimilarity * (s.count - 1)) + (item.similarity || 0)) / s.count;
      });

      chrome.storage.local.set({ learningData: list, behavioralStats: newStats }, () => {
        loadMemoryItems();
        loadMetrics();
      });
    }
  });
}

function addManualReferenceSample() {
  const text = document.getElementById("manualSampleText").value.trim();
  if (!text) return;

  chrome.storage.local.get(["learningData"], (result) => {
    const list = result.learningData || [];
    const sample = {
      intent: "Personal Reference",
      draft: "AI baseline sample",
      finalText: text,
      similarity: 0.92,
      editDistance: 8,
      timestamp: Date.now()
    };
    list.push(sample);

    chrome.storage.local.set({ learningData: list }, () => {
      document.getElementById("manualSampleText").value = "";
      loadMemoryItems();
    });
  });
}

function clearAllMemory() {
  if (confirm("Are you sure you want to clear all learned style memory? This cannot be undone.")) {
    chrome.storage.local.set({ learningData: [], behavioralStats: {} }, () => {
      loadMemoryItems();
      loadMetrics();
    });
  }
}

function exportLearningData() {
  chrome.storage.local.get(["learningData", "behavioralStats"], (result) => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(result, null, 2));
    const dlAnchor = document.createElement("a");
    dlAnchor.setAttribute("href", dataStr);
    dlAnchor.setAttribute("download", `gmail-ai-learning-dataset-${Date.now()}.json`);
    dlAnchor.click();
    dlAnchor.remove();
  });
}

function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

// Initial Listeners
document.addEventListener("DOMContentLoaded", () => {
  restoreOptions();
  loadMetrics();
  loadMemoryItems();
});

document.getElementById("saveBtn")?.addEventListener("click", saveOptions);
document.getElementById("testApiBtn")?.addEventListener("click", testApiConnection);
document.getElementById("addManualSampleBtn")?.addEventListener("click", addManualReferenceSample);
document.getElementById("clearAllMemoryBtn")?.addEventListener("click", clearAllMemory);
document.getElementById("exportDataBtn")?.addEventListener("click", exportLearningData);
