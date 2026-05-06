// AI image generator — uses pollinations.ai (free, no auth, CORS-open)
// to produce images from a text prompt directly inside the arcade.
//
// Endpoint:
//   GET https://image.pollinations.ai/prompt/<urlEncodedText>
//        ?model=<flux|flux-realism|flux-anime|flux-3d|turbo|gptimage>
//        &width=1024&height=1024&seed=<int>&nologo=true
//
// Returns image/jpeg. The response is heavily cached at the Pollinations
// CDN keyed by URL — same prompt/model/seed always returns the same
// image. Different seeds give variations.
//
// Save-to-gallery uses the existing ArcadeGallery system so generations
// the user wants to keep show up alongside other gallery uploads.

(function () {
    const MODELS = [
        { id: 'flux',           label: 'Flux (default, sharp + photorealistic)' },
        { id: 'flux-realism',   label: 'Flux Realism (more photoreal)' },
        { id: 'flux-anime',     label: 'Flux Anime' },
        { id: 'flux-3d',        label: 'Flux 3D' },
        { id: 'turbo',          label: 'Turbo (fast, lower quality)' },
        { id: 'gptimage',       label: 'GPT Image (DALL-E style)' },
    ];

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function buildUrl({ prompt, model, width, height, seed }) {
        const params = new URLSearchParams();
        if (model)  params.set('model', model);
        if (width)  params.set('width', String(width));
        if (height) params.set('height', String(height));
        if (seed)   params.set('seed', String(seed));
        params.set('nologo', 'true');
        return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;
    }

    function renderAigenView() {
        const container = document.getElementById('aigenView');
        if (!container) return;

        container.innerHTML = `
            <div class="aigen-panel">
                <div class="aigen-header">
                    <h2>\u{1F3A8} AI Image Generator</h2>
                    <p class="aigen-help">Type what you want and hit Generate. Free, unlimited, runs through Pollinations.ai's Flux model.</p>
                </div>
                <div class="aigen-form">
                    <textarea id="aigenPrompt" class="aigen-prompt" maxlength="800"
                        placeholder="A neon-lit cat playing piano in a Tokyo alley at night, cinematic"></textarea>
                    <div class="aigen-form-row">
                        <label>Model
                            <select id="aigenModel">
                                ${MODELS.map(m => `<option value="${m.id}">${m.label}</option>`).join('')}
                            </select>
                        </label>
                        <label>Width
                            <input type="number" id="aigenWidth" value="1024" min="256" max="2048" step="64">
                        </label>
                        <label>Height
                            <input type="number" id="aigenHeight" value="1024" min="256" max="2048" step="64">
                        </label>
                        <label>Seed
                            <input type="number" id="aigenSeed" placeholder="random">
                        </label>
                    </div>
                    <div class="aigen-form-row">
                        <button class="auth-submit" id="aigenGenBtn">Generate</button>
                        <button class="auth-submit-secondary" id="aigenRandomSeedBtn" title="Reroll with a new random seed">\u{1F3B2} Reroll</button>
                    </div>
                </div>
                <div class="aigen-result" id="aigenResult"></div>
                <div class="aigen-history" id="aigenHistory"></div>
            </div>
        `;

        const promptEl = container.querySelector('#aigenPrompt');
        const modelEl  = container.querySelector('#aigenModel');
        const widthEl  = container.querySelector('#aigenWidth');
        const heightEl = container.querySelector('#aigenHeight');
        const seedEl   = container.querySelector('#aigenSeed');
        const resultEl = container.querySelector('#aigenResult');
        const historyEl = container.querySelector('#aigenHistory');

        // Restore last prompt from localStorage so the field survives
        // tab switches.
        try {
            const saved = JSON.parse(localStorage.getItem('arcade-aigen-state') || '{}');
            if (saved.prompt) promptEl.value = saved.prompt;
            if (saved.model)  modelEl.value  = saved.model;
            if (saved.width)  widthEl.value  = saved.width;
            if (saved.height) heightEl.value = saved.height;
        } catch {}

        function persistState() {
            try {
                localStorage.setItem('arcade-aigen-state', JSON.stringify({
                    prompt: promptEl.value,
                    model:  modelEl.value,
                    width:  widthEl.value,
                    height: heightEl.value,
                }));
            } catch {}
        }
        [promptEl, modelEl, widthEl, heightEl].forEach(el => el.addEventListener('input', persistState));

        // ─── History (last 12 generations, in localStorage) ──────
        function loadHistory() {
            try { return JSON.parse(localStorage.getItem('arcade-aigen-history') || '[]'); }
            catch { return []; }
        }
        function saveHistory(items) {
            try { localStorage.setItem('arcade-aigen-history', JSON.stringify(items.slice(0, 12))); } catch {}
        }
        function pushHistory(entry) {
            const items = loadHistory();
            items.unshift(entry);
            saveHistory(items);
            renderHistory();
        }
        function renderHistory() {
            const items = loadHistory();
            if (!items.length) { historyEl.innerHTML = ''; return; }
            historyEl.innerHTML = `
                <h3 class="aigen-history-title">Recent generations</h3>
                <div class="aigen-history-grid">
                    ${items.map(e => `
                        <a class="aigen-history-tile" href="${esc(e.url)}" target="_blank" rel="noopener" title="${esc(e.prompt)}">
                            <img src="${esc(e.url)}" alt="${esc(e.prompt.slice(0, 40))}" loading="lazy">
                            <span class="aigen-history-prompt">${esc(e.prompt.slice(0, 60))}${e.prompt.length > 60 ? '…' : ''}</span>
                        </a>
                    `).join('')}
                </div>
            `;
        }
        renderHistory();

        // ─── Generate ────────────────────────────────────────────
        async function generate() {
            const prompt = promptEl.value.trim();
            if (!prompt) {
                alert('Type a prompt first.');
                return;
            }
            const url = buildUrl({
                prompt,
                model:  modelEl.value,
                width:  Number(widthEl.value)  || 1024,
                height: Number(heightEl.value) || 1024,
                seed:   seedEl.value ? Number(seedEl.value) : undefined,
            });
            const startedAt = Date.now();
            resultEl.innerHTML = `
                <div class="aigen-loading">
                    <div class="aigen-spinner"></div>
                    <div>Generating… (Pollinations Flux can take 5-30s)</div>
                </div>
            `;

            // Pre-fetch the image so we can show real progress + handle
            // errors before the <img> tag tries the URL itself.
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
                resultEl.innerHTML = `
                    <div class="aigen-image-wrap">
                        <img class="aigen-image" src="${esc(url)}" alt="${esc(prompt)}">
                        <div class="aigen-image-meta">
                            <span><strong>${esc(modelEl.value)}</strong> · ${esc(widthEl.value)}×${esc(heightEl.value)} · ${elapsed}s</span>
                            <div class="aigen-image-actions">
                                <a class="auth-submit-secondary" href="${esc(url)}" download="aigen-${Date.now()}.jpg" target="_blank">Download</a>
                                <button class="auth-submit-secondary" id="aigenSaveGalleryBtn">Save to gallery</button>
                                <button class="auth-submit-secondary" id="aigenCopyPromptBtn">Copy URL</button>
                            </div>
                        </div>
                    </div>
                `;
                pushHistory({ prompt, url, model: modelEl.value });

                document.getElementById('aigenSaveGalleryBtn')?.addEventListener('click', async () => {
                    if (!window.ArcadeAuth?.isLoggedIn?.()) {
                        alert('Sign in to save to your gallery.');
                        return;
                    }
                    if (!window.ArcadeGallery?.uploadFromUrl) {
                        alert('Gallery system not loaded.');
                        return;
                    }
                    try {
                        await window.ArcadeGallery.uploadFromUrl(url, prompt);
                        alert('Saved to gallery.');
                    } catch (e) {
                        alert('Save failed: ' + e.message);
                    }
                });
                document.getElementById('aigenCopyPromptBtn')?.addEventListener('click', () => {
                    navigator.clipboard?.writeText(url);
                    const btn = document.getElementById('aigenCopyPromptBtn');
                    if (btn) {
                        const old = btn.textContent;
                        btn.textContent = 'Copied!';
                        setTimeout(() => { btn.textContent = old; }, 1200);
                    }
                });
            };
            img.onerror = () => {
                resultEl.innerHTML = `<div class="aigen-error">Generation failed. Pollinations.ai may be busy — try again, or pick a different model.</div>`;
            };
            img.src = url;
        }

        container.querySelector('#aigenGenBtn').addEventListener('click', generate);
        container.querySelector('#aigenRandomSeedBtn').addEventListener('click', () => {
            seedEl.value = Math.floor(Math.random() * 1_000_000);
            generate();
        });
        // Submit on Enter inside the prompt textarea (Ctrl+Enter actually,
        // since plain Enter in a textarea is for newlines)
        promptEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                generate();
            }
        });
    }

    window.ArcadeAigen = { renderAigenView };
})();
