# Notes for Claude / future agents working on this repo

## House rule: every new game in `games/games.json` must ship with

1. **A cover image** (`thumbnail` field) — pointing at a real image, not the
   `assets/thumbnails/platforms/<rom>.png` platform fallback. Sources we
   trust:
   - **libretro thumbnails CDN** for retail console games
     (`https://thumbnails.libretro.com/<Platform>/Named_Boxarts/<Name>.png`)
   - **pokemonrom.net** og:image for Pokemon ROM hacks
   - **visualboyadvance.org** og:image for GBA/GBC hacks not on pokemonrom
   - **crazygames.com / poki / itch.io** og:image for HTML5 games
   - **The game's own CDN** (e.g. `pokerogue.net/images/logo.png`)
   The `<img onerror>` handler in `app.js` falls back to the platform PNG
   if a remote URL ever 404s, so a dead URL doesn't break the card —
   but we should still pick covers that work today.

2. **A real description** (`description` field, 30-300 chars) — what the
   game IS, not "Game pulled from <site>." Stub descriptions are why
   users can't tell entries apart. One sentence is fine; mention the
   genre, the hook, and (for hacks) what's different about this one.

3. **Specific tags** (`tags` field, 4+ items) — favor narrow tags over
   broad ones so users can filter precisely. Examples of the granular
   tag taxonomy in use:
   - Roguelites: `roguelite`, `roguelike`, `permadeath`, `procgen`,
     `run-based`, `meta-progression`, `bullet-heaven`,
     `auto-attacker`, `dungeon-crawler`, `2d-roguelite`,
     `card-roguelite`, `monster-tamer-roguelite`, `arena-roguelite`
   - Pokemon: `pokemon`, `monster-tamer`, `fakemon`, `rom-hack`,
     `difficulty-hack`, `randomizer`
   - Racing: `racing`, `cars`, `nfs`, `gran-turismo`, `tuner`,
     `simulation`, `arcade`, `crash`
   - Platforms: `gba`, `gbc`, `gb`, `ds`, `n64`, `psx`, `ps2`,
     `nes`, `snes`, `genesis`, `arcade`, `html5`, `itch`,
     `browser-native`, `external`
   Always include at least one platform tag.

4. **A specific category** (`category` field) — use one of:
   `Pokemon`, `Racing`, `Adventure`, `Action`, `Sports`, `Puzzle`,
   `Strategy`, `Simulation`, `Shooter`, `Platformer`, `Fighting`,
   `Horror`, `Mario`, `Sonic`, `Minecraft`, `Other`. Avoid `Other`
   if anything more specific fits.

5. **`addedAt: <ISO timestamp>`** so the NEW badge surfaces it for
   30 days and the home grid sorts it to the top.

## Validate before commit

Run `node validate-catalog.mjs` in the repo root. It exits non-zero
if any entry with `addedAt` is missing a cover, description, tags,
or category. Use it as a pre-flight check after batch-adding games.

## Other site-wide notes

- **Render** is the primary host. **Vercel** is a secondary deploy of
  the same repo. Both get every push. Custom DNS lives in each
  platform's dashboard.
- **`_headers`** (Render/Netlify/Cloudflare Pages syntax) is honored
  on Vercel via `vercel.json` not by the file. Both files exist; they
  define the same COOP/COEP rules for `/play/*` (Play! PS2 emulator
  needs cross-origin isolation).
- **Cloudflare worker** at `arcad-groq.gatabanumai.workers.dev` is
  the LLM proxy + ROM proxy + needs manual redeploy from
  `workers/groq-proxy.js` whenever you change it. Source-of-truth
  is the file, NOT the dashboard.
  - **ROM-proxy allowed hosts** (anything else returns 403):
    | Host | What it's for |
    | --- | --- |
    | `archive.org` and `*.archive.org` | retail console ROMs |
    | `raw.githubusercontent.com` | GitHub raw files (100 MB cap) |
    | `objects.githubusercontent.com` | GitHub Releases (2 GB/file) |
    | `github.com` | direct repo URLs (rare) |
    | `cdn.jsdelivr.net` | GitHub + npm CDN proxy |
    | `cdn.statically.io` | alt CDN proxy for GitHub |
    | `gitlab.com` | GitLab raw URLs |
    | `*.gitlab.io` | GitLab Pages |
    | `codeberg.org` | Gitea-based GitHub alternative |
    | `*.pages.dev` | Cloudflare Pages |
    | `*.r2.dev` | Cloudflare R2 public buckets |
    | `*.itch.zone` | itch.io game asset CDN |
  - When sourcing a new game ROM, prefer hosts already in this
    list. If the only working source is on a host NOT here, add
    it (with a comment justifying why) — but be skeptical: any
    new host expands the abuse surface of the open proxy.
- **`/play/`** subdir hosts the BSD-licensed Play! PS2 emulator
  build with a URL-loader shim, IDB cache, parallel-Range downloader,
  and Background Fetch support. Path-scoped service workers handle
  COOP/COEP and background download events.
- **PS2 game pattern**: HTML file does a top-frame redirect to
  `/play/index.html?rom=<encoded-worker-url>` to escape the arcade's
  iframe wrapper (cross-origin isolation can't propagate through
  unsanctioned parent frames).
- **itch.io game pattern**: iframe `https://html-classic.itch.zone/html/<id>/index.html`
  directly. The itch.io page itself blocks external embed via CSP
  `frame-ancestors`, but the underlying build URL has no such
  restriction. Extract the embed ID from the itch page's
  `iframe_placeholder` data.
