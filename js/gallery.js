(function () {
    let db;
    const MAX_FILE_SIZE = 5 * 1024 * 1024;
    const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const MAX_DIMENSION = 800;
    const JPEG_QUALITY = 0.7;
    let galleryImages = [];
    let unsubGallery = null;
    let galleryActive = false;

    function init() {
        if (!db) db = ArcadeAuth.getDb();
    }

    function startGalleryListener() {
        if (unsubGallery) return;
        unsubGallery = db.collection('gallery').onSnapshot(() => {
            if (galleryActive) {
                loadGallery().then(() => {
                    buildGalleryHTML();
                });
            }
        }, () => {});
    }

    async function loadGallery() {
        init();
        try {
            // Approval flow was retired — all uploads show up immediately.
            // Auto-expiry was also retired (used to delete anything older
            // than 5 hours) since users wanted uploads to stick around.
            // Admins can still delete individual images; pin button survives
            // for consistency but doesn't affect visibility anymore.
            const snap = await db.collection('gallery').get();
            galleryImages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            // Sort: pinned first, then by date
            galleryImages.sort((a, b) => {
                if (a.pinned && !b.pinned) return -1;
                if (!a.pinned && b.pinned) return 1;
                const ta = a.createdAt?.toMillis?.() || 0;
                const tb = b.createdAt?.toMillis?.() || 0;
                return tb - ta;
            });
        } catch {
            galleryImages = [];
        }
    }

    function compressImage(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    let w = img.width;
                    let h = img.height;
                    if (w > MAX_DIMENSION || h > MAX_DIMENSION) {
                        if (w > h) {
                            h = Math.round(h * MAX_DIMENSION / w);
                            w = MAX_DIMENSION;
                        } else {
                            w = Math.round(w * MAX_DIMENSION / h);
                            h = MAX_DIMENSION;
                        }
                    }
                    canvas.width = w;
                    canvas.height = h;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, w, h);
                    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
                    resolve(dataUrl);
                };
                img.onerror = () => reject(new Error('Failed to load image'));
                img.src = e.target.result;
            };
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
        });
    }

    // Used to show "Xh Ym left" before the 5-hour auto-expiry kicked in.
    // That's gone now (images are kept until someone explicitly deletes
    // them), so this just returns a pinned marker or an uploaded-timestamp
    // humanization — no more countdown.
    function timeRemaining(img) {
        if (img.pinned) return 'Pinned';
        const created = img.createdAt?.toMillis?.() || 0;
        if (!created) return '';
        const s = Math.floor((Date.now() - created) / 1000);
        if (s < 60) return 'just now';
        if (s < 3600) return Math.floor(s / 60) + 'm ago';
        if (s < 86400) return Math.floor(s / 3600) + 'h ago';
        return Math.floor(s / 86400) + 'd ago';
    }

    async function renderGalleryView() {
        const container = document.getElementById('galleryView');
        if (!container) return;
        container.innerHTML = '<div class="users-loading">Loading gallery...</div>';

        await loadGallery();
        galleryActive = true;
        startGalleryListener();

        buildGalleryHTML();
    }

    function buildGalleryHTML() {
        const container = document.getElementById('galleryView');
        if (!container) return;

        const isAdmin = ArcadeAuth.isAdmin();
        const currentUid = ArcadeAuth.getUser()?.uid;

        let html = '<div class="gallery-panel">';
        html += `<div class="gallery-toolbar">
            <button class="gallery-upload-btn" id="galleryUploadBtn">Upload Image</button>
            <input type="file" id="galleryFileInput" accept="image/*" style="display:none;">
            <div class="upload-progress" id="uploadProgress" style="display:none;">
                <div class="upload-progress-bar" id="uploadBar"></div>
                <span id="uploadText">Uploading...</span>
            </div>
            <span class="gallery-note">Images stay up until someone deletes them.</span>
        </div>`;

        if (galleryImages.length === 0) {
            html += '<div class="gallery-empty">No images yet. Be the first to upload!</div>';
        } else {
            html += '<div class="gallery-grid">';
            for (const img of galleryImages) {
                const canDelete = isAdmin || img.uid === currentUid;
                const deleteBtn = canDelete ? `<button class="gallery-delete-btn" data-id="${esc(img.id)}">Delete</button>` : '';
                const pinBtn = isAdmin ? `<button class="gallery-pin-btn${img.pinned ? ' pinned' : ''}" data-id="${esc(img.id)}" title="${img.pinned ? 'Unpin' : 'Pin'}">&#128204;</button>` : '';
                const expiryText = timeRemaining(img);
                const expiryBadge = expiryText ? `<span class="gallery-expiry${img.pinned ? ' gallery-expiry-pinned' : ''}">${esc(expiryText)}</span>` : '';

                html += `<div class="gallery-card">
                    <div class="gallery-card-img-wrap">
                        <img src="${esc(img.url)}" alt="" loading="lazy" class="gallery-card-img" data-url="${esc(img.url)}">
                        ${pinBtn}
                    </div>
                    <div class="gallery-card-info">
                        <span class="gallery-card-user">${esc(img.username || 'unknown')}</span>
                        ${expiryBadge}
                        <div class="gallery-card-actions">
                            ${deleteBtn}
                        </div>
                    </div>
                </div>`;
            }
            html += '</div>';
        }

        html += '</div>';
        container.innerHTML = html;

        // Bind events
        document.getElementById('galleryUploadBtn')?.addEventListener('click', () => {
            document.getElementById('galleryFileInput')?.click();
        });

        document.getElementById('galleryFileInput')?.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            await uploadImage(file);
            e.target.value = '';
        });

        // Image click → lightbox
        container.querySelectorAll('.gallery-card-img').forEach(img => {
            img.addEventListener('click', () => showLightbox(img.dataset.url));
        });

        // Pin/unpin
        container.querySelectorAll('.gallery-pin-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = btn.dataset.id;
                const img = galleryImages.find(i => i.id === id);
                if (!img) return;
                try {
                    await db.collection('gallery').doc(id).update({ pinned: !img.pinned });
                } catch (err) { alert('Failed: ' + err.message); }
            });
        });

        container.querySelectorAll('.gallery-delete-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Delete this image?')) return;
                await deleteImage(btn.dataset.id);
            });
        });
    }

    async function uploadImage(file) {
        init();
        if (!ALLOWED_TYPES.includes(file.type)) {
            alert('Only JPEG, PNG, GIF, and WebP images are allowed.');
            return;
        }
        if (file.size > MAX_FILE_SIZE) {
            alert('Image must be under 5MB.');
            return;
        }

        const user = ArcadeAuth.getUser();
        if (!user) return;

        const progress = document.getElementById('uploadProgress');
        const bar = document.getElementById('uploadBar');
        const text = document.getElementById('uploadText');
        progress.style.display = 'flex';
        bar.style.width = '30%';
        text.textContent = 'Compressing...';

        try {
            const dataUrl = await compressImage(file);
            bar.style.width = '60%';
            text.textContent = 'Saving...';

            await db.collection('gallery').add({
                uid: user.uid,
                username: ArcadeAuth.getUsername(),
                url: dataUrl,
                // approved left as true — admin approval flow retired
                approved: true,
                pinned: false,
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            progress.style.display = 'none';
            bar.style.width = '0%';
        } catch (e) {
            progress.style.display = 'none';
            bar.style.width = '0%';
            alert('Upload failed: ' + e.message);
        }
    }

    async function deleteImage(imageId) {
        init();
        try {
            await db.collection('gallery').doc(imageId).delete();
        } catch (e) {
            alert('Delete failed: ' + e.message);
        }
    }

    function showLightbox(url) {
        const existing = document.getElementById('lightboxOverlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'lightbox-overlay';
        overlay.id = 'lightboxOverlay';
        overlay.innerHTML = `<img src="${esc(url)}" alt="">`;
        overlay.addEventListener('click', () => overlay.remove());
        document.body.appendChild(overlay);
    }

    function esc(s) {
        if (!s) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    window.ArcadeGallery = {
        renderGalleryView,
        loadGallery,
        uploadImage
    };
})();
