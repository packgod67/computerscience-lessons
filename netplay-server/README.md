# Arcade Netplay Relay

Vendored from [EmulatorJS/EmulatorJS-Netplay](https://github.com/EmulatorJS/EmulatorJS-Netplay) (Apache 2.0). Self-hosted because the official `netplay.emulatorjs.org` server has been returning HTTP 525 (SSL handshake failed at Cloudflare) since at least April 2026.

## What it is

A Socket.IO relay that:
- Tracks open netplay rooms keyed by `sessionId`
- Relays `data-message`, `webrtc-signal`, `snapshot`, `input` events between peers in the same room
- Exposes `GET /list?game_id=X` for the EmulatorJS client to discover open rooms

The actual game data (frames, inputs, savestates) goes peer-to-peer over WebRTC; this server just handles signaling.

## Deploy to Render (recommended)

The repo contains a `render.yaml` Blueprint at this directory.

1. Sign in to **render.com** → click **New** → **Blueprint**
2. Connect to `packgod67/computerscience-lessons`
3. Render reads `netplay-server/render.yaml` and creates a Web Service named `arcade-netplay`
4. Wait ~3 minutes for first deploy
5. URL is `https://arcade-netplay.onrender.com` (or whatever Render assigns)

## Deploy elsewhere

Any Node 18+ host. Single file (`server.js`), three deps (`express`, `socket.io`, `cors`).

- **Vercel / Netlify / Cloudflare Pages**: NO — they're static-only
- **Vercel Edge Functions**: NO — limited WebSocket support
- **Render Web Service** (free): YES — but cold starts hurt netplay (active rooms die when server sleeps)
- **Fly.io**: paid only as of 2024
- **Railway**: $5/mo credit
- **Koyeb** (free tier): YES — 1 service, no advertised cold starts

The cold-start issue means free tiers drop your room mid-game if everyone's been idle 15min. Plan accordingly.

## Hook the arcade up

Once deployed, set `window.ARCADE_CONFIG.netplayServer` in `js/config.js`:

```js
window.ARCADE_CONFIG = {
    // ... existing fields
    netplayServer: 'https://arcade-netplay.onrender.com',
};
```

Pokemon Quetzal's wrapper reads this and falls back to the (currently broken) official server only if it's not set.

## Test the relay is working

```bash
curl https://arcade-netplay.onrender.com/list?game_id=test
# Expected: {} (empty object — no rooms yet)

curl https://arcade-netplay.onrender.com/
# Expected: 404 from express (no root handler — but that's fine, healthcheck still works as long as TCP responds)
```

If you want a healthier `/` response, modify `server.js` to add `app.get('/', (req, res) => res.json({ ok: true }))` near the other route handlers.

## Update from upstream

```bash
curl -sf https://raw.githubusercontent.com/EmulatorJS/EmulatorJS-Netplay/main/server.js > server.js
# Review the diff before commit — upstream might add fields we'd want to keep
```
