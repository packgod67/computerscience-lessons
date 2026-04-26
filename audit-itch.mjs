// Audit every iframe-pattern game in the catalog. Three failure modes:
//
//   1. Hotlink-protected — the game's HTML contains a JS check against
//      document.referrer / window.parent.origin and redirects to
//      itch.io/embed-hotlink/<id> when the referer doesn't match itch.io.
//      Detected by fetching the iframe URL with a foreign Referer header
//      and looking for "embed-hotlink" or "you should be using itch.io"
//      in the response body.
//
//   2. Dead URL — Google Cloud Storage returns 403 ("AccessDenied") or
//      the file no longer exists. Detected by HTTP status.
//
//   3. Working — 200 + game HTML with no hotlink-check script.
//
// Run: node audit-itch.mjs
//
// Outputs a triage report. Doesn't modify the catalog — that's manual.

import fs from 'node:fs';

const catalog = JSON.parse(fs.readFileSync('games/games.json', 'utf8'));

// Pull iframe src from each game's HTML wrapper.
function extractIframeSrc(htmlPath) {
    if (!fs.existsSync(htmlPath)) return null;
    const c = fs.readFileSync(htmlPath, 'utf8');
    const m = c.match(/<iframe[^>]+src="([^"]+)"/i);
    return m ? m[1] : null;
}

// Probe a single iframe URL with a foreign Referer set, mimicking
// how a real browser would load it from our arcade origin.
async function probe(url) {
    try {
        const r = await fetch(url, {
            headers: {
                'Referer': 'https://computerscience-lessons.onrender.com/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Sec-Fetch-Dest': 'iframe',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'cross-site',
            },
            redirect: 'follow',
        });
        if (!r.ok) return { status: 'dead', code: r.status };
        const body = await r.text();
        // Look for the hotlink-check pattern. itch's hotlink-protected
        // games inject a script that calls `embed-hotlink/<id>` or shows
        // "You should be using itch.io" inline. The string check is fast
        // and matches both the AMP redirect page and the inline JS guard.
        // Detection: itch injects `<script defer src=".../htmlgame.js">` into
        // hotlink-protected games. The script runs at parse-end, reads the
        // parent frame's origin, and redirects to itch.io/embed-hotlink/<id>
        // if the parent isn't itch.io. Old Unity games with synchronous
        // UnityLoader.js often replace the document before this defer runs
        // (the user reports Vapor Trails works for this reason). Newer
        // Godot/GameMaker/GDevelop games load async → htmlgame.js wins → hotlink.
        // We flag every game with the script and let the user pick which to
        // remove based on engine type.
        if (body.includes('static.itch.io/htmlgame.js')) {
            return { status: 'hotlinked', code: 200, bodyLen: body.length };
        }
        if (/embed[-_]hotlink|you should be using itch\.io/i.test(body)) {
            return { status: 'hotlinked', code: 200, bodyLen: body.length };
        }
        return { status: 'ok', code: 200, bodyLen: body.length };
    } catch (e) {
        return { status: 'error', code: 0, error: e.message };
    }
}

// Filter the catalog to itch-iframe games (skip Ruffle, ROM, etc.)
const targets = [];
for (const g of catalog) {
    if (!g.path) continue;
    const src = extractIframeSrc(g.path);
    if (!src) continue;
    // Only check itch.zone iframes — Ruffle player etc. is fine
    if (!src.includes('itch.zone/') && !src.includes('ungrounded.net/')) continue;
    targets.push({ id: g.id, title: g.title, src });
}

console.log(`Auditing ${targets.length} iframe games...`);

// Throttle: 8 concurrent fetches at a time.
const CONC = 8;
const results = [];
for (let i = 0; i < targets.length; i += CONC) {
    const batch = targets.slice(i, i + CONC);
    const outs = await Promise.all(batch.map(async t => ({
        ...t,
        ...(await probe(t.src)),
    })));
    results.push(...outs);
    process.stdout.write(`  ${results.length}/${targets.length}\r`);
}
console.log('');

const grouped = { hotlinked: [], dead: [], error: [], ok: [] };
for (const r of results) grouped[r.status].push(r);

console.log(`\n========== HOTLINK-PROTECTED (${grouped.hotlinked.length}) ==========`);
for (const r of grouped.hotlinked) console.log(`  ${r.id.padEnd(28)} ${r.title}`);
console.log(`\n========== DEAD URLs (${grouped.dead.length}) ==========`);
for (const r of grouped.dead) console.log(`  [${r.code}] ${r.id.padEnd(28)} ${r.title}`);
console.log(`\n========== ERRORS (${grouped.error.length}) ==========`);
for (const r of grouped.error) console.log(`  ${r.id.padEnd(28)} ${r.error}`);
console.log(`\n========== WORKING (${grouped.ok.length}) ==========`);
console.log(`  (omitted from output — all good)`);
console.log(`\nTotal: ${results.length} | broken: ${grouped.hotlinked.length + grouped.dead.length + grouped.error.length}`);
