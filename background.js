// background.js
// Service worker for background tasks and API calls

chrome.runtime.onInstalled.addListener(() => {
  console.log("Gmail AI Reply Assistant installed.");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GENERATE_REPLY") {
    console.log("Background received email content:", message.emailContent);

    callOpenRouterAPI(message.emailContent, message.tone, message.length)
      .then(replyText => {
        sendResponse({ reply: replyText });
      })
      .catch(error => {
        console.error("OpenRouter API Error:", error);
        // Send the actual error message back to the page so it's easier to see
        sendResponse({ reply: `API Error: ${error.message || error}` });
      });

    return true; // Keep the message channel open for the async response
  }
  
  if (message.type === "LEARNING_CAPTURE") {
    console.log("Captured learning data:", message.payload);
    
    const aiDraft = message.payload.draft || "";
    const finalSentText = message.payload.finalText || "";
    
    const distance = levenshtein(aiDraft, finalSentText);
    const maxLen = Math.max(aiDraft.length, finalSentText.length);
    const similarity = maxLen === 0 ? 1 : 1 - (distance / maxLen);
    
    message.payload.editDistance = distance;
    message.payload.similarity = similarity;
    
    console.log(`Edit Distance: ${distance}, Similarity: ${(similarity * 100).toFixed(2)}%`);

    chrome.storage.local.get(["learningData", "behavioralStats"], (result) => {
      const data = result.learningData || [];
      data.push(message.payload);
      
      const stats = result.behavioralStats || {};
      const intent = message.payload.intent || "Unknown";
      
      if (!stats[intent]) {
        stats[intent] = { totalEdits: 0, avgSimilarity: 0, count: 0 };
      }
      
      const currentStat = stats[intent];
      const newCount = currentStat.count + 1;
      const newAvgSimilarity = ((currentStat.avgSimilarity * currentStat.count) + similarity) / newCount;
      
      stats[intent] = {
        totalEdits: currentStat.totalEdits + distance,
        avgSimilarity: newAvgSimilarity,
        count: newCount
      };

      chrome.storage.local.set({ learningData: data, behavioralStats: stats });
    });
  }
});

// Levenshtein distance implementation
function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          Math.min(matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j] + 1) // deletion
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

async function callOpenRouterAPI(emailText, toneOverride, lengthOverride) {
  // Read API key and preferred model from storage instead of hardcoding them
  const { apiKey, model: preferredModel, localLlmUrl, defaultTone, defaultLength } = await chrome.storage.sync.get([
    "apiKey", "model", "localLlmUrl", "defaultTone", "defaultLength"
  ]);

  // Read learning data to inject few-shot examples (Phase 2 Learning)
  const { learningData } = await chrome.storage.local.get("learningData");
  
  let styleContext = "";
  if (learningData && learningData.length > 0) {
    // Filter for examples where user made actual edits (similarity < 0.95), and get the 3 most recent
    const recentEdits = learningData
      .filter(item => item.similarity < 0.95 && item.finalText)
      .slice(-3);
      
    if (recentEdits.length > 0) {
      styleContext = "\n\nUSER'S PERSONAL STYLE EXAMPLES:\nThe user often edits AI drafts to match their personal voice. Here are some examples of what the AI generated previously, and what the user actually sent:\n";
      recentEdits.forEach((edit, idx) => {
        styleContext += `\nExample ${idx + 1}:\n- AI Draft: "${edit.draft}"\n- User's Final Sent Version (MIMIC THIS STYLE): "${edit.finalText}"\n`;
      });
      styleContext += "\nUse these examples to adapt your response to match the User's Final Sent Version style.\n";
    }
  }

  if (!apiKey) {
    throw new Error("No API key set. Please configure it in the extension settings.");
  }

  const finalTone = toneOverride || defaultTone || 'Professional';
  const finalLength = lengthOverride || defaultLength || 'Medium';

  // Fallback chain: preferred model from storage goes first, then built-in backups
  // Verified free models as of Sept 2026
  const FALLBACK_MODELS = [
    "nvidia/nemotron-3-ultra:free",         // Reasoning, coding, agents
    "google/gemma-4-31b-it:free",          // Great for documents & reasoning
    "google/gemma-4-26b-a4b-it:free",      // Multimodal, coding, reasoning
    "stealth/space-bunny-alpha",            // Proven to work, 1M context
    "qwen/qwen3.8-27b:free",               // Coding, multimodal, agents
    "thinking-machines/inkling:free",       // Reasoning, coding, RAG (fixed slug)
    "thinking-machines/inkling-small:free", // Smaller, faster version
    "nvidia/nemotron-3.5-lightning:free",   // High-throughput tasks
    "nvidia/nemotron-3-super:free",         // Multi-agent reasoning
    "poolside/laguna-s-2.1:free",           // Coding agents
    "inclusionai/ling-3.0-flash-fin:free",  // Reasoning & coding
    "dots-studio/dots3-note-preview:free",  // Reasoning, multimodal (fixed slug)
    "cohere/north-mini-code:free",          // Software engineering
    "nvidia/nemotron-3-nano-omni:free",     // Multimodal fallback
  ];

  // If a preferred model is saved, use it first; otherwise fall straight to the backup list
  const MODELS = preferredModel
    ? [preferredModel, ...FALLBACK_MODELS.filter(m => m !== preferredModel)]
    : FALLBACK_MODELS;

  let lastError = null;

  for (const model of MODELS) {
    console.log(`Trying model: ${model}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      console.warn(`Model ${model} timed out after 30s, trying next...`);
    }, 30000); // 30 second timeout per model

    try {
      const apiUrl = localLlmUrl || "https://openrouter.ai/api/v1/chat/completions";
      const response = await fetch(apiUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          "model": model,
          "messages": [
            {
              "role": "system",
              "content": `You are a strict, automated email reply generator. You are reading an email thread that the user received. You must draft a reply ON BEHALF OF THE USER, back to the sender.
Your tone should be: ${finalTone}.
Your length should be: ${finalLength}.

CRITICAL INSTRUCTIONS:
1. You are replying TO the sender, FROM the user. Do NOT act like customer support, and do NOT adopt the persona of the system that sent the email (e.g., do not tell the user to "click the reset link").
2. You are NOT a conversational chatbot. Do NOT offer generic help and do NOT ask "how can I help?".
3. If the email is an automated notification (e.g. password reset) that usually doesn't require a reply, just draft a short acknowledgment (e.g., "Received, thanks") or leave it blank.
4. If the email can be replied to, draft the reply and leave "missing_info" as an empty array [].
5. ONLY populate "missing_info" if a critical piece of factual information (like a date, a name, or a decision) is strictly required to draft the reply. Never ask for "what action to take".
${styleContext}
You MUST output ONLY a valid JSON object with the following schema, and no other text:
{
  "intent": "classification of the email (e.g. enquiry, complaint, meeting, etc.)",
  "confidence": "high/medium/low",
  "draft": "the actual email reply body to send",
  "missing_info": ["array of specific factual questions (e.g. 'What time works for you?'), or leave empty []"]
}`
            },
            {
              "role": "user",
              "content": emailText
            }
          ]
        })
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text();
        console.warn(`Model ${model} failed: ${response.status} - ${errorText}`);
        lastError = `Status ${response.status} on model ${model}`;
        continue; // Try the next model
      }

      const data = await response.json();
      console.log(`Success with model: ${model}`);
      
      let content = data.choices[0].message.content;
      // Strip markdown block if present
      if (content.startsWith("\`\`\`json")) {
        content = content.replace(/^\`\`\`json\s*/, "").replace(/\s*\`\`\`$/, "");
      } else if (content.startsWith("\`\`\`")) {
        content = content.replace(/^\`\`\`\s*/, "").replace(/\s*\`\`\`$/, "");
      }
      
      let parsedResponse;
      try {
        parsedResponse = JSON.parse(content);
      } catch (parseErr) {
        console.warn("Failed to parse JSON response:", content);
        // Fallback for non-compliant models
        parsedResponse = {
          intent: "unknown",
          confidence: "low",
          draft: content,
          missing_info: []
        };
      }
      
      return parsedResponse;

    } catch (err) {
      clearTimeout(timeout);
      console.warn(`Model ${model} threw an error:`, err.message);
      lastError = err.message;
      continue; // Try the next model
    }
  }

  throw new Error(`All models failed. Last error: ${lastError}`);
}

