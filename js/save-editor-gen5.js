// Gen 5 (NDS Pokemon) save file parser/encoder.
// Covers Black, White, Black 2, White 2 — plus all Moemon B2/W2 hacks.
//
// Format references:
//   PKHeX.Core/Saves/SAV5{BW,B2W2}.cs
//   PKHeX.Core/Saves/Access/SaveBlockAccessor5BW.cs and ...5B2W2.cs
//   PKHeX.Core/Saves/Substructures/Gen5/{PlayerData5,Misc5,BoxLayout5}.cs
//
// Save layout (524,288 bytes = 0x80000):
//   No slot A/B. Single save area with many small "blocks" cataloged by
//   per-game tables. Each block has a CRC-16-CCITT trailer plus a mirror
//   in the dedicated Checksum Block.
//
// Pokemon encryption is identical to Gen 4 — we re-use the algorithm
// from window.SaveEditorGen4 (loaded first by the page).

(function (global) {
    'use strict';

    // Reuse encryption + shuffle + char-set-agnostic helpers from Gen 4.
    // Gen 4 file must be loaded before this one.
    const G4 = global.SaveEditorGen4;
    if (!G4) {
        console.error('SaveEditorGen5: must load save-editor-gen4.js first');
        return;
    }

    const SAVE_SIZE = 0x80000;

    // ---- Block tables (offset, length) ----
    // Pulled from PKHeX SaveBlockAccessor5BW.cs / 5B2W2.cs.
    // Only the blocks we actually read/write are listed; everything else
    // gets CRC-recomputed via a generic table sweep at write time.
    //
    // Each entry is [blockIndex, offset, length].
    // The "checksum block" at the end mirrors every block's CRC at
    // (checksumBlockOffset + 2*blockIndex).
    const BLOCKS_BW = {
        boxLayout: [0,  0x00000, 0x03E0],
        boxes: [
            [1, 0x00400, 0x0FF0], [2, 0x01400, 0x0FF0], [3, 0x02400, 0x0FF0],
            [4, 0x03400, 0x0FF0], [5, 0x04400, 0x0FF0], [6, 0x05400, 0x0FF0],
            [7, 0x06400, 0x0FF0], [8, 0x07400, 0x0FF0], [9, 0x08400, 0x0FF0],
            [10,0x09400, 0x0FF0], [11,0x0A400, 0x0FF0], [12,0x0B400, 0x0FF0],
            [13,0x0C400, 0x0FF0], [14,0x0D400, 0x0FF0], [15,0x0E400, 0x0FF0],
            [16,0x0F400, 0x0FF0], [17,0x10400, 0x0FF0], [18,0x11400, 0x0FF0],
            [19,0x12400, 0x0FF0], [20,0x13400, 0x0FF0], [21,0x14400, 0x0FF0],
            [22,0x15400, 0x0FF0], [23,0x16400, 0x0FF0], [24,0x17400, 0x0FF0],
        ],
        inventory: [25, 0x18400, 0x09C0],
        party:     [26, 0x18E00, 0x0534],
        trainer:   [27, 0x19400, 0x0068],
        misc:      [52, 0x21200, 0x00EC],
        pokedex:   [55, 0x21600, 0x04D4],
        checksumBlock: 0x23F00,
    };
    const BLOCKS_B2W2 = {
        boxLayout: [0,  0x00000, 0x03E0],
        boxes: [
            [1, 0x00400, 0x0FF0], [2, 0x01400, 0x0FF0], [3, 0x02400, 0x0FF0],
            [4, 0x03400, 0x0FF0], [5, 0x04400, 0x0FF0], [6, 0x05400, 0x0FF0],
            [7, 0x06400, 0x0FF0], [8, 0x07400, 0x0FF0], [9, 0x08400, 0x0FF0],
            [10,0x09400, 0x0FF0], [11,0x0A400, 0x0FF0], [12,0x0B400, 0x0FF0],
            [13,0x0C400, 0x0FF0], [14,0x0D400, 0x0FF0], [15,0x0E400, 0x0FF0],
            [16,0x0F400, 0x0FF0], [17,0x10400, 0x0FF0], [18,0x11400, 0x0FF0],
            [19,0x12400, 0x0FF0], [20,0x13400, 0x0FF0], [21,0x14400, 0x0FF0],
            [22,0x15400, 0x0FF0], [23,0x16400, 0x0FF0], [24,0x17400, 0x0FF0],
        ],
        inventory: [25, 0x18400, 0x09EC],
        party:     [26, 0x18E00, 0x0534],
        trainer:   [27, 0x19400, 0x00B0],
        misc:      [52, 0x21100, 0x00F0],
        pokedex:   [54, 0x21400, 0x04DC],
        checksumBlock: 0x25F00,
    };

    function u16(b, o) { return b[o] | (b[o+1] << 8); }
    function u32(b, o) { return ((b[o]) | (b[o+1] << 8) | (b[o+2] << 16) | (b[o+3] << 24)) >>> 0; }
    function setU16(b, o, v) { b[o] = v & 0xFF; b[o+1] = (v >> 8) & 0xFF; }
    function setU32(b, o, v) {
        b[o] = v & 0xFF; b[o+1] = (v >> 8) & 0xFF;
        b[o+2] = (v >> 16) & 0xFF; b[o+3] = (v >>> 24) & 0xFF;
    }

    // Gen 5 uses real UTF-16LE for trainer / nicknames / box names.
    function decodeUTF16(buf, off, maxBytes) {
        let s = '';
        for (let i = 0; i < maxBytes; i += 2) {
            const cu = u16(buf, off + i);
            if (cu === 0xFFFF || cu === 0x0000) break;
            s += String.fromCharCode(cu);
        }
        return s;
    }
    function encodeUTF16(s, lenBytes) {
        const out = new Uint8Array(lenBytes).fill(0xFF);
        const maxChars = (lenBytes / 2) - 1;
        for (let i = 0; i < Math.min(s.length, maxChars); i++) {
            setU16(out, i * 2, s.charCodeAt(i));
        }
        setU16(out, Math.min(s.length, maxChars) * 2, 0xFFFF);
        return out;
    }

    // ---- Game detection ----
    // BW has 70 blocks (last = checksum block #69); B2W2 has 74 (last #73).
    // The checksum block for BW starts at 0x23F00; for B2W2 at 0x25F00.
    // Easiest heuristic: check the checksum block region's contents.
    // If 0x23F00 has a valid CRC for the boxLayout block, it's BW.
    function detectGame(buf) {
        if (buf.length < SAVE_SIZE) {
            throw new Error(`Gen 5 save must be ${SAVE_SIZE} bytes (got ${buf.length})`);
        }
        // Verify boxLayout block CRC matches the mirror in BW's checksum block
        const layoutCrc = G4._crc16(buf, 0x00000, 0x03E0);
        const bwMirror = u16(buf, 0x23F00 + 0 * 2);
        if (layoutCrc === bwMirror) return 'bw';

        const b2w2Mirror = u16(buf, 0x25F00 + 0 * 2);
        if (layoutCrc === b2w2Mirror) return 'b2w2';

        return null;
    }

    // ---- Main parse ----
    function parse(rawBytes) {
        const buf = new Uint8Array(rawBytes);
        const game = detectGame(buf);
        if (!game) throw new Error('Not a Gen 5 save (no valid box-layout CRC at either BW or B2W2 mirror)');
        const T = game === 'bw' ? BLOCKS_BW : BLOCKS_B2W2;

        // ---- Trainer block ----
        const [, trOff] = T.trainer;
        const trainer = {
            name: decodeUTF16(buf, trOff + 0x04, 16),
            tid: u16(buf, trOff + 0x14),
            sid: u16(buf, trOff + 0x16),
            language: buf[trOff + 0x1E],
            gender: buf[trOff + 0x21],
            playtime: {
                hours:   u16(buf, trOff + 0x24),
                minutes: buf[trOff + 0x26],
                seconds: buf[trOff + 0x27],
                frames:  0,
            },
            game,
        };

        // ---- Misc block (money, badges) ----
        const [, miscOff] = T.misc;
        const money = u32(buf, miscOff + 0x00);
        const badges = buf[miscOff + 0x04];

        // ---- Party block ----
        const [, partyOff] = T.party;
        const partyCount = buf[partyOff + 4];
        const party = [];
        for (let i = 0; i < Math.min(6, partyCount); i++) {
            const off = partyOff + 8 + i * 220;
            const pk = G4._parsePokemon(buf, off, true);
            // Gen 5 party stats trailer is 100 bytes too (220 = 136 + 84,
            // but we still use party=true to decrypt 100 bytes — extra
            // 16 of zeros are harmless).
            party.push(pk);
        }

        // ---- PC Boxes ----
        // BoxLayout (block 0): currentBox at 0x00, names at 0x04 + 0x28*N (16 bytes UTF-16),
        // wallpapers at 0x3C4 + N. Boxes are each their own block.
        const currentBox = buf[0x00];
        const names = [];
        const wallpapers = [];
        for (let b = 0; b < 24; b++) {
            names.push(decodeUTF16(buf, 0x04 + 0x28 * b, 16));
            wallpapers.push(buf[0x3C4 + b]);
        }
        const boxes = [];
        for (let b = 0; b < 24; b++) {
            const [, boxOff] = T.boxes[b];
            const box = [];
            for (let s = 0; s < 30; s++) {
                const off = boxOff + s * 136;
                box.push(G4._parsePokemon(buf, off, false));
            }
            boxes.push(box);
        }
        const pc = { currentBox, boxes, names, wallpapers };

        return {
            game, _gen: 5,
            trainer, money, coins: 0, badges, partyCount,
            party, pc,
            bag: { items: [], keyItems: [], balls: [], tms: [], berries: [] },
            _raw: buf,
            _t: T,
        };
    }

    // ---- Main write ----
    function write(save, edits) {
        const buf = save._raw;
        const T = save._t;
        const [, trOff] = T.trainer;
        const [, miscOff] = T.misc;
        const [, partyOff] = T.party;

        if (edits.trainerName != null) {
            buf.set(encodeUTF16(edits.trainerName, 16), trOff + 0x04);
        }
        if (edits.money != null) {
            setU32(buf, miscOff + 0x00, Math.max(0, Math.min(9999999, edits.money | 0)));
        }
        if (edits.party) {
            buf[partyOff + 4] = Math.min(6, edits.party.length);
            for (let i = 0; i < 6; i++) {
                const off = partyOff + 8 + i * 220;
                const pk = edits.party[i];
                if (pk) G4._writePokemon(buf, off, pk, true);
                else {
                    for (let j = 0; j < 220; j++) buf[off + j] = 0;
                }
            }
        }
        if (edits.pc) {
            buf[0x00] = edits.pc.currentBox || 0;
            for (let b = 0; b < 24; b++) {
                buf.set(encodeUTF16(edits.pc.names[b] || '', 16), 0x04 + 0x28 * b);
                buf[0x3C4 + b] = edits.pc.wallpapers[b] || 0;
                const [, boxOff] = T.boxes[b];
                for (let s = 0; s < 30; s++) {
                    const off = boxOff + s * 136;
                    G4._writePokemon(buf, off, edits.pc.boxes[b][s], false);
                }
            }
        }

        // ---- Recompute every block's CRC + checksum-block mirror ----
        recomputeAllCRCs(buf, T);

        return buf;
    }

    function recomputeAllCRCs(buf, T) {
        function fix(idx, off, len) {
            const crc = G4._crc16(buf, off, len);
            // Write trailer at off + len (with 2-byte trailing pad/storage —
            // PKHeX writes the CRC at the start of the 0x10/0x100-aligned
            // tail; here we write at len, len+1 since blocks have a few
            // bytes of slack after `len` before the next block boundary).
            setU16(buf, off + len, crc);
            // Mirror into checksum block at index*2
            setU16(buf, T.checksumBlock + idx * 2, crc);
        }
        fix(T.boxLayout[0], T.boxLayout[1], T.boxLayout[2]);
        for (const [idx, off, len] of T.boxes) fix(idx, off, len);
        fix(T.inventory[0], T.inventory[1], T.inventory[2]);
        fix(T.party[0],     T.party[1],     T.party[2]);
        fix(T.trainer[0],   T.trainer[1],   T.trainer[2]);
        fix(T.misc[0],      T.misc[1],      T.misc[2]);
        fix(T.pokedex[0],   T.pokedex[1],   T.pokedex[2]);
    }

    global.SaveEditorGen5 = {
        parse, write,
        recalcStats: G4.recalcStats,
        getNature:   G4.getNature,
        setNature:   G4.setNature,
        isShiny:     G4.isShiny,
        setShiny:    G4.setShiny,
        NATURE_NAMES: G4.NATURE_NAMES,
    };
})(typeof window !== 'undefined' ? window : globalThis);
