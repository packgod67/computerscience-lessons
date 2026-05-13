// Append Moemon catalog entries + mark the existing broken Vanilla+ wrapper.
// Idempotent: skips entries whose id already exists.

import fs from 'node:fs';

const FILE = 'games/games.json';
const NOW = new Date().toISOString();

const ENTRIES = [
    {
        id: 'clmoemonfirered',
        title: 'Moemon FireRed',
        category: 'Pokemon',
        path: 'games/clmoemonfirered.html',
        description: 'Classic Moemon hack of Pokemon FireRed — every Kanto Pokemon redrawn as an anime-style "moe" girl while the original story, gym order, and battle mechanics stay intact. The hack that started the whole Moemon trend.',
        thumbnail: 'https://archive.org/services/img/MoemonFireRed',
        rom: 'gba',
        addedAt: NOW,
        tags: ['pokemon', 'moemon', 'rom-hack', 'fakemon', 'monster-tamer', 'anime', 'sprite-swap', 'gba', 'hack', 'kanto', 'retro'],
    },
    {
        id: 'clmegamoemonfirered',
        title: 'Mega Moemon FireRed (v1.4c)',
        category: 'Pokemon',
        path: 'games/clmegamoemonfirered.html',
        description: 'Septentrion\'s flagship Moemon update — about 600 moe-girl Pokemon from Gens 1-8, Mega Evolutions, Fairy typing, double encounters, and curated trainer rosters. The most polished Moemon to play first.',
        thumbnail: 'https://www.pokeharbor.com/wp-content/uploads/2021/07/Mega-Moemon-FireRed-1.png',
        rom: 'gba',
        addedAt: NOW,
        tags: ['pokemon', 'moemon', 'mega-evolution', 'fakemon', 'monster-tamer', 'anime', 'fairy-type', 'sprite-swap', 'gba', 'hack', 'rom-hack', 'difficulty-hack', 'kanto', 'retro'],
    },
    {
        id: 'clmegamoemonemerald',
        title: 'Mega Moemon Emerald (v0.4.2)',
        category: 'Pokemon',
        path: 'games/clmegamoemonemerald.html',
        description: 'Mega Evolutions land in Hoenn — Moemon sprite swap of Pokemon Emerald with added Megas and extra overworld sprite work. Early-access build but the full Hoenn campaign is playable end-to-end.',
        thumbnail: 'https://archive.org/services/img/mega-moemon-emerald',
        rom: 'gba',
        addedAt: NOW,
        tags: ['pokemon', 'moemon', 'mega-evolution', 'fakemon', 'monster-tamer', 'anime', 'sprite-swap', 'gba', 'hack', 'rom-hack', 'hoenn', 'retro'],
    },
    {
        id: 'clmoemonmystical',
        title: 'Moemon Mystical',
        category: 'Pokemon',
        path: 'games/clmoemonmystical.html',
        description: 'Ruby-based Moemon hack with a completed v1 release — full Hoenn run with the entire roster reimagined as moe-style girls. Self-contained build, no patching required.',
        thumbnail: 'https://www.pokeharbor.com/wp-content/uploads/2021/09/moemon_mystical_1_sc.png',
        rom: 'gba',
        addedAt: NOW,
        tags: ['pokemon', 'moemon', 'fakemon', 'monster-tamer', 'anime', 'sprite-swap', 'gba', 'hack', 'rom-hack', 'hoenn', 'retro'],
    },
    {
        id: 'clmoemondevil3',
        title: 'Moemon Devil 3RdXPlus',
        category: 'Pokemon',
        path: 'games/clmoemondevil3.html',
        description: 'French-origin difficulty hack — significantly harder gym battles and trainer rosters paired with Moemon sprite replacements. For players who already cleared vanilla FireRed and want a tougher run with the moe aesthetic.',
        thumbnail: 'https://archive.org/services/img/moemon-devil-3-rd-xplus-v-1.02',
        rom: 'gba',
        addedAt: NOW,
        tags: ['pokemon', 'moemon', 'difficulty-hack', 'fakemon', 'monster-tamer', 'anime', 'sprite-swap', 'gba', 'hack', 'rom-hack', 'hard', 'kanto', 'retro'],
    },
    {
        id: 'clmoemonquetzal',
        title: 'Moemon Quetzal (English Alpha 8v4)',
        category: 'Pokemon',
        path: 'games/clmoemonquetzal.html',
        description: 'Moemon-skinned build of Pokemon Quetzal — Emerald base with multiplayer netcode (co-op and PvP), branching paths, custom regions, and the full roster as moe-style girls. English Alpha 8 build.',
        thumbnail: 'https://archive.org/services/img/moemon-quetzal-english-alpha-8v-4',
        rom: 'gba',
        addedAt: NOW,
        tags: ['pokemon', 'moemon', 'multiplayer', 'fakemon', 'monster-tamer', 'anime', 'sprite-swap', 'gba', 'hack', 'rom-hack', 'quetzal', 'hoenn', 'retro'],
    },
    {
        id: 'clmoemonplatinum',
        title: 'Moemon Platinum (v1.4)',
        category: 'Pokemon',
        path: 'games/clmoemonplatinum.html',
        description: 'Kurisu\'s NDS Vanilla+ port — pure sprite swap of Pokemon Platinum, no story changes. Full Sinnoh campaign with every Pokemon redrawn as a moe-style girl, including the distortion-world Giratina arc.',
        thumbnail: 'https://archive.org/services/img/moemon-platinum',
        rom: 'nds',
        addedAt: NOW,
        tags: ['pokemon', 'moemon', 'fakemon', 'monster-tamer', 'anime', 'sprite-swap', 'nds', 'hack', 'rom-hack', 'sinnoh', 'retro'],
    },
    {
        id: 'clmoemonsoulsilver',
        title: 'Moemon SoulSilver (v1.4)',
        category: 'Pokemon',
        path: 'games/clmoemonsoulsilver.html',
        description: 'Kurisu\'s Vanilla+ Moemon port of HGSS SoulSilver — full Johto and Kanto adventure with the entire roster redrawn as moe-style girls. Walking-buddy follower system intact.',
        thumbnail: 'https://archive.org/services/img/moemon-soulsilver',
        rom: 'nds',
        addedAt: NOW,
        tags: ['pokemon', 'moemon', 'fakemon', 'monster-tamer', 'anime', 'sprite-swap', 'nds', 'hack', 'rom-hack', 'johto', 'kanto', 'retro'],
    },
    {
        id: 'clmoemonheartgold',
        title: 'Moemon HeartGold (v1.4)',
        category: 'Pokemon',
        path: 'games/clmoemonheartgold.html',
        description: 'Kurisu\'s Vanilla+ Moemon port of HGSS HeartGold — twin to SoulSilver with the version-exclusive encounters swapped. Full Johto plus Kanto run with moe-style Pokemon sprites throughout.',
        thumbnail: 'https://archive.org/services/img/moemon-heartgold',
        rom: 'nds',
        addedAt: NOW,
        tags: ['pokemon', 'moemon', 'fakemon', 'monster-tamer', 'anime', 'sprite-swap', 'nds', 'hack', 'rom-hack', 'johto', 'kanto', 'retro'],
    },
    {
        id: 'clmoemonblack2',
        title: 'Moemon Black 2 (v1.1)',
        category: 'Pokemon',
        path: 'games/clmoemonblack2.html',
        description: 'Kurisu\'s Vanilla+ Moemon port of Black 2 — Unova post-game story with the entire Gen 5 plus cross-gen roster reimagined as moe-style girls. Hefty 512MB build, includes story content from the sequel arc.',
        thumbnail: 'https://archive.org/services/img/moemon-black-2',
        rom: 'nds',
        addedAt: NOW,
        tags: ['pokemon', 'moemon', 'fakemon', 'monster-tamer', 'anime', 'sprite-swap', 'nds', 'hack', 'rom-hack', 'unova', 'retro'],
    },
    {
        id: 'clmoemonwhite2',
        title: 'Moemon White 2 (v1.1)',
        category: 'Pokemon',
        path: 'games/clmoemonwhite2.html',
        description: 'Kurisu\'s Vanilla+ Moemon port of White 2 — paired with Black 2, with the version-exclusive encounters reflavored as moe-style girls. Full Unova post-game campaign at 512MB.',
        thumbnail: 'https://archive.org/services/img/moemon-white-2',
        rom: 'nds',
        addedAt: NOW,
        tags: ['pokemon', 'moemon', 'fakemon', 'monster-tamer', 'anime', 'sprite-swap', 'nds', 'hack', 'rom-hack', 'unova', 'retro'],
    },
];

const games = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const existing = new Set(games.map((g) => g.id));

let added = 0;
let skipped = 0;
for (const e of ENTRIES) {
    if (existing.has(e.id)) {
        console.log('skip (exists):', e.id);
        skipped++;
        continue;
    }
    games.push(e);
    added++;
    console.log('add:', e.id);
}

// Patch the existing broken Moemon Emerald Vanilla+ entries:
//   - add description + thumbnail so the card stops looking broken in UI
//   - mark broken: true so the warning chip shows (source ROM dead)
//   - normalize duplicate ID to canonical
for (const g of games) {
    if (g.id === 'clMoemon Emerald Vanilla+ (v1.1.0)' || g.id === 'clmoemon-emerald-vanilla-v1-1-0') {
        g.title = 'Moemon Emerald Vanilla+ (v1.1.0)';
        g.category = 'Pokemon';
        g.description = 'Pure sprite-swap of Pokemon Emerald — full Hoenn campaign with the entire roster redrawn as moe-style girls, no story or balance changes. NOTE: original CDN source went down; load may fail until re-mirrored.';
        g.thumbnail = 'https://www.pokeharbor.com/wp-content/uploads/2021/09/Moemon_Sapphire_01.png';
        g.rom = 'gba';
        g.tags = ['pokemon', 'moemon', 'fakemon', 'monster-tamer', 'anime', 'sprite-swap', 'gba', 'hack', 'rom-hack', 'hoenn', 'retro'];
        g.broken = true;
    }
}

fs.writeFileSync(FILE, JSON.stringify(games, null, 2) + '\n');
console.log(`\nAdded ${added}, skipped ${skipped}. Catalog now has ${games.length} entries.`);
