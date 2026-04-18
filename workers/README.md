# Workers

## `groq-proxy.js` — Free Llama-3.3-70B recommendations for all users

This Cloudflare Worker sits between the arcade and Groq's API. It holds the admin's Groq key server-side so visitors never need to authenticate to get high-quality AI recommendations.

### One-time setup (~5 minutes)

1. **Get a Groq API key** at <https://console.groq.com/keys>. Free tier is 14,400 requests/day — plenty for an arcade.

2. **Create a Cloudflare Worker**:
   - Sign up at <https://dash.cloudflare.com/> (free).
   - Workers & Pages → Create → Create Worker.
   - Name it `arcade-groq` (or anything).
   - Click "Edit Code" and paste the full contents of `groq-proxy.js`.
   - Click **Deploy**.

3. **Add your Groq key as a secret**:
   - In the worker's page: Settings → Variables and Secrets → Add variable.
   - Choose **Secret** type.
   - Name: `GROQ_API_KEY`  Value: your `gsk_...` key.
   - Click **Deploy** again so the secret takes effect.

4. **Copy the worker URL** (something like `https://arcade-groq.yourname.workers.dev`).

5. **Tell the arcade to use it**: open the site, type this into your browser console:
   ```js
   localStorage.setItem('arcade-groq-worker-url', 'https://arcade-groq.yourname.workers.dev');
   ```
   (Or use the admin settings toggle once we wire up a UI for it.)

### Verifying it works

Hit the recommender (⚡ button in the search bar). Open devtools → Network. You should see a POST to your worker URL. The source badge should say "⚡ AI-picked" and responses should be noticeably smarter and faster than the pollinations fallback.

### Costs

- Cloudflare Workers free tier: 100,000 requests/day.
- Groq free tier: 14,400 requests/day across all your apps.

The worker is the bottleneck at 14,400/day unless you upgrade Groq or add caching. For an arcade, that's thousands of recommendations — should be far more than you'll ever hit.

### Disabling

Remove the localStorage entry (or wipe site data) and the recommender falls back to pollinations automatically.
