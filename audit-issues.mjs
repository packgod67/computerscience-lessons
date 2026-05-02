// One-shot site issue audit. Reports:
//   - Duplicate catalog entries (case-insensitive ids)
//   - Multiple catalog entries pointing at the same wrapper file
//   - Catalog entries whose wrapper file doesn't exist on disk
//   - Wrapper files on disk with no catalog entry
//   - Wrappers referencing the dead schoolstuff1337/supplies repo

import fs from 'node:fs';
import path from 'node:path';

const data = JSON.parse(fs.readFileSync('games/games.json', 'utf8'));
const games = Array.isArray(data) ? data : data.games;

// 1. Duplicate IDs (case-insensitive)
const seen = {};
const dups = [];
for (const g of games) {
    const k = (g.id || '').toLowerCase();
    if (seen[k]) dups.push([seen[k].id, g.id]);
    else seen[k] = g;
}
console.log('=== Duplicate catalog entries (case-insensitive) ===');
console.log('Count:', dups.length);
dups.slice(0, 20).forEach(([a, b]) => console.log('  ', a, '<->', b));

// 2. Catalog entries pointing at non-existent wrapper files
console.log('\n=== Catalog entries with missing wrapper files ===');
const missing = [];
for (const g of games) {
    if (!g.path) continue;
    if (g.path.startsWith('http')) continue;
    if (!fs.existsSync(g.path)) missing.push({ id: g.id, path: g.path });
}
console.log('Count:', missing.length);
missing.slice(0, 20).forEach(x => console.log('  ', x.id, '->', x.path));

// 3. Orphan wrappers
console.log('\n=== Orphan wrapper files (no catalog entry) ===');
const norm = p => path.normalize(p).replace(/\\/g, '/');
const referenced = new Set(games.map(g => g.path).filter(Boolean).map(norm));
const allFiles = fs.readdirSync('games').filter(f => f.endsWith('.html')).map(f => 'games/' + f);
const orphans = allFiles.filter(f => !referenced.has(f));
console.log('Count:', orphans.length);
orphans.slice(0, 20).forEach(o => console.log('  ', o));

// 4. Dead-repo wrappers
console.log('\n=== Wrappers using dead schoolstuff1337/supplies repo ===');
const deadList = [];
for (const f of allFiles) {
    const html = fs.readFileSync(f, 'utf8');
    if (html.includes('schoolstuff1337/supplies')) deadList.push(f);
}
console.log('Count:', deadList.length);
deadList.slice(0, 20).forEach(d => console.log('  ', d));

// 5. Multiple catalog entries → same wrapper
console.log('\n=== Catalog entries sharing one wrapper (case-insensitive) ===');
const pathMap = {};
for (const g of games) {
    if (!g.path) continue;
    const k = g.path.toLowerCase();
    (pathMap[k] = pathMap[k] || []).push(g.id);
}
const shared = Object.entries(pathMap).filter(([_, ids]) => ids.length > 1);
console.log('Count:', shared.length);
shared.slice(0, 20).forEach(([p, ids]) => console.log('  ', p, '->', ids.join(', ')));

// 6. Other suspect external CDN repos (any cdn.jsdelivr.net/gh/<repo>
//    that 404s — sample by grouping by repo)
console.log('\n=== External jsdelivr repos referenced by wrappers (top 20) ===');
const repoCounts = {};
for (const f of allFiles) {
    const html = fs.readFileSync(f, 'utf8');
    const matches = html.match(/cdn\.jsdelivr\.net\/gh\/[^/"' ]+\/[^/@"' ]+/g) || [];
    for (const m of matches) {
        repoCounts[m] = (repoCounts[m] || 0) + 1;
    }
}
const repoRanked = Object.entries(repoCounts).sort((a, b) => b[1] - a[1]);
repoRanked.slice(0, 20).forEach(([r, c]) => console.log('  ', c, '×', r));
