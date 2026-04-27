// Profile widgets — drag-to-place image AND text canvas on profiles.
//
// MODEL
//   profile.widgets = [{
//     id:   short string id,
//     type: 'image' | 'text',
//
//     // For type:'image':
//     src:  data:URL or http URL,
//
//     // For type:'text':
//     text:  '<= 200 chars',
//     color: '#fff',                        // CSS color
//     bg:    'none' | 'subtle' | 'solid',   // background style
//
//     // Position + size are stored as PERCENT of the canvas, not pixels,
//     // so widgets stay where you put them across screen sizes.
//     x: 0..100, y: 0..100,                 // top-left corner
//     w: 5..100, h: 5..100,                 // width/height as % of canvas
//     rot: -180..180,                       // optional rotation degrees
//     z:  0..999,                           // stack order
//   }]
//
// WHY PERCENT-BASED: phones are narrow, desktops are wide. A widget
// dragged to the corner on desktop should still be in the corner on
// mobile. Pixel coords would cluster widgets at the top-left on small
// screens.
//
// EDIT MODE
//   Owner sees a two-button toolbar (+ Image, Edit). Tapping Edit
//   toggles a flag that:
//     - Adds drag handles + resize corner + delete chip per widget
//     - Lets click-drag move them around inside the canvas bounds
//     - Saves to Firestore on mouseup (debounced, last write wins)
//
// READ MODE (visitors / when Edit is off)
//   No interaction; widgets render as static images.
//
// Firestore — uses the existing users/{uid}.widgets array via
// ArcadeAuth.updateProfile (which now whitelists `widgets`).

(function () {
    const CANVAS_ASPECT = 4 / 3;             // 4:3 canvas → roughly 480x360 on desktop
    const MAX_WIDGETS = 20;
    const MAX_IMAGE_KB = 200;                // post-compression cap
    const COMPRESSED_DIM = 320;              // longest side

    function uid() {
        return 'w' + Math.random().toString(36).slice(2, 9);
    }

    // ─── Mount ───────────────────────────────────────────────────────
    function mount(canvas, profile, isSelf) {
        // Store the live widget array on the canvas so multiple instances
        // (rare) don't collide.
        canvas._widgets = (Array.isArray(profile.widgets) ? profile.widgets : []).slice();
        canvas._isSelf = !!isSelf;
        canvas._editing = false;
        canvas._save = debouncedSave();

        // Set the canvas aspect ratio via inline style — keeps the
        // percent-based coordinates consistent.
        canvas.style.aspectRatio = String(CANVAS_ASPECT);

        renderAll(canvas);

        if (isSelf) {
            const addBtn = document.getElementById('profileWidgetAddImage');
            const addUrlBtn = document.getElementById('profileWidgetAddUrl');
            const addTextBtn = document.getElementById('profileWidgetAddText');
            const editBtn = document.getElementById('profileWidgetEditToggle');
            if (addBtn) addBtn.onclick = () => promptAddImage(canvas);
            if (addUrlBtn) addUrlBtn.onclick = () => promptAddImageUrl(canvas);
            if (addTextBtn) addTextBtn.onclick = () => promptAddText(canvas);
            if (editBtn) editBtn.onclick = () => {
                canvas._editing = !canvas._editing;
                editBtn.textContent = canvas._editing ? 'Done editing' : 'Edit';
                editBtn.classList.toggle('is-on', canvas._editing);
                renderAll(canvas);
            };
        }
    }

    function renderAll(canvas) {
        canvas.classList.toggle('is-editing', !!canvas._editing);
        // Build out the children
        canvas.innerHTML = '';
        if (!canvas._widgets.length && canvas._isSelf) {
            const empty = document.createElement('div');
            empty.className = 'profile-widgets-empty';
            empty.textContent = 'Tap "+ Image" to drop a photo, sticker, or meme. Drag to position, drag the corner to resize.';
            canvas.appendChild(empty);
        }
        // Sort by z so stacking order is predictable
        canvas._widgets.sort((a, b) => (a.z || 0) - (b.z || 0));
        for (const w of canvas._widgets) {
            canvas.appendChild(renderWidget(w, canvas));
        }
    }

    function renderWidget(w, canvas) {
        const el = document.createElement('div');
        el.className = 'profile-widget';
        el.dataset.id = w.id;
        el.style.left = w.x + '%';
        el.style.top = w.y + '%';
        el.style.width = w.w + '%';
        el.style.height = w.h + '%';
        el.style.zIndex = String(w.z || 1);
        if (w.rot) el.style.transform = `rotate(${w.rot}deg)`;

        if (w.type === 'image') {
            const img = document.createElement('img');
            img.src = w.src;
            img.alt = '';
            img.draggable = false;
            el.appendChild(img);
        } else if (w.type === 'text') {
            // Text widget: a span centered inside the absolute box. Color
            // + background style come from the widget's own fields. Font
            // size auto-fits via the box height (h% of canvas) so users
            // can resize via the corner handle and the text scales.
            el.classList.add('profile-widget-text');
            el.classList.add('profile-widget-text-bg-' + (w.bg || 'none'));
            const span = document.createElement('span');
            span.textContent = w.text || '';
            span.style.color = w.color || '#ffffff';
            el.appendChild(span);

            // In edit mode, double-click opens a prompt to change the
            // text. Single click is reserved for drag (handled below).
            if (canvas._editing) {
                el.addEventListener('dblclick', (ev) => {
                    ev.stopPropagation();
                    const next = prompt('Edit text (max 200 chars):', w.text || '');
                    if (next === null) return;
                    w.text = String(next).slice(0, 200);
                    span.textContent = w.text;
                    canvas._save(canvas._widgets);
                });
            }
        }

        if (canvas._editing) {
            // Drag handle covers the whole widget
            el.addEventListener('pointerdown', (ev) => startDrag(ev, w, el, canvas));
            // Delete chip
            const del = document.createElement('button');
            del.className = 'profile-widget-del';
            del.type = 'button';
            del.textContent = '×';
            del.addEventListener('pointerdown', (ev) => ev.stopPropagation());
            del.addEventListener('click', (ev) => {
                ev.stopPropagation();
                canvas._widgets = canvas._widgets.filter(x => x.id !== w.id);
                canvas._save(canvas._widgets);
                renderAll(canvas);
            });
            el.appendChild(del);
            // Resize handle (bottom-right)
            const resize = document.createElement('div');
            resize.className = 'profile-widget-resize';
            resize.addEventListener('pointerdown', (ev) => {
                ev.stopPropagation();
                startResize(ev, w, el, canvas);
            });
            el.appendChild(resize);
            // Rotate handle (top-right)
            const rot = document.createElement('button');
            rot.className = 'profile-widget-rot';
            rot.type = 'button';
            rot.textContent = '↻';
            rot.title = 'Rotate';
            rot.addEventListener('pointerdown', (ev) => ev.stopPropagation());
            rot.addEventListener('click', (ev) => {
                ev.stopPropagation();
                w.rot = ((w.rot || 0) + 15) % 360;
                el.style.transform = `rotate(${w.rot}deg)`;
                canvas._save(canvas._widgets);
            });
            el.appendChild(rot);
        }
        return el;
    }

    // ─── Drag / resize ───────────────────────────────────────────────
    function startDrag(ev, w, el, canvas) {
        ev.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const startX = ev.clientX, startY = ev.clientY;
        const origX = w.x, origY = w.y;
        // Bring to front
        const maxZ = canvas._widgets.reduce((m, x) => Math.max(m, x.z || 0), 0);
        w.z = maxZ + 1;
        el.style.zIndex = String(w.z);

        function move(e2) {
            const dx = (e2.clientX - startX) / rect.width * 100;
            const dy = (e2.clientY - startY) / rect.height * 100;
            w.x = clamp(origX + dx, 0, 100 - w.w);
            w.y = clamp(origY + dy, 0, 100 - w.h);
            el.style.left = w.x + '%';
            el.style.top = w.y + '%';
        }
        function up() {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            canvas._save(canvas._widgets);
        }
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }

    function startResize(ev, w, el, canvas) {
        ev.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const startX = ev.clientX, startY = ev.clientY;
        const origW = w.w, origH = w.h;

        function move(e2) {
            const dx = (e2.clientX - startX) / rect.width * 100;
            const dy = (e2.clientY - startY) / rect.height * 100;
            w.w = clamp(origW + dx, 5, 100 - w.x);
            w.h = clamp(origH + dy, 5, 100 - w.y);
            el.style.width = w.w + '%';
            el.style.height = w.h + '%';
        }
        function up() {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            canvas._save(canvas._widgets);
        }
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }

    function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

    // ─── Image upload + compression ──────────────────────────────────
    // "+ Image" goes straight to the OS file picker. Most users want
    // their own photos / memes / stickers, not a URL paste. The "+ URL"
    // button (separate, in the toolbar) handles the URL-paste path for
    // animated GIFs from giphy etc.
    function promptAddImage(canvas) {
        if (canvas._widgets.length >= MAX_WIDGETS) {
            alert('Max ' + MAX_WIDGETS + ' widgets per profile. Delete one first.');
            return;
        }
        openFilePicker(canvas);
    }
    function promptAddImageUrl(canvas) {
        if (canvas._widgets.length >= MAX_WIDGETS) {
            alert('Max ' + MAX_WIDGETS + ' widgets per profile. Delete one first.');
            return;
        }
        const url = prompt('Paste an image URL (jpg, png, gif, webp):', '');
        if (!url || !url.trim()) return;
        addWidget(canvas, { type: 'image', src: url.trim() });
    }

    // Text widget — single-prompt UX for now: type the text, hit OK.
    // Color / background style are pickable from a tiny inline modal
    // (kept simple — too many prompts in a row gets annoying).
    function promptAddText(canvas) {
        if (canvas._widgets.length >= MAX_WIDGETS) {
            alert('Max ' + MAX_WIDGETS + ' widgets per profile. Delete one first.');
            return;
        }
        showTextModal(canvas, null);
    }

    function showTextModal(canvas, existing) {
        // Tear down any prior instance
        const prior = document.getElementById('arcadeTextWidgetModal');
        if (prior) prior.remove();

        const overlay = document.createElement('div');
        overlay.id = 'arcadeTextWidgetModal';
        overlay.className = 'modal-overlay arcade-textwidget-overlay';
        overlay.innerHTML = `
            <div class="arcade-textwidget-modal">
                <button class="modal-close arcade-textwidget-close" type="button" aria-label="Close">&times;</button>
                <h3>${existing ? 'Edit text' : 'Add text widget'}</h3>
                <label class="arcade-textwidget-row">
                    <span>Text</span>
                    <textarea id="twText" maxlength="200" rows="3" placeholder="Anything you want to display"></textarea>
                </label>
                <label class="arcade-textwidget-row">
                    <span>Color</span>
                    <input type="color" id="twColor" value="#ffffff">
                </label>
                <label class="arcade-textwidget-row">
                    <span>Background</span>
                    <select id="twBg">
                        <option value="none">None (transparent)</option>
                        <option value="subtle">Subtle (semi-transparent)</option>
                        <option value="solid">Solid (matches color)</option>
                    </select>
                </label>
                <div class="arcade-textwidget-actions">
                    <button class="auth-submit-secondary" id="twCancel" type="button">Cancel</button>
                    <button class="auth-submit" id="twSave" type="button">${existing ? 'Save' : 'Add'}</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const txtEl = overlay.querySelector('#twText');
        const colEl = overlay.querySelector('#twColor');
        const bgEl = overlay.querySelector('#twBg');
        if (existing) {
            txtEl.value = existing.text || '';
            colEl.value = existing.color || '#ffffff';
            bgEl.value = existing.bg || 'none';
        }
        setTimeout(() => txtEl.focus(), 50);

        const close = () => overlay.remove();
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        overlay.querySelector('.arcade-textwidget-close').addEventListener('click', close);
        overlay.querySelector('#twCancel').addEventListener('click', close);
        overlay.querySelector('#twSave').addEventListener('click', () => {
            const text = (txtEl.value || '').slice(0, 200);
            if (!text.trim()) { close(); return; }
            const color = colEl.value || '#ffffff';
            const bg = bgEl.value || 'none';
            if (existing) {
                existing.text = text;
                existing.color = color;
                existing.bg = bg;
                canvas._save(canvas._widgets);
                renderAll(canvas);
            } else {
                // New widget — start a bit larger than image default since
                // text needs room to breathe.
                addWidget(canvas, { type: 'text', text, color, bg, w: 35, h: 12 });
            }
            close();
        });
    }

    function openFilePicker(canvas) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/png,image/jpeg,image/gif,image/webp';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.onchange = async () => {
            const file = input.files?.[0];
            input.remove();
            if (!file) return;
            try {
                const dataUrl = await compressImage(file);
                if (dataUrl.length / 1024 > MAX_IMAGE_KB * 1.4) {
                    if (!confirm('This image is large (' + Math.round(dataUrl.length / 1024) + ' KB). Add anyway?')) return;
                }
                addWidget(canvas, { type: 'image', src: dataUrl });
            } catch (e) {
                alert('Image upload failed: ' + (e?.message || e));
            }
        };
        input.click();
    }

    // Same approach as the gallery / emoji uploaders — draw to a
    // canvas at COMPRESSED_DIM longest side, export as JPEG q=0.85.
    // GIFs lose animation (we'd need gif.js to keep it; out of scope).
    function compressImage(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('read failed'));
            reader.onload = () => {
                const img = new Image();
                img.onerror = () => reject(new Error('decode failed'));
                img.onload = () => {
                    const longest = Math.max(img.width, img.height);
                    const scale = longest > COMPRESSED_DIM ? COMPRESSED_DIM / longest : 1;
                    const w = Math.round(img.width * scale);
                    const h = Math.round(img.height * scale);
                    const c = document.createElement('canvas');
                    c.width = w; c.height = h;
                    const ctx = c.getContext('2d');
                    ctx.drawImage(img, 0, 0, w, h);
                    // PNG preserves transparency for stickers/icons; JPEG
                    // is smaller for photos. Pick by source MIME.
                    const mime = (file.type === 'image/png' || file.type === 'image/webp') ? 'image/png' : 'image/jpeg';
                    resolve(c.toDataURL(mime, 0.85));
                };
                img.src = reader.result;
            };
            reader.readAsDataURL(file);
        });
    }

    function addWidget(canvas, partial) {
        const w = Object.assign({
            id: uid(),
            type: 'image',
            src: '',
            x: 30, y: 30,         // start near center-ish
            w: 35, h: 35,
            rot: 0,
            z: (canvas._widgets.reduce((m, x) => Math.max(m, x.z || 0), 0)) + 1,
        }, partial);
        canvas._widgets.push(w);
        canvas._save(canvas._widgets);
        // Force-enable edit mode so the user can immediately drag the
        // newly-added widget.
        canvas._editing = true;
        const editBtn = document.getElementById('profileWidgetEditToggle');
        if (editBtn) {
            editBtn.textContent = 'Done editing';
            editBtn.classList.add('is-on');
        }
        renderAll(canvas);
    }

    // ─── Save (debounced) ────────────────────────────────────────────
    function debouncedSave() {
        let t = null;
        return function (widgets) {
            clearTimeout(t);
            t = setTimeout(async () => {
                if (!window.ArcadeAuth?.updateProfile) return;
                try {
                    // Sanitize before saving — coerce types, drop unknown
                    // fields, hard-cap counts and field sizes. Text +
                    // image widgets share the position/size/rotation
                    // schema; the type field gates which subset of
                    // content fields are kept.
                    const sanitized = widgets.slice(0, MAX_WIDGETS).map(w => {
                        const isText = w.type === 'text';
                        const base = {
                            id: String(w.id || uid()).slice(0, 16),
                            type: isText ? 'text' : 'image',
                            x: clamp(Number(w.x) || 0, 0, 100),
                            y: clamp(Number(w.y) || 0, 0, 100),
                            w: clamp(Number(w.w) || 30, 5, 100),
                            h: clamp(Number(w.h) || 30, 5, 100),
                            rot: clamp(Number(w.rot) || 0, -360, 360),
                            z: clamp(Number(w.z) || 1, 0, 9999),
                        };
                        if (isText) {
                            base.text = String(w.text || '').slice(0, 200);
                            // Validate color is a hex string; fall back
                            // to white if the user passed garbage.
                            const c = String(w.color || '#ffffff');
                            base.color = /^#[0-9a-f]{3,8}$/i.test(c) ? c : '#ffffff';
                            base.bg = ['none', 'subtle', 'solid'].includes(w.bg) ? w.bg : 'none';
                        } else {
                            base.src = String(w.src || '').slice(0, 600000); // ~600 KB cap on data: URLs
                        }
                        return base;
                    });
                    await window.ArcadeAuth.updateProfile({ widgets: sanitized });
                } catch (e) {
                    console.warn('Failed to save widgets:', e);
                }
            }, 600);
        };
    }

    window.ArcadeProfileWidgets = { mount };
})();
