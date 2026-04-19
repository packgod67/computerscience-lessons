// ===== Cheat Code Manager (Admin) =====
// Admin UI for entering GameShark / Action Replay / CodeBreaker codes per
// game. Codes live in Firestore at cheats/{gameId}/codes/{docId}. When a
// user opens a game, player.js fetches the enabled codes and posts them
// to the iframe via postMessage. The iframe applies them through the
// EmulatorJS cheats API once the emulator is ready.
(function () {
    let games = [];
    let gamesLoaded = false;
    let selectedGameId = null;
    let cheatsUnsub = null;
    let currentCheats = [];
    let defaultCheats = null; // lazy-loaded from games/default-cheats.json

    function db() { return ArcadeAuth.getDb(); }
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    async function loadGames() {
        if (gamesLoaded) return games;
        try {
            const res = await fetch('games/games.json');
            games = await res.json();
            gamesLoaded = true;
        } catch { games = []; }
        return games;
    }

    async function loadDefaultCheats() {
        if (defaultCheats) return defaultCheats;
        try {
            const res = await fetch('games/default-cheats.json');
            defaultCheats = await res.json();
        } catch { defaultCheats = {}; }
        return defaultCheats;
    }

    function getDefaultCheatsForGame(gameId) {
        if (!defaultCheats || !defaultCheats[gameId]) return [];
        return defaultCheats[gameId];
    }

    // ===== Firestore CRUD =====

    async function listCheats(gameId) {
        if (!gameId) return [];
        try {
            const snap = await db().collection('cheats').doc(gameId)
                .collection('codes').orderBy('createdAt', 'desc').get();
            return snap.docs.map(d => ({ id: d.id, ...d.data() }));
        } catch (e) {
            console.error('listCheats:', e);
            return [];
        }
    }

    function subscribeCheats(gameId, onChange) {
        if (cheatsUnsub) { cheatsUnsub(); cheatsUnsub = null; }
        if (!gameId) return;
        cheatsUnsub = db().collection('cheats').doc(gameId)
            .collection('codes').orderBy('createdAt', 'desc')
            .onSnapshot((snap) => {
                currentCheats = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                onChange(currentCheats);
            }, (err) => {
                console.error('subscribeCheats:', err);
                onChange([]);
            });
    }

    async function addCheat(gameId, { name, codes, type, enabled }) {
        const uid = ArcadeAuth.getUser()?.uid;
        if (!uid) throw new Error('Not logged in');
        await db().collection('cheats').doc(gameId).collection('codes').add({
            name: String(name || 'Unnamed cheat').slice(0, 120),
            codes: String(codes || '').slice(0, 8000),
            type: type || 'auto',
            enabled: !!enabled,
            createdBy: uid,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
    }

    async function updateCheat(gameId, cheatId, fields) {
        const allowed = ['name', 'codes', 'type', 'enabled'];
        const safe = {};
        for (const k of allowed) if (k in fields) safe[k] = fields[k];
        await db().collection('cheats').doc(gameId)
            .collection('codes').doc(cheatId).update(safe);
    }

    async function deleteCheat(gameId, cheatId) {
        await db().collection('cheats').doc(gameId)
            .collection('codes').doc(cheatId).delete();
    }

    // ===== Consumer API (used by player.js) =====
    // Returns array of [name, codeString] for the enabled cheats in a game.
    async function getEnabledCheatsForGame(gameId) {
        if (!gameId) return [];
        try {
            const snap = await db().collection('cheats').doc(gameId)
                .collection('codes').where('enabled', '==', true).get();
            return snap.docs.map(d => {
                const data = d.data();
                return {
                    name: data.name || 'Cheat',
                    codes: (data.codes || '').trim(),
                    type: data.type || 'auto',
                };
            }).filter(c => c.codes.length > 0);
        } catch (e) {
            return [];
        }
    }

    // ===== Admin UI =====

    async function renderCheatsView() {
        if (!ArcadeAuth.isAdmin()) return;
        const container = document.getElementById('cheatsView');
        if (!container) return;

        container.innerHTML = '<div class="cheats-loading">Loading games…</div>';
        await Promise.all([loadGames(), loadDefaultCheats()]);

        container.innerHTML = `
            <div class="cheats-panel">
                <div class="cheats-header">
                    <h2>Cheat Code Manager</h2>
                    <p class="cheats-hint">GameShark / Action Replay / CodeBreaker codes per game. Enabled codes auto-apply when anyone opens the game. Put one code per line. Names like <code>92345678 ABCDEF01</code> (GameShark) or <code>82345678 ABCD</code> (CodeBreaker) work.</p>
                </div>
                <div class="cheats-body">
                    <div class="cheats-games-col">
                        <input type="search" id="cheatGameSearch" class="cheats-search" placeholder="Search games…">
                        <div class="cheats-games-list" id="cheatGamesList"></div>
                    </div>
                    <div class="cheats-codes-col" id="cheatCodesCol">
                        <div class="cheats-codes-empty">Pick a game on the left.</div>
                    </div>
                </div>
            </div>
        `;

        const searchEl = document.getElementById('cheatGameSearch');
        const listEl = document.getElementById('cheatGamesList');

        function renderGamesList() {
            const q = searchEl.value.trim().toLowerCase();
            const filtered = q
                ? games.filter(g => (g.title || '').toLowerCase().includes(q))
                : games.slice(0, 100);
            // Always prioritize Pokemon since that's the main use case
            const pokemonFirst = filtered.slice().sort((a, b) => {
                const ap = (a.title || '').toLowerCase().startsWith('pokemon') ? 0 : 1;
                const bp = (b.title || '').toLowerCase().startsWith('pokemon') ? 0 : 1;
                return ap - bp || (a.title || '').localeCompare(b.title || '');
            });
            listEl.innerHTML = pokemonFirst.map(g => {
                const active = g.id === selectedGameId ? ' is-active' : '';
                return `<button class="cheats-game-item${active}" data-id="${esc(g.id)}">
                    <span class="cheats-game-title">${esc(g.title)}</span>
                    <span class="cheats-game-category">${esc(g.category || '')}</span>
                </button>`;
            }).join('') || '<div class="cheats-codes-empty">No matches.</div>';
        }

        searchEl.addEventListener('input', renderGamesList);
        listEl.addEventListener('click', (e) => {
            const btn = e.target.closest('.cheats-game-item');
            if (!btn) return;
            selectedGameId = btn.dataset.id;
            renderGamesList();
            renderCodesCol();
        });
        renderGamesList();
    }

    function renderCodesCol() {
        const col = document.getElementById('cheatCodesCol');
        if (!col) return;
        if (!selectedGameId) {
            col.innerHTML = '<div class="cheats-codes-empty">Pick a game on the left.</div>';
            return;
        }
        const game = games.find(g => g.id === selectedGameId);
        const bundled = getDefaultCheatsForGame(selectedGameId);
        const importBar = bundled.length > 0
            ? `<div class="cheats-import-bar">
                <span class="cheats-import-text">
                    <strong>${bundled.length}</strong> built-in cheat${bundled.length === 1 ? '' : 's'} available
                </span>
                <button class="cheats-import-btn" id="cheatImportBtn" type="button">Import all (disabled)</button>
            </div>`
            : '';
        col.innerHTML = `
            <div class="cheats-codes-head">
                <h3>${esc(game ? game.title : selectedGameId)}</h3>
                <span class="cheats-codes-game-id">${esc(selectedGameId)}</span>
            </div>
            ${importBar}
            <form class="cheats-add-form" id="cheatAddForm">
                <input type="text" id="cheatNameInput" class="cheats-input" placeholder="Cheat name (e.g. 99 Master Balls)" maxlength="120" required>
                <textarea id="cheatCodesInput" class="cheats-input cheats-codes-input" placeholder="Paste the code(s). Example:&#10;820257C4 270F" rows="3" required></textarea>
                <div class="cheats-add-row">
                    <select id="cheatTypeInput" class="cheats-input cheats-input-type">
                        <option value="auto">Auto-detect</option>
                        <option value="gameshark">GameShark v3</option>
                        <option value="actionreplay">Action Replay</option>
                        <option value="codebreaker">CodeBreaker</option>
                        <option value="raw">Raw hex</option>
                    </select>
                    <label class="cheats-enabled-label"><input type="checkbox" id="cheatEnabledInput" checked> Enabled</label>
                    <button type="submit" class="cheats-add-btn">Add cheat</button>
                </div>
            </form>
            <div class="cheats-existing" id="cheatExistingList">
                <div class="cheats-loading">Loading…</div>
            </div>
        `;

        // Wire up bulk import — adds every built-in cheat to Firestore,
        // all disabled by default so the admin opts in per cheat.
        const importBtn = document.getElementById('cheatImportBtn');
        if (importBtn) {
            importBtn.addEventListener('click', async () => {
                if (!confirm(`Import ${bundled.length} built-in cheats for this game? They'll all be disabled until you flip the enable toggle.`)) return;
                importBtn.disabled = true;
                importBtn.textContent = 'Importing…';
                let ok = 0, dup = 0;
                // Load current cheat names to avoid duplicates
                const existing = currentCheats || await listCheats(selectedGameId);
                const existingNames = new Set(existing.map(c => (c.name || '').trim().toLowerCase()));
                for (const c of bundled) {
                    if (existingNames.has((c.name || '').trim().toLowerCase())) { dup++; continue; }
                    try {
                        await addCheat(selectedGameId, {
                            name: c.name, codes: c.codes, type: c.type || 'auto', enabled: false
                        });
                        ok++;
                    } catch (e) {
                        console.error('import err:', c.name, e);
                    }
                }
                importBtn.disabled = false;
                importBtn.textContent = 'Import all (disabled)';
                alert(`Imported ${ok}${dup ? ` (skipped ${dup} duplicates)` : ''}. Flip the enable toggle on each cheat you want active.`);
            });
        }

        const form = document.getElementById('cheatAddForm');
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = document.getElementById('cheatNameInput').value.trim();
            const codes = document.getElementById('cheatCodesInput').value.trim();
            const type = document.getElementById('cheatTypeInput').value;
            const enabled = document.getElementById('cheatEnabledInput').checked;
            if (!name || !codes) return;
            const submitBtn = form.querySelector('.cheats-add-btn');
            submitBtn.disabled = true;
            submitBtn.textContent = 'Adding…';
            try {
                await addCheat(selectedGameId, { name, codes, type, enabled });
                form.reset();
                document.getElementById('cheatEnabledInput').checked = true;
            } catch (err) {
                alert('Failed to add: ' + err.message);
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Add cheat';
            }
        });

        subscribeCheats(selectedGameId, renderExistingList);
    }

    function renderExistingList(cheats) {
        const list = document.getElementById('cheatExistingList');
        if (!list) return;
        if (!cheats.length) {
            list.innerHTML = '<div class="cheats-codes-empty">No cheats yet for this game. Add one above.</div>';
            return;
        }
        list.innerHTML = cheats.map(c => {
            const codes = (c.codes || '').split('\n').map(esc).join('<br>');
            return `<div class="cheats-item" data-id="${esc(c.id)}">
                <div class="cheats-item-head">
                    <input type="text" class="cheats-item-name" value="${esc(c.name || '')}" data-field="name">
                    <label class="cheats-item-enable">
                        <input type="checkbox" data-field="enabled" ${c.enabled ? 'checked' : ''}>
                        <span>enabled</span>
                    </label>
                    <button class="cheats-item-delete" title="Delete">&times;</button>
                </div>
                <textarea class="cheats-item-codes" data-field="codes" rows="2">${esc(c.codes || '')}</textarea>
                <div class="cheats-item-foot">
                    <select class="cheats-item-type" data-field="type">
                        <option value="auto"${c.type === 'auto' || !c.type ? ' selected' : ''}>Auto</option>
                        <option value="gameshark"${c.type === 'gameshark' ? ' selected' : ''}>GameShark</option>
                        <option value="actionreplay"${c.type === 'actionreplay' ? ' selected' : ''}>Action Replay</option>
                        <option value="codebreaker"${c.type === 'codebreaker' ? ' selected' : ''}>CodeBreaker</option>
                        <option value="raw"${c.type === 'raw' ? ' selected' : ''}>Raw</option>
                    </select>
                    <span class="cheats-item-status" id="cheat-status-${esc(c.id)}"></span>
                </div>
            </div>`;
        }).join('');

        // Wire inputs — debounced save on change
        list.querySelectorAll('.cheats-item').forEach(item => {
            const id = item.dataset.id;
            const saveTimeouts = {};
            function queueSave(field, value) {
                clearTimeout(saveTimeouts[field]);
                const statusEl = document.getElementById('cheat-status-' + id);
                if (statusEl) statusEl.textContent = 'Saving…';
                saveTimeouts[field] = setTimeout(async () => {
                    try {
                        await updateCheat(selectedGameId, id, { [field]: value });
                        if (statusEl) statusEl.textContent = 'Saved';
                        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 1500);
                    } catch (err) {
                        if (statusEl) statusEl.textContent = 'Error';
                    }
                }, 400);
            }
            item.querySelectorAll('[data-field]').forEach(el => {
                el.addEventListener('input', () => {
                    let val;
                    if (el.type === 'checkbox') val = el.checked;
                    else val = el.value;
                    queueSave(el.dataset.field, val);
                });
                el.addEventListener('change', () => {
                    let val;
                    if (el.type === 'checkbox') val = el.checked;
                    else val = el.value;
                    queueSave(el.dataset.field, val);
                });
            });
            item.querySelector('.cheats-item-delete').addEventListener('click', async () => {
                if (!confirm('Delete this cheat?')) return;
                try {
                    await deleteCheat(selectedGameId, id);
                } catch (err) {
                    alert('Delete failed: ' + err.message);
                }
            });
        });
    }

    window.ArcadeCheats = {
        renderCheatsView,
        getEnabledCheatsForGame,
    };
})();
