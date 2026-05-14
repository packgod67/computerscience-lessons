// Synthetic round-trip tests for Gen 4 + Gen 5 NDS save parsers.
// Self-consistency only: we generate a save through write(), parse it
// back, mutate, write again, parse again — and assert all fields survive.
// Doesn't catch bugs where our format diverges from PKHeX's reading of
// real saves; for that, drop an actual Pokemon Platinum / HGSS / B2W2
// save into the editor and try it.

import fs from 'node:fs';
import vm from 'node:vm';

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('js/save-editor-gen4.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync('js/save-editor-gen5.js', 'utf8'), ctx);
const G4 = ctx.window.SaveEditorGen4;
const G5 = ctx.window.SaveEditorGen5;

function expect(label, got, want) {
    const ok = got === want;
    console.log(`  ${ok ? '✓' : '✗'} ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    if (!ok) process.exitCode = 1;
}

// ============================================================
// Gen 4 test
// ============================================================
console.log('Gen 4 (Platinum) test:');

// Build a valid empty Pt save:
//   - 524288 bytes
//   - General block at slot A 0x00000-0xCF2C
//   - Storage block at 0xCF2C-0x1F110
//   - Magic 0x20060623 at slot A general end - 8 = 0xCF24
//   - Major counter at general end - 0x14 = 0xCF18 (u32)
//   - CRCs at slot A general end - 2 = 0xCF2A AND slot A storage end - 2
//   - Same for slot B at +0x40000
//
// Pre-write only the magic + counter + party count + one party Pokemon,
// then let writePokemon + CRC fixup populate the rest via G4.write().

const SLOT_A = 0x00000;
const SLOT_B = 0x40000;
const PT = { generalSize: 0xCF2C, storageStart: 0xCF2C, storageSize: 0x121E4,
             footerSize: 0x14, trainer1: 0x68, party: 0xA0 };

const buf = new Uint8Array(0x80000);

function writeMagic(slot) {
    // Major counter (highest at slot A so it wins active-slot pick)
    const ctr = slot === SLOT_A ? 100 : 50;
    const footer = slot + PT.generalSize - 0x14;
    // major counter (u32)
    buf[footer + 0] = ctr & 0xFF;
    // magic (u32) at footer + 0x0C
    const m = 0x20060623;
    buf[footer + 0x0C + 0] = m & 0xFF;
    buf[footer + 0x0C + 1] = (m >> 8) & 0xFF;
    buf[footer + 0x0C + 2] = (m >> 16) & 0xFF;
    buf[footer + 0x0C + 3] = (m >>> 24) & 0xFF;
    // Storage footer too
    const sfooter = slot + PT.storageStart + PT.storageSize - 0x14;
    buf[sfooter + 0] = ctr & 0xFF;
    buf[sfooter + 0x0C + 0] = m & 0xFF;
    buf[sfooter + 0x0C + 1] = (m >> 8) & 0xFF;
    buf[sfooter + 0x0C + 2] = (m >> 16) & 0xFF;
    buf[sfooter + 0x0C + 3] = (m >>> 24) & 0xFF;
}
writeMagic(SLOT_A);
writeMagic(SLOT_B);

// Hand-craft a Pokemon at SLOT_A + party offset (slot 0):
const partyOff = SLOT_A + PT.party;
buf[SLOT_A + PT.party - 4] = 1; // partyCount=1

// Use Gen 4 writePokemon to encrypt one Pokemon for us
const seed = { isEmpty: false, isPC: false,
    pid: 0x10001000,
    otid: ((0x1234 << 16) | 0x5678) >>> 0,
    nickname: 'PIKA',
    otName: 'ASH',
    language: 2,
    growth: { species: 25, heldItem: 0, otTid: 0x5678, otSid: 0x1234,
              exp: 8000, friendship: 70, ability: 0, markings: 0, language: 2 },
    attacks: { moves: [85, 0, 0, 0], pp: [15, 0, 0, 0] },
    evs: { hp: 0, atk: 0, def: 0, spe: 0, spa: 0, spd: 0,
           cool: 0, beauty: 0, cute: 0, smart: 0, tough: 0, feel: 0 },
    misc: { pokerus: 0, metLoc: 0, originInfo: 0,
            ivs: { hp: 31, atk: 31, def: 31, spe: 31, spa: 31, spd: 31 },
            isEgg: 0, ability: 0, ribbons: 0 },
    status: 0, level: 20, currentHp: 70, maxHp: 70,
    attack: 50, defense: 40, speed: 90, spAttack: 50, spDefense: 50,
};
G4._writePokemon(buf, partyOff, seed, true);

// Initial CRC fixup pass — needs G4.parse hooks but we can't call parse
// until magic + CRCs are set. Bootstrap: directly compute + write the
// two CRCs for slot A blocks, mirror to slot B.
function fixCRCsSlot(slot) {
    const genCk = G4._crc16(buf, slot, PT.generalSize - 2);
    buf[slot + PT.generalSize - 2] = genCk & 0xFF;
    buf[slot + PT.generalSize - 1] = (genCk >> 8) & 0xFF;
    const stoCk = G4._crc16(buf, slot + PT.storageStart, PT.storageSize - 2);
    buf[slot + PT.storageStart + PT.storageSize - 2] = stoCk & 0xFF;
    buf[slot + PT.storageStart + PT.storageSize - 1] = (stoCk >> 8) & 0xFF;
}
fixCRCsSlot(SLOT_A);
// Slot B: copy slot A bytes then fix CRC so both slots are valid
buf.set(buf.subarray(SLOT_A, SLOT_A + PT.generalSize), SLOT_B);
buf.set(buf.subarray(SLOT_A + PT.storageStart, SLOT_A + PT.storageStart + PT.storageSize), SLOT_B + PT.storageStart);
// But change slot B counter to be lower so slot A wins
buf[SLOT_B + PT.generalSize - 0x14] = 50;
buf[SLOT_B + PT.storageStart + PT.storageSize - 0x14] = 50;
fixCRCsSlot(SLOT_B);

console.log('  parsing...');
let save;
try { save = G4.parse(buf); }
catch (e) { console.error('  ✗ parse failed:', e.message); process.exitCode = 1; throw e; }

expect('game',          save.game, 'pt');
expect('party count',   save.party.length, 1);
expect('species',       save.party[0].growth.species, 25);
expect('level',         save.party[0].level, 20);
expect('move 0',        save.party[0].attacks.moves[0], 85);
expect('iv hp',         save.party[0].misc.ivs.hp, 31);
expect('exp',           save.party[0].growth.exp, 8000);
expect('checksum valid', save.party[0].checksumValid, true);
expect('nature',        G4.getNature(save.party[0]), G4.NATURE_NAMES[0x10001000 % 25]);

// Mutate + round-trip
const pk = save.party[0];
pk.growth.species = 6; // Charizard
pk.level = 50;
pk.attacks.moves[1] = 53;
pk.attacks.pp[1] = 15;
pk.misc.ivs.atk = 0;
pk.evs.spa = 252;
G4.setShiny(pk, true);

const out = G4.write(save, { trainerName: 'ASH', money: 99999, party: save.party });
const save2 = G4.parse(out);
expect('rt species',    save2.party[0].growth.species, 6);
expect('rt level',      save2.party[0].level, 50);
expect('rt move 1',     save2.party[0].attacks.moves[1], 53);
expect('rt iv atk',     save2.party[0].misc.ivs.atk, 0);
expect('rt ev spa',     save2.party[0].evs.spa, 252);
expect('rt shiny',      G4.isShiny(save2.party[0]), true);
expect('rt money',      save2.money, 99999);
expect('rt checksum',   save2.party[0].checksumValid, true);

// PC box test
const pcSlot = save2.pc.boxes[5][10];
pcSlot.isEmpty = false;
pcSlot.pid = 0x12345678;
pcSlot.otid = save2.party[0].otid;
pcSlot.nickname = 'BOXMON';
pcSlot.otName = 'ASH';
pcSlot.language = 2;
pcSlot.growth = { species: 150, heldItem: 0, otTid: pcSlot.otid & 0xFFFF, otSid: (pcSlot.otid >>> 16) & 0xFFFF,
                  exp: 125000, friendship: 100, ability: 0, markings: 0, language: 2 };
pcSlot.attacks = { moves: [94, 0, 0, 0], pp: [10, 0, 0, 0] };
pcSlot.evs = { hp: 4, atk: 0, def: 0, spe: 252, spa: 252, spd: 0,
               cool: 0, beauty: 0, cute: 0, smart: 0, tough: 0, feel: 0 };
pcSlot.misc.ivs = { hp: 31, atk: 0, def: 31, spe: 31, spa: 31, spd: 31 };
save2.pc.names[5] = 'TESTBOX';
save2.pc.wallpapers[5] = 3;
save2.pc.currentBox = 5;

const out2 = G4.write(save2, { trainerName: 'ASH', money: 99999, party: save2.party, pc: save2.pc });
const save3 = G4.parse(out2);
expect('pc box[5][10] species', save3.pc.boxes[5][10].growth.species, 150);
expect('pc move',               save3.pc.boxes[5][10].attacks.moves[0], 94);
expect('pc ev spa',             save3.pc.boxes[5][10].evs.spa, 252);
expect('pc current box',        save3.pc.currentBox, 5);
expect('pc wallpaper',          save3.pc.wallpapers[5], 3);
// PKHeX style: empty slot stays empty
expect('pc other slot empty',   save3.pc.boxes[5][11].isEmpty, true);

// ============================================================
// Gen 5 test (BW)
// ============================================================
console.log('\nGen 5 (Black/White) test:');

const buf5 = new Uint8Array(0x80000);
const BW_BLOCKS = {
    boxLayout: [0, 0x00000, 0x03E0],
    boxes: Array.from({length: 24}, (_, i) => [i + 1, 0x00400 + i * 0x1000, 0x0FF0]),
    inventory: [25, 0x18400, 0x09C0],
    party:     [26, 0x18E00, 0x0534],
    trainer:   [27, 0x19400, 0x0068],
    misc:      [52, 0x21200, 0x00EC],
    pokedex:   [55, 0x21600, 0x04D4],
    checksumBlock: 0x23F00,
};

// Place a party Pokemon at party block + 8 (slot 0)
const partyBlockOff = BW_BLOCKS.party[1];
buf5[partyBlockOff + 4] = 1; // count
const seed5 = JSON.parse(JSON.stringify(seed));
seed5.pid = 0x10001000;
seed5.otid = ((0x1234 << 16) | 0x5678) >>> 0;
G4._writePokemon(buf5, partyBlockOff + 8, seed5, true);

// Trainer name "ASH" at trainer block + 4
function setTrainer5() {
    const trOff = BW_BLOCKS.trainer[1];
    // UTF-16LE "ASH"
    buf5[trOff + 4] = 0x41; buf5[trOff + 5] = 0x00;
    buf5[trOff + 6] = 0x53; buf5[trOff + 7] = 0x00;
    buf5[trOff + 8] = 0x48; buf5[trOff + 9] = 0x00;
    buf5[trOff + 10] = 0xFF; buf5[trOff + 11] = 0xFF;
    // TID = 0x5678
    buf5[trOff + 0x14] = 0x78; buf5[trOff + 0x15] = 0x56;
    // SID = 0x1234
    buf5[trOff + 0x16] = 0x34; buf5[trOff + 0x17] = 0x12;
}
setTrainer5();
// Money = 12345
buf5[BW_BLOCKS.misc[1] + 0] = 0x39;
buf5[BW_BLOCKS.misc[1] + 1] = 0x30;
buf5[BW_BLOCKS.misc[1] + 2] = 0x00;
buf5[BW_BLOCKS.misc[1] + 3] = 0x00;

// Compute and write CRCs for every block + mirror in checksum block
function fix5(idx, off, len) {
    const crc = G4._crc16(buf5, off, len);
    buf5[off + len] = crc & 0xFF;
    buf5[off + len + 1] = (crc >> 8) & 0xFF;
    const m = BW_BLOCKS.checksumBlock + idx * 2;
    buf5[m] = crc & 0xFF;
    buf5[m + 1] = (crc >> 8) & 0xFF;
}
fix5(...BW_BLOCKS.boxLayout);
for (const b of BW_BLOCKS.boxes) fix5(...b);
fix5(...BW_BLOCKS.inventory);
fix5(...BW_BLOCKS.party);
fix5(...BW_BLOCKS.trainer);
fix5(...BW_BLOCKS.misc);
fix5(...BW_BLOCKS.pokedex);

console.log('  parsing...');
let save5;
try { save5 = G5.parse(buf5); }
catch (e) { console.error('  ✗ parse failed:', e.message); process.exitCode = 1; throw e; }

expect('g5 game',         save5.game, 'bw');
expect('g5 trainer name', save5.trainer.name, 'ASH');
expect('g5 TID',          save5.trainer.tid, 0x5678);
expect('g5 SID',          save5.trainer.sid, 0x1234);
expect('g5 money',        save5.money, 12345);
expect('g5 party count',  save5.party.length, 1);
expect('g5 species',      save5.party[0].growth.species, 25);
expect('g5 level',        save5.party[0].level, 20);
expect('g5 iv hp',        save5.party[0].misc.ivs.hp, 31);
expect('g5 checksum',     save5.party[0].checksumValid, true);

// Mutate and round-trip
save5.party[0].level = 60;
save5.party[0].growth.species = 9; // Blastoise
save5.party[0].attacks.moves[2] = 56; // Hydro Pump
const out5 = G5.write(save5, { trainerName: 'GARY', money: 5555555, party: save5.party, pc: save5.pc });
const save5b = G5.parse(out5);
expect('g5 rt trainer',  save5b.trainer.name, 'GARY');
expect('g5 rt money',    save5b.money, 5555555);
expect('g5 rt species',  save5b.party[0].growth.species, 9);
expect('g5 rt level',    save5b.party[0].level, 60);
expect('g5 rt move 2',   save5b.party[0].attacks.moves[2], 56);
expect('g5 rt checksum', save5b.party[0].checksumValid, true);

if (process.exitCode === 1) console.error('\n✗ Gen 4/5 tests failed');
else console.log('\n✓ Gen 4/5 tests pass');
