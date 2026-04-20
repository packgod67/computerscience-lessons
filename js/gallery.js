(function () {
    let db;
    const MAX_FILE_SIZE = 5 * 1024 * 1024;
    const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const MAX_DIMENSION = 800;
    const JPEG_QUALITY = 0.7;
    const EXPIRY_MS = 5 * 60 * 60 * 1000; // 5 hours
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

    function isExpired(img) {
        if (img.pinned) return false;
        const created = img.createdAt?.toMillis?.() || 0;
        if (!created) return false;
        return Date.now() - created > EXPIRY_MS;
    }

    async function cleanupExpired(images) {
        const expired = images.filter(img => isExpired(img));
        for (const img of expired) {
            try {
                await db.collection('gallery').doc(img.id).delete();
            } catch {}
        }
        return images.filter(img => !isExpired(img));
    }

    async function loadGallery() {
        init();
        try {
            // Approval flow was retired — all uploads show up immediately.
            const snap = await db.collection('gallery').get();
            const allImages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            // Clean up expired images and filter them out
            galleryImages = await cleanupExpired(allImages);
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

    function timeRemaining(img) {
        if (img.pinned) return 'Pinned';
        const created = img.createdAt?.toMillis?.() || 0;
        if (!created) return '';
        const remaining = EXPIRY_MS - (Date.now() - created);
        if (remaining <= 0) return 'Expired';
        const hours = Math.floor(remaining / 3600000);
        const mins = Math.floor((remaining % 3600000) / 60000);
        if (hours > 0) return `${hours}h ${mins}m left`;
        return `${mins}m left`;
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
            <span class="gallery-note">Images expire after 5 hours (unless pinned)</span>
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
