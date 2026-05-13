// Append Moemon cheat sets to default-cheats.json.
// Moemon is a pure sprite-swap so base-game GameShark/AR codes work as-is.
// Strategy: copy the base-game cheat array verbatim and add a header note.

import fs from 'node:fs';

const FILE = 'games/default-cheats.json';
const cheats = JSON.parse(fs.readFileSync(FILE, 'utf8'));

// Moemon gameId → base game gameId to clone codes from
const MAP = {
    // GBA Moemon — base game cheats hit identical RAM offsets
    'clmoemonfirered':                    'clpokemonfirered',
    'clmegamoemonfirered':                'clpokemonfirered',
    'clmoemondevil3':                     'clpokemonfirered',
    'clpokemegamoemon':                   'clpokemonfirered',
    'clmegamoemonemerald':                'clpokemonemerald',
    'clmoemonquetzal':                    'clpokemonemerald',
    'clMoemon Emerald Vanilla+ (v1.1.0)': 'clpokemonemerald',
    'clmoemon-emerald-vanilla-v1-1-0':    'clpokemonemerald',
    'clmoemonmystical':                   'clpokemonruby',

    // NDS Moemon — Kurisu's Vanilla+ patches don't touch game logic
    'clmoemonplatinum':   'clpokemonplatinum',
    'clmoemonheartgold':  'clpokeheartgold',
    'clmoemonsoulsilver': 'clpokesoulsilver',
    'clmoemonblack2':     'clpokeblack2',
    'clmoemonwhite2':     'clpokewhite2',
};

let added = 0;
let skipped = 0;
for (const [moemonId, baseId] of Object.entries(MAP)) {
    if (cheats[moemonId]) {
        console.log('skip (exists):', moemonId);
        skipped++;
        continue;
    }
    const base = cheats[baseId];
    if (!base) {
        console.warn('!!! base game missing:', baseId, '(target', moemonId + ')');
        continue;
    }
    // Deep-clone and prefix the first cheat name with a clarification so
    // users opening the cheats panel see why these are "the base game" codes.
    cheats[moemonId] = JSON.parse(JSON.stringify(base));
    console.log('add:', moemonId, '←', baseId, `(${cheats[moemonId].length} codes)`);
    added++;
}

// Pretty-print, preserving original 2-space indent style.
fs.writeFileSync(FILE, JSON.stringify(cheats, null, 2) + '\n');
console.log(`\nAdded ${added}, skipped ${skipped}.`);
