// Rescue broken games by re-pointing them at archive.org.
//
// For each game with `broken: true`:
//   1. Read the wrapper for its EJS_core
//   2. Search archive.org for the title
//   3. Walk results, fetching metadata, look for a downloadable ROM
//      file whose extension matches the core (.nes/.gba/.smc/etc)
//   4. If found, rewrite the wrapper using the working pattern (worker
//      proxy + EmulatorJS) and clear `broken` from the catalog entry
//   5. Print a summary at the end of rescued vs unrescuable
//
// Two phases: search (logs candidates) and apply (writes the fixes).
// Run with --apply to actually mutate files.

import fs from 'node:fs';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const LIMIT = Number(process.argv.find(a => a.startsWith('--limit=')) ?
                       process.argv.find(a => a.startsWith('--limit=')).split('=')[1] : 999);
const ONLY_CORE = process.argv.find(a => a.startsWith('--core=')) ?
                  process.argv.find(a => a.startsWith('--core=')).split('=')[1] : null;

// Map EJS_core → file extensions we'd accept for that platform
const CORE_EXTENSIONS = {
    nes:           ['.nes'],
    snes:          ['.smc', '.sfc'],
    n64:           ['.z64', '.n64', '.v64'],
    parallel_n64:  ['.z64', '.n64', '.v64'],
    gba:           ['.gba'],
    gbc:           ['.gbc', '.gb'],
    gb:            ['.gb', '.gbc'],
    nds:           ['.nds'],
    segaMD:        ['.md', '.gen', '.smd', '.bin'],
    segaGG:        ['.gg'],
    atari2600:     ['.a26', '.bin'],
    ngp:           ['.ngp', '.ngc'],
    arcade:        ['.zip'],   // arcade ROMs are usually zipped MAME sets
};

const WORKER_PROXY = 'https://arcad-groq.gatabanumai.workers.dev/rom?src=';

// ─── Helpers ──────────────────────────────────────────────────
// Map our EJS_core → search hint (helps discriminate platform on
// items where the title is generic — e.g. "Donkey Kong" is on every
// console).
const CORE_TO_HINT = {
    nes: 'nes', snes: 'snes', n64: 'n64', parallel_n64: 'n64',
    gba: 'gba', gbc: 'gbc', gb: 'game boy',
    nds: 'nds OR "nintendo ds"',
    segaMD: '"sega genesis" OR "mega drive"',
    segaGG: '"game gear"',
    atari2600: '"atari 2600"',
    ngp: '"neo geo pocket"',
    arcade: 'arcade OR mame',
};

async function archiveSearchOnce(title, core, withHint) {
    const cleanTitle = String(title)
        .replace(/[()[\]]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const hint = withHint ? (CORE_TO_HINT[core] || '') : '';
    const q = `title:(${JSON.stringify(cleanTitle)}) AND mediatype:software` +
              (hint ? ` AND (${hint})` : '');
    const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl%5B%5D=identifier&fl%5B%5D=title&output=json&rows=10`;
    try {
        const r = await fetch(url);
        if (!r.ok) return [];
        const j = await r.json();
        return j?.response?.docs || [];
    } catch { return []; }
}

// Try multiple search variants. Returns the first non-empty result.
// Variants: full title with platform hint, full title without hint,
// title minus platform-y words, first half of title.
async function archiveSearch(title, core) {
    const variants = [title];
    // Strip platform-name-ish words
    const stripped = title.replace(/\b(NES|SNES|GBA|GBC|GB|N64|NDS|Genesis|Megadrive|Game ?Gear|Atari|MAME|ROM Hack|Hack|Collection|Album|Edition|Deluxe|EX)\b/gi, '').replace(/\s+/g, ' ').trim();
    if (stripped && stripped !== title) variants.push(stripped);
    // First 3 words
    const first3 = title.split(/\s+/).slice(0, 3).join(' ');
    if (first3 !== title) variants.push(first3);
    // First 2 words
    const first2 = title.split(/\s+/).slice(0, 2).join(' ');
    if (first2 !== title && first2 !== first3) variants.push(first2);

    for (const v of variants) {
        const docs = await archiveSearchOnce(v, core, true);
        if (docs.length) return docs;
        // Without platform hint — sometimes ROMs aren't tagged that way
        const docs2 = await archiveSearchOnce(v, core, false);
        if (docs2.length) return docs2;
    }
    return [];
}

async function archiveMetadata(identifier) {
    try {
        const r = await fetch(`https://archive.org/metadata/${identifier}`);
        if (!r.ok) return null;
        return await r.json();
    } catch { return null; }
}

function pickRomFile(metadata, exts) {
    if (!metadata?.files) return null;
    // Skip manual / scan / cover-art / metadata files — these often
    // share an item with the ROM itself, but we want the ROM.
    const usable = metadata.files.filter(f => {
        const n = (f.name || '').toLowerCase();
        return !n.includes('_jp2') && !n.endsWith('.pdf')
            && !n.includes('manual') && !n.includes('scan')
            && !n.endsWith('.txt') && !n.endsWith('.xml')
            && !n.endsWith('.sqlite') && !n.endsWith('_meta.txt');
    });
    // Prefer direct ROM files over zips
    const direct = usable.find(f =>
        exts.some(e => f.name?.toLowerCase().endsWith(e)));
    if (direct) return direct.name;
    const zip = usable.find(f => f.name?.toLowerCase().endsWith('.zip'));
    if (zip) return zip.name;
    const sevenZ = usable.find(f => f.name?.toLowerCase().endsWith('.7z'));
    if (sevenZ) return sevenZ.name;
    return null;
}

async function headOk(url) {
    try {
        const r = await fetch(url, { method: 'HEAD' });
        return r.ok;
    } catch { return false; }
}

// Build the worker-proxy URL. archive.org filenames often have spaces;
// double-encode so the proxy unwraps once + the fetch encoder again.
function buildProxyUrl(identifier, filename) {
    const direct = `https://archive.org/download/${identifier}/${encodeURIComponent(filename).replace(/'/g, '%27')}`;
    return WORKER_PROXY + encodeURIComponent(direct);
}

// Wrapper template — based on the pattern that already works in
// cl1636pokemonfireredsquirrels.html / clPokeAmbrosia.html.
function makeWrapper({ title, core, romUrl, gameName }) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
  <title>${title.replace(/[<>&]/g, '')}</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; color: #fff; font-family: system-ui, sans-serif; }
    #game { width: 100vw; height: 100vh; }
    #startButton {
      display: block; margin: 40vh auto 0;
      padding: 14px 28px; background: #4CAF50; color: #fff;
      border: none; border-radius: 8px; cursor: pointer;
      font-size: 16px; box-shadow: 0 0 14px rgba(0,0,0,0.6);
    }
    #loading-progress {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      color: #fff; font-size: 14px;
    }
  </style>
</head>
<body>
  <div id="game"></div>
  <button id="startButton">▶ PLAY</button>
  <div id="loading-progress" style="display:none;">Loading…</div>
  <script>
    document.getElementById('startButton').addEventListener('click', startGame);
    function startGame() {
      document.getElementById('startButton').style.display = 'none';
      document.getElementById('loading-progress').style.display = 'block';
      window.EJS_player        = '#game';
      window.EJS_core          = ${JSON.stringify(core)};
      window.EJS_color         = '#000000';
      window.EJS_startOnLoaded = true;
      window.EJS_pathtodata    = 'https://cdn.jsdelivr.net/gh/EmulatorJS/EmulatorJS@main/data/';
      window.EJS_netplayServer = 'https://netplay.emulatorjs.org';
      window.EJS_gameName      = ${JSON.stringify(gameName)};
      window.EJS_gameUrl       = ${JSON.stringify(romUrl)};
      window.EJS_onGameStart   = function () {
        document.getElementById('loading-progress')?.remove();
      };
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/gh/EmulatorJS/EmulatorJS@main/data/loader.js';
      document.body.appendChild(s);
    }
  </script>
</body>
</html>
`;
}

// ─── Main ──────────────────────────────────────────────────────
const data = JSON.parse(fs.readFileSync('games/games.json', 'utf8'));
const games = Array.isArray(data) ? data : data.games;
const broken = games.filter(g => g.broken);

// Read core from each wrapper
function readCore(p) {
    if (!fs.existsSync(p)) return null;
    const html = fs.readFileSync(p, 'utf8');
    const m = html.match(/EJS_core\s*=\s*['"]([^'"]+)['"]/);
    return m ? m[1] : null;
}

const targets = [];
for (const g of broken) {
    const core = readCore(g.path);
    if (!core) continue;                       // probably flash, skip for now
    if (!CORE_EXTENSIONS[core]) continue;      // unsupported core
    if (ONLY_CORE && core !== ONLY_CORE) continue;
    targets.push({ ...g, core });
}
targets.length = Math.min(targets.length, LIMIT);

console.log(`Targets: ${targets.length} (limit ${LIMIT}, core filter: ${ONLY_CORE || 'any'})\n`);

const rescued = [];
const failed = [];

for (let i = 0; i < targets.length; i++) {
    const g = targets[i];
    process.stdout.write(`[${i+1}/${targets.length}] ${g.title} (${g.core})... `);
    const docs = await archiveSearch(g.title, g.core);
    let found = null;
    for (const d of docs.slice(0, 4)) {
        const md = await archiveMetadata(d.identifier);
        if (!md) continue;
        const file = pickRomFile(md, CORE_EXTENSIONS[g.core]);
        if (!file) continue;
        const proxyUrl = buildProxyUrl(d.identifier, file);
        // Verify via HEAD on the worker (which forwards to archive.org)
        const ok = await headOk(proxyUrl);
        if (ok) {
            found = { identifier: d.identifier, file, proxyUrl };
            break;
        }
    }
    if (found) {
        console.log('✓ ' + found.identifier + '/' + found.file);
        rescued.push({ game: g, ...found });
    } else {
        console.log('✗ no match');
        failed.push(g);
    }
}

console.log(`\n=== Summary ===`);
console.log(`Rescued: ${rescued.length}`);
console.log(`Failed:  ${failed.length}`);

if (APPLY && rescued.length) {
    console.log(`\nWriting wrappers + clearing broken flag...`);
    for (const r of rescued) {
        const wrapper = makeWrapper({
            title: r.game.title,
            core: r.game.core,
            romUrl: r.proxyUrl,
            gameName: r.game.title,
        });
        fs.writeFileSync(r.game.path, wrapper);
    }
    // Clear broken flag in catalog
    const updated = games.map(g => {
        if (rescued.find(r => r.game.id === g.id)) {
            const { broken, ...rest } = g;
            return rest;
        }
        return g;
    });
    fs.writeFileSync('games/games.json', JSON.stringify(updated, null, 2));
    console.log(`✅ Done. ${rescued.length} games rescued.`);
} else if (rescued.length) {
    console.log(`\n(dry run — pass --apply to write fixes)`);
}

if (failed.length) {
    console.log(`\nFailed (no archive.org match):`);
    failed.slice(0, 30).forEach(f => console.log(`  - ${f.title} (${f.core})`));
}
