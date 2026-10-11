// options.js

// Restores select box and text fields state using the preferences stored in chrome.storage.
const restoreOptions = () => {
  chrome.storage.sync.get(
    {
      apiKey: '',
      model: '',
      localLlmUrl: '',
      defaultTone: 'Professional',
      defaultLength: 'Medium'
    },
    (items) => {
      document.getElementById('apiKey').value = items.apiKey;
      document.getElementById('model').value = items.model;
      document.getElementById('localLlmUrl').value = items.localLlmUrl;
      document.getElementById('defaultTone').value = items.defaultTone;
      document.getElementById('defaultLength').value = items.defaultLength;
    }
  );
};

// Saves options to chrome.storage
const saveOptions = () => {
  const apiKey = document.getElementById('apiKey').value.trim();
  const model = document.getElementById('model').value.trim();
  const localLlmUrl = document.getElementById('localLlmUrl').value.trim();
  const defaultTone = document.getElementById('defaultTone').value;
  const defaultLength = document.getElementById('defaultLength').value;

  chrome.storage.sync.set(
    {
      apiKey: apiKey,
      model: model,
      localLlmUrl: localLlmUrl,
      defaultTone: defaultTone,
      defaultLength: defaultLength
    },
    () => {
      // Update status to let user know options were saved.
      const status = document.getElementById('status');
      status.style.opacity = 1;
      setTimeout(() => {
        status.style.opacity = 0;
      }, 2000);
    }
  );
};

document.addEventListener('DOMContentLoaded', () => {
  restoreOptions();
  loadMetrics();
});

document.getElementById('saveBtn').addEventListener('click', saveOptions);

// Loads and renders behavioral stats (Levenshtein distances)
function loadMetrics() {
  chrome.storage.local.get(["behavioralStats"], (result) => {
    const stats = result.behavioralStats;
    const metricsList = document.getElementById("metricsList");
    
    if (!stats || Object.keys(stats).length === 0) {
      return; // Leave the default "no data" message
    }

    metricsList.innerHTML = ""; // Clear existing

    for (const [intent, stat] of Object.entries(stats)) {
      const simPercent = Math.round(stat.avgSimilarity * 100);
      
      let barColor = "var(--primary)";
      if (simPercent < 50) barColor = "#EF4444"; // Red if low similarity
      else if (simPercent > 85) barColor = "#10B981"; // Green if high similarity
      
      const html = `
        <div class="metric-card">
          <div class="metric-header">
            <span>Intent: <strong style="text-transform: capitalize;">${intent.replace(/_/g, " ")}</strong></span>
            <span style="color: ${barColor}">${simPercent}% Match</span>
          </div>
          <div class="progress-bar-bg">
            <div class="progress-bar-fill" style="width: ${simPercent}%; background-color: ${barColor};"></div>
          </div>
          <div class="metric-stats">
            <span>Total Emails Sent: ${stat.count}</span>
            <span>Avg Edit Distance: ${Math.round(stat.totalEdits / stat.count)} chars</span>
          </div>
        </div>
      `;
      metricsList.innerHTML += html;
    }
  });
}
