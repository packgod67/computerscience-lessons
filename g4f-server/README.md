# gpt4free server

OpenAI-compatible API server that proxies to various free AI providers via
reverse engineering. Deployed as a separate Render service so the main
arcade can call it from the Cloudflare worker as an extra LLM tier.

## Deploy to Render

1. **Render dashboard** → **New +** → **Web Service**
2. **Connect your GitHub repo** (`packgod67/computerscience-lessons`)
3. Fill in these settings:

   | Field | Value |
   |---|---|
   | **Name** | `arcade-g4f` (or anything you like) |
   | **Region** | same as your arcade (Frankfurt/Oregon/whichever) |
   | **Branch** | `main` |
   | **Root Directory** | `g4f-server` |
   | **Runtime** | `Python 3` |
   | **Build Command** | `pip install -r requirements.txt` |
   | **Start Command** | `g4f api --bind 0.0.0.0:$PORT` |
   | **Instance Type** | `Free` |

4. Click **Create Web Service**
5. Wait ~3-5 minutes for first build. When it shows **Live**, copy the URL
   (looks like `https://arcade-g4f.onrender.com`)
6. Paste the URL into the arcade's Cloudflare worker as the `G4F_URL`
   environment variable (no secret needed — it's just a URL, not an API key)

## Important — Free tier cold starts

Render's free tier **spins down the service after 15 min of inactivity**.
The next request after a cold-down wakes it up, taking ~30-60 seconds
before it responds. Subsequent requests in the same session are fast.

For Kirky, this means the FIRST query after a quiet period might time out
on g4f and fall through to Groq/Pollinations. That's fine — our cooldown
logic handles it gracefully.

To keep it warm 24/7, upgrade to a paid instance (~$7/month) or use an
external ping service like `uptimerobot.com` every 10 min to keep the
service hot.

## Why this vs just using Groq

- **More models.** g4f can route to GPT-5, Claude 4.6, Gemini Pro, Grok,
  Kimi — all for free, no API keys.
- **Bigger pool.** Not rate-limited by any single provider's quota.
- **Caveat:** reverse-engineered providers break frequently. Your worker
  should treat g4f as a "bonus tier" that falls through to official APIs
  when it's down.

## Test after deploy

```bash
curl -X POST https://arcade-g4f.onrender.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role":"user","content":"say hi in 3 words"}]
  }'
```

If you get a JSON response with `choices[0].message.content`, it works.
If you get a 503 or timeout, the provider that model uses is currently
broken — try a different model (`deepseek-v3`, `gemini-2.0-flash`, etc.)
or wait and retry.
