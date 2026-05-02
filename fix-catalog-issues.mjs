// Auto-fix the catalog issues found by audit-issues.mjs.
//
// 1) Dedupe catalog entries with case-insensitive matching IDs. We keep
//    the more-complete entry (more fields populated, longer description,
//    has a real thumbnail). The dropped one is logged so we don't lose
//    metadata silently.
// 2) Tag any catalog entry whose wrapper references a known-dead
//    external repo with `broken: true`. The home grid filters these
//    out so users don't click into a dead game.
// 3) Cleanup orphan wrappers — files in games/ with no catalog entry.
//    Dry-run only (logs them); we don't delete anything automatically
//    because they may be intentional drafts.

import fs from 'node:fs';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const DEAD_REPOS = [
    'schoolstuff1337/supplies',
    'kaklikOf13/resurviv',
    'MopNop/jello',
];

const data = JSON.parse(fs.readFileSync('games/games.json', 'utf8'));
const games = Array.isArray(data) ? data : data.games;

// ─── 1. Dedupe ──────────────────────────────────────────────────
function score(g) {
    let s = 0;
    if (g.thumbnail && !g.thumbnail.includes('/platforms/')) s += 5;
    if (g.description && g.description.length > 30) s += 4;
    if (g.category && g.category !== 'Other') s += 2;
    if (Array.isArray(g.tags)) s += Math.min(g.tags.length, 8);
    if (g.addedAt) s += 2;
    if (g.rom) s += 1;
    return s;
}

const groups = {};
for (const g of games) {
    const k = (g.id || '').toLowerCase();
    (groups[k] = groups[k] || []).push(g);
}

const dedupedRaw = [];
const dropped = [];
for (const [k, group] of Object.entries(groups)) {
    if (group.length === 1) { dedupedRaw.push(group[0]); continue; }
    // Sort by score desc, keep the best
    group.sort((a, b) => score(b) - score(a));
    const winner = { ...group[0] };
    // Merge non-empty fields from the loser into winner if winner is missing them
    for (let i = 1; i < group.length; i++) {
        const loser = group[i];
        for (const key of Object.keys(loser)) {
            if (winner[key] == null && loser[key] != null) winner[key] = loser[key];
            // Merge tags
            if (key === 'tags' && Array.isArray(loser.tags)) {
                winner.tags = [...new Set([...(winner.tags || []), ...loser.tags])];
            }
        }
        dropped.push({ kept: winner.id, dropped: loser.id });
    }
    dedupedRaw.push(winner);
}

console.log('=== Dedupe ===');
console.log('Before:', games.length, 'After:', dedupedRaw.length, 'Dropped:', dropped.length);
dropped.slice(0, 10).forEach(d => console.log('  kept', d.kept, '/ dropped', d.dropped));

// ─── 2. Mark dead-repo games as broken ──────────────────────────
let markedBroken = 0;
for (const g of dedupedRaw) {
    if (!g.path) continue;
    if (g.path.startsWith('http')) continue;
    if (!fs.existsSync(g.path)) continue;
    const html = fs.readFileSync(g.path, 'utf8');
    if (DEAD_REPOS.some(r => html.includes(r))) {
        g.broken = true;
        markedBroken++;
    }
}
console.log('\n=== Broken-flag pass ===');
console.log('Marked broken:', markedBroken);

// ─── 3. Orphan wrappers ─────────────────────────────────────────
const norm = p => path.normalize(p).replace(/\\/g, '/');
const referenced = new Set(dedupedRaw.map(g => g.path).filter(Boolean).map(norm));
const allFiles = fs.readdirSync('games').filter(f => f.endsWith('.html')).map(f => 'games/' + f);
const orphans = allFiles.filter(f => !referenced.has(f) && !f.includes('_ps2-template'));

console.log('\n=== Orphan wrappers (no catalog entry) ===');
console.log('Count:', orphans.length);
orphans.forEach(o => console.log('  ', o));

// ─── Write ──────────────────────────────────────────────────────
if (APPLY) {
    fs.writeFileSync('games/games.json', JSON.stringify(dedupedRaw, null, 2));
    console.log('\n✅ games.json updated.');
} else {
    console.log('\n(dry run — pass --apply to write)');
}
