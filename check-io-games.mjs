// Check every .io game wrapper for likely iframe-friendliness:
//   1. HTTP status (200 expected; redirects + 4xx/5xx are red flags)
//   2. X-Frame-Options / CSP frame-ancestors headers
//   3. Frame-busting JS patterns in the response body
//   4. Anti-hotlink markers (3kh0 ad injection / itch htmlgame.js)
// Outputs a categorized report so we know which to leave alone vs
// which need a different approach.

import fs from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126';

const data = JSON.parse(fs.readFileSync('games/games.json', 'utf8'));
const games = Array.isArray(data) ? data : data.games;

// Find every wrapper that iframes a .io domain or 3kh0.github.io
const iogames = [];
for (const g of games) {
    if (!g.path || !fs.existsSync(g.path)) continue;
    const html = fs.readFileSync(g.path, 'utf8');
    const m = html.match(/<iframe[^>]+src=["']([^"']+)["']/);
    if (!m) continue;
    if (!/\.io[\/"'?]|\.io$|3kh0\.github\.io/.test(m[1])) continue;
    iogames.push({ id: g.id, title: g.title, url: m[1] });
}
console.log(`Probing ${iogames.length} .io game URLs...\n`);

// Frame-busting / anti-hotlink patterns to look for in the HTML body
const PATTERNS = [
    { name: 'top!=self redirect',       re: /(window\.)?top\s*!=\s*(window\.)?self/ },
    { name: 'top!==self redirect',      re: /(window\.)?top\s*!==\s*(window\.)?self/ },
    { name: 'top.location assign',      re: /(window\.)?top\.location\s*[=.]\s*['"]?http/ },
    { name: 'parent.location assign',   re: /parent\.location\s*[=.]\s*['"]?http/ },
    { name: 'itch htmlgame.js',         re: /static\.itch\.io\/htmlgame\.js/ },
    { name: '3kh0 ad injection',        re: /\/js\/main\.js|googletagmanager\.com.*3kh0/ },
    { name: 'frame-ancestors deny',     re: /frame-ancestors[^;]*'none'/i },
];

const results = [];

async function check(g) {
    try {
        const resp = await fetch(g.url, {
            headers: { 'User-Agent': UA },
            redirect: 'follow',
            signal: AbortSignal.timeout(8000),
        });
        const status = resp.status;
        const xfo = resp.headers.get('x-frame-options') || '';
        const csp = resp.headers.get('content-security-policy') || '';
        const fa = (csp.match(/frame-ancestors[^;]*/i) || [''])[0];
        const text = await resp.text().catch(() => '');
        const hits = PATTERNS.filter(p => p.re.test(text)).map(p => p.name);

        let verdict = 'OK';
        const reasons = [];
        if (status >= 400)        { verdict = 'FAIL'; reasons.push(`HTTP ${status}`); }
        if (/DENY|SAMEORIGIN/i.test(xfo)) { verdict = 'FAIL'; reasons.push(`XFO=${xfo}`); }
        if (fa)                   { verdict = 'FAIL'; reasons.push(`CSP ${fa}`); }
        if (hits.length)          { verdict = verdict === 'OK' ? 'WARN' : verdict; reasons.push(...hits); }

        return { ...g, status, verdict, reasons };
    } catch (e) {
        return { ...g, status: 0, verdict: 'FAIL', reasons: [e.message || 'fetch error'] };
    }
}

// Run in batches of 8 so we don't fork too much
const BATCH = 8;
for (let i = 0; i < iogames.length; i += BATCH) {
    const slice = iogames.slice(i, i + BATCH);
    const part = await Promise.all(slice.map(check));
    results.push(...part);
    process.stdout.write('.');
}
console.log('\n');

const byVerdict = { OK: [], WARN: [], FAIL: [] };
for (const r of results) byVerdict[r.verdict].push(r);

console.log(`\n=== Summary ===`);
console.log(`OK:    ${byVerdict.OK.length}`);
console.log(`WARN:  ${byVerdict.WARN.length}  (loads but has potential issues)`);
console.log(`FAIL:  ${byVerdict.FAIL.length}  (won't iframe)`);

console.log(`\n=== FAIL list ===`);
byVerdict.FAIL.forEach(r =>
    console.log(`  ${r.id} → ${r.url}\n    reasons: ${r.reasons.join('; ')}`));

console.log(`\n=== WARN list (top 20) ===`);
byVerdict.WARN.slice(0, 20).forEach(r =>
    console.log(`  ${r.id} → ${r.url}\n    notes: ${r.reasons.join('; ')}`));

// Write full JSON for reuse
fs.writeFileSync('io-check-report.json', JSON.stringify(results, null, 2));
console.log(`\nFull report written to io-check-report.json`);
