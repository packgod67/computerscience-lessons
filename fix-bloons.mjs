// Bulk-rewrite all Bloons TD wrappers using a clean self-contained
// Ruffle template + verified-working SWF URLs. The original wrappers
// either iframed 3kh0's page (which has ad injection breaking in
// iframes), used dead repos, or used outdated <object>/<embed>
// patterns that don't always work with Ruffle.
//
// All SWFs HEAD-checked 200 + CORS-open before this script runs.

import fs from 'node:fs';

// path → { title, swf }
const FIXES = {
    'games/clbloonstd.html': {
        title: 'Bloons Tower Defense',
        swf: 'https://cdn.jsdelivr.net/gh/bubbls/UGS-file-encryption@main/bloons-tower-defense-1.swf',
    },
    'games/clbloonsTD1.html': {
        title: 'Bloons Tower Defense 1',
        swf: 'https://cdn.jsdelivr.net/gh/bubbls/UGS-file-encryption@main/bloons-tower-defense-1.swf',
    },
    'games/clbloonsTD2.html': {
        title: 'Bloons Tower Defense 2',
        swf: 'https://cdn.jsdelivr.net/gh/vjspranav/FlashGames@c4afbfe9dd12f23ef93e19d7f3d298105448f349/games/Bloons_Tower_Defense_2.swf',
    },
    'games/clbloonsTD3.html': {
        title: 'Bloons Tower Defense 3',
        swf: 'https://cdn.jsdelivr.net/gh/bubbls/UGS-file-encryption@main/Bloons_Tower_Defense_3.swf',
    },
    'games/clbloonsTD4.html': {
        title: 'Bloons Tower Defense 4',
        swf: 'https://cdn.jsdelivr.net/gh/QiProject/flash-games@8a30ea684498b868a7b1cd188bd860ba2042eb56/Bloons-Tower-Defense-4.swf',
    },
    'games/clbloonsTD5.html': {
        title: 'Bloons Tower Defense 5',
        swf: 'https://cdn.jsdelivr.net/gh/bubbls/UGS-file-encryption@b6b363179429fc584fac223384f1b45cc419d1a7/WDzRSvadTXBNOR.swf',
    },
    'games/clBTD1.html': {
        title: 'BTD 1',
        swf: 'https://cdn.jsdelivr.net/gh/bubbls/UGS-file-encryption@main/bloons-tower-defense-1.swf',
    },
    'games/clbtd5.html': {
        title: 'BTD 5',
        swf: 'https://cdn.jsdelivr.net/gh/bubbls/UGS-file-encryption@b6b363179429fc584fac223384f1b45cc419d1a7/WDzRSvadTXBNOR.swf',
    },
};

// Clean Ruffle template — official Ruffle from npm CDN. Loads the
// SWF directly (no third-party preloader). 4:3 letterbox so the
// classic Flash 800x600 aspect ratio doesn't get stretched on
// modern wide displays.
function template({ title, swf }) {
    const safeTitle = title.replace(/[<>&]/g, '');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
  <title>${safeTitle}</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; width: 100%; background: #000; overflow: hidden; }
    #ruffle-stage { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; }
    ruffle-player, #ruffle-stage > * { width: 100%; height: 100%; max-width: 100vw; max-height: 100vh; background: #000; }
    #ruffle-fallback {
      color: #fff; font-family: system-ui, sans-serif; text-align: center; padding: 20px;
    }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/@ruffle-rs/ruffle"></script>
</head>
<body>
  <div id="ruffle-stage">
    <div id="ruffle-fallback">Loading Ruffle…</div>
  </div>
  <script>
    window.RufflePlayer = window.RufflePlayer || {};
    window.RufflePlayer.config = {
      autoplay: 'on',
      unmuteOverlay: 'visible',
      letterbox: 'on',
      logLevel: 'warn',
    };
    window.addEventListener('load', () => {
      try {
        const ruffle = window.RufflePlayer.newest();
        if (!ruffle) {
          document.getElementById('ruffle-fallback').textContent =
            'Ruffle failed to load. Check your network or extension blockers.';
          return;
        }
        const player = ruffle.createPlayer();
        const stage = document.getElementById('ruffle-stage');
        stage.innerHTML = '';
        stage.appendChild(player);
        player.load(${JSON.stringify(swf)}).catch(err => {
          stage.innerHTML = '<div id="ruffle-fallback">Failed to load SWF: ' + err.message + '</div>';
        });
      } catch (err) {
        document.getElementById('ruffle-fallback').textContent =
          'Error: ' + (err.message || err);
      }
    });
  </script>
</body>
</html>
`;
}

let updated = 0;
for (const [path, cfg] of Object.entries(FIXES)) {
    if (!fs.existsSync(path)) {
        console.log(`SKIP (missing): ${path}`);
        continue;
    }
    fs.writeFileSync(path, template(cfg));
    console.log(`✓ ${path}`);
    updated++;
}
console.log(`\nUpdated ${updated} wrappers.`);

// Also clear broken flag if any of these are marked broken (they aren't
// — these aren't in the dead-repo list — but safety check)
const dataPath = 'games/games.json';
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const games = Array.isArray(data) ? data : data.games;
const fixedPaths = new Set(Object.keys(FIXES).map(p => p.toLowerCase()));
let cleared = 0;
const updatedGames = games.map(g => {
    if (g.broken && fixedPaths.has((g.path || '').toLowerCase())) {
        cleared++;
        const { broken, ...rest } = g;
        return rest;
    }
    return g;
});
if (cleared) {
    fs.writeFileSync(dataPath, JSON.stringify(updatedGames, null, 2));
    console.log(`Cleared broken flag from ${cleared} entries.`);
}
