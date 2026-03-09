(function () {
    let db;
    let allEmojis = [];
    let emojisMap = {}; // name -> url
    let unsubEmojis = null;
    let pickerOpen = false;

    const EMOJI_SIZE = 64;
    const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB
    const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

    function getDb() {
        if (!db) db = ArcadeAuth.getDb();
        return db;
    }

    function esc(s) {
        if (!s) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    async function loadEmojis() {
        try {
            const snap = await getDb().collection('emojis').get();
            allEmojis = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            allEmojis.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            emojisMap = {};
            allEmojis.forEach(e => { emojisMap[e.name] = e.url; });
        } catch {
            allEmojis = [];
            emojisMap = {};
        }
    }

    function startListener() {
        if (unsubEmojis) return;
        unsubEmojis = getDb().collection('emojis').onSnapshot(() => {
            loadEmojis();
        }, () => {});
    }

    function replaceEmojis(escapedText) {
        if (allEmojis.length === 0) return escapedText;
        // Check if text is only emoji codes (with optional whitespace)
        const stripped = escapedText.replace(/:([a-zA-Z0-9_-]+):/g, (m, name) => emojisMap[name] ? '' : m).trim();
        const emojiOnly = stripped === '' && /:([a-zA-Z0-9_-]+):/.test(escapedText);
        const cls = emojiOnly ? 'emoji-inline emoji-jumbo' : 'emoji-inline';
        return escapedText.replace(/:([a-zA-Z0-9_-]+):/g, (match, name) => {
            const url = emojisMap[name];
            if (!url) return match;
            return `<img class="${cls}" src="${esc(url)}" alt=":${esc(name)}:" title=":${esc(name)}:">`;
        });
    }

    function compressEmoji(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = EMOJI_SIZE;
                    canvas.height = EMOJI_SIZE;
                    const ctx = canvas.getContext('2d');
                    // Draw centered/scaled to fit square
                    const scale = Math.min(EMOJI_SIZE / img.width, EMOJI_SIZE / img.height);
                    const w = img.width * scale;
                    const h = img.height * scale;
                    const x = (EMOJI_SIZE - w) / 2;
                    const y = (EMOJI_SIZE - h) / 2;
                    ctx.drawImage(img, x, y, w, h);
                    resolve(canvas.toDataURL('image/png'));
                };
                img.onerror = () => reject(new Error('Failed to load image'));
                img.src = e.target.result;
            };
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
        });
    }

    // ===== Admin: Manage Emojis Modal =====
    function showEmojiManagementModal() {
        closeModal();
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'emojiModal';

        let gridHtml = allEmojis.map(e => `
            <div class="emoji-manage-item">
                <img src="${esc(e.url)}" alt=":${esc(e.name)}:" title=":${esc(e.name)}:">
                <span class="emoji-manage-name">:${esc(e.name)}:</span>
                <button class="emoji-delete-btn" data-id="${esc(e.id)}" title="Delete">&times;</button>
            </div>`).join('');

        if (!gridHtml) gridHtml = '<p class="text-muted">No emojis yet. Upload one!</p>';

        overlay.innerHTML = `
            <div class="modal-box">
                <div class="modal-header">
                    <h2>Manage Emojis</h2>
                    <button class="modal-close" id="closeEmojiModal">&times;</button>
                </div>
                <div class="emoji-upload-form">
                    <input type="text" id="emojiName" placeholder="Emoji name (letters, numbers, _ -)" class="auth-input" maxlength="32">
                    <div class="emoji-upload-row">
                        <button class="auth-submit" id="emojiSelectFileBtn">Choose Image</button>
                        <input type="file" id="emojiFileInput" accept="image/*" style="display:none;">
                        <span class="emoji-file-label" id="emojiFileLabel">No file chosen</span>
                    </div>
                    <div class="emoji-preview-row" id="emojiPreviewRow" style="display:none;">
                        <img id="emojiPreviewImg" class="emoji-preview-img" alt="Preview">
                    </div>
                    <button class="auth-submit" id="emojiUploadBtn">Upload Emoji</button>
                </div>
                <div class="emoji-manage-grid" id="emojiGrid">${gridHtml}</div>
            </div>`;

        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
        document.getElementById('closeEmojiModal').addEventListener('click', closeModal);

        let selectedFile = null;

        document.getElementById('emojiSelectFileBtn').addEventListener('click', () => {
            document.getElementById('emojiFileInput').click();
        });

        document.getElementById('emojiFileInput').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            selectedFile = file;
            document.getElementById('emojiFileLabel').textContent = file.name;
            // Show preview
            try {
                const dataUrl = await compressEmoji(file);
                document.getElementById('emojiPreviewImg').src = dataUrl;
                document.getElementById('emojiPreviewRow').style.display = 'flex';
            } catch {
                document.getElementById('emojiPreviewRow').style.display = 'none';
            }
        });

        document.getElementById('emojiUploadBtn').addEventListener('click', async () => {
            const name = document.getElementById('emojiName').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
            if (!name) { alert('Enter a valid emoji name (letters, numbers, _ -)'); return; }
            if (!selectedFile) { alert('Choose an image file first.'); return; }
            if (!ALLOWED_TYPES.includes(selectedFile.type)) { alert('Only JPEG, PNG, GIF, and WebP allowed.'); return; }
            if (selectedFile.size > MAX_FILE_SIZE) { alert('Image must be under 1MB.'); return; }
            if (emojisMap[name]) { alert('An emoji with that name already exists.'); return; }

            try {
                const dataUrl = await compressEmoji(selectedFile);
                await getDb().collection('emojis').add({
                    name: name,
                    url: dataUrl,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp()
                });
                await loadEmojis();
                showEmojiManagementModal(); // Refresh modal
            } catch (e) {
                alert('Upload failed: ' + e.message);
            }
        });

        // Delete buttons
        document.getElementById('emojiGrid').addEventListener('click', async (e) => {
            const btn = e.target.closest('.emoji-delete-btn');
            if (!btn) return;
            if (!confirm('Delete this emoji?')) return;
            try {
                await getDb().collection('emojis').doc(btn.dataset.id).delete();
                await loadEmojis();
                showEmojiManagementModal();
            } catch (err) {
                alert('Delete failed: ' + err.message);
            }
        });
    }

    // ===== Emoji Picker Popup =====
    function renderEmojiPicker(containerEl, inputEl) {
        // Toggle
        const existing = document.getElementById('emojiPickerPopup');
        if (existing) { existing.remove(); pickerOpen = false; return; }

        if (allEmojis.length === 0) return;

        pickerOpen = true;
        const popup = document.createElement('div');
        popup.className = 'emoji-picker-popup';
        popup.id = 'emojiPickerPopup';

        let html = '<div class="emoji-picker-grid">';
        for (const e of allEmojis) {
            html += `<button class="emoji-picker-item" data-name="${esc(e.name)}" title=":${esc(e.name)}:"><img src="${esc(e.url)}" alt=":${esc(e.name)}:"></button>`;
        }
        html += '</div>';
        popup.innerHTML = html;

        containerEl.appendChild(popup);

        popup.addEventListener('click', (e) => {
            const item = e.target.closest('.emoji-picker-item');
            if (!item) return;
            const name = item.dataset.name;
            const pos = inputEl.selectionStart || inputEl.value.length;
            const before = inputEl.value.substring(0, pos);
            const after = inputEl.value.substring(pos);
            const insert = `:${name}:`;
            inputEl.value = before + insert + after;
            inputEl.focus();
            inputEl.selectionStart = inputEl.selectionEnd = pos + insert.length;
        });

        // Close on click outside
        setTimeout(() => {
            function closeHandler(e) {
                if (!popup.contains(e.target) && !e.target.closest('.emoji-picker-btn')) {
                    popup.remove();
                    pickerOpen = false;
                    document.removeEventListener('click', closeHandler);
                }
            }
            document.addEventListener('click', closeHandler);
        }, 0);
    }

    function closeModal() {
        document.getElementById('emojiModal')?.remove();
    }

    window.ArcadeEmojis = {
        loadEmojis,
        startListener,
        replaceEmojis,
        showEmojiManagementModal,
        renderEmojiPicker,
        getAllEmojis: () => allEmojis
    };
})();
