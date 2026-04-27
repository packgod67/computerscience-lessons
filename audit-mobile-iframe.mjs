// Deep audit — fetch each browser-native game's iframe target and look
// for ACTUAL mobile-control signals in its HTML/JS:
//
//   1. Touch event listeners (touchstart, touchmove, touchend, pointerdown)
//   2. Mobile-web-app-capable / apple-mobile-web-app-capable meta tags
//   3. Viewport meta tag with user-scalable=no (almost always means
//      the dev wants mobile-friendly UX)
//   4. References to "isMobile" / "ontouchstart" detection (engine
//      auto-adapts UI for mobile)
//
// If at least 2 of these signals hit, we're confident the game has
// real mobile-control support and tag it #mobile.
//
// Notes:
//   - ROM games already covered by audit-mobile-tags.mjs (EmulatorJS
//     touch overlay). This script only operates on non-ROM games.
//   - We skip games already tagged #mobile.
//   - Worker-proxied games (arcad-groq.gatabanumai.workers.dev/itch/)
//     get the underlying itch URL extracted before fetching.
//
// Run: node audit-mobile-iframe.mjs            (dry-run, shows changes)
//      node audit-mobile-iframe.mjs --apply    (writes to games.json)

import fs from 'node:fs';

const APPLY = process.argv.includes('--apply');
const CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 8000;
const WORKER_PROXY = 'https://arcad-groq.gatabanumai.workers.dev/itch/';
const ITCH_DIRECT = 'https://html-classic.itch.zone/html/';
const ITCH_DIRECT_ALT = 'https://html.itch.zone/html/';

const catalog = JSON.parse(fs.readFileSync('games/games.json', 'utf8'));

function extractIframeSrc(htmlPath) {
    if (!fs.existsSync(htmlPath)) return null;
    const c = fs.readFileSync(htmlPath, 'utf8');
    const m = c.match(/<iframe[^>]+src="([^"]+)"/i);
    return m ? m[1] : null;
}

// Worker-proxy URLs forward to the underlying itch URL — fetch directly
// to avoid the proxy overhead (and to not hammer our own worker).
function unwrapWorkerProxy(url) {
    if (url.startsWith(WORKER_PROXY)) {
        return ITCH_DIRECT + url.slice(WORKER_PROXY.length);
    }
    return url;
}

async function fetchWithTimeout(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        const r = await fetch(url, {
            signal: ctrl.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; arcade-mobile-audit/1.0)',
            },
        });
        if (!r.ok) return null;
        const body = await r.text();
        return body;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function scanForMobileSignals(html) {
    if (!html) return { score: 0, hits: [] };
    const hits = [];
    // 1. Touch event listeners
    if (/['"](touchstart|touchmove|touchend|touchcancel)['"]/i.test(html)) {
        hits.push('touch-event');
    }
    // 2. Pointer events configured for touch
    if (/pointerdown|pointerup|pointermove/i.test(html)
        && /touch|coarse|isMobile/i.test(html)) {
        hits.push('pointer-touch');
    }
    // 3. Mobile-web-app meta tags
    if (/mobile-web-app-capable|apple-mobile-web-app-capable/i.test(html)) {
        hits.push('pwa-meta');
    }
    // 4. Viewport explicitly mobile-tuned
    if (/<meta[^>]+name=["']viewport["'][^>]+(user-scalable=no|maximum-scale=1)/i.test(html)) {
        hits.push('mobile-viewport');
    }
    // 5. Engine autodetect (Godot/Unity/Phaser all have isMobile checks)
    if (/\bisMobile\b|\bontouchstart\b|\bnavigator\.maxTouchPoints/i.test(html)) {
        hits.push('mobile-detect');
    }
    // 6. Mobile-control overlay class names common in HTML5 game frameworks
    if (/mobile-controls|touch-controls|virtualPad|touchPad/i.test(html)) {
        hits.push('virtual-pad');
    }
    return { score: hits.length, hits };
}

// Filter targets: non-ROM games, with a wrapper, NOT already mobile-tagged.
const targets = [];
for (const g of catalog) {
    if (g.rom) continue;                          // ROMs: handled by other audit
    if (!g.path) continue;
    const tags = (g.tags || []).map(t => t.toLowerCase());
    if (tags.includes('mobile')) continue;        // already tagged, skip
    const src = extractIframeSrc(g.path);
    if (!src) continue;
    targets.push({ id: g.id, title: g.title, src });
}

console.log(`Scanning ${targets.length} non-ROM browser games not yet #mobile-tagged...`);

// Throttled concurrency
const results = [];
let cursor = 0;
async function worker() {
    while (cursor < targets.length) {
        const idx = cursor++;
        const t = targets[idx];
        const url = unwrapWorkerProxy(t.src);
        const body = await fetchWithTimeout(url);
        const sig = scanForMobileSignals(body);
        results.push({ ...t, sigScore: sig.score, sigHits: sig.hits });
        if (results.length % 50 === 0) process.stdout.write(`  ${results.length}/${targets.length}\r`);
    }
}
const workers = Array.from({ length: CONCURRENCY }, () => worker());
await Promise.all(workers);
console.log(`  ${results.length}/${targets.length} done`);

// Threshold: 2+ signals — but require at least ONE "real touch
// interaction" signal. pwa-meta + mobile-viewport alone isn't enough
// (many GDevelop / Construct templates ship those by default even
// for keyboard-only games — Saul Goodman, American Dad Game, etc.
// were false positives in the looser threshold).
const REAL_TOUCH_SIGNALS = new Set(['touch-event', 'pointer-touch', 'virtual-pad', 'mobile-detect']);
const shouldAdd = results.filter(r => {
    if (r.sigScore < 2) return false;
    return r.sigHits.some(h => REAL_TOUCH_SIGNALS.has(h));
});
const maybe = results.filter(r => r.sigScore >= 1 && !shouldAdd.includes(r));

console.log(`\n========== DEEP AUDIT RESULTS ==========`);
console.log(`Scanned:                ${results.length}`);
console.log(`Confident mobile (≥2):  ${shouldAdd.length}`);
console.log(`Borderline (1 signal):  ${maybe.length}`);

console.log(`\n=== ADDING #mobile TO (${shouldAdd.length}) ===`);
for (const r of shouldAdd.slice(0, 60)) {
    console.log(`  +mobile  ${r.id.padEnd(28)} ${(r.title || '').slice(0, 35).padEnd(36)} ${r.sigHits.join(',')}`);
}
if (shouldAdd.length > 60) console.log(`  ... (${shouldAdd.length - 60} more)`);

if (APPLY) {
    let n = 0;
    for (const r of shouldAdd) {
        const g = catalog.find(x => x.id === r.id);
        if (!g) continue;
        if (!g.tags) g.tags = [];
        if (!g.tags.includes('mobile')) {
            g.tags.push('mobile');
            n++;
        }
    }
    fs.writeFileSync('games/games.json', JSON.stringify(catalog, null, 2));
    console.log(`\n✅ Applied ${n} additions to games/games.json.`);
} else {
    console.log(`\nDry run. Re-run with --apply to commit.`);
}
