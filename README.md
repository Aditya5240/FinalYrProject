# AI Reply Assistant - General-Purpose Chrome Extension

An intelligent, context-aware Chrome extension that generates contextual replies on **any website or web application** using either **Local LLMs** (Ollama, LM Studio, vLLM) for 100% offline privacy or **Cloud Vision Models** (OpenRouter).

---

## Key Features

1. **Pick a message by clicking it (Alt+S), read from the page itself (DOM)**:
   - Press Alt+S, hover (the block under the mouse is outlined) and click the message: an email, chat, LinkedIn post, comment.
   - The extension reads the page's structure instead of a screenshot, so it gets the **full text however long it is**, plus its
     **formatting**: bold, italic, headings and lists are kept (`**bold**`, `_italic_`, `## heading`, `- item`), and emphasised text is sent
     to the model as **key points** (deadlines, requests, questions).
   - **Context levels:** the clicked block is level 1; each enclosing block that adds more text is the next level. The default is
     5 levels (Settings). The reply card's **− / +** buttons narrow or widen the context, the page outline shows what is included, and
     **Show** displays exactly what the AI reads.
   - **Backup: screenshot snip (Alt+Shift+S)** for images of text, PDFs and canvas apps.

2. **First-Class Local LLM Support (Private & Free)**:
   - Connects to any local LLM runner (Ollama, LM Studio, LocalAI, vLLM).
   - **Auto-Model Detection**: One-click "Detect Models" dynamically queries your local server (`/v1/models` and `/api/tags`) and populates available models into a select dropdown.
   - **Smart Multimodal & Text Routing**: Works with multimodal vision models (e.g., `llava`, `llama3.2-vision`) and text-only models (e.g., `llama3`, `mistral`, `deepseek-r1`) with automatic fallback to prevent HTTP 400 errors.
   - **DeepSeek-R1 / Reasoning Support**: Automatically strips `<think>...</think>` internal reasoning traces from raw outputs so only the final reply is shown.

3. **OpenRouter Cloud Vision Fallback**:
   - Optional cloud provider with fallback chain across free multimodal models (`google/gemma-4-31b-it:free`, `qwen/qwen3.8-27b:free`, `nvidia/nemotron-3-nano-omni:free`, `meta-llama/llama-3.2-11b-vision-instruct:free`).

4. **Universal On-Screen Reply Card & Extension Popup**:
   - Floating reply card, isolated from the website's styles (Shadow DOM) so it looks the same on every site.
   - **Drag** it by the header (position is remembered), **resize** from the bottom-right corner, **minimise** (button or double-click the header), **Esc** to close.
   - **Quick refine**: Shorter, More formal, Friendlier, Say yes, Decline politely, or type your own instruction. These revise the current draft, including your own edits.
   - **Insert**: click in the page's reply box, then press Insert to type the reply straight in (Gmail, LinkedIn, WhatsApp Web, normal text boxes). **Copy** and **Fresh reply** are also available.
   - Live word and character count; errors appear inside the card.
   - Copy/insert events (generated vs. final text) are saved locally as `replyHistory` for the personalisation feature.
   - Extension toolbar popup reflects the active provider badge (`💻 Local: llama3` or `☁️ OpenRouter`).

5. **Personalization & Directives**:
   - Customize your identity name, closing sign-off, and persistent style rules (e.g. "Direct and concise", "Friendly tone").

---

## Installation & Setup

### 1. Load the Extension into Google Chrome

1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Toggle on **Developer mode** in the top-right corner.
3. Click **Load unpacked** in the top-left corner.
4. Select this project directory (`Final Year Project`).
5. The extension icon will now appear in your Chrome toolbar. Click the puzzle icon and pin **AI Reply Assistant**.

---

### 2. Configure Local LLM (Ollama or LM Studio)

#### Option A: Ollama (Recommended)
1. Download and run Ollama from [ollama.com](https://ollama.com).
2. Pull your desired model in terminal:
   ```bash
   # For text-only (uses extracted screen text):
   ollama run llama3

   # OR for vision + text:
   ollama run llava
   # or
   ollama run llama3.2-vision
   ```
3. Open the extension **Settings** (click the gear icon in the popup).
4. Click **Local LLM**.
5. Server URL default is `http://localhost:11434`.
6. Click **🔍 Detect Models** — your installed models will appear in a dropdown!
7. Click **⚡ Test Local Connection** to verify connection latency.
8. Click **Save Settings**.

#### Option B: LM Studio
1. Open LM Studio and start the **Local Server** (default port `1234`).
2. Load any model into memory.
3. In the extension settings, click the **🤖 LM Studio (1234)** chip (`http://localhost:1234`).
4. Click **🔍 Detect Models** and **⚡ Test Local Connection**.
5. Click **Save Settings**.

---

## How to Use

1. **Pick the message**: press **`Alt + S`** (or click **Pick a message** in the popup), hover, and click the message.
2. **Adjust the context if needed**: on the reply card, **−** for less, **+** for more, then **↻ Write reply for this context**.
3. **Use the reply**: edit it, use a refine chip, then **Insert** (into the page's reply box) or **Copy**, and send as usual.
4. For an image, PDF or canvas: **`Alt + Shift + S`** (or the popup's *Snip an area instead* link) and drag a box.

---

## ✨ Personalisation & Self-Learning

The extension learns **your** writing style from how you use it, without training a model.
Everything is stored only on your device (`chrome.storage.local`).

### What it learns from
| Signal | Where it comes from |
|---|---|
| What you actually sent | After **Insert**, the reply box is followed until you send (Enter, Ctrl+Enter or a Send/Post/Reply button, then the box empties or closes), so edits made on the page are learned too. Quoted email threads are ignored. Without a detected send, the last edited version is used. With **Copy**, the text in the card at copy time is used. |
| How you refine | The **Shorter / More formal / Friendlier / Say yes / Decline** buttons and custom rewrites |
| Ratings | **👍 / 👎** on the reply card |
| Rejections | Closing the card without using the reply |
| Context | The website and the sender of the message |

### How it uses it (in every prompt)
1. **Your real past replies as examples:** the 3 most similar past messages are found by meaning (embeddings from your local
   Ollama/LM Studio, e.g. `nomic-embed-text`) or by keywords (TF-IDF) as a fallback, and your actual replies to them are shown to
   the model as examples (few-shot learning). Replies to the same sender and on the same site are preferred; 👎 replies are never used.
2. **Style profile:** measured habits such as usual length (per site), greeting, sign-off, emoji, contractions, exclamation marks,
   phrases you always delete or add, and preferences from refine buttons per site.
3. **Your 5 preferences:** after **every reply you send**, the LLM receives the current 5 preferences plus the new reply (AI draft vs.
   what you sent, refine steps, rating) and returns the updated 5: it keeps what still fits, sharpens it, or replaces the weakest one.
   All 5 go into every prompt. You can edit (edited = pinned), pin 📌, remove or add preferences; every change is logged.

The card shows a **✨ Personalised** badge; hover it to see how many examples, rules and habits were used.

### "What I've learned about you" page
Open it from the popup (💡 icon) or Settings. Tabs:
- **Overview:** replies learned from, % sent unchanged, average edit amount, a chart of edits over time, and personalised vs. generic comparison
- **Writing style:** the exact habits sent to the AI, statistics, deleted/added phrases, per-site table
- **Preferences:** your 5 preferences (edit, pin, remove), "Update preferences now", and a log of how each sent reply changed them
- **History:** every reply with AI draft vs. what you sent, outcome, edit %, rating; delete entries
- **Settings & data:** personalisation on/off (for a baseline comparison), pause learning, auto-learn rules, semantic search setup, export backup (JSON), **export training data (JSONL, chat format) for fine-tuning a model later**, import, reset

### Optional: semantic search
```bash
ollama pull nomic-embed-text
```
Then in **What I've learned → Settings & data**, click **Test & index history**.

### Measuring the learning (for evaluation)
- **Edit amount** = word-level edit distance between the AI's first draft and what you sent (0% = sent unchanged).
- **Sent unchanged** = share of used replies sent without any change.
- Compare **Personalised** vs **Generic** replies (switch personalisation off for some replies), and the first vs second half of your history.

### Code structure
| File | Role |
|---|---|
| `personalization.js` | Learning engine: TF-IDF + embedding retrieval, style statistics, phrase diff (LCS), rule distillation prompt/parsing, metrics, JSONL export |
| `background.js` | Interaction lifecycle, builds the personalised prompt, calls the LLM, runs rule learning, embeddings |
| `content.js` | Snipping, reply card (rating, badge, refine), sends learning signals |
| `profile.html/js` | "What I've learned about you" dashboard |
