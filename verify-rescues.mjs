// Verify the auto-rescues didn't pick up false-positive matches.
//
// For every catalog game whose wrapper now points at the
// arcad-groq /rom proxy (i.e. was rescued), HEAD the URL and check:
//   1. Content-Length is within sane range for the platform
//   2. URL filename shares at least one significant word with the game title
//
// If either check fails, mark the game broken: true again so it falls
// back into the broken list. The wrapper is left in place but won't be
// shown to non-admins.

import fs from 'node:fs';

const APPLY = process.argv.includes('--apply');

// Sane ROM size ranges per EJS_core (in bytes)
const SIZE_RANGES = {
    nes:           [10 * 1024,        8 * 1024 * 1024],
    snes:          [128 * 1024,       16 * 1024 * 1024],
    n64:           [2 * 1024 * 1024,  256 * 1024 * 1024],
    parallel_n64:  [2 * 1024 * 1024,  256 * 1024 * 1024],
    gba:           [256 * 1024,       128 * 1024 * 1024],
    gbc:           [16 * 1024,        8 * 1024 * 1024],
    gb:            [8 * 1024,         4 * 1024 * 1024],
    nds:           [1 * 1024 * 1024,  1024 * 1024 * 1024],
    segaMD:        [64 * 1024,        16 * 1024 * 1024],
    segaGG:        [16 * 1024,        2 * 1024 * 1024],
    atari2600:     [1024,             256 * 1024],
    ngp:           [64 * 1024,        64 * 1024 * 1024],
    arcade:        [16 * 1024,        500 * 1024 * 1024],
};

// Tokenize a string into word tokens for fuzzy match
function tokenize(s) {
    return String(s || '').toLowerCase()
        // Strip URL-y separators along with punctuation so e.g.
        // "/pokemon-cursed.zip" → "pokemon cursed zip" not "/pokemon-cursed.zip"
        .replace(/[._\-()[\]'"\/:%&?=]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 3 && !['the','and','for','rom','usa','jp','eu','rev','net','zip','com','org'].includes(t));
}

function titleMatchesUrl(title, url, core) {
    // Arcade core: MAME ROM names are opaque short codes (msh.zip, sf2.zip)
    // — there's no useful title-match we can do. Trust size + HEAD only.
    if (core === 'arcade') return true;

    const t = tokenize(title);
    if (!t.length) return true;
    let filename = '';
    try {
        const decoded = decodeURIComponent(url);
        const srcMatch = decoded.match(/[?&]src=([^&]+)/);
        const target = srcMatch ? decodeURIComponent(srcMatch[1]) : decoded;
        filename = target.split(/[\/\\]/).pop() || target;
    } catch { filename = url; }
    // Tokenize AND keep the raw lowercase filename for substring scans —
    // compound filenames like "pokeemeraldrogue.gba" don't tokenize into
    // the title's words but DO contain them as substrings.
    const u = tokenize(filename);
    const flat = filename.toLowerCase().replace(/[^a-z0-9]/g, '');
    return t.some(w => u.includes(w) || flat.includes(w));
}

const data = JSON.parse(fs.readFileSync('games/games.json', 'utf8'));
const games = Array.isArray(data) ? data : data.games;

// Find ALL games whose wrapper points at the worker proxy (regardless
// of broken flag) so we can both confirm passing ones and re-mark
// failures.
const rescued = [];
for (const g of games) {
    if (!g.path || !fs.existsSync(g.path)) continue;
    const html = fs.readFileSync(g.path, 'utf8');
    if (!html.includes('arcad-groq.gatabanumai.workers.dev/rom?src=')) continue;
    // Read EJS_gameUrl + EJS_core
    const urlMatch = html.match(/EJS_gameUrl\s*=\s*['"]([^'"]+)['"]/);
    const coreMatch = html.match(/EJS_core\s*=\s*['"]([^'"]+)['"]/);
    if (!urlMatch || !coreMatch) continue;
    rescued.push({ id: g.id, title: g.title, url: urlMatch[1], core: coreMatch[1] });
}

console.log(`Found ${rescued.length} rescued wrappers to verify.\n`);

const reverts = [];
let ok = 0;

for (let i = 0; i < rescued.length; i++) {
    const r = rescued[i];
    process.stdout.write(`[${i+1}/${rescued.length}] ${r.title}... `);
    try {
        const resp = await fetch(r.url, { method: 'HEAD' });
        const size = Number(resp.headers.get('content-length') || 0);
        const range = SIZE_RANGES[r.core] || [1024, 1024 * 1024 * 1024];
        const sizeOk = size >= range[0] && size <= range[1];
        const titleOk = titleMatchesUrl(r.title, r.url, r.core);
        if (!resp.ok) {
            console.log(`✗ ${resp.status}`);
            reverts.push({ ...r, reason: `HTTP ${resp.status}` });
        } else if (!sizeOk) {
            console.log(`✗ size ${(size / 1024 / 1024).toFixed(1)}MB outside ${(range[0]/1024/1024).toFixed(1)}-${(range[1]/1024/1024).toFixed(0)}MB`);
            reverts.push({ ...r, reason: `size ${size} outside range` });
        } else if (!titleOk) {
            console.log(`✗ title mismatch (url=${decodeURIComponent(r.url).slice(-60)})`);
            reverts.push({ ...r, reason: 'title mismatch' });
        } else {
            console.log(`✓ ${(size / 1024 / 1024).toFixed(1)}MB`);
            ok++;
        }
    } catch (e) {
        console.log(`✗ fetch error: ${e.message}`);
        reverts.push({ ...r, reason: e.message });
    }
}

console.log(`\n=== Verification Summary ===`);
console.log(`Verified OK:   ${ok}`);
console.log(`To revert:     ${reverts.length}`);

if (APPLY) {
    const okIds = new Set(rescued.filter(r => !reverts.find(rev => rev.id === r.id)).map(r => r.id));
    const revertIds = new Set(reverts.map(r => r.id));
    const updated = games.map(g => {
        if (revertIds.has(g.id))   return { ...g, broken: true };
        if (okIds.has(g.id)) {
            const { broken, ...rest } = g;
            return rest;
        }
        return g;
    });
    fs.writeFileSync('games/games.json', JSON.stringify(updated, null, 2));
    console.log(`\n✅ ${ok} verified games cleared; ${reverts.length} re-marked broken.`);
} else if (reverts.length) {
    console.log(`\n(dry run — pass --apply to update flags)`);
}
