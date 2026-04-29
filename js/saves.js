// ===== Manual Save States =====
// Each user has a personal library of save files. They upload .sav / .state
// files, tag them with a game (optional), and re-download whenever they
// want. EmulatorJS already supports "Load State" from a local file, so
// the flow is:
//
//    1. Play, hit Emulator → Save State → file downloads to your computer
//    2. Come here, upload the file, label it, pick which game it's for
//    3. Later, download it from here and use Emulator → Load State
//
// Why manual? The original auto-save cloud system was scrapped because
// it (a) overwrote in-progress saves on load, and (b) states for DS/PSX
// games blow past Firestore's 1 MB per-doc limit. This manual version
// doesn't try to auto-sync — the user is in control.
//
// Schema — `user_saves/{id}`:
//   uid         string  owner
//   label       string  user-chosen name (<=120 chars)
//   gameId      string  optional, links to a game in games.json
//   gameTitle   string  cached title for display when gameId resolves
//   filename    string  original filename
//   mime        string  MIME type
//   size        number  bytes (the original, uncompressed)
//   dataUrl     string  base64 data URL (gzipped blob preferred, but the
//                       emulator-side tooling is split on gzip support —
//                       so we just store the raw bytes base64'd)
//   createdAt   server timestamp
//
// Firestore rule:
//   match /user_saves/{id} {
//     allow read, write: if request.auth != null
//       && request.auth.uid == resource.data.uid;
//     allow create: if request.auth != null
//       && request.auth.uid == request.resource.data.uid;
//   }
//
// Size cap: Firestore docs max out at 1 MB. GBA/SNES/GB saves are tiny
// (usually <64 KB), GBA/NDS save states are ~100-300 KB, PSX/DS states
// can be 500 KB-2 MB. We cap uploads at 900 KB raw to stay under the
// doc limit after base64 inflation.

(function () {
    let db = null;
    let saves = [];
    let unsub = null;
    let savesActive = false;
    let games = null;  // lazy-loaded games.json for the gameId picker

    const MAX_RAW_BYTES = 900 * 1024;  // 900 KB — leaves room for base64 overhead

    function getDb() {
        if (!db) db = ArcadeAuth.getDb();
        return db;
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function fmtSize(n) {
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1024 / 1024).toFixed(2) + ' MB';
    }

    function fmtTime(ms) {
        if (!ms) return '';
        const d = new Date(ms);
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    async function loadGames() {
        if (games) return games;
        try {
            const res = await fetch('games/games.json');
            games = await res.json();
        } catch { games = []; }
        return games;
    }

    // ─────────────────────────────────────────────────────────────

    async function renderSavesView() {
        const container = document.getElementById('savesView');
        if (!container) return;
        if (!ArcadeAuth.isLoggedIn()) {
            container.innerHTML = '<div class="saves-empty">Log in to upload save states.</div>';
            return;
        }
        container.innerHTML = '<div class="saves-loading">Loading your saves…</div>';

        savesActive = true;
        await loadGames();
        startListener();
        build(container);
    }

    function startListener() {
        if (unsub) return;
        const uid = ArcadeAuth.getUser()?.uid;
        if (!uid) return;
        unsub = getDb().collection('user_saves')
            .where('uid', '==', uid)
            .onSnapshot((snap) => {
                saves = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                if (savesActive) {
                    const container = document.getElementById('savesView');
                    if (container) build(container);
                }
            }, (err) => {
                console.warn('Saves listener error:', err);
                const container = document.getElementById('savesView');
                if (container) container.innerHTML = `<div class="saves-empty">Couldn't load saves: ${esc(err.message || err.code)}</div>`;
            });
    }

    function build(container) {
        // Sort newest first
        const sorted = [...saves].sort((a, b) => {
            const ta = a.createdAt?.toMillis?.() || 0;
            const tb = b.createdAt?.toMillis?.() || 0;
            return tb - ta;
        });

        container.innerHTML = `
            <div class="saves-panel">
                <div class="saves-header">
                    <h2>Your save states</h2>
                    <p class="saves-hint">
                        Download save states from any emulator (menu → Save State → exports a .state file) and upload them here.
                        Re-download later and use Load State to continue.
                        Max ${fmtSize(MAX_RAW_BYTES)} per file.
                    </p>
                </div>

                <form class="saves-upload" id="savesUploadForm">
                    <input type="file" id="savesFile" accept=".state,.sav,.srm,.ss0,.ss1,.ss2,.ss3,.ss4,.ss5,.ss6,.ss7,.ss8,.ss9,.fs0,.fs1,application/octet-stream" required>
                    <input type="text" id="savesLabel" class="auth-input" placeholder="Label (e.g. 'After Elite Four')" maxlength="120" required>
                    <div class="saves-game-picker" id="savesGamePicker">
                        <input type="text" id="savesGameSearch" class="auth-input saves-game-search" placeholder="Search a game to link (optional)" autocomplete="off">
                        <input type="hidden" id="savesGameId" value="">
                        <button type="button" class="saves-game-clear" id="savesGameClear" style="display:none;" title="Clear selection">&times;</button>
                        <div class="saves-game-dropdown" id="savesGameDropdown" hidden></div>
                    </div>
                    <label class="saves-thumb-row">
                        <span class="saves-thumb-label">Thumbnail (optional):</span>
                        <input type="file" id="savesThumb" accept="image/png,image/jpeg,image/webp">
                    </label>
                    <button type="submit" class="saves-upload-btn">Upload</button>
                </form>
                <div class="saves-upload-progress" id="savesProgress" style="display:none;"></div>

                <div class="saves-list" id="savesList">
                    ${sorted.length === 0
                        ? '<div class="saves-empty">No save states yet. Upload one above.</div>'
                        : sorted.map(renderSave).join('')}
                </div>
            </div>
        `;

        // Searchable game picker — type to filter, click a match to select.
        // Internal state: the hidden #savesGameId input holds the picked id;
        // #savesGameSearch shows the picked title for human confirmation.
        wireGamePicker();

        document.getElementById('savesUploadForm').addEventListener('submit', onUploadSubmit);

        container.querySelectorAll('.save-download').forEach(b => {
            b.addEventListener('click', () => {
                const id = b.dataset.id;
                const save = saves.find(s => s.id === id);
                if (save) downloadSave(save);
            });
        });
        container.querySelectorAll('.save-rename').forEach(b => {
            b.addEventListener('click', async () => {
                const id = b.dataset.id;
                const save = saves.find(s => s.id === id);
                if (!save) return;
                const label = prompt('New label:', save.label || '');
                if (label === null) return;
                try {
                    await getDb().collection('user_saves').doc(id).update({
                        label: label.trim().slice(0, 120),
                    });
                } catch (e) { alert('Rename failed: ' + e.message); }
            });
        });
        container.querySelectorAll('.save-delete').forEach(b => {
            b.addEventListener('click', async () => {
                if (!confirm('Delete this save? This cannot be undone.')) return;
                try {
                    await getDb().collection('user_saves').doc(b.dataset.id).delete();
                } catch (e) { alert('Delete failed: ' + e.message); }
            });
        });
    }

    function renderSave(s) {
        const created = s.createdAt?.toMillis?.();
        const gameLabel = s.gameTitle
            ? `<span class="save-game">${esc(s.gameTitle)}</span>`
            : (s.gameId ? `<span class="save-game">${esc(s.gameId)}</span>` : '');
        // Thumbnail: render the user-uploaded screenshot if present.
        // Helps recognize saves at a glance vs. a wall of "Save 1 / Save 2"
        // labels.
        const thumbHtml = s.thumbnail
            ? `<img class="save-thumb" src="${esc(s.thumbnail)}" alt="" loading="lazy">`
            : '<div class="save-thumb save-thumb-placeholder">\u{1F4BE}</div>';
        return `
            <div class="save-row">
                ${thumbHtml}
                <div class="save-info">
                    <div class="save-label">${esc(s.label || 'Unlabeled')}</div>
                    <div class="save-meta">
                        ${gameLabel}
                        <span class="save-filename">${esc(s.filename || '')}</span>
                        <span class="save-size">${esc(fmtSize(s.size || 0))}</span>
                        <span class="save-time">${esc(fmtTime(created))}</span>
                    </div>
                </div>
                <div class="save-actions">
                    <button class="save-download" data-id="${esc(s.id)}" title="Download">&#128229;</button>
                    <button class="save-rename" data-id="${esc(s.id)}" title="Rename">&#9998;</button>
                    <button class="save-delete" data-id="${esc(s.id)}" title="Delete">&times;</button>
                </div>
            </div>
        `;
    }

    // ─────────────────────────────────────────────────────────────
    // Game picker — searchable combo-box
    // ─────────────────────────────────────────────────────────────
    //
    // Replaces a 2,800-option <select> with a text-search input that
    // shows the top 12 matches as a dropdown. A hidden input holds the
    // picked game id so the existing onUploadSubmit reader (`.value` on
    // #savesGameId) keeps working.

    function wireGamePicker() {
        const searchInput = document.getElementById('savesGameSearch');
        const hiddenIdInput = document.getElementById('savesGameId');
        const clearBtn = document.getElementById('savesGameClear');
        const dropdown = document.getElementById('savesGameDropdown');
        if (!searchInput || !dropdown || !Array.isArray(games)) return;

        // Lowercased titles indexed once — avoids re-lowercasing every keystroke.
        const haystack = games.map(g => ({
            g,
            needle: (g.title || '').toLowerCase(),
        }));

        function renderResults(q) {
            const query = q.trim().toLowerCase();
            if (!query) { dropdown.hidden = true; dropdown.innerHTML = ''; return; }

            // Substring match + dumb scoring: prefix matches outrank mid-string
            // matches so "poke" surfaces Pokemon titles before "Chicken Poker".
            const hits = [];
            for (const { g, needle } of haystack) {
                if (!needle) continue;
                const idx = needle.indexOf(query);
                if (idx < 0) continue;
                hits.push({ g, score: idx === 0 ? 0 : idx + 1 });
                if (hits.length >= 60) break;  // cap scan for performance
            }
            hits.sort((a, b) => a.score - b.score || a.g.title.localeCompare(b.g.title));
            const top = hits.slice(0, 12);

            if (top.length === 0) {
                dropdown.innerHTML = `<div class="saves-game-dropdown-empty">No games match.</div>`;
                dropdown.hidden = false;
                return;
            }
            dropdown.innerHTML = top.map(({ g }) => `
                <button type="button" class="saves-game-option" data-id="${esc(g.id)}" data-title="${esc(g.title || '')}">
                    <span class="saves-game-option-title">${esc(g.title || '')}</span>
                    <span class="saves-game-option-cat">${esc(g.category || '')}</span>
                </button>
            `).join('');
            dropdown.hidden = false;
        }

        searchInput.addEventListener('input', () => {
            // Typing clears any previous selection so the hidden id doesn't
            // disagree with the visible text.
            if (hiddenIdInput.value) {
                hiddenIdInput.value = '';
                clearBtn.style.display = 'none';
            }
            renderResults(searchInput.value);
        });
        searchInput.addEventListener('focus', () => {
            if (searchInput.value.trim()) renderResults(searchInput.value);
        });
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                dropdown.hidden = true;
            } else if (e.key === 'Enter' && !dropdown.hidden) {
                // Pick the top result on Enter — lets keyboard users stay in flow.
                e.preventDefault();
                const first = dropdown.querySelector('.saves-game-option');
                if (first) first.click();
            }
        });

        dropdown.addEventListener('click', (e) => {
            const btn = e.target.closest('.saves-game-option');
            if (!btn) return;
            hiddenIdInput.value = btn.dataset.id;
            searchInput.value = btn.dataset.title;
            clearBtn.style.display = '';
            dropdown.hidden = true;
        });

        clearBtn.addEventListener('click', () => {
            hiddenIdInput.value = '';
            searchInput.value = '';
            clearBtn.style.display = 'none';
            dropdown.hidden = true;
            searchInput.focus();
        });

        // Close the dropdown when clicking anywhere outside the picker.
        document.addEventListener('click', (e) => {
            if (!e.target.closest('#savesGamePicker')) {
                dropdown.hidden = true;
            }
        });
    }

    // ─────────────────────────────────────────────────────────────

    async function onUploadSubmit(e) {
        e.preventDefault();
        const fileInput = document.getElementById('savesFile');
        const labelInput = document.getElementById('savesLabel');
        const gameSelect = document.getElementById('savesGameId');
        const progressEl = document.getElementById('savesProgress');

        const file = fileInput.files[0];
        const label = labelInput.value.trim().slice(0, 120);
        const gameId = gameSelect.value || '';

        if (!file) { alert('Pick a file'); return; }
        if (!label) { alert('Add a label'); return; }
        if (file.size > MAX_RAW_BYTES) {
            alert(`File too large (${fmtSize(file.size)}). Max is ${fmtSize(MAX_RAW_BYTES)} — states for bigger games (DS/PSX) can exceed this, sorry.`);
            return;
        }

        progressEl.style.display = 'block';
        progressEl.textContent = 'Reading file…';

        try {
            const dataUrl = await readAsDataURL(file);
            progressEl.textContent = 'Uploading…';

            // Resolve game title for display
            let gameTitle = '';
            if (gameId && Array.isArray(games)) {
                const hit = games.find(g => g.id === gameId);
                if (hit) gameTitle = hit.title || '';
            }

            // Optional thumbnail — captured to a small data URL so users
            // can recognize their saves at a glance. Compressed to
            // 320×180 max @ JPEG q=0.7 to keep doc size sane.
            let thumbnail = '';
            const thumbInput = document.getElementById('savesThumb');
            if (thumbInput && thumbInput.files && thumbInput.files[0]) {
                try {
                    thumbnail = await compressThumb(thumbInput.files[0], 320, 180, 0.7);
                } catch {}
            }

            await getDb().collection('user_saves').add({
                uid: ArcadeAuth.getUser().uid,
                label,
                gameId,
                gameTitle,
                filename: file.name.slice(0, 200),
                mime: file.type || 'application/octet-stream',
                size: file.size,
                dataUrl,
                thumbnail,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            });

            progressEl.textContent = 'Saved.';
            setTimeout(() => { progressEl.style.display = 'none'; }, 1500);
            fileInput.value = '';
            labelInput.value = '';
            // Reset the searchable picker — hidden id, visible search text,
            // and the × button. wireGamePicker() isn't called again here; we
            // just clear the three inputs it controls.
            gameSelect.value = '';
            const searchEl = document.getElementById('savesGameSearch');
            const clearBtn = document.getElementById('savesGameClear');
            if (searchEl) searchEl.value = '';
            if (clearBtn) clearBtn.style.display = 'none';
        } catch (err) {
            progressEl.textContent = 'Upload failed: ' + (err.message || 'unknown');
            setTimeout(() => { progressEl.style.display = 'none'; }, 4000);
        }
    }

    function readAsDataURL(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = () => reject(new Error('Failed to read file'));
            r.readAsDataURL(file);
        });
    }

    // Compress an image file to a data URL fitting within maxW×maxH.
    // Used for save-state thumbnails — small (320×180) JPEGs typically
    // come out under 20 KB so they don't blow up the user_saves doc.
    function compressThumb(file, maxW, maxH, quality) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const img = new Image();
                img.onload = () => {
                    let w = img.width, h = img.height;
                    if (w > maxW || h > maxH) {
                        const scale = Math.min(maxW / w, maxH / h);
                        w = Math.round(w * scale);
                        h = Math.round(h * scale);
                    }
                    const c = document.createElement('canvas');
                    c.width = w; c.height = h;
                    c.getContext('2d').drawImage(img, 0, 0, w, h);
                    resolve(c.toDataURL('image/jpeg', quality));
                };
                img.onerror = () => reject(new Error('decode failed'));
                img.src = reader.result;
            };
            reader.onerror = () => reject(new Error('read failed'));
            reader.readAsDataURL(file);
        });
    }

    function downloadSave(save) {
        // The dataUrl is base64 — turn it back into a Blob and trigger a
        // download. Using a real Blob + createObjectURL so the filename
        // shows up correctly in the Save As dialog.
        const [meta, b64] = (save.dataUrl || '').split(',', 2);
        if (!b64) { alert("Can't download — file data is missing."); return; }
        try {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const mime = (meta && meta.match(/data:([^;]+)/)?.[1]) || (save.mime || 'application/octet-stream');
            const blob = new Blob([bytes], { type: mime });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = save.filename || 'save.bin';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
        } catch (e) {
            alert('Download failed: ' + e.message);
        }
    }

    window.ArcadeSaves = {
        renderSavesView,
    };
})();
