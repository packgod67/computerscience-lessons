// Pokemon Save Editor — UI controller.
// Glues the file picker, party/bag display, edit modal, and download flow
// onto the Gen 3 parser exposed at `window.SaveEditorGen3`.

(function () {
    'use strict';

    const G3 = window.SaveEditorGen3;
    const G4 = window.SaveEditorGen4;
    const G5 = window.SaveEditorGen5;
    let G = null;         // active parser (pointer to G3/G4/G5)
    let pokedata = null;  // loaded from games/save-editor-pokedata.json
    let save = null;      // parsed save (or null)
    let originalBytes = null; // pristine copy for Reset

    // ---- Lookup helpers built from pokedata.json ----
    // Each entry is a tuple — we wrap it in something more ergonomic.
    let speciesById, movesById, itemsById;
    let speciesList, movesList, itemsList;

    function buildLookups() {
        speciesById = new Map();
        speciesList = pokedata.species.map((s) => {
            const obj = {
                id: s[0], name: s[1],
                base: { hp: s[2], atk: s[3], def: s[4], spe: s[5], spa: s[6], spd: s[7] },
                types: s[8],
            };
            speciesById.set(obj.id, obj);
            return obj;
        });
        movesById = new Map();
        movesList = pokedata.moves.map((m) => {
            const obj = { id: m[0], name: m[1], type: m[2], power: m[3], pp: m[4], acc: m[5] };
            movesById.set(obj.id, obj);
            return obj;
        });
        itemsById = new Map();
        itemsList = pokedata.items.map((it) => {
            const obj = { id: it[0], name: it[1] };
            itemsById.set(obj.id, obj);
            return obj;
        });
    }

    // Pokemon Showdown sprite CDN. Use gen-appropriate sprites where
    // possible (gen3 for Gen 3 saves, gen5 for everything else since
    // gen5 sprites cover all 1-649 mons). Showdown's "name" matches
    // PokeAPI's for everything in Gen 1-5, so we can derive directly.
    function spriteUrl(speciesId) {
        const s = speciesById.get(speciesId);
        if (!s || speciesId === 0) {
            return 'https://play.pokemonshowdown.com/sprites/gen5/0.png';
        }
        const slug = s.name.replace(/[^a-z0-9]/gi, '').toLowerCase();
        const dir = (save && save._gen === 3 && speciesId <= 386) ? 'gen3' : 'gen5';
        return `https://play.pokemonshowdown.com/sprites/${dir}/${slug}.png`;
    }

    function speciesName(id) {
        const s = speciesById.get(id);
        return s ? capitalize(s.name) : `Species #${id}`;
    }
    function moveName(id) {
        if (id === 0) return '—';
        const m = movesById.get(id);
        return m ? capitalize(m.name) : `Move #${id}`;
    }
    function itemName(id) {
        if (id === 0) return '—';
        const it = itemsById.get(id);
        return it ? it.name : `Item #${id}`;
    }
    function capitalize(s) { return s.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '); }

    // ---- File loading ----
    function showError(msg) {
        const el = document.getElementById('error');
        el.textContent = msg;
        el.style.display = 'block';
    }
    function clearError() {
        document.getElementById('error').style.display = 'none';
    }

    function setupFilePicker() {
        const dz = document.getElementById('dropzone');
        const input = document.getElementById('fileInput');

        dz.addEventListener('click', () => input.click());

        ['dragenter', 'dragover'].forEach((ev) => {
            dz.addEventListener(ev, (e) => {
                e.preventDefault();
                dz.classList.add('dragover');
            });
        });
        ['dragleave', 'drop'].forEach((ev) => {
            dz.addEventListener(ev, (e) => {
                e.preventDefault();
                dz.classList.remove('dragover');
            });
        });
        dz.addEventListener('drop', (e) => {
            const f = e.dataTransfer.files[0];
            if (f) loadFile(f);
        });
        input.addEventListener('change', (e) => {
            const f = e.target.files[0];
            if (f) loadFile(f);
        });
    }

    // Pick the right parser by file size and presence of magic bytes.
    // Gen 3 GBA: 64KB or 128KB
    // Gen 4 NDS: 512KB, slot-magic 0x20060623 at known offsets
    // Gen 5 NDS: 512KB, box-layout CRC mirror in checksum block
    function detectGen(bytes) {
        const size = bytes.length;
        if (size <= 0x20000) return { gen: 3, parser: G3 };
        // 0x80000 = 524288 — could be Gen 4 or Gen 5
        if (size >= 0x40000) {
            // Try Gen 4 first (magic check is cheap)
            if (G4 && G4._detectGame(bytes)) return { gen: 4, parser: G4 };
            if (G5) return { gen: 5, parser: G5 };
        }
        return { gen: 3, parser: G3 };
    }

    async function loadFile(file) {
        clearError();
        try {
            const buf = await file.arrayBuffer();
            const bytes = new Uint8Array(buf);
            // Keep pristine copy for the Reset button
            originalBytes = new Uint8Array(bytes);
            const detected = detectGen(bytes);
            G = detected.parser;
            save = G.parse(bytes);
            save._gen = detected.gen;
            renderAll();
            document.getElementById('dropzone').style.display = 'none';
            document.getElementById('editor').style.display = 'block';
            document.getElementById('downloadBtn').disabled = false;
            document.getElementById('resetBtn').style.display = 'inline-block';
            const badge = document.getElementById('gameBadge');
            badge.textContent = `Gen ${detected.gen} ${save.game}`;
            badge.className = `game-badge ${save.game}`;
            badge.style.display = 'inline-block';
        } catch (e) {
            console.error(e);
            showError(`Couldn't parse save file: ${e.message}. Supported: Gen 3 GBA (.sav 64-128KB), Gen 4 NDS (.sav 512KB — Diamond/Pearl/Platinum/HeartGold/SoulSilver), Gen 5 NDS (.sav 512KB — Black/White/Black 2/White 2).`);
        }
    }

    function resetSave() {
        if (!originalBytes) return;
        save = G.parse(new Uint8Array(originalBytes));
        renderAll();
    }

    // ---- Trainer header ----
    function renderTrainerHeader() {
        document.getElementById('trainerName').value = save.trainer.name;
        document.getElementById('trainerId').textContent =
            `${save.trainer.tid} / ${save.trainer.sid}`;
        document.getElementById('money').value = save.money;
        const pt = save.trainer.playtime;
        document.getElementById('playtime').textContent =
            `${pt.hours}h ${String(pt.minutes).padStart(2, '0')}m ${String(pt.seconds).padStart(2, '0')}s`;
    }

    // ---- Party grid ----
    function renderParty() {
        const grid = document.getElementById('partyGrid');
        grid.innerHTML = '';
        for (let i = 0; i < 6; i++) {
            const pk = save.party[i];
            const card = document.createElement('div');
            if (!pk) {
                card.className = 'party-card empty';
                card.innerHTML = `
                    <div class="sprite"></div>
                    <div class="nickname">—</div>
                    <div class="species">Empty slot</div>
                `;
            } else {
                const shiny = G.isShiny(pk);
                card.className = 'party-card';
                card.innerHTML = `
                    ${shiny ? '<div class="shiny-star">★</div>' : ''}
                    <img class="sprite" src="${spriteUrl(pk.growth.species)}" alt="" onerror="this.style.visibility='hidden'">
                    <div class="nickname">${escape(pk.nickname || speciesName(pk.growth.species))}</div>
                    <div class="species">${speciesName(pk.growth.species)} · ${G.getNature(pk)}</div>
                    <div class="level">Lv ${pk.level}</div>
                `;
                card.addEventListener('click', () => openPokemonModal(i));
            }
            grid.appendChild(card);
        }
        document.getElementById('partyCount').textContent = save.party.length;
    }

    function escape(s) {
        return String(s).replace(/[&<>"']/g, (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // ---- Bag ----
    const BAG_CATEGORIES = [
        { key: 'items',    label: 'Items' },
        { key: 'keyItems', label: 'Key Items' },
        { key: 'balls',    label: 'Pokeballs' },
        { key: 'tms',      label: 'TMs / HMs' },
        { key: 'berries',  label: 'Berries' },
    ];
    let activeBagCat = 'items';

    function renderBag() {
        // Gen 4/5 bag editing isn't supported yet — hide the section
        // entirely so users don't get a misleading empty UI.
        const bagSection = document.querySelector('section:has(#bagTabs)');
        if (save._gen && save._gen >= 4) {
            if (bagSection) bagSection.style.display = 'none';
            return;
        }
        if (bagSection) bagSection.style.display = '';
        const tabs = document.getElementById('bagTabs');
        tabs.innerHTML = '';
        for (const cat of BAG_CATEGORIES) {
            const b = document.createElement('button');
            b.textContent = `${cat.label} (${save.bag[cat.key].length})`;
            if (cat.key === activeBagCat) b.classList.add('active');
            b.addEventListener('click', () => { activeBagCat = cat.key; renderBag(); });
            tabs.appendChild(b);
        }
        const list = document.getElementById('bagList');
        list.innerHTML = '';
        const slots = save.bag[activeBagCat];
        slots.forEach((slot, idx) => {
            const row = document.createElement('div');
            row.className = 'row';
            row.innerHTML = `
                <select data-idx="${idx}" data-kind="item">
                    ${itemOptions(slot.id)}
                </select>
                <input type="number" min="1" max="999" value="${slot.qty}" data-idx="${idx}" data-kind="qty">
                <button class="remove" data-idx="${idx}" title="Remove">×</button>
            `;
            list.appendChild(row);
        });
        const addRow = document.createElement('div');
        addRow.className = 'add-row';
        addRow.innerHTML = `<button id="addItemBtn">+ Add item</button>`;
        list.appendChild(addRow);

        // Wire events
        list.querySelectorAll('select[data-kind=item]').forEach((sel) => {
            sel.addEventListener('change', (e) => {
                const i = +e.target.dataset.idx;
                save.bag[activeBagCat][i].id = +e.target.value;
            });
        });
        list.querySelectorAll('input[data-kind=qty]').forEach((inp) => {
            inp.addEventListener('input', (e) => {
                const i = +e.target.dataset.idx;
                save.bag[activeBagCat][i].qty = Math.max(1, Math.min(999, +e.target.value || 1));
            });
        });
        list.querySelectorAll('button.remove').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const i = +e.target.dataset.idx;
                save.bag[activeBagCat].splice(i, 1);
                renderBag();
            });
        });
        document.getElementById('addItemBtn').addEventListener('click', () => {
            save.bag[activeBagCat].push({ id: itemsList[1]?.id || 1, qty: 1 });
            renderBag();
        });
    }

    function itemOptions(selectedId) {
        let out = '';
        for (const it of itemsList) {
            out += `<option value="${it.id}"${it.id === selectedId ? ' selected' : ''}>${escape(it.name)}</option>`;
        }
        return out;
    }

    // ---- PC Boxes ----
    let activeBoxIdx = 0;

    function renderPC() {
        if (!save.pc) {
            document.getElementById('pcSection').style.display = 'none';
            return;
        }
        document.getElementById('pcSection').style.display = '';
        const boxCount = save.pc.boxes.length;
        activeBoxIdx = save.pc.currentBox || 0;
        if (activeBoxIdx < 0 || activeBoxIdx >= boxCount) activeBoxIdx = 0;

        const picker = document.getElementById('boxPicker');
        picker.innerHTML = '';
        for (let i = 0; i < boxCount; i++) {
            const opt = document.createElement('option');
            opt.value = i;
            const liveName = save.pc.names[i] || `Box ${i + 1}`;
            const filled = save.pc.boxes[i].filter((p) => !p.isEmpty).length;
            opt.textContent = `${i + 1}. ${liveName} (${filled}/30)`;
            if (i === activeBoxIdx) opt.selected = true;
            picker.appendChild(opt);
        }
        renderActiveBox();
    }

    function renderActiveBox() {
        const grid = document.getElementById('boxGrid');
        const box = save.pc.boxes[activeBoxIdx];
        grid.innerHTML = '';
        for (let s = 0; s < 30; s++) {
            const pk = box[s];
            const cell = document.createElement('div');
            if (pk.isEmpty) {
                cell.className = 'box-slot empty';
                cell.innerHTML = '<span style="color:var(--muted);font-size:10px;">—</span>';
            } else {
                cell.className = 'box-slot';
                const shiny = G.isShiny(pk);
                cell.title = `${speciesName(pk.growth.species)} · Lv ${pk.level} · ${G.getNature(pk)}`;
                cell.innerHTML = `
                    ${shiny ? '<span class="shiny-mini">★</span>' : ''}
                    <img src="${spriteUrl(pk.growth.species)}" alt="" onerror="this.style.visibility='hidden'">
                    <span class="lv-tag">Lv ${pk.level}</span>
                `;
                cell.addEventListener('click', () => openPokemonModal({ pc: true, box: activeBoxIdx, slot: s }));
            }
            grid.appendChild(cell);
        }
        const filled = box.filter((p) => !p.isEmpty).length;
        document.getElementById('boxStats').textContent = `${filled} / 30 occupied`;
        document.getElementById('boxName').value = save.pc.names[activeBoxIdx] || '';
    }

    function wirePCControls() {
        document.getElementById('prevBox').addEventListener('click', () => {
            const n = save.pc.boxes.length;
            activeBoxIdx = (activeBoxIdx + n - 1) % n;
            document.getElementById('boxPicker').value = activeBoxIdx;
            renderActiveBox();
        });
        document.getElementById('nextBox').addEventListener('click', () => {
            const n = save.pc.boxes.length;
            activeBoxIdx = (activeBoxIdx + 1) % n;
            document.getElementById('boxPicker').value = activeBoxIdx;
            renderActiveBox();
        });
        document.getElementById('boxPicker').addEventListener('change', (e) => {
            activeBoxIdx = +e.target.value;
            renderActiveBox();
        });
        document.getElementById('boxName').addEventListener('input', (e) => {
            // Limit to 8 chars (Gen 3 box names are 8 chars + 0xFF terminator)
            save.pc.names[activeBoxIdx] = (e.target.value || '').slice(0, 8).toUpperCase();
        });
    }

    // ---- Pokemon edit modal ----
    // editingRef = number (party slot) or { pc:true, box, slot }
    let editingRef = null;

    function refToPokemon(ref) {
        if (typeof ref === 'number') return save.party[ref];
        return save.pc.boxes[ref.box][ref.slot];
    }

    function openPokemonModal(ref) {
        editingRef = ref;
        const pk = refToPokemon(ref);
        const sp = speciesById.get(pk.growth.species) || { name: '?', base: { hp: 1, atk: 1, def: 1, spe: 1, spa: 1, spd: 1 } };

        const isParty = typeof ref === 'number';
        const where = isParty
            ? `Party slot ${ref + 1}`
            : `Box ${ref.box + 1} slot ${ref.slot + 1}`;
        const title = pk.isEmpty
            ? `${where} — empty (assigning new)`
            : `${where}: ${pk.nickname || speciesName(pk.growth.species)}`;
        document.getElementById('modalTitle').textContent = title;

        const body = document.getElementById('modalBody');
        body.innerHTML = `
            <img class="sprite-large" id="modalSprite" src="${spriteUrl(pk.growth.species)}" onerror="this.style.visibility='hidden'">

            <div class="grid-2">
                <div class="field">
                    <label>Species</label>
                    <select id="f_species">${speciesOptions(pk.growth.species)}</select>
                </div>
                <div class="field">
                    <label>Nickname</label>
                    <input type="text" id="f_nickname" maxlength="10" value="${escape(pk.nickname)}">
                </div>
                <div class="field">
                    <label>Level (1-100)</label>
                    <input type="number" id="f_level" min="1" max="100" value="${pk.level}">
                </div>
                <div class="field">
                    <label>Held Item</label>
                    <select id="f_helditem">${itemOptions(pk.growth.heldItem)}</select>
                </div>
                <div class="field">
                    <label>Nature</label>
                    <select id="f_nature">${natureOptions(G.getNature(pk))}</select>
                </div>
                <div class="field">
                    <label>Friendship (0-255)</label>
                    <input type="number" id="f_friendship" min="0" max="255" value="${pk.growth.friendship}">
                </div>
            </div>

            <h4>Moves</h4>
            <div class="grid-2">
                ${[0, 1, 2, 3].map((i) => `
                    <div class="field">
                        <label>Move ${i + 1}</label>
                        <select id="f_move${i}">${moveOptions(pk.attacks.moves[i])}</select>
                    </div>
                `).join('')}
            </div>

            <h4>IVs (0-31)</h4>
            <div class="grid-3">
                ${[['hp', 'HP'], ['atk', 'Atk'], ['def', 'Def'], ['spa', 'SpA'], ['spd', 'SpD'], ['spe', 'Spe']].map(([k, l]) => `
                    <div class="field">
                        <label>${l}</label>
                        <input type="number" id="f_iv_${k}" min="0" max="31" value="${pk.misc.ivs[k]}">
                    </div>
                `).join('')}
            </div>
            <div style="margin-top:8px;">
                <button id="maxIvs" style="background:var(--accent-2);border:none;color:white;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:12px;">Max all IVs (31)</button>
            </div>

            <h4>EVs (0-252 each, 510 total)</h4>
            <div class="grid-3">
                ${[['hp', 'HP'], ['atk', 'Atk'], ['def', 'Def'], ['spa', 'SpA'], ['spd', 'SpD'], ['spe', 'Spe']].map(([k, l]) => `
                    <div class="field">
                        <label>${l}</label>
                        <input type="number" id="f_ev_${k}" min="0" max="252" value="${pk.evs[k]}">
                    </div>
                `).join('')}
            </div>
            <div id="evTotal" style="font-size:12px;color:var(--muted);margin-top:6px;"></div>

            <div class="checkbox-row">
                <input type="checkbox" id="f_shiny" ${G.isShiny(pk) ? 'checked' : ''}>
                <label for="f_shiny" style="cursor:pointer;">Force shiny (re-rolls PID, preserves nature)</label>
            </div>
        `;

        // Live updates
        const updEvTotal = () => {
            const total = ['hp', 'atk', 'def', 'spa', 'spd', 'spe']
                .map((k) => +document.getElementById(`f_ev_${k}`).value || 0)
                .reduce((a, b) => a + b, 0);
            const el = document.getElementById('evTotal');
            el.textContent = `EV total: ${total} / 510`;
            el.style.color = total > 510 ? 'var(--bad)' : 'var(--muted)';
        };
        updEvTotal();
        ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].forEach((k) => {
            document.getElementById(`f_ev_${k}`).addEventListener('input', updEvTotal);
        });

        document.getElementById('f_species').addEventListener('change', (e) => {
            const id = +e.target.value;
            document.getElementById('modalSprite').src = spriteUrl(id);
        });

        document.getElementById('maxIvs').addEventListener('click', () => {
            ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].forEach((k) => {
                document.getElementById(`f_iv_${k}`).value = 31;
            });
        });

        document.getElementById('modalOverlay').classList.add('open');
    }

    function speciesOptions(selectedId) {
        let out = '';
        for (const s of speciesList) {
            out += `<option value="${s.id}"${s.id === selectedId ? ' selected' : ''}>${s.id.toString().padStart(3, '0')} ${escape(capitalize(s.name))}</option>`;
        }
        return out;
    }
    function moveOptions(selectedId) {
        let out = `<option value="0"${selectedId === 0 ? ' selected' : ''}>—</option>`;
        for (const m of movesList) {
            out += `<option value="${m.id}"${m.id === selectedId ? ' selected' : ''}>${escape(capitalize(m.name))}</option>`;
        }
        return out;
    }
    function natureOptions(selectedName) {
        let out = '';
        for (const n of G.NATURE_NAMES) {
            out += `<option value="${n}"${n === selectedName ? ' selected' : ''}>${n}</option>`;
        }
        return out;
    }

    function closeModal() {
        document.getElementById('modalOverlay').classList.remove('open');
        editingRef = null;
    }

    function savePokemonEdits() {
        const pk = refToPokemon(editingRef);
        const newSpecies = +document.getElementById('f_species').value;
        const newLevel = clamp(+document.getElementById('f_level').value, 1, 100);

        pk.growth.species  = newSpecies;
        pk.growth.heldItem = +document.getElementById('f_helditem').value;
        pk.growth.friendship = clamp(+document.getElementById('f_friendship').value, 0, 255);
        pk.nickname = document.getElementById('f_nickname').value;
        pk.level = newLevel;

        for (let i = 0; i < 4; i++) {
            const moveId = +document.getElementById(`f_move${i}`).value;
            pk.attacks.moves[i] = moveId;
            const m = movesById.get(moveId);
            pk.attacks.pp[i] = m ? m.pp : 0;
        }

        ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].forEach((k) => {
            pk.misc.ivs[k] = clamp(+document.getElementById(`f_iv_${k}`).value, 0, 31);
            pk.evs[k]      = clamp(+document.getElementById(`f_ev_${k}`).value, 0, 252);
        });

        // Apply nature
        const wantNature = document.getElementById('f_nature').value;
        if (wantNature !== G.getNature(pk)) {
            G.setNature(pk, wantNature);
        }
        // Apply shiny
        const wantShiny = document.getElementById('f_shiny').checked;
        if (wantShiny !== G.isShiny(pk)) {
            G.setShiny(pk, wantShiny);
        }
        // Recalc EXP to match level — simple lookup using medium-fast curve
        pk.growth.exp = expForLevel(newLevel, 'medium-fast');

        // Recompute stats from base stats + IVs + EVs + nature
        const sp = speciesById.get(newSpecies);
        if (sp) G.recalcStats(pk, sp.base, G.getNature(pk));

        // Mark a PC slot live before we lose the ref to closeModal
        const wasPc = !isPartyRef(editingRef);
        if (wasPc && pk.growth.species > 0) pk.isEmpty = false;
        closeModal();
        renderParty();
        if (save.pc) renderPC();
    }

    function isPartyRef(ref) { return typeof ref === 'number'; }

    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v | 0)); }

    // Medium-fast curve: exp = level^3.
    // Most species use this; others differ but Gen 3 lets you carry over the
    // exp value as long as level field matches what exp implies, so this is
    // safe for the level we set.
    function expForLevel(lv, curve) {
        if (curve === 'medium-fast') return lv * lv * lv;
        return lv * lv * lv;
    }

    // ---- Download ----
    function downloadSave() {
        // Apply current trainer + money edits before writing
        const edits = {
            trainerName: document.getElementById('trainerName').value,
            money: parseInt(document.getElementById('money').value, 10),
            party: save.party,
            bag: save.bag,
        };
        if (save.pc) {
            // Also update currentBox from picker
            save.pc.currentBox = activeBoxIdx;
            edits.pc = save.pc;
        }
        const bytes = G.write(save, edits);
        const blob = new Blob([bytes], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `pokemon-edited-${Date.now()}.sav`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    // ---- Re-render everything ----
    function renderAll() {
        renderTrainerHeader();
        renderParty();
        renderBag();
        renderPC();
    }

    // ---- Init ----
    async function init() {
        // Load pokedata.json
        try {
            const r = await fetch('games/save-editor-pokedata.json');
            pokedata = await r.json();
            buildLookups();
        } catch (e) {
            showError('Failed to load Pokemon data. Refresh the page and try again.');
            return;
        }
        setupFilePicker();

        document.getElementById('downloadBtn').addEventListener('click', downloadSave);
        document.getElementById('resetBtn').addEventListener('click', () => {
            if (confirm('Discard all changes and reload the original save?')) resetSave();
        });

        document.getElementById('modalClose').addEventListener('click', closeModal);
        document.getElementById('modalCancel').addEventListener('click', closeModal);
        document.getElementById('modalSave').addEventListener('click', savePokemonEdits);
        document.getElementById('modalOverlay').addEventListener('click', (e) => {
            if (e.target.id === 'modalOverlay') closeModal();
        });

        wirePCControls();
    }

    init();
})();
