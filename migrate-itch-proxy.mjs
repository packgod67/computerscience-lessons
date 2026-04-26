// Migrate game wrapper HTMLs from direct html-classic.itch.zone iframes
// to the worker proxy at /itch/. The worker fetches each itch HTML page,
// strips itch's hotlink-check script, and proxies sub-resources back
// through itself — so games iframed from our arcade origin no longer
// trigger the embed-hotlink redirect.
//
// Migration scope: only games that have `static.itch.io/htmlgame.js` in
// their HTML (the hotlink-check script). Games without it stay direct
// since the proxy adds no value for them and would mask any future
// itch-side issues.
//
// Run: node migrate-itch-proxy.mjs           (dry-run, shows changes)
//      node migrate-itch-proxy.mjs --apply   (writes changes)

import fs from 'node:fs';
import path from 'node:path';

const WORKER_BASE = 'https://arcad-groq.gatabanumai.workers.dev/itch/';
const APPLY = process.argv.includes('--apply');

const catalog = JSON.parse(fs.readFileSync('games/games.json', 'utf8'));

let changed = 0;
let scanned = 0;

for (const g of catalog) {
    if (!g.path) continue;
    if (!fs.existsSync(g.path)) continue;
    let html = fs.readFileSync(g.path, 'utf8');
    const m = html.match(/<iframe[^>]+src="(https:\/\/html-classic\.itch\.zone\/html\/([^"]+))"/i);
    if (!m) continue;
    scanned++;

    const fullUrl = m[1];
    const itchPath = m[2];

    // Skip already-migrated entries (defensive — script is idempotent)
    if (fullUrl.includes(WORKER_BASE)) continue;

    // Probe upstream once to decide if migration is needed. Proxying
    // every itch game would add latency for games that don't need it,
    // so check for the htmlgame.js script first and only migrate the
    // ones that actually have hotlink protection.
    let needsProxy = false;
    try {
        const r = await fetch(fullUrl, {
            headers: { 'User-Agent': 'arcade-migration-check' },
        });
        if (r.ok) {
            const body = await r.text();
            if (body.includes('static.itch.io/htmlgame.js')) needsProxy = true;
        }
    } catch {}

    if (!needsProxy) continue;

    const newSrc = WORKER_BASE + itchPath;
    const newHtml = html.replace(
        /<iframe([^>]+)src="https:\/\/html-classic\.itch\.zone\/html\/[^"]+"/i,
        `<iframe$1src="${newSrc}"`
    );

    console.log(`${APPLY ? 'PATCH' : 'WOULD'} ${g.id.padEnd(28)} ${g.title}`);
    console.log(`  ${itchPath}`);

    if (APPLY) fs.writeFileSync(g.path, newHtml);
    changed++;
}

console.log(`\nScanned: ${scanned}, ${APPLY ? 'patched' : 'would patch'}: ${changed}`);
console.log(APPLY ? 'Done.' : 'Re-run with --apply to commit.');
