// One-shot: fetch Pokemon Gen 3 species + moves + items from PokeAPI and
// emit a single compact JSON the save editor loads at startup.
//
// Output: games/save-editor-pokedata.json (~80KB)
// Species 1-411 (covers Gen 3 + Box Pokemon range used by hacks),
// moves 1-354 (Gen 3 set), items 1-377 (Gen 3 set).

import fs from 'node:fs';

const POKEAPI = 'https://pokeapi.co/api/v2';

// 8-way parallel fetch with retries, since PokeAPI rate-limits ~100/s.
async function fetchJSON(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const r = await fetch(url);
            if (r.ok) return await r.json();
            if (r.status === 429) await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
        } catch {
            await new Promise((s) => setTimeout(s, 500 * (i + 1)));
        }
    }
    throw new Error(`fetch failed: ${url}`);
}

async function pmap(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    let done = 0;
    const total = items.length;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
            done++;
            if (done % 25 === 0 || done === total) {
                process.stdout.write(`\r  progress: ${done}/${total}    `);
            }
        }
    }
    await Promise.all(Array(limit).fill(0).map(worker));
    console.log();
    return out;
}

// ---- Species (1-411) ----
console.log('Fetching species 1-411...');
const SPECIES_MAX = 411;
const speciesIds = Array.from({ length: SPECIES_MAX }, (_, i) => i + 1);
const speciesRaw = await pmap(speciesIds, 8, async (id) => {
    try {
        const p = await fetchJSON(`${POKEAPI}/pokemon/${id}`);
        const stats = {};
        for (const s of p.stats) stats[s.stat.name] = s.base_stat;
        return [
            id,
            p.name,
            stats.hp || 0,
            stats.attack || 0,
            stats.defense || 0,
            stats.speed || 0,
            stats['special-attack'] || 0,
            stats['special-defense'] || 0,
            p.types.map((t) => t.type.name).join('/'),
        ];
    } catch (e) {
        console.warn(`species ${id} failed:`, e.message);
        return [id, `???`, 0, 0, 0, 0, 0, 0, ''];
    }
});

// ---- Moves (1-354 = up to Psycho Boost, Gen 3 last) ----
console.log('Fetching moves 1-354...');
const MOVES_MAX = 354;
const moveIds = Array.from({ length: MOVES_MAX }, (_, i) => i + 1);
const movesRaw = await pmap(moveIds, 8, async (id) => {
    try {
        const m = await fetchJSON(`${POKEAPI}/move/${id}`);
        return [id, m.name, m.type?.name || '', m.power || 0, m.pp || 0, m.accuracy || 0];
    } catch {
        return [id, '???', '', 0, 0, 0];
    }
});

// ---- Items: PokeAPI uses different IDs than Gen 3 ROM. We need the
//      original Gen 3 game indices, not the modern ID. Build by name. ----
//
// Gen 3 game-index list is small enough to embed. The names come from
// the official Gen 3 item list (Bulbapedia). Index 0 is "nothing".
const GEN3_ITEMS = [
    // 0-19
    '', 'Master Ball', 'Ultra Ball', 'Great Ball', 'Poke Ball', 'Safari Ball',
    'Net Ball', 'Dive Ball', 'Nest Ball', 'Repeat Ball', 'Timer Ball',
    'Luxury Ball', 'Premier Ball', 'Potion', 'Antidote', 'Burn Heal',
    'Ice Heal', 'Awakening', 'Parlyz Heal', 'Full Restore',
    // 20-39
    'Max Potion', 'Hyper Potion', 'Super Potion', 'Full Heal', 'Revive',
    'Max Revive', 'Fresh Water', 'Soda Pop', 'Lemonade', 'Moomoo Milk',
    'EnergyPowder', 'Energy Root', 'Heal Powder', 'Revival Herb', 'Ether',
    'Max Ether', 'Elixir', 'Max Elixir', 'Lava Cookie', 'Blue Flute',
    // 40-59
    'Yellow Flute', 'Red Flute', 'Black Flute', 'White Flute', 'Berry Juice',
    'Sacred Ash', 'Shoal Salt', 'Shoal Shell', 'Red Shard', 'Blue Shard',
    'Yellow Shard', 'Green Shard', '?', '?', '?',
    '?', '?', '?', '?', '?',
    // 60-79
    '?', '?', '?', 'HP Up', 'Protein',
    'Iron', 'Carbos', 'Calcium', 'Rare Candy', 'PP Up',
    'Zinc', 'PP Max', '?', 'Guard Spec.', 'Dire Hit',
    'X Attack', 'X Defend', 'X Speed', 'X Accuracy', 'X Special',
    // 80-99
    'Poke Doll', 'Fluffy Tail', '?', 'Super Repel', 'Max Repel',
    'Escape Rope', 'Repel', '?', '?', '?',
    '?', '?', '?', 'Sun Stone', 'Moon Stone',
    'Fire Stone', 'Thunder Stone', 'Water Stone', 'Leaf Stone', '?',
    // 100-119
    '?', '?', '?', 'TinyMushroom', 'Big Mushroom',
    '?', 'Pearl', 'Big Pearl', 'Stardust', 'Star Piece',
    'Nugget', 'Heart Scale', '?', '?', '?',
    '?', '?', '?', '?', 'Orange Mail',
    // 120-139
    'Harbor Mail', 'Glitter Mail', 'Mech Mail', 'Wood Mail', 'Wave Mail',
    'Bead Mail', 'Shadow Mail', 'Tropic Mail', 'Dream Mail', 'Fab Mail',
    'Retro Mail', 'Cheri Berry', 'Chesto Berry', 'Pecha Berry', 'Rawst Berry',
    'Aspear Berry', 'Leppa Berry', 'Oran Berry', 'Persim Berry', 'Lum Berry',
    // 140-159
    'Sitrus Berry', 'Figy Berry', 'Wiki Berry', 'Mago Berry', 'Aguav Berry',
    'Iapapa Berry', 'Razz Berry', 'Bluk Berry', 'Nanab Berry', 'Wepear Berry',
    'Pinap Berry', 'Pomeg Berry', 'Kelpsy Berry', 'Qualot Berry', 'Hondew Berry',
    'Grepa Berry', 'Tamato Berry', 'Cornn Berry', 'Magost Berry', 'Rabuta Berry',
    // 160-179
    'Nomel Berry', 'Spelon Berry', 'Pamtre Berry', 'Watmel Berry', 'Durin Berry',
    'Belue Berry', 'Liechi Berry', 'Ganlon Berry', 'Salac Berry', 'Petaya Berry',
    'Apicot Berry', 'Lansat Berry', 'Starf Berry', 'Enigma Berry', '?',
    '?', '?', 'BrightPowder', 'White Herb', 'Macho Brace',
    // 180-199
    'Exp. Share', 'Quick Claw', 'Soothe Bell', 'Mental Herb', 'Choice Band',
    'King\'s Rock', 'SilverPowder', 'Amulet Coin', 'Cleanse Tag', 'Soul Dew',
    'DeepSeaTooth', 'DeepSeaScale', 'Smoke Ball', 'Everstone', 'Focus Band',
    'Lucky Egg', 'Scope Lens', 'Metal Coat', 'Leftovers', 'Dragon Scale',
    // 200-219
    'Light Ball', 'Soft Sand', 'Hard Stone', 'Miracle Seed', 'BlackGlasses',
    'Black Belt', 'Magnet', 'Mystic Water', 'Sharp Beak', 'Poison Barb',
    'NeverMeltIce', 'Spell Tag', 'TwistedSpoon', 'Charcoal', 'Dragon Fang',
    'Silk Scarf', 'UpGrade', 'Shell Bell', 'Sea Incense', 'Lax Incense',
    // 220-239
    'Lucky Punch', 'Metal Powder', 'Thick Club', 'Stick', '?',
    '?', '?', '?', '?', '?',
    '?', '?', '?', '?', '?',
    '?', '?', '?', '?', '?',
    // 240-253
    '?', '?', '?', '?', '?',
    '?', '?', '?', '?', '?',
    '?', '?', '?', 'Red Scarf',
    // 254-258 contest scarves
    'Blue Scarf', 'Pink Scarf', 'Green Scarf', 'Yellow Scarf', 'Mach Bike',
    // 259-289 key items
    'Coin Case', 'Itemfinder', 'Old Rod', 'Good Rod', 'Super Rod',
    'S.S. Ticket', 'Contest Pass', '?', 'Wailmer Pail', 'Devon Goods',
    'Soot Sack', 'Basement Key', 'Acro Bike', 'PokeBlock Case', 'Letter',
    'Eon Ticket', 'Red Orb', 'Blue Orb', 'Scanner', 'Go-Goggles',
    'Meteorite', 'Rm. 1 Key', 'Rm. 2 Key', 'Rm. 4 Key', 'Rm. 6 Key',
    'Storage Key', 'Root Fossil', 'Claw Fossil', 'Devon Scope', '',
    // 289-329 TMs/HMs
    '', // 289 spacer
    'TM01', 'TM02', 'TM03', 'TM04', 'TM05', 'TM06', 'TM07', 'TM08',
    'TM09', 'TM10', 'TM11', 'TM12', 'TM13', 'TM14', 'TM15', 'TM16',
    'TM17', 'TM18', 'TM19', 'TM20', 'TM21', 'TM22', 'TM23', 'TM24',
    'TM25', 'TM26', 'TM27', 'TM28', 'TM29', 'TM30', 'TM31', 'TM32',
    'TM33', 'TM34', 'TM35', 'TM36', 'TM37', 'TM38', 'TM39', 'TM40',
    'TM41', 'TM42', 'TM43', 'TM44', 'TM45', 'TM46', 'TM47', 'TM48',
    'TM49', 'TM50',
    'HM01', 'HM02', 'HM03', 'HM04', 'HM05', 'HM06', 'HM07', 'HM08',
    '?', '?',
    // 349+ FRLG / Emerald extras
    'Oak\'s Parcel', 'Poke Flute', 'Secret Key', 'Bike Voucher', 'Gold Teeth',
    'Old Amber', 'Card Key', 'Lift Key', 'Helix Fossil', 'Dome Fossil',
    'Silph Scope', 'Bicycle', 'Town Map', 'VS Seeker', 'Fame Checker',
    'TM Case', 'Berry Pouch', 'Teachy TV', 'Tri-Pass', 'Rainbow Pass',
    'Tea', 'MysticTicket', 'AuroraTicket', 'Powder Jar', 'Ruby', 'Sapphire',
    'Magma Emblem', 'Old Sea Map',
];

const items = GEN3_ITEMS.map((name, id) => [id, name]).filter((x) => x[1]);

const data = {
    _meta: {
        generation: 3,
        speciesCount: SPECIES_MAX,
        moveCount: MOVES_MAX,
        itemCount: items.length,
        generatedAt: new Date().toISOString(),
        notes: 'Compact tuples: species=[id,name,hp,atk,def,spe,spa,spd,types]; moves=[id,name,type,power,pp,accuracy]; items=[id,name]',
    },
    species: speciesRaw,
    moves: movesRaw,
    items,
};

fs.writeFileSync('games/save-editor-pokedata.json', JSON.stringify(data));
const kb = (fs.statSync('games/save-editor-pokedata.json').size / 1024).toFixed(1);
console.log(`\nWrote games/save-editor-pokedata.json (${kb} KB)`);
console.log(`  species: ${speciesRaw.length}, moves: ${movesRaw.length}, items: ${items.length}`);
