# Training your personal reply model

This folder contains `train_reply_model.ipynb`, a Google Colab notebook that fine-tunes **Llama 3.2 3B Instruct**
to write replies in your style and exports it for Ollama.

## Steps
1. In the extension: **What I've learned → Settings & data → ⬇ Export training data (JSONL)**.
2. Open https://colab.research.google.com → **File → Upload notebook** → choose `train_reply_model.ipynb`.
3. **Runtime → Change runtime type → T4 GPU**, then **Runtime → Run all**.
4. When asked (cell 3), upload the JSONL file. About 30–45 minutes later the model is in your Google Drive
   folder `ai-reply-model` (a `.gguf` file, `Modelfile`, `evaluation_results.csv`).
5. Download that folder to your laptop (e.g. `C:\ai-reply-model`) and run in PowerShell:
   ```
   cd C:\ai-reply-model
   ollama create aditya-reply -f Modelfile
   ollama run aditya-reply "Can you join the meeting at 10 tomorrow?"
   ```
6. In the extension: **Settings → Local LLM → Detect Models → aditya-reply → Save**.

## How the training works
| Stage | Data | Purpose |
| --- | --- | --- |
| 1. General reply skill | ~1,500 message → reply pairs from the public SODA dialogue dataset (allenai/soda, CC-BY-4.0) | teaches the model to answer as the person who received the message |
| 2. Personal style | your exported replies (80% of them; 20% are held out for testing) | adapts tone, length, greetings and sign-offs to you |

- Method: **LoRA** (rank 16) on a 4-bit model with Unsloth; only the reply part of each example is trained on.
- The prompt format is identical to what the extension sends, so the model behaves the same inside the extension.
- Export: adapters merged and converted to GGUF (`q4_k_m`, about 2 GB) with a Llama 3 chat template Modelfile.

## Evaluation (printed by the notebook, saved as `evaluation_results.csv`)
On your held-out replies it compares the base model, the model after stage 1, and after stage 2:
- **Edit amount**: word-level edit distance to what you actually sent (same metric as the extension dashboard; lower is better)
- **ROUGE-L**: word overlap in order with what you sent (higher is better)
- **Length difference** in words (lower is better)

After loading the model, keep using the extension: its dashboard now shows a row per model, so you can compare
`llama3.2:latest` and `aditya-reply` on real replies.

## Notes
- With fewer than ~30 personal replies, stage 2 has a modest effect; re-run the notebook as you collect more.
- Your uploaded replies are processed on Google Colab's servers during the session.
