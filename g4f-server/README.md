# gpt4free server

OpenAI-compatible API that proxies to various free AI providers via
reverse engineering. Deploy this as a separate service so the Arcade's
Cloudflare worker can route Kirky through it as an extra LLM tier.

## Recommended: Hugging Face Spaces (free, always-on, no cold starts)

This is the best option for a solo hobbyist — no credit card, always
warm, Python-native.

### Deploy steps

1. **Create a Hugging Face account** at [huggingface.co](https://huggingface.co)
2. **New Space:** [huggingface.co/new-space](https://huggingface.co/new-space)
   - **Owner:** your username
   - **Space name:** `arcade-g4f`
   - **License:** MIT
   - **Space SDK:** **Docker** (not Gradio, not Streamlit)
   - **Docker template:** Blank
   - **Hardware:** CPU basic (free)
   - **Visibility:** Public
3. Click **Create Space**
4. You'll land on the new Space's page. Click **Files** tab.
5. Upload these three files from your local `g4f-server/` folder:
   - `Dockerfile`
   - `requirements.txt`
   - `hf-space-README.md` → **rename to `README.md`** during upload
     (HF needs the frontmatter in `README.md` at the Space's root)
6. HF will automatically start building. Watch the **Logs** tab.
7. Build takes ~3-8 minutes (Docker image + pip install).
8. When Status shows **Running**, the API is live at:
   ```
   https://<your-username>-arcade-g4f.hf.space
   ```
   (format: `<username>-<spacename>.hf.space`, lowercase)

### Test

```bash
curl https://<your-username>-arcade-g4f.hf.space/v1/models
```

Expected: a JSON list of available models.

```bash
curl -X POST https://<your-username>-arcade-g4f.hf.space/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'
```

Expected: a JSON response with `choices[0].message.content`.

### Wire into the arcade

Once the endpoint works:
1. Cloudflare dashboard → `arcade-groq` worker → **Settings** → **Variables and Secrets**
2. **Add Variable** (not Secret)
3. Name: `G4F_URL`
4. Value: your HF Space URL (e.g. `https://yourname-arcade-g4f.hf.space`)
5. Save
6. Edit Code → paste the latest `workers/groq-proxy.js` → Deploy

## Alternative: Render (free tier, cold starts after 15 min idle)

If you prefer Render, use a Web Service with:

| Field | Value |
|---|---|
| Root Directory | `g4f-server` |
| Runtime | Python 3 |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `g4f api --bind 0.0.0.0:$PORT` |
| Instance Type | Free |

Render's free tier sleeps after 15 min of inactivity — use UptimeRobot
to keep it warm, or accept ~30-60s cold starts.

## Why this exists

Kirky (the arcade's chat assistant) uses a cascade of LLM providers.
gpt4free gives access to premium models (GPT, Claude, Gemini Pro) for
free via reverse engineering — unreliable but occasionally offers
better responses than Groq's Llama 3.3. The worker treats g4f as a
"bonus tier": try it first, fall back to stable providers if it fails.

Reverse-engineered providers break regularly (when the upstream
services update their bot detection or rotate endpoints). Don't rely
on g4f alone for anything production.
