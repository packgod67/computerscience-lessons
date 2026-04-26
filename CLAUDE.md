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

- **Hosting mirrors** — the same repo deploys to several hosts so we
  have multiple URLs and no single-host outage takes the arcade down:
  | Host | URL | Headers config |
  | --- | --- | --- |
  | Render (primary) | `computerscience-lessons.onrender.com` | `_headers` (ignored — coi-serviceworker covers /play/) |
  | Vercel | `computer-sciencelessons.vercel.app` | `vercel.json` |
  | Cloudflare Pages | `computerscience-lessons.pages.dev` | `_headers` (native) |
  | GitHub Pages | `packgod67.github.io/computerscience-lessons` | none (coi-serviceworker covers /play/) |
  | Deno Deploy | `<project>.deno.dev` | `serve.ts` (TS handler adds them) |
  | Netlify | `computer-sciencelessons.netlify.app` | `_headers` (native — same syntax as CF Pages) |
  All git-connected hosts auto-deploy on push to `main`. Surge requires
  manual `surge .` from repo root.
- **`_headers`** (Render/Netlify/Cloudflare Pages syntax) is honored
  on Cloudflare Pages and Netlify natively. Vercel ignores it (uses
  `vercel.json`). Render ignores it (relies on coi-serviceworker for
  PS2). All three header configs (`_headers`, `vercel.json`, the
  COOP/COEP block in `serve.ts`) define the SAME rules — keep them in
  sync when changing the policy.
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
    | `uploads.ungrounded.net` | Newgrounds Flash + HTML5 uploads |
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
  - **Hotlink-protection bypass**: itch injects
    `static.itch.io/htmlgame.js` into ~40% of games. The script
    reads the parent frame's origin and redirects to
    `itch.io/embed-hotlink/<id>` if the parent isn't itch.io. Old
    Unity games with synchronous loaders escape this (their engine
    replaces the document before the deferred script runs); modern
    Godot/GameMaker games don't.
  - **Use the Deno proxy** for any game whose HTML contains
    `htmlgame.js`: iframe
    `https://computersciencelessons.packgod67.deno.net/itch/<game_path>`
    instead of the direct itch URL. The proxy fetches itch's HTML,
    strips the script, injects a `<base href>` so relative URLs
    loop back through it. Saves persist per-Deno-origin.
    See `serve.ts` `/itch/` handler. (The same proxy logic also
    lives at `workers/groq-proxy.js` `/itch/` as a backup; we
    moved primary to Deno because *.workers.dev is on too many
    tracker blocklists.)
  - **Detection script**: `node audit-itch.mjs` reports every iframe
    game with htmlgame.js or a dead URL.
  - **Bulk migration**: `node migrate-itch-proxy.mjs --apply`
    rewrites every wrapper that needs the proxy.
- **Newgrounds Flash pattern**: iframe `play/flash/?title=<t>&swf=<encoded SWF URL>`.
  The page bundles Ruffle (Rust/WASM Flash emulator) from unpkg, fetches
  the SWF via the worker's ROM proxy (Newgrounds' `uploads.ungrounded.net`
  pins ACAO to newgrounds.com so direct fetch fails), and plays it.
  Save data persists per-origin via SharedObject in localStorage.
  - **SWF URL discovery**: portal page HTML contains a JSON blob like
    `embedController([{"url":"https:\/\/uploads.ungrounded.net\/<bucket>\/<id>_<slug>.swf",...}])`.
    Bucket = `floor(portal_id / 1000) * 1000`. Extract via regex.
  - **Cover URL**: `https://picon.ngfiles.com/<bucket>/flash_<id>_card.png`
    is the canonical thumbnail.
  - **Tags**: always include `flash`, `ruffle`, `newgrounds` plus
    `as2` or `as3` to mark the runtime — useful when triaging
    "doesn't work in Ruffle" reports.
- **Newgrounds HTML5 pattern**: iframe
  `https://uploads.ungrounded.net/alternate/<bucket>/<id>_alternate_<asset>_r<rev>.zip/index.html`
  directly (no Ruffle, no proxy needed — the .zip path acts as a
  server-side directory). Same iframable behaviour as itch HTML5 games.
