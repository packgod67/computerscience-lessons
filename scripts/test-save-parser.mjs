// Round-trip smoke test for the Gen 3 save parser.
// Builds a synthetic Gen 3 save (Emerald), parses it, mutates the trainer
// name + party Pokemon, writes back, re-parses, asserts the mutations
// survived and section checksums verify.

import fs from 'node:fs';
import vm from 'node:vm';

// Load the browser module into a Node context with a fake `window`.
const src = fs.readFileSync('js/save-editor-gen3.js', 'utf8');
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(src, ctx);
const G3 = ctx.window.SaveEditorGen3;

const SAVE_SIZE = 128 * 1024;
const SECTION_SIZE = 4096;
const FOOTER_OFFSET = 0xFF4;
const SIGNATURE = 0x08012025;

function setU16(buf, off, v) { buf[off] = v & 0xFF; buf[off + 1] = (v >> 8) & 0xFF; }
function setU32(buf, off, v) {
    buf[off] = v & 0xFF; buf[off + 1] = (v >> 8) & 0xFF;
    buf[off + 2] = (v >> 16) & 0xFF; buf[off + 3] = (v >>> 24) & 0xFF;
}
function u16(buf, off) { return buf[off] | (buf[off + 1] << 8); }

const SECTION_DATA_SIZE = [3884, 3968, 3968, 3968, 3848, 3968,
    3968, 3968, 3968, 3968, 3968, 3968, 3968, 2000];

function checksum(buf, start, len) {
    let sum = 0;
    for (let i = start; i < start + len; i += 4) {
        sum = (sum + ((buf[i]) | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24))) >>> 0;
    }
    return ((sum & 0xFFFF) + (sum >>> 16)) & 0xFFFF;
}

// Build minimal valid Emerald save
const buf = new Uint8Array(SAVE_SIZE);
const SAVE_INDEX = 1;
const ENCRYPTION_KEY = 0xDEADBEEF;

// Pack 14 sections into slot A in section-id order 0..13 (real saves shuffle them,
// but that's allowed and the parser handles both)
for (let i = 0; i < 14; i++) {
    const off = i * SECTION_SIZE;
    setU16(buf, off + FOOTER_OFFSET + 0, i);          // section id
    setU16(buf, off + FOOTER_OFFSET + 2, 0);          // checksum filled after
    setU32(buf, off + FOOTER_OFFSET + 4, SIGNATURE);
    setU32(buf, off + FOOTER_OFFSET + 8, SAVE_INDEX);
}

// Section 0 (Trainer Info) - data area
// Write trainer name "RED   " (R=0xCC, E=0xBF, D=0xBE)
buf[0x00] = 0xCC; buf[0x01] = 0xBF; buf[0x02] = 0xBE;
for (let i = 3; i < 7; i++) buf[i] = 0xFF;
buf[0x08] = 0; // gender = male
setU16(buf, 0x0A, 0x1234); // public TID
setU16(buf, 0x0C, 0x5678); // secret SID
setU16(buf, 0x0E, 42); // hours
buf[0x10] = 30; // minutes
// Emerald: encryption key at 0xAC (must be non-zero, non-one to mark as Emerald)
setU32(buf, 0xAC, ENCRYPTION_KEY);

// Section 1 (Team and Items) at byte offset 1*4096 = 4096
// In Emerald offsets: party count at 0x234, party at 0x238, money at 0x490
const sec1Base = SECTION_SIZE;
buf[sec1Base + 0x234] = 1; // 1 party member
setU32(buf, sec1Base + 0x490, (12345 ^ ENCRYPTION_KEY) >>> 0); // money

// Build a single party Pokemon at sec1Base + 0x238
const pkOff = sec1Base + 0x238;
const PID = 0x12345678; // PID % 24 = 8 → AEGM, PID % 25 = 24 → Quirky nature
const OTID = (0x5678 << 16 | 0x1234) >>> 0;
setU32(buf, pkOff + 0x00, PID);
setU32(buf, pkOff + 0x04, OTID);
// Nickname "PIKA" = P=0xCA, I=0xC3, K=0xC5, A=0xBB
buf[pkOff + 0x08] = 0xCA;
buf[pkOff + 0x09] = 0xC3;
buf[pkOff + 0x0A] = 0xC5;
buf[pkOff + 0x0B] = 0xBB;
for (let i = 0x0C; i < 0x12; i++) buf[pkOff + i] = 0xFF;
buf[pkOff + 0x12] = 2; // language
// OT name "RED" = R=0xCC E=0xBF D=0xBE
buf[pkOff + 0x14] = 0xCC;
buf[pkOff + 0x15] = 0xBF;
buf[pkOff + 0x16] = 0xBE;
for (let i = 0x17; i < 0x1B; i++) buf[pkOff + i] = 0xFF;

// Substructures: AEGM order
// A (Attacks): moves [85=Thunderbolt, 0, 0, 0], PP[15,0,0,0]
const subA = new Uint8Array(12);
subA[0] = 85; subA[1] = 0; subA[8] = 15;
// E (EVs/condition): all zero
const subE = new Uint8Array(12);
// G (Growth): species=25 (Pikachu), heldItem=0, exp=8000, ppBonus=0, friendship=70
const subG = new Uint8Array(12);
subG[0] = 25; subG[1] = 0;
setU32(subG, 0x04, 8000);
subG[0x08] = 0;
subG[0x09] = 70;
// M (Misc): IVs maxed
const subM = new Uint8Array(12);
const ivWord = (31 | (31 << 5) | (31 << 10) | (31 << 15) | (31 << 20) | (31 << 25)) >>> 0;
setU32(subM, 0x04, ivWord);

// PID 0x12345678 % 24 = 0 → substructure order GAEM.
// Position 0 = G, 1 = A, 2 = E, 3 = M
const decrypted = new Uint8Array(48);
decrypted.set(subG, 0);
decrypted.set(subA, 12);
decrypted.set(subE, 24);
decrypted.set(subM, 36);

// Pokemon checksum (over decrypted 48 bytes as 16-bit words)
let pkSum = 0;
for (let i = 0; i < 48; i += 2) pkSum = (pkSum + (decrypted[i] | (decrypted[i + 1] << 8))) & 0xFFFF;
setU16(buf, pkOff + 0x1C, pkSum);

// Encrypt 48 bytes with PID ^ OTID
const key = (PID ^ OTID) >>> 0;
for (let i = 0; i < 48; i += 4) {
    const v = ((decrypted[i] | (decrypted[i + 1] << 8) | (decrypted[i + 2] << 16) | (decrypted[i + 3] << 24)) ^ key) >>> 0;
    setU32(buf, pkOff + 0x20 + i, v);
}

// Party stats at offset 0x50+
setU32(buf, pkOff + 0x50, 0); // status
buf[pkOff + 0x54] = 20; // level
setU16(buf, pkOff + 0x56, 70); // current HP
setU16(buf, pkOff + 0x58, 70); // max HP
setU16(buf, pkOff + 0x5A, 50); // atk
setU16(buf, pkOff + 0x5C, 40); // def
setU16(buf, pkOff + 0x5E, 90); // spe
setU16(buf, pkOff + 0x60, 50); // spa
setU16(buf, pkOff + 0x62, 50); // spd

// Recompute every section's checksum
for (let i = 0; i < 14; i++) {
    const off = i * SECTION_SIZE;
    const ck = checksum(buf, off, SECTION_DATA_SIZE[i]);
    setU16(buf, off + FOOTER_OFFSET + 2, ck);
}

// ---------- Parse and assert ----------
console.log('Parsing synthetic save...');
const save = G3.parse(buf);
function expect(label, got, want) {
    const ok = got === want;
    console.log(`  ${ok ? '✓' : '✗'} ${label}: got ${got}, want ${want}`);
    if (!ok) process.exitCode = 1;
}

expect('game type',   save.game, 'emerald');
expect('encryption key', save.encryptionKey, ENCRYPTION_KEY);
expect('trainer name', save.trainer.name, 'RED');
expect('TID',          save.trainer.tid, 0x1234);
expect('SID',          save.trainer.sid, 0x5678);
expect('hours',        save.trainer.playtime.hours, 42);
expect('money',        save.money, 12345);
expect('party count',  save.partyCount, 1);
expect('party len',    save.party.length, 1);

const pk = save.party[0];
expect('species',     pk.growth.species, 25);
expect('level',       pk.level, 20);
expect('nickname',    pk.nickname, 'PIKA');
expect('OT name',     pk.otName, 'RED');
expect('move 0',      pk.attacks.moves[0], 85);
expect('iv hp',       pk.misc.ivs.hp, 31);
expect('iv spd',      pk.misc.ivs.spd, 31);
expect('exp',         pk.growth.exp, 8000);
expect('friendship',  pk.growth.friendship, 70);
expect('PK checksum valid', pk.checksumValid, true);
expect('nature',      G3.getNature(pk), G3.NATURE_NAMES[PID % 25]);

// ---------- Round-trip: mutate and write back ----------
console.log('\nMutating and round-tripping...');
pk.level = 50;
pk.growth.species = 6; // Charizard
pk.misc.ivs.atk = 0;
pk.evs.spa = 252;
pk.attacks.moves[1] = 53; // Flamethrower
pk.attacks.pp[1] = 15;

const out = G3.write(save, {
    trainerName: 'ASH',
    money: 99999,
    party: save.party,
    bag: save.bag,
});

console.log('Re-parsing...');
const save2 = G3.parse(out);
expect('new trainer', save2.trainer.name, 'ASH');
expect('new money',   save2.money, 99999);
const pk2 = save2.party[0];
expect('new species', pk2.growth.species, 6);
expect('new level',   pk2.level, 50);
expect('new iv atk',  pk2.misc.ivs.atk, 0);
expect('new ev spa',  pk2.evs.spa, 252);
expect('new move 1',  pk2.attacks.moves[1], 53);
expect('PK checksum after mutate', pk2.checksumValid, true);

if (process.exitCode === 1) {
    console.error('\n✗ Tests failed');
} else {
    console.log('\n✓ All tests pass');
}
