// Gen 3 (GBA Pokemon) save file parser/encoder.
//
// Save format docs:
//   https://bulbapedia.bulbagarden.net/wiki/Save_data_structure_(Generation_III)
//
// Layout (128 KB total):
//   Slot A: bytes 0x00000-0x0DFFF   (14 sections * 4KB each)
//   Slot B: bytes 0x0E000-0x1BFFF   (14 sections * 4KB)
//   Hall of Fame, Mystery Gift, Battle Records, etc: 0x1C000-0x1FFFF
//
// Each section is 4096 bytes. Last 12 bytes are the footer:
//   offset 0xFF4: section ID (2 bytes, 0-13)
//   offset 0xFF6: checksum (2 bytes)
//   offset 0xFF8: signature 0x08012025 (4 bytes)
//   offset 0xFFC: save index (4 bytes — newer slot = higher number)
//
// Sections within a slot are stored in *arbitrary* order. Read footer
// IDs to map section roles. The active slot is whichever has the higher
// save index.
//
// Section roles:
//   0  = TrainerInfo  (3884 bytes of data)
//   1  = TeamItems    (3968 bytes — bag + party live here)
//   2-4 = GameState   (general world state)
//   5  = Misc / PC items
//   6-13 = PC boxes (Pokemon storage)
//
// Game detection — at offset 0xAC of section 0 data:
//   0x00000000 = Ruby / Sapphire
//   0x00000001 = FireRed / LeafGreen
//   other      = Emerald (and the value IS the encryption key)
//
// Encryption key (for money/items quantity XOR):
//   Emerald: section 0 offset 0xAC (4 bytes)
//   FRLG:    section 0 offset 0xF20 (4 bytes)
//   RS:      none (treat key as 0)

(function (global) {
    'use strict';

    const SAVE_SIZE = 128 * 1024;          // 0x20000
    const SLOT_SIZE = 14 * 4096;           // 0xE000
    const SECTION_SIZE = 4096;             // 0x1000
    const FOOTER_OFFSET = 0xFF4;
    const SIGNATURE = 0x08012025;

    // How many data bytes each section ID validates over (rest is padding).
    // Source: pokeruby/pokeemerald `gSaveSectionLocations`.
    const SECTION_DATA_SIZE = [
        3884, 3968, 3968, 3968, 3848, 3968,
        3968, 3968, 3968, 3968, 3968, 3968, 3968, 2000,
    ];

    // ---- character encoding (Gen 3 international) ----
    const CHARMAP = {};
    const REVCHARMAP = {};
    (function buildCharmap() {
        const ranges = [
            [0x00, ' '], [0x1B, '+'], [0x2D, '.'],
            [0xA1, '0'], [0xA2, '1'], [0xA3, '2'], [0xA4, '3'], [0xA5, '4'],
            [0xA6, '5'], [0xA7, '6'], [0xA8, '7'], [0xA9, '8'], [0xAA, '9'],
            [0xAB, '!'], [0xAC, '?'], [0xAD, '.'], [0xAE, '-'], [0xAF, '·'],
            [0xB0, '…'], [0xB1, '"'], [0xB2, '"'], [0xB3, "'"], [0xB4, "'"],
            [0xB5, '♂'], [0xB6, '♀'], [0xB7, '$'], [0xB8, ','], [0xB9, '×'],
            [0xBA, '/'],
            [0xFB, '◙'], [0xFC, ''], [0xFD, ''], [0xFE, '\n'], [0xFF, '\0'],
        ];
        for (const [byte, ch] of ranges) {
            CHARMAP[byte] = ch;
            REVCHARMAP[ch] = byte;
        }
        // A-Z
        for (let i = 0; i < 26; i++) {
            CHARMAP[0xBB + i] = String.fromCharCode(65 + i);
            REVCHARMAP[String.fromCharCode(65 + i)] = 0xBB + i;
        }
        // a-z
        for (let i = 0; i < 26; i++) {
            CHARMAP[0xD5 + i] = String.fromCharCode(97 + i);
            REVCHARMAP[String.fromCharCode(97 + i)] = 0xD5 + i;
        }
    })();

    function decodeStr(bytes) {
        let out = '';
        for (const b of bytes) {
            if (b === 0xFF) break;
            out += CHARMAP[b] || '?';
        }
        return out;
    }

    function encodeStr(s, len) {
        const out = new Uint8Array(len).fill(0xFF);
        for (let i = 0; i < Math.min(s.length, len); i++) {
            out[i] = REVCHARMAP[s[i]] != null ? REVCHARMAP[s[i]] : 0;
        }
        return out;
    }

    // ---- low-level helpers ----
    function u16(buf, off) { return buf[off] | (buf[off + 1] << 8); }
    function u32(buf, off) {
        return ((buf[off]) | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
    }
    function setU16(buf, off, v) { buf[off] = v & 0xFF; buf[off + 1] = (v >> 8) & 0xFF; }
    function setU32(buf, off, v) {
        buf[off] = v & 0xFF; buf[off + 1] = (v >> 8) & 0xFF;
        buf[off + 2] = (v >> 16) & 0xFF; buf[off + 3] = (v >>> 24) & 0xFF;
    }

    // Section checksum: sum of 32-bit words over the data area, then fold
    // upper and lower halves together to get a 16-bit value.
    function checksum(buf, start, len) {
        let sum = 0;
        const end = start + len;
        for (let i = start; i < end; i += 4) {
            sum = (sum + u32(buf, i)) >>> 0;
        }
        return ((sum & 0xFFFF) + (sum >>> 16)) & 0xFFFF;
    }

    // ---- slot detection ----
    // Returns { activeSlot: 0 | 1, sections: [{id, offset}], rawIndex }
    function parseSlot(buf, slotStart) {
        const sections = [];
        for (let i = 0; i < 14; i++) {
            const off = slotStart + i * SECTION_SIZE;
            const id = u16(buf, off + FOOTER_OFFSET);
            const sig = u32(buf, off + FOOTER_OFFSET + 4);
            if (sig !== SIGNATURE) return null;
            const idx = u32(buf, off + FOOTER_OFFSET + 8);
            sections.push({ id, offset: off, saveIndex: idx });
        }
        return { sections, saveIndex: sections[0].saveIndex };
    }

    function parse(raw) {
        if (raw.length < SAVE_SIZE) {
            // Some emulators pad to 64K; reject if too small to be plausible
            if (raw.length < 0x10000) throw new Error('Save file too small');
        }
        const buf = new Uint8Array(raw);

        const slotA = parseSlot(buf, 0);
        const slotB = parseSlot(buf, SLOT_SIZE);

        let active;
        if (slotA && slotB) {
            active = slotA.saveIndex >= slotB.saveIndex ? slotA : slotB;
        } else if (slotA) active = slotA;
        else if (slotB) active = slotB;
        else throw new Error('No valid save slot found (signature mismatch)');

        // Map section id -> location
        const byId = {};
        for (const s of active.sections) byId[s.id] = s;

        // Detect game by reading offset 0xAC of section 0
        const sec0 = byId[0];
        if (!sec0) throw new Error('Missing section 0 (Trainer Info)');
        const gameCode = u32(buf, sec0.offset + 0xAC);

        let game, encryptionKey;
        if (gameCode === 0x00000000) {
            game = 'rs';
            encryptionKey = 0;
        } else if (gameCode === 0x00000001) {
            game = 'frlg';
            encryptionKey = u32(buf, sec0.offset + 0xF20);
        } else {
            game = 'emerald';
            encryptionKey = gameCode;
        }

        // Per-game offsets within section 1 (TeamItems block)
        const OFFSETS = {
            emerald: { partyCount: 0x234, party: 0x238, money: 0x490, coins: 0x494,
                       items:   { off: 0x498, slots: 30 },
                       keyItems:{ off: 0x510, slots: 30 },
                       balls:   { off: 0x588, slots: 16 },
                       tms:     { off: 0x5C8, slots: 64 },
                       berries: { off: 0x790, slots: 46 } },
            frlg:    { partyCount: 0x034, party: 0x038, money: 0x290, coins: 0x294,
                       items:   { off: 0x298, slots: 42 },
                       keyItems:{ off: 0x340, slots: 30 },
                       balls:   { off: 0x3B8, slots: 13 },
                       tms:     { off: 0x3EC, slots: 58 },
                       berries: { off: 0x54C, slots: 43 } },
            rs:      { partyCount: 0x234, party: 0x238, money: 0x490, coins: 0x494,
                       items:   { off: 0x498, slots: 20 },
                       keyItems:{ off: 0x4E8, slots: 20 },
                       balls:   { off: 0x538, slots: 16 },
                       tms:     { off: 0x578, slots: 64 },
                       berries: { off: 0x678, slots: 46 } },
        };
        const offsets = OFFSETS[game];

        const sec1 = byId[1];
        if (!sec1) throw new Error('Missing section 1 (Team & Items)');

        // ---- Trainer info (section 0, offsets within data area) ----
        const trainer = {
            name: decodeStr(buf.subarray(sec0.offset + 0x00, sec0.offset + 0x07)),
            gender: buf[sec0.offset + 0x08],   // 0 = boy, 1 = girl
            tid: u16(buf, sec0.offset + 0x0A), // public id
            sid: u16(buf, sec0.offset + 0x0C), // secret id
            playtime: {
                hours: u16(buf, sec0.offset + 0x0E),
                minutes: buf[sec0.offset + 0x10],
                seconds: buf[sec0.offset + 0x11],
                frames: buf[sec0.offset + 0x12],
            },
            game, encryptionKey,
        };

        // ---- Money / coins (XOR'd with encryption key on Em/FRLG) ----
        const moneyOff = sec1.offset + offsets.money;
        const money = (u32(buf, moneyOff) ^ encryptionKey) >>> 0;
        const coins = u16(buf, sec1.offset + offsets.coins) ^ (encryptionKey & 0xFFFF);

        // ---- Bag items ----
        function readSlots(cat) {
            const c = offsets[cat];
            const slots = [];
            for (let i = 0; i < c.slots; i++) {
                const o = sec1.offset + c.off + i * 4;
                const itemId = u16(buf, o);
                const rawQty = u16(buf, o + 2);
                // Key Items have unencrypted quantity 0 or 1 in RS/Em/FRLG
                const qty = (cat === 'keyItems' && game === 'rs')
                    ? rawQty
                    : (rawQty ^ (encryptionKey & 0xFFFF));
                if (itemId !== 0) slots.push({ id: itemId, qty });
            }
            return slots;
        }
        const bag = {
            items:    readSlots('items'),
            keyItems: readSlots('keyItems'),
            balls:    readSlots('balls'),
            tms:      readSlots('tms'),
            berries:  readSlots('berries'),
        };

        // ---- Party ----
        const partyCount = Math.min(6, buf[sec1.offset + offsets.partyCount]);
        const party = [];
        for (let i = 0; i < partyCount; i++) {
            const pkOff = sec1.offset + offsets.party + i * 100;
            party.push(parsePokemon(buf, pkOff));
        }

        // ---- PC Storage (sections 5-13 concatenated) ----
        // 33,744 bytes total. The data is split across 9 sections but
        // contiguous when concatenated in section-id order.
        const pc = parsePCStorage(buf, byId);

        return {
            game, encryptionKey,
            trainer, money, coins, bag, party, partyCount, pc,
            // Stash refs so we can write back later
            _raw: buf,
            _active: active,
            _byId: byId,
            _offsets: offsets,
            _slot: active === slotA ? 0 : 1,
        };
    }

    // PC storage is split across 9 sections (5-13). Their data areas
    // concatenated in section-id order give one flat 33,744-byte block:
    //   0x0000  current box index (u32)
    //   0x0004  14 boxes × 30 slots × 80 bytes/pkmn  (33,600 bytes)
    //   0x8344  14 × 9-byte box names                (126 bytes)
    //   0x83C2  14 × 1-byte wallpaper IDs            (14 bytes)
    function parsePCStorage(buf, byId) {
        const flat = new Uint8Array(33744);
        let cursor = 0;
        for (let id = 5; id <= 13; id++) {
            const sec = byId[id];
            if (!sec) return null;
            const dataLen = SECTION_DATA_SIZE[id];
            flat.set(buf.subarray(sec.offset, sec.offset + dataLen), cursor);
            cursor += dataLen;
        }

        const currentBox = u32(flat, 0x0000);
        const boxes = [];
        for (let b = 0; b < 14; b++) {
            const box = [];
            for (let s = 0; s < 30; s++) {
                const off = 0x0004 + (b * 30 + s) * 80;
                const pk = parsePokemonPC(flat, off, b, s);
                box.push(pk);
            }
            boxes.push(box);
        }
        const names = [];
        for (let b = 0; b < 14; b++) {
            const off = 0x8344 + b * 9;
            names.push(decodeStr(flat.subarray(off, off + 9)));
        }
        const wallpapers = [];
        for (let b = 0; b < 14; b++) wallpapers.push(flat[0x83C2 + b]);
        return { currentBox, boxes, names, wallpapers, _flat: flat };
    }

    // PC Pokemon = first 80 bytes of party struct. Same encryption / shuffle.
    // Level / HP / stats are NOT stored — they're computed from EXP + base
    // stats at load-from-box time. We parse with placeholders so the editor
    // can show them; on write we recompute and ignore the trailing 20 bytes.
    function parsePokemonPC(flat, off, boxIdx, slotIdx) {
        const pid = u32(flat, off + 0x00);
        const otid = u32(flat, off + 0x04);
        // Empty slot signal: PID=0 AND species=0 after decrypt.
        // We still construct an object so the UI can show "empty" slots
        // and let the user fill them; a "live" PC pokemon has species>0.
        const nickRaw = flat.subarray(off + 0x08, off + 0x12);
        const lang = flat[off + 0x12];
        const otNameRaw = flat.subarray(off + 0x14, off + 0x1B);
        const markings = flat[off + 0x1B];
        const storedCk = u16(flat, off + 0x1C);

        const key = (pid ^ otid) >>> 0;
        const decrypted = new Uint8Array(48);
        for (let i = 0; i < 48; i += 4) {
            const v = (u32(flat, off + 0x20 + i) ^ key) >>> 0;
            decrypted[i + 0] = v & 0xFF;
            decrypted[i + 1] = (v >> 8) & 0xFF;
            decrypted[i + 2] = (v >> 16) & 0xFF;
            decrypted[i + 3] = (v >>> 24) & 0xFF;
        }
        let sum = 0;
        for (let i = 0; i < 48; i += 2) sum = (sum + (decrypted[i] | (decrypted[i + 1] << 8))) & 0xFFFF;
        const checksumValid = sum === storedCk;

        const order = SUBSTRUCT_ORDER[pid % 24];
        const sub = { G: null, A: null, E: null, M: null };
        for (let i = 0; i < 4; i++) sub[order[i]] = decrypted.subarray(i * 12, (i + 1) * 12);

        const growth = {
            species:    u16(sub.G, 0x00),
            heldItem:   u16(sub.G, 0x02),
            exp:        u32(sub.G, 0x04),
            ppBonuses:  sub.G[0x08],
            friendship: sub.G[0x09],
        };
        const attacks = {
            moves: [u16(sub.A, 0), u16(sub.A, 2), u16(sub.A, 4), u16(sub.A, 6)],
            pp:    [sub.A[0x08], sub.A[0x09], sub.A[0x0A], sub.A[0x0B]],
        };
        const evs = {
            hp: sub.E[0], atk: sub.E[1], def: sub.E[2],
            spe: sub.E[3], spa: sub.E[4], spd: sub.E[5],
            cool: sub.E[6], beauty: sub.E[7], cute: sub.E[8],
            smart: sub.E[9], tough: sub.E[10], feel: sub.E[11],
        };
        const miscWord = u32(sub.M, 0x04);
        const ivs = {
            hp:  miscWord & 0x1F,
            atk: (miscWord >> 5) & 0x1F,
            def: (miscWord >> 10) & 0x1F,
            spe: (miscWord >> 15) & 0x1F,
            spa: (miscWord >> 20) & 0x1F,
            spd: (miscWord >> 25) & 0x1F,
        };
        const isEgg   = (miscWord >> 30) & 1;
        const ability = (miscWord >> 31) & 1;
        const misc = {
            pokerus: sub.M[0],
            metLoc: sub.M[1],
            originInfo: u16(sub.M, 2),
            ivs, isEgg, ability,
            ribbons: u32(sub.M, 0x08),
        };

        // Level computed from EXP (medium-fast curve approx: lv = floor(exp^(1/3)))
        let level = Math.floor(Math.cbrt(growth.exp));
        if (level < 1) level = 1;
        if (level > 100) level = 100;
        // Slots with species=0 are empty; mark them
        const isEmpty = growth.species === 0 && pid === 0;

        return {
            isPC: true,
            isEmpty,
            boxIdx, slotIdx,
            offset: off,             // offset within the flat PC array
            pid, otid, key,
            nickname: decodeStr(nickRaw),
            language: lang,
            otName: decodeStr(otNameRaw),
            markings,
            checksumValid,
            growth, attacks, evs, misc,
            // Placeholders so the same code paths can re-use party fields
            status: 0, level,
            currentHp: 0, maxHp: 0,
            attack: 0, defense: 0, speed: 0, spAttack: 0, spDefense: 0,
        };
    }

    // ---- Pokemon (100-byte party struct) ----
    // 0x00 PID, 0x04 OTID, 0x08 nick(10), 0x12 lang, 0x13 misc,
    // 0x14 OT name(7), 0x1B markings, 0x1C checksum(2), 0x1E unknown,
    // 0x20 encrypted data (48 bytes), 0x50 status..stats
    //
    // 48-byte data area = 4 substructures of 12 bytes, order = SUBSTRUCT_ORDER[pid % 24].
    // Each substructure is XOR-decrypted byte-by-byte with the key (PID ^ OTID).

    const SUBSTRUCT_ORDER = [
        'GAEM','GAME','GEAM','GEMA','GMAE','GMEA',
        'AGEM','AGME','AEGM','AEMG','AMGE','AMEG',
        'EGAM','EGMA','EAGM','EAMG','EMGA','EMAG',
        'MGAE','MGEA','MAGE','MAEG','MEGA','MEAG',
    ];

    function parsePokemon(buf, off) {
        const pid = u32(buf, off + 0x00);
        const otid = u32(buf, off + 0x04);
        const nickRaw = buf.subarray(off + 0x08, off + 0x12);
        const lang = buf[off + 0x12];
        const otNameRaw = buf.subarray(off + 0x14, off + 0x1B);
        const markings = buf[off + 0x1B];
        const storedCk = u16(buf, off + 0x1C);

        // Decrypt 48-byte data block
        const key = (pid ^ otid) >>> 0;
        const decrypted = new Uint8Array(48);
        for (let i = 0; i < 48; i += 4) {
            const v = (u32(buf, off + 0x20 + i) ^ key) >>> 0;
            decrypted[i + 0] = v & 0xFF;
            decrypted[i + 1] = (v >> 8) & 0xFF;
            decrypted[i + 2] = (v >> 16) & 0xFF;
            decrypted[i + 3] = (v >>> 24) & 0xFF;
        }

        // Verify checksum: sum of 24 16-bit words
        let sum = 0;
        for (let i = 0; i < 48; i += 2) sum = (sum + (decrypted[i] | (decrypted[i + 1] << 8))) & 0xFFFF;
        const checksumValid = sum === storedCk;

        // Unshuffle substructures
        const order = SUBSTRUCT_ORDER[pid % 24];
        const sub = { G: null, A: null, E: null, M: null };
        for (let i = 0; i < 4; i++) {
            sub[order[i]] = decrypted.subarray(i * 12, (i + 1) * 12);
        }

        const growth = {
            species:    u16(sub.G, 0x00),
            heldItem:   u16(sub.G, 0x02),
            exp:        u32(sub.G, 0x04),
            ppBonuses:  sub.G[0x08],
            friendship: sub.G[0x09],
        };
        const attacks = {
            moves: [u16(sub.A, 0), u16(sub.A, 2), u16(sub.A, 4), u16(sub.A, 6)],
            pp:    [sub.A[0x08], sub.A[0x09], sub.A[0x0A], sub.A[0x0B]],
        };
        const evs = {
            hp:  sub.E[0], atk: sub.E[1], def: sub.E[2],
            spe: sub.E[3], spa: sub.E[4], spd: sub.E[5],
            cool: sub.E[6], beauty: sub.E[7], cute: sub.E[8],
            smart: sub.E[9], tough: sub.E[10], feel: sub.E[11],
        };
        const miscWord = u32(sub.M, 0x04); // IVs + flags packed
        const ivs = {
            hp:  miscWord & 0x1F,
            atk: (miscWord >> 5) & 0x1F,
            def: (miscWord >> 10) & 0x1F,
            spe: (miscWord >> 15) & 0x1F,
            spa: (miscWord >> 20) & 0x1F,
            spd: (miscWord >> 25) & 0x1F,
        };
        const isEgg   = (miscWord >> 30) & 1;
        const ability = (miscWord >> 31) & 1;
        const misc = {
            pokerus:    sub.M[0],
            metLoc:     sub.M[1],
            originInfo: u16(sub.M, 2),
            ivs, isEgg, ability,
            ribbons:    u32(sub.M, 0x08),
        };

        return {
            offset: off,
            pid, otid, key,
            nickname: decodeStr(nickRaw),
            language: lang,
            otName: decodeStr(otNameRaw),
            markings,
            checksumValid,
            growth, attacks, evs, misc,
            status: u32(buf, off + 0x50),
            level:  buf[off + 0x54],
            mail:   buf[off + 0x55],
            currentHp: u16(buf, off + 0x56),
            maxHp:     u16(buf, off + 0x58),
            attack:    u16(buf, off + 0x5A),
            defense:   u16(buf, off + 0x5C),
            speed:     u16(buf, off + 0x5E),
            spAttack:  u16(buf, off + 0x60),
            spDefense: u16(buf, off + 0x62),
        };
    }

    // ---- Write back ----
    // Writes a parsed save back into buf and recomputes all checksums.
    function write(save, edits) {
        // edits = { money, trainerName, party: [{...patched}], bag: {...} }
        const buf = save._raw;
        const sec0 = save._byId[0];
        const sec1 = save._byId[1];
        const off = save._offsets;
        const key = save.encryptionKey;

        if (edits.trainerName != null) {
            const enc = encodeStr(edits.trainerName.toUpperCase(), 7);
            buf.set(enc, sec0.offset + 0x00);
        }
        if (edits.money != null) {
            const m = Math.max(0, Math.min(999999, edits.money | 0));
            setU32(buf, sec1.offset + off.money, (m ^ key) >>> 0);
        }

        if (edits.party) {
            for (const pk of edits.party) writePokemon(buf, pk);
        }

        if (edits.pc) {
            // Re-serialize every PC pokemon into the flat 33,744 byte array,
            // then split back across sections 5-13.
            const flat = edits.pc._flat;
            setU32(flat, 0x0000, edits.pc.currentBox || 0);
            for (let b = 0; b < 14; b++) {
                for (let s = 0; s < 30; s++) {
                    const pk = edits.pc.boxes[b][s];
                    const off = 0x0004 + (b * 30 + s) * 80;
                    writePokemonPC(flat, off, pk);
                }
                const nameOff = 0x8344 + b * 9;
                flat.set(encodeStr(edits.pc.names[b] || '', 9), nameOff);
                flat[0x83C2 + b] = edits.pc.wallpapers[b] || 0;
            }
            // Split back across sections 5-13
            let cursor = 0;
            for (let id = 5; id <= 13; id++) {
                const sec = save._byId[id];
                if (!sec) continue;
                const dataLen = SECTION_DATA_SIZE[id];
                buf.set(flat.subarray(cursor, cursor + dataLen), sec.offset);
                cursor += dataLen;
            }
        }

        if (edits.bag) {
            for (const cat of Object.keys(edits.bag)) {
                const slots = edits.bag[cat];
                const c = off[cat];
                if (!c) continue;
                // Clear all slots
                for (let i = 0; i < c.slots; i++) {
                    setU16(buf, sec1.offset + c.off + i * 4, 0);
                    setU16(buf, sec1.offset + c.off + i * 4 + 2, 0);
                }
                for (let i = 0; i < Math.min(slots.length, c.slots); i++) {
                    const s = slots[i];
                    const qty = (cat === 'keyItems' && save.game === 'rs')
                        ? s.qty
                        : (s.qty ^ (key & 0xFFFF));
                    setU16(buf, sec1.offset + c.off + i * 4, s.id);
                    setU16(buf, sec1.offset + c.off + i * 4 + 2, qty);
                }
            }
        }

        // Recompute section checksums for every section
        for (const s of save._active.sections) {
            const dataLen = SECTION_DATA_SIZE[s.id];
            const ck = checksum(buf, s.offset, dataLen);
            setU16(buf, s.offset + FOOTER_OFFSET + 2, ck);
        }
        return buf;
    }

    function writePokemon(buf, pk) {
        const off = pk.offset;
        // Update nickname / OT name (unencrypted)
        buf.set(encodeStr(pk.nickname || '', 10), off + 0x08);
        buf.set(encodeStr(pk.otName || '', 7), off + 0x14);
        // Re-pack substructures with patched fields
        const sub = { G: new Uint8Array(12), A: new Uint8Array(12), E: new Uint8Array(12), M: new Uint8Array(12) };
        setU16(sub.G, 0x00, pk.growth.species);
        setU16(sub.G, 0x02, pk.growth.heldItem);
        setU32(sub.G, 0x04, pk.growth.exp);
        sub.G[0x08] = pk.growth.ppBonuses;
        sub.G[0x09] = pk.growth.friendship;

        for (let i = 0; i < 4; i++) {
            setU16(sub.A, i * 2, pk.attacks.moves[i]);
            sub.A[0x08 + i] = pk.attacks.pp[i];
        }
        sub.E[0] = pk.evs.hp;  sub.E[1] = pk.evs.atk; sub.E[2] = pk.evs.def;
        sub.E[3] = pk.evs.spe; sub.E[4] = pk.evs.spa; sub.E[5] = pk.evs.spd;
        sub.E[6] = pk.evs.cool;   sub.E[7]  = pk.evs.beauty;
        sub.E[8] = pk.evs.cute;   sub.E[9]  = pk.evs.smart;
        sub.E[10]= pk.evs.tough;  sub.E[11] = pk.evs.feel;

        sub.M[0] = pk.misc.pokerus;
        sub.M[1] = pk.misc.metLoc;
        setU16(sub.M, 2, pk.misc.originInfo);
        const ivs = pk.misc.ivs;
        const miscWord = (
            (ivs.hp & 0x1F) |
            ((ivs.atk & 0x1F) << 5) |
            ((ivs.def & 0x1F) << 10) |
            ((ivs.spe & 0x1F) << 15) |
            ((ivs.spa & 0x1F) << 20) |
            ((ivs.spd & 0x1F) << 25) |
            ((pk.misc.isEgg & 1) << 30) |
            ((pk.misc.ability & 1) << 31)
        ) >>> 0;
        setU32(sub.M, 0x04, miscWord);
        setU32(sub.M, 0x08, pk.misc.ribbons);

        // Reshuffle by PID % 24
        const order = SUBSTRUCT_ORDER[pk.pid % 24];
        const decrypted = new Uint8Array(48);
        for (let i = 0; i < 4; i++) {
            decrypted.set(sub[order[i]], i * 12);
        }
        // Recompute Pokemon checksum
        let sum = 0;
        for (let i = 0; i < 48; i += 2) {
            sum = (sum + (decrypted[i] | (decrypted[i + 1] << 8))) & 0xFFFF;
        }
        setU16(buf, off + 0x1C, sum);
        // Encrypt
        for (let i = 0; i < 48; i += 4) {
            const v = ((decrypted[i] | (decrypted[i + 1] << 8) | (decrypted[i + 2] << 16) | (decrypted[i + 3] << 24)) ^ pk.key) >>> 0;
            setU32(buf, off + 0x20 + i, v);
        }

        // Update stats / hp / level too (level is unencrypted)
        buf[off + 0x54] = pk.level;
        setU16(buf, off + 0x56, pk.currentHp);
        setU16(buf, off + 0x58, pk.maxHp);
        setU16(buf, off + 0x5A, pk.attack);
        setU16(buf, off + 0x5C, pk.defense);
        setU16(buf, off + 0x5E, pk.speed);
        setU16(buf, off + 0x60, pk.spAttack);
        setU16(buf, off + 0x62, pk.spDefense);
    }

    // PC variant: same as writePokemon but stops at byte 0x4F. Stats /
    // level aren't stored on disk — when the user takes the pokemon out
    // of the PC the game recomputes them from EXP + base stats.
    function writePokemonPC(flat, off, pk) {
        // Empty slot — zero it out and bail
        if (pk.isEmpty) {
            for (let i = 0; i < 80; i++) flat[off + i] = 0;
            return;
        }
        flat.set(encodeStr(pk.nickname || '', 10), off + 0x08);
        flat.set(encodeStr(pk.otName || '', 7), off + 0x14);
        flat[off + 0x12] = pk.language || 2;
        flat[off + 0x1B] = pk.markings || 0;

        const sub = { G: new Uint8Array(12), A: new Uint8Array(12), E: new Uint8Array(12), M: new Uint8Array(12) };
        setU16(sub.G, 0x00, pk.growth.species);
        setU16(sub.G, 0x02, pk.growth.heldItem);
        setU32(sub.G, 0x04, pk.growth.exp);
        sub.G[0x08] = pk.growth.ppBonuses;
        sub.G[0x09] = pk.growth.friendship;
        for (let i = 0; i < 4; i++) {
            setU16(sub.A, i * 2, pk.attacks.moves[i]);
            sub.A[0x08 + i] = pk.attacks.pp[i];
        }
        sub.E[0] = pk.evs.hp;  sub.E[1] = pk.evs.atk; sub.E[2] = pk.evs.def;
        sub.E[3] = pk.evs.spe; sub.E[4] = pk.evs.spa; sub.E[5] = pk.evs.spd;
        sub.E[6] = pk.evs.cool || 0;   sub.E[7]  = pk.evs.beauty || 0;
        sub.E[8] = pk.evs.cute || 0;   sub.E[9]  = pk.evs.smart || 0;
        sub.E[10]= pk.evs.tough || 0;  sub.E[11] = pk.evs.feel || 0;
        sub.M[0] = pk.misc.pokerus || 0;
        sub.M[1] = pk.misc.metLoc || 0;
        setU16(sub.M, 2, pk.misc.originInfo || 0);
        const ivs = pk.misc.ivs;
        const miscWord = (
            (ivs.hp & 0x1F) |
            ((ivs.atk & 0x1F) << 5) |
            ((ivs.def & 0x1F) << 10) |
            ((ivs.spe & 0x1F) << 15) |
            ((ivs.spa & 0x1F) << 20) |
            ((ivs.spd & 0x1F) << 25) |
            ((pk.misc.isEgg & 1) << 30) |
            ((pk.misc.ability & 1) << 31)
        ) >>> 0;
        setU32(sub.M, 0x04, miscWord);
        setU32(sub.M, 0x08, pk.misc.ribbons || 0);

        // PID / OTID write — shadow-write because the parser stored them
        setU32(flat, off + 0x00, pk.pid);
        setU32(flat, off + 0x04, pk.otid);

        const order = SUBSTRUCT_ORDER[pk.pid % 24];
        const decrypted = new Uint8Array(48);
        for (let i = 0; i < 4; i++) decrypted.set(sub[order[i]], i * 12);
        let sum = 0;
        for (let i = 0; i < 48; i += 2) {
            sum = (sum + (decrypted[i] | (decrypted[i + 1] << 8))) & 0xFFFF;
        }
        setU16(flat, off + 0x1C, sum);
        for (let i = 0; i < 48; i += 4) {
            const v = ((decrypted[i] | (decrypted[i + 1] << 8) | (decrypted[i + 2] << 16) | (decrypted[i + 3] << 24)) ^ pk.key) >>> 0;
            setU32(flat, off + 0x20 + i, v);
        }
        // Bytes 0x50-0x4F are unused in PC storage — leave as zero
    }

    // ---- Stat recalculation ----
    // stat = floor(((2*base + iv + floor(ev/4)) * level)/100 + 5) * nature
    // HP   = floor(((2*base + iv + floor(ev/4)) * level)/100 + 10 + level)
    function recalcStats(pk, baseStats, nature) {
        const lv = pk.level;
        const iv = pk.misc.ivs;
        const ev = pk.evs;
        const hp = Math.floor(((2 * baseStats.hp + iv.hp + Math.floor(ev.hp / 4)) * lv) / 100) + 10 + lv;
        function s(b, i, e, statKey) {
            const raw = Math.floor(((2 * b + i + Math.floor(e / 4)) * lv) / 100) + 5;
            return Math.floor(raw * natureMult(nature, statKey));
        }
        pk.maxHp = hp;
        pk.currentHp = hp;
        pk.attack    = s(baseStats.atk, iv.atk, ev.atk, 'atk');
        pk.defense   = s(baseStats.def, iv.def, ev.def, 'def');
        pk.speed     = s(baseStats.spe, iv.spe, ev.spe, 'spe');
        pk.spAttack  = s(baseStats.spa, iv.spa, ev.spa, 'spa');
        pk.spDefense = s(baseStats.spd, iv.spd, ev.spd, 'spd');
    }

    // PID encodes nature as PID % 25
    const NATURE_NAMES = [
        'Hardy','Lonely','Brave','Adamant','Naughty','Bold','Docile','Relaxed',
        'Impish','Lax','Timid','Hasty','Serious','Jolly','Naive','Modest',
        'Mild','Quiet','Bashful','Rash','Calm','Gentle','Sassy','Careful','Quirky',
    ];
    function getNature(pk) { return NATURE_NAMES[pk.pid % 25]; }

    // Nature stat multipliers
    const NATURE_TABLE = {
        Hardy:  {}, Lonely: {atk:1.1, def:0.9}, Brave: {atk:1.1, spe:0.9},
        Adamant:{atk:1.1, spa:0.9}, Naughty:{atk:1.1, spd:0.9},
        Bold:   {def:1.1, atk:0.9}, Docile:{},
        Relaxed:{def:1.1, spe:0.9}, Impish:{def:1.1, spa:0.9},
        Lax:    {def:1.1, spd:0.9},
        Timid:  {spe:1.1, atk:0.9}, Hasty:{spe:1.1, def:0.9},
        Serious:{}, Jolly:{spe:1.1, spa:0.9}, Naive:{spe:1.1, spd:0.9},
        Modest: {spa:1.1, atk:0.9}, Mild:{spa:1.1, def:0.9},
        Quiet:  {spa:1.1, spe:0.9}, Bashful:{},
        Rash:   {spa:1.1, spd:0.9},
        Calm:   {spd:1.1, atk:0.9}, Gentle:{spd:1.1, def:0.9},
        Sassy:  {spd:1.1, spe:0.9}, Careful:{spd:1.1, spa:0.9}, Quirky:{},
    };
    function natureMult(nature, statKey) {
        const tab = NATURE_TABLE[nature] || {};
        return tab[statKey] || 1;
    }

    // Set nature by rerolling PID. Keeps gender / shininess approximately.
    function setNature(pk, natureName) {
        const targetIdx = NATURE_NAMES.indexOf(natureName);
        if (targetIdx < 0) return;
        // Find a PID whose lower bits give us this nature, preserving
        // the high bits (which influence shininess via OTID XOR).
        const high = (pk.pid >>> 16) & 0xFFFF;
        let low = pk.pid & 0xFFFF;
        for (let i = 0; i < 65536; i++) {
            const pid = ((high << 16) | low) >>> 0;
            if (pid % 25 === targetIdx) {
                pk.pid = pid;
                pk.key = (pid ^ pk.otid) >>> 0;
                return;
            }
            low = (low + 1) & 0xFFFF;
        }
    }

    function isShiny(pk) {
        const ot = pk.otid;
        const tid = ot & 0xFFFF;
        const sid = (ot >> 16) & 0xFFFF;
        const lo = pk.pid & 0xFFFF;
        const hi = (pk.pid >>> 16) & 0xFFFF;
        return (tid ^ sid ^ lo ^ hi) < 8;
    }

    // Force shiny by tweaking PID's low half until shiny check passes.
    function setShiny(pk, on) {
        const tid = pk.otid & 0xFFFF;
        const sid = (pk.otid >> 16) & 0xFFFF;
        // Need lo ^ hi ^ tid ^ sid < 8  OR  >= 8
        // Preserve nature (pid % 25) — search both halves until ok.
        const wantedNature = pk.pid % 25;
        let pid = pk.pid;
        for (let attempt = 0; attempt < 200000; attempt++) {
            const lo = pid & 0xFFFF;
            const hi = (pid >>> 16) & 0xFFFF;
            const shinyVal = (tid ^ sid ^ lo ^ hi);
            const isCurrentlyShiny = shinyVal < 8;
            if (on === isCurrentlyShiny && pid % 25 === wantedNature) {
                pk.pid = pid;
                pk.key = (pid ^ pk.otid) >>> 0;
                return true;
            }
            pid = (pid + 1) >>> 0;
        }
        return false;
    }

    global.SaveEditorGen3 = {
        parse, write,
        decodeStr, encodeStr,
        recalcStats, getNature, setNature, isShiny, setShiny,
        NATURE_NAMES,
        SECTION_DATA_SIZE,
    };
})(window);
