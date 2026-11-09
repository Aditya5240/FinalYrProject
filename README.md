# Reply Assistant

A Chrome extension that writes replies to any message on any website (email, chat, LinkedIn, Classroom, forums), **in your own style**, and gets better the more replies you send.

- **Click the message, get a reply.** Nothing to copy or paste.
- **Learns from what you actually send**, including the edits you make before sending.
- **Private if you want it:** runs on a model on your own computer, so your messages never leave it. A cloud option is available too.
- **You stay in control:** what it has learned is shown as 5 plain-language preferences that you can read, edit and pin.

---

## Get started in 5 minutes

### 1. Install the extension

1. Download this project: on GitHub click **Code → Download ZIP** and unzip it, or run `git clone https://github.com/Aditya5240/FinalYrProject.git`.
2. In Chrome, open `chrome://extensions`.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and choose the project folder (the one that contains `manifest.json`).
5. Click the puzzle icon in the toolbar and pin **Reply Assistant**.

### 2. Choose a model that writes the replies

Open the extension's **Settings**: click the toolbar icon, then the gear. Pick one of the options below. Settings save by themselves.

**A. Ollama on your computer (free and private, recommended)**
1. Install Ollama from [ollama.com](https://ollama.com) and start it.
2. In a terminal, run:
   ```bash
   ollama pull llama3.2
   ollama pull nomic-embed-text   # optional: better matching of your past replies
   ```
3. In Settings, choose **Your own model**, set App to **Ollama**, and press **Refresh**. Your model appears in the list.
4. Press **Test**. It should say *Working*.

**B. LM Studio on your computer**
1. In LM Studio, load a model and start the **Local Server** (port 1234).
2. In Settings, choose **Your own model**, set App to **LM Studio**, press **Refresh**, then **Test**.

**C. A server someone gave you (lab, university or company server)**

Use this if you were given an address like `http://10.20.30.57:8000`. It works with any OpenAI-compatible server: vLLM, LiteLLM, llama.cpp, or Ollama or LM Studio on another machine.
1. Make sure this computer is on the **same network** as the server (college Wi-Fi or VPN). To check, open `<address>/v1/models` in Chrome. If you see a list of models, you're connected.
2. In Settings, choose **Your own model** and set App to **Other address**.
3. Paste the address (with or without `/v1`). Fill in **Access key** only if you were given one.
4. Pick the model from the list and press **Test**.

**D. Cloud (OpenRouter)**
1. Create a free key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. In Settings, choose **Cloud**, paste the key, and press **Test**.

### 3. Tell it who you are (optional)

In Settings → **About you**, add your name. You can also add a sign-off and a writing note such as "Keep it short." Leave the sign-off empty and it will learn yours.

That's it. Go to any page with a message.

---

## How to use it

1. **Pick the message.** Press **Alt+S**, or click the toolbar icon and then **Pick a message to reply to**. Move the mouse over the message (it gets outlined) and click it.
2. **Check what it will read.** The reply card opens with **Reading 3 of 7** and **− / +** buttons. The dashed outline on the page shows exactly what will be read. Press **+** to include more (the whole thread) or **−** for less (just that message).
3. **Optional: say what you want before it writes.**
   - Tone buttons: **Shorter, Formal, Friendlier, Say yes, Decline**. You can combine them.
   - A note, for example *"mention I'm free on Friday"*.
4. **Press Write reply** (or Enter). The draft appears in the card.
5. **Adjust if needed.**
   - Edit the text directly.
   - Press a tone button or type what should change, then press **Rewrite**.
   - Press **↻** for a fresh reply.
   - Press **Clear draft** to empty the draft.
6. **Use it.** Click inside the page's reply box, then press **Insert into reply**, or use **Copy**.
   - Changed your mind after inserting? Edit the draft and press **Update reply** to swap it. **Clear** removes it from the page.
7. **Send it as usual.** The extension notices what you actually sent and learns from it.

Other things you can do:
- **Pick another** (top of the card) switches to a different message.
- **Drag** the card by its title, **resize** it from the corner, and press **Esc** to close it.
- **👍 / 👎** tells it whether a reply was good.
- **Image, PDF or canvas app?** Press **Alt+Shift+S** (or **Snip an area instead** in the popup) and drag a box over the message. This needs a model that can read images, such as `llava` or `llama3.2-vision`.

To change the shortcuts, open `chrome://extensions/shortcuts`.

---

## How it learns your style

You don't need to train anything. It learns while you use it, and everything is stored only in your browser.

| It looks at | So that |
|---|---|
| **What you actually sent** (after Insert it follows the reply box until you press Send) | your edits teach it what you'd really write |
| How much you changed its draft | it can measure whether it's improving |
| Tone buttons, 👍 / 👎, closing without using a reply | it learns what you like and dislike |
| The website and who the message is from | replies to your manager and to a friend can differ |

Every reply it writes uses three things:
1. **Your 5 preferences:** short rules like *"Sign off with just 'Thanks, Aditya'"*. They are rewritten automatically after every reply you send. See and edit them in **Settings → Your writing preferences**, from the popup, or by clicking **In your style** on the card. Pin one to keep it fixed.
2. **Your past replies to similar messages:** the 3 closest ones are shown to the model as examples.
3. **Your measured habits:** usual length, greeting, sign-off, emoji, and phrases you always delete.

To see everything it has learned, open **What I've learned about you**: the lightbulb icon in the popup, or Settings → Reading and more. It has charts, your history, the preference log, and backup, export and reset.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| **HTTP 403 with Ollama** | In PowerShell run `setx OLLAMA_ORIGINS "chrome-extension://*"`, fully quit Ollama from the system tray, and start it again. |
| **"Can't reach …"** | Make sure Ollama or LM Studio is running. For a server address, check you're on the same network and that `<address>/v1/models` opens in Chrome. |
| **"The server refused access" (401 / 403)** | The server needs an access key. Enter it in Settings under **Other address**. |
| **"Model not found"** | In Settings, press **Refresh** and pick a model from the list. |
| **Nothing happens on a page** | Refresh the page (F5). This is needed once after installing or reloading the extension. |
| **Insert does nothing** | Click inside the page's reply box first, then press Insert, or use **Copy** and paste. |
| **Slow first reply** | The model is loading into memory. Later replies are faster. Big shared models can take up to a minute. |
| **Snip says "no readable text"** | Your model can't read images. Use **Alt+S** to pick the message instead, or install a vision model. |

---

## Privacy

- With **Your own model**, messages go only to the model you chose: your own computer or the server you entered.
- Your history, preferences and settings are stored in Chrome on your device (`chrome.storage`). They are never uploaded anywhere.
- You can pause learning, export your data, or reset everything from **What I've learned → Settings & data**.

---

## For developers

| File | What it does |
|---|---|
| `manifest.json` | Chrome extension setup (Manifest V3), permissions, shortcuts |
| `content.js` | Runs on web pages: picking a message (reads the page's HTML, levels, bold/italic as key points), the reply card, Insert/Update/Clear, follows the reply box until it is sent, the snip backup |
| `background.js` | Builds the personalised prompt, talks to the model (Ollama, LM Studio, any OpenAI-compatible server, OpenRouter), updates the 5 preferences, embeddings |
| `personalization.js` | The learning engine: finding similar past replies (TF-IDF and embeddings), style statistics, edit distance, preference update prompt, metrics, training-data export |
| `popup.html/js` | The toolbar popup |
| `options.html/js` | Settings |
| `profile.html/js` | The "What I've learned about you" dashboard |
| `training/` | Optional: fine-tune your own small model in Google Colab from your exported replies (LoRA, exported to Ollama). Start with `training/TRAINING.md` |

After changing code, press the reload icon on the extension in `chrome://extensions`, then refresh the web page.
