# /play — Play! PS2 emulator

Self-hosted build of the [Play! PS2 emulator](https://github.com/jpd002/Play-),
from the publicly-redistributable BSD-licensed WASM release at
[playjs.purei.org](https://playjs.purei.org/).

## What's here

- `index.html` — patched entry point. Reads `?rom=<url>` from the query
  string, fetches the ROM, and feeds it into Play!'s file input via
  `DataTransfer` so the user doesn't have to browse a file picker.
- `Play.wasm`, `Play.js` — emulator core.
- `static/js/main.fd7fdcec.js`, `static/css/main.5a525eca.css` — Play!'s
  React UI, unchanged.

All of the above was fetched from playjs.purei.org and committed as-is.
When Play! publishes an update (a new `main.xxxxx.js` hash or Play.wasm
rebuild), re-download and replace these files.

## Why it's self-hosted

Play!'s hosted build has no URL-loading API — it's strictly a file picker.
To embed it in game cards we need to boot straight into a ROM from its
archive.org URL, which requires patching the page. Because our arcade's
main pages aren't cross-origin-isolated (deliberately — COEP breaks our
archive.org iframes), we can't just iframe the purei.org build either.
Hosting under `/play/*` with its own COOP/COEP header block is the clean
split.

## Required host configuration

The emulator needs SharedArrayBuffer → needs cross-origin isolation →
needs these HTTP response headers on everything under `/play/*`:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: cross-origin
```

These are set in the repo-root `_headers` file (Render/Netlify/Cloudflare
Pages syntax — Render honors it for static sites).

The Cloudflare worker's `/rom?src=...` proxy also had to add
`Cross-Origin-Resource-Policy: cross-origin` so COEP-isolated pages can
fetch ROMs through it.

## Using it from a game card

For a PS2 game entry, the game's HTML file should iframe this emulator:

```html
<iframe src="/play/index.html?rom=<encoded-rom-url>&name=<display-name>"
        allow="cross-origin-isolated; autoplay; gamepad *"
        style="width:100%;height:100vh;border:0;">
</iframe>
```

The ROM URL still goes through the worker's `/rom` proxy, same as all our
other ROM games:

```
/rom?src=<URL-encoded-archive.org-URL>
```

## Compatibility

Play! on desktop plays hundreds of games. The WASM browser build is much
more limited — per the project's own README: "not meant to play all games
that are currently supported by the emulator on desktop". Racing games
are typically the worst case.

Reasonable test targets (known to at least boot in Play! desktop — browser
build still varies):
- Homebrew + PS2 demos
- 2D puzzle games (Puzzle Bobble, Bishi Bashi Special)
- Lighter 3D (Gradius V, Katamari Damacy)

The heavy racing titles the arcade wants (NFS Most Wanted PS2, GT3, GT4)
push the hardest on the emulator and are where failures cluster. Test
before advertising.

## Verifying the deployment

1. Push. Wait for Render to redeploy.
2. Visit `https://<your-render-url>/play/` directly.
3. Confirm: (a) the page loads, (b) you see a file picker and the Play!
   logo, (c) the browser console shows no CORP/COEP errors.
4. Pick a local `.iso`/`.chd`/`.bin` of a game you own. The PS2 BIOS
   animation should play.
5. Only after step 4 succeeds do PS2 game catalog entries make sense to
   add — otherwise clicking a card loads a broken emulator and looks
   worse than no PS2 tab at all.

## License

Play! is BSD 2-clause. Attribution is in `index.html` (bottom-right
corner). Source: https://github.com/jpd002/Play-
