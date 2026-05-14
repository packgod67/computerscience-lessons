// Gen 4 (NDS Pokemon) save file parser/encoder.
// Covers Diamond / Pearl / Platinum / HeartGold / SoulSilver — plus all
// Moemon hacks built on those engines (Kurisu's Vanilla+ patches don't
// change save layout, only sprites).
//
// Format references:
//   PKHeX.Core/Saves/SAV4*.cs (kwsch/PKHeX) — authoritative source-of-truth
//   PKHeX.Core/PKM/Util/PokeCrypto.cs (encryption + 24-perm shuffle)
//   PKHeX.Core/Saves/Util/Checksums.cs (CRC-16-CCITT for footers)
//
// Save layout (524,288 bytes total = 0x80000):
//   Slot A: 0x00000-0x3FFFF
//   Slot B: 0x40000-0x7FFFF  (backup, mirror)
//   Each slot contains [General Block][Storage Block]
//   Active block per type chosen independently by major save counter.
//
// Per-game offsets within a slot:
//   D/P:  General 0x0000-0xC100,  Storage 0xC100-0x1E2E0
//   Pt:   General 0x0000-0xCF2C,  Storage 0xCF2C-0x1F110
//   HGSS: General 0x0000-0xF628,  Storage 0xF700-0x21A10
//
// Block footer is at the END of each block. DP/Pt = 0x14 bytes,
// HGSS = 0x10. Major counter at footer+0 (u32). Magic 0x20060623 at
// footer+0x0C (DP/Pt) or footer+0x08 (HGSS) — both resolve to
// `block_end - 8`, which is how we detect the game.
//
// CRC-16-CCITT: poly 0x1021, init 0xFFFF, no XOR-out, no reflection.
// Stored at last 2 bytes of block.

(function (global) {
    'use strict';

    const SAVE_SIZE      = 0x80000;
    const SLOT_SIZE      = 0x40000;
    const SLOT_A         = 0x00000;
    const SLOT_B         = 0x40000;
    const MAGIC          = 0x20060623; // international/japan magic
    const MAGIC_KO       = 0x20070903; // Korean

    // ---- per-game offsets ----
    // generalSize:  bytes from slot start to end of General block
    // storageStart: bytes from slot start to start of Storage block
    // storageSize:  bytes in Storage block
    // footerSize:   0x14 for DP/Pt, 0x10 for HGSS
    // trainer1:     offset within general block of trainer struct
    // party:        offset within general block of party data (count at party-4)
    // Storage internal layout differs DP/Pt (flat) vs HGSS (0x1000-strided).
    const GAMES = {
        dp: {
            generalSize: 0xC100, storageStart: 0xC100, storageSize: 0x121E0,
            footerSize: 0x14, trainer1: 0x64, party: 0x98,
            storageMode: 'flat',
            // Within Storage (flat layout):
            storageBoxStart: 0x0004, currentBoxOff: 0x0000,
            boxNamesOff: 0x11354, boxWPOff: 0x121B4,
        },
        pt: {
            generalSize: 0xCF2C, storageStart: 0xCF2C, storageSize: 0x121E4,
            footerSize: 0x14, trainer1: 0x68, party: 0xA0,
            storageMode: 'flat',
            storageBoxStart: 0x0004, currentBoxOff: 0x0000,
            boxNamesOff: 0x11354, boxWPOff: 0x121B4,
        },
        hgss: {
            generalSize: 0xF628, storageStart: 0xF700, storageSize: 0x12310,
            footerSize: 0x10, trainer1: 0x64, party: 0x98,
            storageMode: 'chunked',
            // Within Storage (each box 0x1000 strided):
            currentBoxOff: 0x12000, boxNamesOff: 0x12008, boxWPOff: 0x122D8,
        },
    };

    const SIZE_STORED = 136;
    const SIZE_PARTY  = 236;

    // ---- 24-perm substructure shuffle (PKM block ABCD reorder) ----
    // Each entry is 4 letters (A=0, B=1, C=2, D=3) — block positions.
    // Indexed by sv = (PID >> 13) & 31, with sv >= 24 wrapping mod 24.
    const SHUFFLE = [
        [0,1,2,3], [0,1,3,2], [0,2,1,3], [0,3,1,2], [0,2,3,1], [0,3,2,1],
        [1,0,2,3], [1,0,3,2], [2,0,1,3], [3,0,1,2], [2,0,3,1], [3,0,2,1],
        [1,2,0,3], [1,3,0,2], [2,1,0,3], [3,1,0,2], [2,3,0,1], [3,2,0,1],
        [1,2,3,0], [1,3,2,0], [2,1,3,0], [3,1,2,0], [2,3,1,0], [3,2,1,0],
    ];

    // ---- low-level helpers ----
    function u16(b, o) { return b[o] | (b[o+1] << 8); }
    function u32(b, o) { return ((b[o]) | (b[o+1] << 8) | (b[o+2] << 16) | (b[o+3] << 24)) >>> 0; }
    function setU16(b, o, v) { b[o] = v & 0xFF; b[o+1] = (v >> 8) & 0xFF; }
    function setU32(b, o, v) {
        b[o] = v & 0xFF; b[o+1] = (v >> 8) & 0xFF;
        b[o+2] = (v >> 16) & 0xFF; b[o+3] = (v >>> 24) & 0xFF;
    }

    // CRC-16-CCITT, poly 0x1021, init 0xFFFF, no XOR-out, no reflection
    function crc16(buf, start, len) {
        let crc = 0xFFFF;
        for (let i = 0; i < len; i++) {
            crc ^= (buf[start + i] << 8);
            for (let j = 0; j < 8; j++) {
                crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
                crc &= 0xFFFF;
            }
        }
        return crc;
    }

    // ---- PK4 / PK5 encryption (shared between Gen 4/5) ----
    // Body: bytes 0x08-0x87 (128 bytes = 64 u16 words), seed = checksum (u16)
    // Party stats trailer: bytes 0x88-0xEB (100 bytes for party), seed = PID
    // Algorithm: seed = seed*0x41C64E6D + 0x6073; key = seed >>> 16; xor next u16
    function cryptArray(buf, start, len, seed) {
        seed = seed >>> 0;
        for (let i = 0; i < len; i += 2) {
            seed = ((seed * 0x41C64E6D) + 0x6073) >>> 0;
            const key = (seed >>> 16) & 0xFFFF;
            const v = (buf[start + i] | (buf[start + i + 1] << 8)) ^ key;
            buf[start + i] = v & 0xFF;
            buf[start + i + 1] = (v >> 8) & 0xFF;
        }
    }

    // Pokemon body checksum: sum of 16-bit words from 0x08 to 0x87
    function pkmChecksum(decrypted128) {
        let sum = 0;
        for (let i = 0; i < 128; i += 2) sum = (sum + (decrypted128[i] | (decrypted128[i+1] << 8))) & 0xFFFF;
        return sum;
    }

    // ---- Gen 4 char map (Latin subset, enough for English/EU names) ----
    // Source: PKHeX.Core/Util/StringConverter4 — Western chars.
    // We embed only printable Latin since 99% of user-edit cases.
    const G4_CHARMAP = {};       // char-code -> string
    const G4_REVMAP  = {};       // string -> char-code
    (function buildG4Charmap() {
        const ranges = [
            [0x0125, ' '], // half-width space; full-width 0x0001 also exists
            // 0-9
            ...Array.from({length: 10}, (_, i) => [0x011A + i, String(i)]),
            // A-Z
            ...Array.from({length: 26}, (_, i) => [0x0148 + i, String.fromCharCode(0x41 + i)]),
            // a-z
            ...Array.from({length: 26}, (_, i) => [0x0162 + i, String.fromCharCode(0x61 + i)]),
            [0x017C, '!'], [0x017D, '?'], [0x017E, ','], [0x017F, '.'],
            [0x0181, '/'], [0x018B, "'"], [0x018C, '"'], [0x0192, '-'],
            [0xFFFF, '\0'],
        ];
        for (const [code, ch] of ranges) {
            G4_CHARMAP[code] = ch;
            if (G4_REVMAP[ch] == null) G4_REVMAP[ch] = code;
        }
    })();

    function decodeG4(buf, off, lenBytes) {
        let s = '';
        for (let i = 0; i < lenBytes; i += 2) {
            const code = u16(buf, off + i);
            if (code === 0xFFFF || code === 0x0000) break;
            s += G4_CHARMAP[code] || '?';
        }
        return s;
    }

    function encodeG4(s, lenBytes) {
        const out = new Uint8Array(lenBytes).fill(0xFF); // terminator default
        const maxChars = (lenBytes / 2) - 1;
        for (let i = 0; i < Math.min(s.length, maxChars); i++) {
            const code = G4_REVMAP[s[i]] != null ? G4_REVMAP[s[i]] : 0x0125; // space fallback
            setU16(out, i * 2, code);
        }
        setU16(out, Math.min(s.length, maxChars) * 2, 0xFFFF);
        return out;
    }

    // ---- Game detection ----
    // Try each (game, slot) pair. The magic 0x20060623 lives at
    // (slot + generalSize - 8). Whichever combination matches is our game.
    function detectGame(buf) {
        for (const gameKey of ['dp', 'pt', 'hgss']) {
            const g = GAMES[gameKey];
            // Check magic in slot A
            const magicOff = SLOT_A + g.generalSize - 8;
            if (magicOff + 4 > buf.length) continue;
            const m = u32(buf, magicOff);
            if (m === MAGIC || m === MAGIC_KO) return gameKey;
            // Also check slot B
            const magicOffB = SLOT_B + g.generalSize - 8;
            if (magicOffB + 4 < buf.length) {
                const m2 = u32(buf, magicOffB);
                if (m2 === MAGIC || m2 === MAGIC_KO) return gameKey;
            }
        }
        return null;
    }

    // Active-slot picker: read major save counter from each slot's General
    // block footer, pick the higher one. If a slot has invalid CRC, treat
    // its counter as 0 to deprefer it.
    function pickActiveSlot(buf, game, blockType) {
        const g = GAMES[game];
        // blockType = 'general' or 'storage'
        const useGeneral = (blockType === 'general');
        const sizeA_off = useGeneral ? 0 : g.storageStart;
        const len = useGeneral ? g.generalSize : g.storageSize;
        const footerSize = g.footerSize;

        function readMeta(slotBase) {
            const blockEnd = slotBase + (useGeneral ? g.generalSize : g.storageStart + g.storageSize);
            if (blockEnd > buf.length) return { counter: -1, crcValid: false };
            const footerStart = blockEnd - footerSize;
            const major = u32(buf, footerStart);
            const storedCrc = u16(buf, blockEnd - 2);
            // Compute CRC over (block_data minus the 2-byte CRC at the end)
            const blockStart = useGeneral ? slotBase : (slotBase + g.storageStart);
            const calc = crc16(buf, blockStart, len - 2);
            return { counter: major, crcValid: calc === storedCrc };
        }

        const a = readMeta(SLOT_A);
        const b = readMeta(SLOT_B);
        // Prefer valid CRC. Among valid, prefer higher counter.
        if (a.crcValid && b.crcValid) return a.counter >= b.counter ? 'A' : 'B';
        if (a.crcValid) return 'A';
        if (b.crcValid) return 'B';
        // Both invalid — pick higher counter anyway
        return a.counter >= b.counter ? 'A' : 'B';
    }

    // ---- Parse one Pokemon (party or PC) ----
    // off = byte offset into buf, party = boolean (true → 236 bytes, false → 136)
    function parsePokemon(buf, off, party) {
        const totalSize = party ? SIZE_PARTY : SIZE_STORED;
        // Make a working copy so we don't mutate the save buffer
        const data = new Uint8Array(buf.subarray(off, off + totalSize));
        const pid = u32(data, 0);
        const storedCk = u16(data, 6);

        // Empty slot
        if (pid === 0 && storedCk === 0) {
            return makeEmptyPokemon(off, party);
        }

        // Decrypt body
        cryptArray(data, 8, 128, storedCk);
        // Decrypt party trailer
        if (party) cryptArray(data, 0x88, 100, pid);

        // Verify checksum
        const calcCk = pkmChecksum(data.subarray(8, 8 + 128));
        const checksumValid = calcCk === storedCk;

        // Unshuffle 4 × 32-byte blocks
        const sv = ((pid >> 13) & 31) % 24;
        const order = SHUFFLE[sv];
        const blocks = [null, null, null, null];
        for (let i = 0; i < 4; i++) {
            // order[i] is the LETTER (A/B/C/D = 0/1/2/3) currently at position i.
            // We need to reverse: find where each letter lives.
            blocks[order[i]] = data.subarray(8 + i * 32, 8 + (i + 1) * 32);
        }
        const [A, B, C, D] = blocks;

        // Block A: species, item, OT info, exp, ability, friendship
        const growth = {
            species:  u16(A, 0x08),
            heldItem: u16(A, 0x0A),
            otTid:    u16(A, 0x0C),
            otSid:    u16(A, 0x0E),
            exp:      u32(A, 0x10),
            friendship: A[0x14],
            ability:    A[0x15],
            markings:   A[0x16],
            language:   A[0x17],
        };
        // EVs at 0x18-0x1D, contest stats at 0x1E-0x23
        const evs = {
            hp:  A[0x18], atk: A[0x19], def: A[0x1A],
            spe: A[0x1B], spa: A[0x1C], spd: A[0x1D],
        };

        // Block B: moves, PP, IVs (packed u32)
        const moves = [u16(B, 0), u16(B, 2), u16(B, 4), u16(B, 6)];
        const pp    = [B[8], B[9], B[10], B[11]];
        const ivWord = u32(B, 0x10);
        const ivs = {
            hp:  ivWord & 0x1F,
            atk: (ivWord >> 5) & 0x1F,
            def: (ivWord >> 10) & 0x1F,
            spe: (ivWord >> 15) & 0x1F,
            spa: (ivWord >> 20) & 0x1F,
            spd: (ivWord >> 25) & 0x1F,
        };
        const isEgg = (ivWord >> 30) & 1;
        const isNick = (ivWord >> 31) & 1;

        // Block C: nickname (Gen 4 char map, UTF-16-like, 22 bytes = 11 chars)
        const nickname = decodeG4(C, 0x08, 22);

        // Block D: OT name (16 bytes = 8 chars)
        const otName = decodeG4(D, 0, 16);

        // Party stats (only if party-sized)
        let level = 1, currentHp = 0, maxHp = 0;
        let attack = 0, defense = 0, speed = 0, spAttack = 0, spDefense = 0;
        if (party) {
            level     = data[0x8C];
            currentHp = u16(data, 0x8E);
            maxHp     = u16(data, 0x90);
            attack    = u16(data, 0x92);
            defense   = u16(data, 0x94);
            speed     = u16(data, 0x96);
            spAttack  = u16(data, 0x98);
            spDefense = u16(data, 0x9A);
        } else {
            // PC pokemon: derive level from exp (medium-fast approx)
            level = Math.max(1, Math.min(100, Math.floor(Math.cbrt(growth.exp || 1))));
        }

        return {
            isPC: !party,
            isEmpty: false,
            offset: off,
            isPartySize: party,
            pid,
            otid: ((growth.otSid << 16) | growth.otTid) >>> 0,
            key: 0, // unused for Gen 4 (encryption is per-Pokemon)
            nickname, otName,
            language: growth.language,
            checksumValid,
            growth, attacks: { moves, pp },
            evs: {
                ...evs,
                cool: 0, beauty: 0, cute: 0, smart: 0, tough: 0, feel: 0,
            },
            misc: {
                pokerus: 0,
                metLoc: 0,
                originInfo: 0,
                ivs,
                isEgg, ability: growth.ability,
                ribbons: 0,
            },
            status: 0,
            level, currentHp, maxHp,
            attack, defense, speed, spAttack, spDefense,
        };
    }

    function makeEmptyPokemon(off, party) {
        return {
            isPC: !party, isEmpty: true, offset: off, isPartySize: party,
            pid: 0, otid: 0, key: 0,
            nickname: '', otName: '', language: 2, checksumValid: true,
            growth: { species: 0, heldItem: 0, otTid: 0, otSid: 0, exp: 0,
                      friendship: 0, ability: 0, markings: 0, language: 2 },
            attacks: { moves: [0,0,0,0], pp: [0,0,0,0] },
            evs: { hp: 0, atk: 0, def: 0, spe: 0, spa: 0, spd: 0,
                   cool: 0, beauty: 0, cute: 0, smart: 0, tough: 0, feel: 0 },
            misc: { pokerus: 0, metLoc: 0, originInfo: 0,
                    ivs: { hp: 0, atk: 0, def: 0, spe: 0, spa: 0, spd: 0 },
                    isEgg: 0, ability: 0, ribbons: 0 },
            status: 0, level: 1, currentHp: 0, maxHp: 0,
            attack: 0, defense: 0, speed: 0, spAttack: 0, spDefense: 0,
        };
    }

    function writePokemon(buf, off, pk, party) {
        const totalSize = party ? SIZE_PARTY : SIZE_STORED;
        if (pk.isEmpty) {
            for (let i = 0; i < totalSize; i++) buf[off + i] = 0;
            return;
        }

        // Build the 4 blocks fresh
        const A = new Uint8Array(32);
        const B = new Uint8Array(32);
        const C = new Uint8Array(32);
        const D = new Uint8Array(32);

        setU16(A, 0x08, pk.growth.species);
        setU16(A, 0x0A, pk.growth.heldItem);
        setU16(A, 0x0C, pk.otid & 0xFFFF);          // TID
        setU16(A, 0x0E, (pk.otid >>> 16) & 0xFFFF); // SID
        setU32(A, 0x10, pk.growth.exp || 0);
        A[0x14] = pk.growth.friendship || 0;
        A[0x15] = pk.misc.ability || 0;
        A[0x16] = pk.growth.markings || 0;
        A[0x17] = pk.language || 2;
        A[0x18] = pk.evs.hp;  A[0x19] = pk.evs.atk; A[0x1A] = pk.evs.def;
        A[0x1B] = pk.evs.spe; A[0x1C] = pk.evs.spa; A[0x1D] = pk.evs.spd;

        for (let i = 0; i < 4; i++) {
            setU16(B, i * 2, pk.attacks.moves[i] || 0);
            B[8 + i] = pk.attacks.pp[i] || 0;
        }
        const ivs = pk.misc.ivs;
        const ivWord = (
            (ivs.hp & 0x1F) |
            ((ivs.atk & 0x1F) << 5) |
            ((ivs.def & 0x1F) << 10) |
            ((ivs.spe & 0x1F) << 15) |
            ((ivs.spa & 0x1F) << 20) |
            ((ivs.spd & 0x1F) << 25) |
            ((pk.misc.isEgg & 1) << 30) |
            ((1) << 31)  // isNick = 1 (we always treat as nicknamed)
        ) >>> 0;
        setU32(B, 0x10, ivWord);

        // Nickname into C at offset 0x08, 22 bytes
        C.set(encodeG4(pk.nickname || '', 22), 0x08);
        // OT name into D at offset 0x00, 16 bytes
        D.set(encodeG4(pk.otName || '', 16), 0x00);

        // Combine into 128-byte body in canonical ABCD order, then shuffle
        // to the order this Pokemon's PID expects.
        const canonical = new Uint8Array(128);
        canonical.set(A, 0); canonical.set(B, 32); canonical.set(C, 64); canonical.set(D, 96);

        const sv = ((pk.pid >> 13) & 31) % 24;
        const order = SHUFFLE[sv];
        const shuffled = new Uint8Array(128);
        for (let i = 0; i < 4; i++) {
            shuffled.set(canonical.subarray(order[i] * 32, (order[i] + 1) * 32), i * 32);
        }

        // Compute body checksum (over UN-encrypted, in canonical order
        // — actually order doesn't matter for sum)
        const sum = pkmChecksum(canonical);

        // Pack into output buffer at off
        const tmp = new Uint8Array(totalSize);
        setU32(tmp, 0x00, pk.pid);
        setU16(tmp, 0x04, 0); // sanity placeholder
        setU16(tmp, 0x06, sum);
        tmp.set(shuffled, 8);

        if (party) {
            tmp[0x88] = 0;
            tmp[0x8C] = pk.level || 1;
            setU16(tmp, 0x8E, pk.currentHp);
            setU16(tmp, 0x90, pk.maxHp);
            setU16(tmp, 0x92, pk.attack);
            setU16(tmp, 0x94, pk.defense);
            setU16(tmp, 0x96, pk.speed);
            setU16(tmp, 0x98, pk.spAttack);
            setU16(tmp, 0x9A, pk.spDefense);
        }

        // Encrypt body with seed = checksum
        cryptArray(tmp, 8, 128, sum);
        // Encrypt party trailer with seed = PID
        if (party) cryptArray(tmp, 0x88, 100, pk.pid);

        buf.set(tmp, off);
    }

    // ---- Main parse ----
    function parse(rawBytes) {
        const buf = new Uint8Array(rawBytes);
        if (buf.length < 0x40000) throw new Error('Gen 4 save must be at least 256KB');

        const game = detectGame(buf);
        if (!game) throw new Error('Not a Gen 4 save (or magic missing — try a fresh save)');
        const g = GAMES[game];

        const generalSlot = pickActiveSlot(buf, game, 'general');
        const storageSlot = pickActiveSlot(buf, game, 'storage');
        const genBase = generalSlot === 'A' ? SLOT_A : SLOT_B;
        const stoBase = storageSlot === 'A' ? SLOT_A : SLOT_B;

        // ---- Trainer info from General block ----
        const trBase = genBase + g.trainer1;
        const trainer = {
            name: decodeG4(buf, trBase + 0x00, 16),
            tid: u16(buf, trBase + 0x10),
            sid: u16(buf, trBase + 0x12),
            gender: buf[trBase + 0x18],
            language: buf[trBase + 0x19],
            badges: buf[trBase + 0x1A],
            playtime: {
                hours:   u16(buf, trBase + 0x22),
                minutes: buf[trBase + 0x24],
                seconds: buf[trBase + 0x25],
                frames:  0,
            },
            game,
        };
        const money = u32(buf, trBase + 0x14);
        const coins = u16(buf, trBase + 0x20);

        // ---- Party (6 × 236 bytes, count at party-4) ----
        const partyCount = buf[genBase + g.party - 4];
        const party = [];
        for (let i = 0; i < Math.min(6, partyCount); i++) {
            const off = genBase + g.party + i * SIZE_PARTY;
            const pk = parsePokemon(buf, off, true);
            party.push(pk);
        }

        // ---- PC Boxes (18 × 30 × 136 bytes) ----
        const pc = parsePC(buf, stoBase, g);

        return {
            game, _gen: 4,
            trainer, money, coins, partyCount,
            party, pc,
            bag: { items: [], keyItems: [], balls: [], tms: [], berries: [] },
            _raw: buf,
            _genBase: genBase,
            _stoBase: stoBase,
            _g: g,
        };
    }

    function parsePC(buf, stoBase, g) {
        const boxes = [];
        const names = [];
        const wallpapers = [];
        let currentBox = 0;

        if (g.storageMode === 'flat') {
            // DP/Pt: contiguous 18 × 30 × 136 = 73440 bytes
            currentBox = buf[stoBase + g.storageStart + g.currentBoxOff];
            for (let b = 0; b < 18; b++) {
                const box = [];
                for (let s = 0; s < 30; s++) {
                    const off = stoBase + g.storageStart + g.storageBoxStart + (b * 30 + s) * SIZE_STORED;
                    box.push(parsePokemon(buf, off, false));
                }
                boxes.push(box);
                names.push(decodeG4(buf, stoBase + g.storageStart + g.boxNamesOff + b * 40, 40));
                wallpapers.push(buf[stoBase + g.storageStart + g.boxWPOff + b]);
            }
        } else {
            // HGSS: each box at its own 0x1000 chunk
            for (let b = 0; b < 18; b++) {
                const box = [];
                for (let s = 0; s < 30; s++) {
                    const off = stoBase + g.storageStart + b * 0x1000 + s * SIZE_STORED;
                    box.push(parsePokemon(buf, off, false));
                }
                boxes.push(box);
                names.push(decodeG4(buf, stoBase + g.storageStart + g.boxNamesOff + b * 40, 40));
                wallpapers.push(buf[stoBase + g.storageStart + g.boxWPOff + b]);
            }
            currentBox = buf[stoBase + g.storageStart + g.currentBoxOff];
        }
        return { currentBox, boxes, names, wallpapers };
    }

    // ---- Main write ----
    function write(save, edits) {
        const buf = save._raw;
        const g = save._g;
        const genBase = save._genBase;
        const stoBase = save._stoBase;
        const trBase = genBase + g.trainer1;

        if (edits.trainerName != null) {
            buf.set(encodeG4(edits.trainerName, 16), trBase + 0x00);
        }
        if (edits.money != null) {
            setU32(buf, trBase + 0x14, Math.max(0, Math.min(999999, edits.money | 0)));
        }

        // Write party
        if (edits.party) {
            buf[genBase + g.party - 4] = Math.min(6, edits.party.length);
            for (let i = 0; i < 6; i++) {
                const off = genBase + g.party + i * SIZE_PARTY;
                const pk = edits.party[i];
                if (pk) writePokemon(buf, off, pk, true);
                else {
                    // Zero out empty slots
                    for (let j = 0; j < SIZE_PARTY; j++) buf[off + j] = 0;
                }
            }
        }

        // Write PC boxes
        if (edits.pc) {
            writePC(buf, stoBase, g, edits.pc);
        }

        // Recompute General + Storage CRCs (active slot ONLY; backup slot
        // stays as-is — that's fine because we marked the active slot
        // via its newer save counter).
        recomputeCRCs(buf, genBase, stoBase, g);

        // Also mirror the active general/storage into the backup slot so
        // either slot stays valid going forward. PKHeX does this on save.
        if (genBase !== SLOT_A) {
            buf.set(buf.subarray(genBase, genBase + g.generalSize), SLOT_A);
        } else {
            buf.set(buf.subarray(SLOT_A, SLOT_A + g.generalSize), SLOT_B);
        }
        if (stoBase !== SLOT_A) {
            buf.set(buf.subarray(stoBase + g.storageStart, stoBase + g.storageStart + g.storageSize), SLOT_A + g.storageStart);
        } else {
            buf.set(buf.subarray(SLOT_A + g.storageStart, SLOT_A + g.storageStart + g.storageSize), SLOT_B + g.storageStart);
        }
        // Recompute CRCs on the just-mirrored copies too
        recomputeCRCs(buf, SLOT_A, SLOT_A, g);
        recomputeCRCs(buf, SLOT_B, SLOT_B, g);

        return buf;
    }

    function writePC(buf, stoBase, g, pc) {
        if (g.storageMode === 'flat') {
            buf[stoBase + g.storageStart + g.currentBoxOff] = pc.currentBox || 0;
            for (let b = 0; b < 18; b++) {
                for (let s = 0; s < 30; s++) {
                    const off = stoBase + g.storageStart + g.storageBoxStart + (b * 30 + s) * SIZE_STORED;
                    writePokemon(buf, off, pc.boxes[b][s], false);
                }
                buf.set(encodeG4(pc.names[b] || '', 40), stoBase + g.storageStart + g.boxNamesOff + b * 40);
                buf[stoBase + g.storageStart + g.boxWPOff + b] = pc.wallpapers[b] || 0;
            }
        } else {
            buf[stoBase + g.storageStart + g.currentBoxOff] = pc.currentBox || 0;
            for (let b = 0; b < 18; b++) {
                for (let s = 0; s < 30; s++) {
                    const off = stoBase + g.storageStart + b * 0x1000 + s * SIZE_STORED;
                    writePokemon(buf, off, pc.boxes[b][s], false);
                }
                buf.set(encodeG4(pc.names[b] || '', 40), stoBase + g.storageStart + g.boxNamesOff + b * 40);
                buf[stoBase + g.storageStart + g.boxWPOff + b] = pc.wallpapers[b] || 0;
            }
        }
    }

    function recomputeCRCs(buf, genBase, stoBase, g) {
        // General block CRC
        const genCk = crc16(buf, genBase, g.generalSize - 2);
        setU16(buf, genBase + g.generalSize - 2, genCk);
        // Storage block CRC
        const stoCk = crc16(buf, stoBase + g.storageStart, g.storageSize - 2);
        setU16(buf, stoBase + g.storageStart + g.storageSize - 2, stoCk);
    }

    // ---- Stats / nature / shiny (Gen 4 nature = PID % 25 same as Gen 3) ----
    const NATURE_NAMES = [
        'Hardy','Lonely','Brave','Adamant','Naughty','Bold','Docile','Relaxed',
        'Impish','Lax','Timid','Hasty','Serious','Jolly','Naive','Modest',
        'Mild','Quiet','Bashful','Rash','Calm','Gentle','Sassy','Careful','Quirky',
    ];
    function getNature(pk) { return NATURE_NAMES[pk.pid % 25]; }

    const NATURE_TABLE = {
        Hardy:{}, Lonely:{atk:1.1,def:0.9}, Brave:{atk:1.1,spe:0.9},
        Adamant:{atk:1.1,spa:0.9}, Naughty:{atk:1.1,spd:0.9},
        Bold:{def:1.1,atk:0.9}, Docile:{}, Relaxed:{def:1.1,spe:0.9},
        Impish:{def:1.1,spa:0.9}, Lax:{def:1.1,spd:0.9},
        Timid:{spe:1.1,atk:0.9}, Hasty:{spe:1.1,def:0.9},
        Serious:{}, Jolly:{spe:1.1,spa:0.9}, Naive:{spe:1.1,spd:0.9},
        Modest:{spa:1.1,atk:0.9}, Mild:{spa:1.1,def:0.9},
        Quiet:{spa:1.1,spe:0.9}, Bashful:{}, Rash:{spa:1.1,spd:0.9},
        Calm:{spd:1.1,atk:0.9}, Gentle:{spd:1.1,def:0.9},
        Sassy:{spd:1.1,spe:0.9}, Careful:{spd:1.1,spa:0.9}, Quirky:{},
    };
    function recalcStats(pk, base, nature) {
        const lv = pk.level || 1;
        const iv = pk.misc.ivs;
        const ev = pk.evs;
        pk.maxHp = Math.floor(((2 * base.hp + iv.hp + Math.floor(ev.hp/4)) * lv) / 100) + 10 + lv;
        pk.currentHp = pk.maxHp;
        function s(b, i, e, k) {
            const t = NATURE_TABLE[nature] || {};
            const m = t[k] || 1;
            return Math.floor((Math.floor(((2*b + i + Math.floor(e/4)) * lv) / 100) + 5) * m);
        }
        pk.attack    = s(base.atk, iv.atk, ev.atk, 'atk');
        pk.defense   = s(base.def, iv.def, ev.def, 'def');
        pk.speed     = s(base.spe, iv.spe, ev.spe, 'spe');
        pk.spAttack  = s(base.spa, iv.spa, ev.spa, 'spa');
        pk.spDefense = s(base.spd, iv.spd, ev.spd, 'spd');
    }

    function setNature(pk, natureName) {
        const target = NATURE_NAMES.indexOf(natureName);
        if (target < 0) return;
        // Find PID where pid%25 == target. Preserve high 24 bits (shininess
        // and substructure-shuffle invariant where possible).
        let pid = pk.pid;
        for (let i = 0; i < 10000; i++) {
            if (pid % 25 === target) { pk.pid = pid >>> 0; return; }
            pid = (pid + 1) >>> 0;
        }
    }

    function isShiny(pk) {
        const tid = pk.otid & 0xFFFF;
        const sid = (pk.otid >>> 16) & 0xFFFF;
        const lo = pk.pid & 0xFFFF;
        const hi = (pk.pid >>> 16) & 0xFFFF;
        return (tid ^ sid ^ lo ^ hi) < 8;
    }

    function setShiny(pk, on) {
        const tid = pk.otid & 0xFFFF;
        const sid = (pk.otid >>> 16) & 0xFFFF;
        // Step by 25 preserves nature (pid % 25), so we only have to scan
        // for the shiny condition. With ~16K iterations we'll cover most
        // of the relevant lo-half PID space and reliably find a match.
        let pid = pk.pid;
        for (let i = 0; i < 1_000_000; i++) {
            const lo = pid & 0xFFFF;
            const hi = (pid >>> 16) & 0xFFFF;
            const cur = (tid ^ sid ^ lo ^ hi) < 8;
            if (cur === on) {
                pk.pid = pid >>> 0;
                return true;
            }
            pid = (pid + 25) >>> 0;
        }
        return false;
    }

    global.SaveEditorGen4 = {
        parse, write,
        recalcStats, getNature, setNature, isShiny, setShiny,
        NATURE_NAMES, SIZE_STORED, SIZE_PARTY,
        // exposed for testing
        _detectGame: detectGame,
        _crc16: crc16,
        _parsePokemon: parsePokemon,
        _writePokemon: writePokemon,
    };
})(typeof window !== 'undefined' ? window : globalThis);
