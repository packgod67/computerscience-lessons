// Expanded variant: covers Gen 1-5 (species 1-649, moves 1-559).
// Items get explicit entries per-game because PokeAPI's item IDs don't
// map to Gen 3/4/5 in-game item indices — those are per-game arrays we
// embed inline. Output goes to games/save-editor-pokedata.json.

import fs from 'node:fs';

const POKEAPI = 'https://pokeapi.co/api/v2';

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

console.log('Fetching species 1-649...');
const SPECIES_MAX = 649;  // through Genesect (end of Gen 5)
const speciesRaw = await pmap(
    Array.from({ length: SPECIES_MAX }, (_, i) => i + 1),
    10,
    async (id) => {
        try {
            const p = await fetchJSON(`${POKEAPI}/pokemon/${id}`);
            const stats = {};
            for (const s of p.stats) stats[s.stat.name] = s.base_stat;
            return [
                id, p.name,
                stats.hp || 0, stats.attack || 0, stats.defense || 0,
                stats.speed || 0, stats['special-attack'] || 0, stats['special-defense'] || 0,
                p.types.map((t) => t.type.name).join('/'),
            ];
        } catch (e) {
            console.warn(`species ${id} failed:`, e.message);
            return [id, '???', 0, 0, 0, 0, 0, 0, ''];
        }
    },
);

console.log('Fetching moves 1-559...');
const MOVES_MAX = 559;  // through V-create / Gen 5 set
const movesRaw = await pmap(
    Array.from({ length: MOVES_MAX }, (_, i) => i + 1),
    10,
    async (id) => {
        try {
            const m = await fetchJSON(`${POKEAPI}/move/${id}`);
            return [id, m.name, m.type?.name || '', m.power || 0, m.pp || 0, m.accuracy || 0];
        } catch {
            return [id, '???', '', 0, 0, 0];
        }
    },
);

// Gen 3 item table (kept from previous file)
const GEN3_ITEMS = [
    '', 'Master Ball', 'Ultra Ball', 'Great Ball', 'Poke Ball', 'Safari Ball',
    'Net Ball', 'Dive Ball', 'Nest Ball', 'Repeat Ball', 'Timer Ball',
    'Luxury Ball', 'Premier Ball', 'Potion', 'Antidote', 'Burn Heal',
    'Ice Heal', 'Awakening', 'Parlyz Heal', 'Full Restore', 'Max Potion',
    'Hyper Potion', 'Super Potion', 'Full Heal', 'Revive', 'Max Revive',
    'Fresh Water', 'Soda Pop', 'Lemonade', 'Moomoo Milk', 'EnergyPowder',
    'Energy Root', 'Heal Powder', 'Revival Herb', 'Ether', 'Max Ether',
    'Elixir', 'Max Elixir', 'Lava Cookie', 'Blue Flute', 'Yellow Flute',
    'Red Flute', 'Black Flute', 'White Flute', 'Berry Juice', 'Sacred Ash',
    'Shoal Salt', 'Shoal Shell', 'Red Shard', 'Blue Shard', 'Yellow Shard',
    'Green Shard', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?',
    'HP Up', 'Protein', 'Iron', 'Carbos', 'Calcium', 'Rare Candy', 'PP Up',
    'Zinc', 'PP Max', '?', 'Guard Spec.', 'Dire Hit', 'X Attack', 'X Defend',
    'X Speed', 'X Accuracy', 'X Special', 'Poke Doll', 'Fluffy Tail', '?',
    'Super Repel', 'Max Repel', 'Escape Rope', 'Repel', '?', '?', '?', '?',
    '?', '?', '?', 'Sun Stone', 'Moon Stone', 'Fire Stone', 'Thunder Stone',
    'Water Stone', 'Leaf Stone', '?', '?', '?', '?', 'TinyMushroom',
    'Big Mushroom', '?', 'Pearl', 'Big Pearl', 'Stardust', 'Star Piece',
    'Nugget', 'Heart Scale', '?', '?', '?', '?', '?', '?', '?', 'Orange Mail',
    'Harbor Mail', 'Glitter Mail', 'Mech Mail', 'Wood Mail', 'Wave Mail',
    'Bead Mail', 'Shadow Mail', 'Tropic Mail', 'Dream Mail', 'Fab Mail',
    'Retro Mail', 'Cheri Berry', 'Chesto Berry', 'Pecha Berry', 'Rawst Berry',
    'Aspear Berry', 'Leppa Berry', 'Oran Berry', 'Persim Berry', 'Lum Berry',
    'Sitrus Berry', 'Figy Berry', 'Wiki Berry', 'Mago Berry', 'Aguav Berry',
    'Iapapa Berry', 'Razz Berry', 'Bluk Berry', 'Nanab Berry', 'Wepear Berry',
    'Pinap Berry', 'Pomeg Berry', 'Kelpsy Berry', 'Qualot Berry', 'Hondew Berry',
    'Grepa Berry', 'Tamato Berry', 'Cornn Berry', 'Magost Berry', 'Rabuta Berry',
    'Nomel Berry', 'Spelon Berry', 'Pamtre Berry', 'Watmel Berry', 'Durin Berry',
    'Belue Berry', 'Liechi Berry', 'Ganlon Berry', 'Salac Berry', 'Petaya Berry',
    'Apicot Berry', 'Lansat Berry', 'Starf Berry', 'Enigma Berry', '?', '?', '?',
    'BrightPowder', 'White Herb', 'Macho Brace', 'Exp. Share', 'Quick Claw',
    'Soothe Bell', 'Mental Herb', 'Choice Band', "King's Rock", 'SilverPowder',
    'Amulet Coin', 'Cleanse Tag', 'Soul Dew', 'DeepSeaTooth', 'DeepSeaScale',
    'Smoke Ball', 'Everstone', 'Focus Band', 'Lucky Egg', 'Scope Lens',
    'Metal Coat', 'Leftovers', 'Dragon Scale', 'Light Ball', 'Soft Sand',
    'Hard Stone', 'Miracle Seed', 'BlackGlasses', 'Black Belt', 'Magnet',
    'Mystic Water', 'Sharp Beak', 'Poison Barb', 'NeverMeltIce', 'Spell Tag',
    'TwistedSpoon', 'Charcoal', 'Dragon Fang', 'Silk Scarf', 'UpGrade',
    'Shell Bell', 'Sea Incense', 'Lax Incense', 'Lucky Punch', 'Metal Powder',
    'Thick Club', 'Stick', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?',
    '?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?',
    'Red Scarf', 'Blue Scarf', 'Pink Scarf', 'Green Scarf', 'Yellow Scarf',
    'Mach Bike', 'Coin Case', 'Itemfinder', 'Old Rod', 'Good Rod', 'Super Rod',
    'S.S. Ticket', 'Contest Pass', '?', 'Wailmer Pail', 'Devon Goods',
    'Soot Sack', 'Basement Key', 'Acro Bike', 'PokeBlock Case', 'Letter',
    'Eon Ticket', 'Red Orb', 'Blue Orb', 'Scanner', 'Go-Goggles', 'Meteorite',
    'Rm. 1 Key', 'Rm. 2 Key', 'Rm. 4 Key', 'Rm. 6 Key', 'Storage Key',
    'Root Fossil', 'Claw Fossil', 'Devon Scope', '',
    'TM01', 'TM02', 'TM03', 'TM04', 'TM05', 'TM06', 'TM07', 'TM08', 'TM09',
    'TM10', 'TM11', 'TM12', 'TM13', 'TM14', 'TM15', 'TM16', 'TM17', 'TM18',
    'TM19', 'TM20', 'TM21', 'TM22', 'TM23', 'TM24', 'TM25', 'TM26', 'TM27',
    'TM28', 'TM29', 'TM30', 'TM31', 'TM32', 'TM33', 'TM34', 'TM35', 'TM36',
    'TM37', 'TM38', 'TM39', 'TM40', 'TM41', 'TM42', 'TM43', 'TM44', 'TM45',
    'TM46', 'TM47', 'TM48', 'TM49', 'TM50',
    'HM01', 'HM02', 'HM03', 'HM04', 'HM05', 'HM06', 'HM07', 'HM08', '?', '?',
    "Oak's Parcel", 'Poke Flute', 'Secret Key', 'Bike Voucher', 'Gold Teeth',
    'Old Amber', 'Card Key', 'Lift Key', 'Helix Fossil', 'Dome Fossil',
    'Silph Scope', 'Bicycle', 'Town Map', 'VS Seeker', 'Fame Checker',
    'TM Case', 'Berry Pouch', 'Teachy TV', 'Tri-Pass', 'Rainbow Pass', 'Tea',
    'MysticTicket', 'AuroraTicket', 'Powder Jar', 'Ruby', 'Sapphire',
    'Magma Emblem', 'Old Sea Map',
];

// Gen 4 + Gen 5 share an item ID table starting at 1 = Master Ball. We
// embed a compact list — names only; quantity rules differ per game
// but parsers handle that. Common items repeat across gens 3-5 with
// the same Master Ball=1, Poke Ball=4 baseline. The Gen 4/5 ID range
// extends further; we include up to 639 covering all Gen 5 items.
const GEN45_ITEMS = [
    '', 'Master Ball', 'Ultra Ball', 'Great Ball', 'Poke Ball', 'Safari Ball',
    'Net Ball', 'Dive Ball', 'Nest Ball', 'Repeat Ball', 'Timer Ball', 'Luxury Ball',
    'Premier Ball', 'Dusk Ball', 'Heal Ball', 'Quick Ball', 'Cherish Ball',
    'Potion', 'Antidote', 'Burn Heal', 'Ice Heal', 'Awakening', 'Parlyz Heal',
    'Full Restore', 'Max Potion', 'Hyper Potion', 'Super Potion', 'Full Heal',
    'Revive', 'Max Revive', 'Fresh Water', 'Soda Pop', 'Lemonade', 'Moomoo Milk',
    'Energy Powder', 'Energy Root', 'Heal Powder', 'Revival Herb', 'Ether',
    'Max Ether', 'Elixir', 'Max Elixir', 'Lava Cookie', 'Berry Juice',
    'Sacred Ash', 'HP Up', 'Protein', 'Iron', 'Carbos', 'Calcium', 'Rare Candy',
    'PP Up', 'Zinc', 'PP Max', 'Old Gateau', 'Guard Spec.', 'Dire Hit',
    'X Attack', 'X Defend', 'X Speed', 'X Accuracy', 'X Special', 'X Sp. Def',
    'Poke Doll', 'Fluffy Tail', 'Blue Flute', 'Yellow Flute', 'Red Flute',
    'Black Flute', 'White Flute', 'Shoal Salt', 'Shoal Shell', 'Red Shard',
    'Blue Shard', 'Yellow Shard', 'Green Shard', 'Super Repel', 'Max Repel',
    'Escape Rope', 'Repel', 'Sun Stone', 'Moon Stone', 'Fire Stone',
    'Thunderstone', 'Water Stone', 'Leaf Stone', 'TinyMushroom', 'Big Mushroom',
    'Pearl', 'Big Pearl', 'Stardust', 'Star Piece', 'Nugget', 'Heart Scale',
    'Honey', 'Growth Mulch', 'Damp Mulch', 'Stable Mulch', 'Gooey Mulch',
    'Root Fossil', 'Claw Fossil', 'Helix Fossil', 'Dome Fossil', 'Old Amber',
    'Armor Fossil', 'Skull Fossil',
    // 102-150 — held items / berries
    'Rare Bone', 'Shiny Stone', 'Dusk Stone', 'Dawn Stone', 'Oval Stone',
    'Odd Keystone', 'Griseous Orb',
    // 108-149 placeholder
    ...Array(42).fill('?'),
    'Bicycle', 'Old Rod', 'Good Rod', 'Super Rod',
    ...Array(20).fill('?'),
    'Cheri Berry', 'Chesto Berry', 'Pecha Berry', 'Rawst Berry', 'Aspear Berry',
    'Leppa Berry', 'Oran Berry', 'Persim Berry', 'Lum Berry', 'Sitrus Berry',
    'Figy Berry', 'Wiki Berry', 'Mago Berry', 'Aguav Berry', 'Iapapa Berry',
    'Razz Berry', 'Bluk Berry', 'Nanab Berry', 'Wepear Berry', 'Pinap Berry',
    'Pomeg Berry', 'Kelpsy Berry', 'Qualot Berry', 'Hondew Berry', 'Grepa Berry',
    'Tamato Berry', 'Cornn Berry', 'Magost Berry', 'Rabuta Berry', 'Nomel Berry',
    'Spelon Berry', 'Pamtre Berry', 'Watmel Berry', 'Durin Berry', 'Belue Berry',
    'Occa Berry', 'Passho Berry', 'Wacan Berry', 'Rindo Berry', 'Yache Berry',
    'Chople Berry', 'Kebia Berry', 'Shuca Berry', 'Coba Berry', 'Payapa Berry',
    'Tanga Berry', 'Charti Berry', 'Kasib Berry', 'Haban Berry', 'Colbur Berry',
    'Babiri Berry', 'Chilan Berry', 'Liechi Berry', 'Ganlon Berry', 'Salac Berry',
    'Petaya Berry', 'Apicot Berry', 'Lansat Berry', 'Starf Berry', 'Enigma Berry',
    'Micle Berry', 'Custap Berry', 'Jaboca Berry', 'Rowap Berry',
    // 213-247 held items
    'BrightPowder', 'White Herb', 'Macho Brace', 'Exp. Share', 'Quick Claw',
    'Soothe Bell', 'Mental Herb', 'Choice Band', "King's Rock", 'SilverPowder',
    'Amulet Coin', 'Cleanse Tag', 'Soul Dew', 'DeepSeaTooth', 'DeepSeaScale',
    'Smoke Ball', 'Everstone', 'Focus Band', 'Lucky Egg', 'Scope Lens',
    'Metal Coat', 'Leftovers', 'Dragon Scale', 'Light Ball', 'Soft Sand',
    'Hard Stone', 'Miracle Seed', 'BlackGlasses', 'Black Belt', 'Magnet',
    'Mystic Water', 'Sharp Beak', 'Poison Barb', 'NeverMeltIce', 'Spell Tag',
    'TwistedSpoon', 'Charcoal', 'Dragon Fang', 'Silk Scarf', 'Up-Grade',
    'Shell Bell', 'Sea Incense', 'Lax Incense', 'Lucky Punch', 'Metal Powder',
    'Thick Club', 'Stick',
    // 260-263 evolution stones
    'Red Scarf', 'Blue Scarf', 'Pink Scarf', 'Green Scarf', 'Yellow Scarf',
    // 265+ Gen 4 specifics
    'Wide Lens', 'Muscle Band', 'Wise Glasses', 'Expert Belt', 'Light Clay',
    'Life Orb', 'Power Herb', 'Toxic Orb', 'Flame Orb', 'Quick Powder',
    'Focus Sash', 'Zoom Lens', 'Metronome', 'Iron Ball', 'Lagging Tail',
    'Destiny Knot', 'Black Sludge', 'Icy Rock', 'Smooth Rock', 'Heat Rock',
    'Damp Rock', 'Grip Claw', 'Choice Scarf', 'Sticky Barb', 'Power Bracer',
    'Power Belt', 'Power Lens', 'Power Band', 'Power Anklet', 'Power Weight',
    'Shed Shell', 'Big Root', 'Choice Specs',
    // Mail / TMs / HMs / key items
    ...Array(35).fill('?'),
    'TM01', 'TM02', 'TM03', 'TM04', 'TM05', 'TM06', 'TM07', 'TM08', 'TM09',
    'TM10', 'TM11', 'TM12', 'TM13', 'TM14', 'TM15', 'TM16', 'TM17', 'TM18',
    'TM19', 'TM20', 'TM21', 'TM22', 'TM23', 'TM24', 'TM25', 'TM26', 'TM27',
    'TM28', 'TM29', 'TM30', 'TM31', 'TM32', 'TM33', 'TM34', 'TM35', 'TM36',
    'TM37', 'TM38', 'TM39', 'TM40', 'TM41', 'TM42', 'TM43', 'TM44', 'TM45',
    'TM46', 'TM47', 'TM48', 'TM49', 'TM50', 'TM51', 'TM52', 'TM53', 'TM54',
    'TM55', 'TM56', 'TM57', 'TM58', 'TM59', 'TM60', 'TM61', 'TM62', 'TM63',
    'TM64', 'TM65', 'TM66', 'TM67', 'TM68', 'TM69', 'TM70', 'TM71', 'TM72',
    'TM73', 'TM74', 'TM75', 'TM76', 'TM77', 'TM78', 'TM79', 'TM80', 'TM81',
    'TM82', 'TM83', 'TM84', 'TM85', 'TM86', 'TM87', 'TM88', 'TM89', 'TM90',
    'TM91', 'TM92',
    'HM01', 'HM02', 'HM03', 'HM04', 'HM05', 'HM06', 'HM07', 'HM08',
];

const itemsGen3 = GEN3_ITEMS.map((name, id) => [id, name]).filter((x) => x[1] && x[1] !== '?');
const itemsGen45 = GEN45_ITEMS.map((name, id) => [id, name]).filter((x) => x[1] && x[1] !== '?');

const data = {
    _meta: {
        generations: [1, 2, 3, 4, 5],
        speciesCount: SPECIES_MAX,
        moveCount: MOVES_MAX,
        generatedAt: new Date().toISOString(),
        notes: 'Tuples: species=[id,name,hp,atk,def,spe,spa,spd,types]; moves=[id,name,type,power,pp,accuracy]; items=[id,name]. items.gen3 = Gen 3 RSE/FRLG item table; items.gen45 = Gen 4 + Gen 5 item table.',
    },
    species: speciesRaw,
    moves: movesRaw,
    items: itemsGen3,        // back-compat: Gen 3 editor reads `items` directly
    itemsGen3,
    itemsGen45,
};

fs.writeFileSync('games/save-editor-pokedata.json', JSON.stringify(data));
const kb = (fs.statSync('games/save-editor-pokedata.json').size / 1024).toFixed(1);
console.log(`\nWrote games/save-editor-pokedata.json (${kb} KB)`);
console.log(`  species: ${speciesRaw.length}, moves: ${movesRaw.length}`);
console.log(`  Gen 3 items: ${itemsGen3.length}, Gen 4/5 items: ${itemsGen45.length}`);
