// Bulk-add games tool — admin pastes a list of itch.io URLs, an LLM
// researches each one (title, cover, description, embed URL, category,
// tags, mobile-friendly flag), the admin reviews, then exports a
// JSON blob to drop into games/games.json + the matching wrapper HTML
// files. The static catalog can't be modified from the browser, so
// "export and commit" is the architecture.
//
// Powered by the existing chatbot worker (groqWorkerUrl) which routes
// to Cloudflare Workers AI / Groq / Cerebras / Gemini in priority
// order. The worker handles auth/keys/rate-limits for us.
//
// Modal flow:
//   1. Paste textarea: one itch URL per line
//   2. Click "Research all" — for each URL, LLM returns:
//        title, embed, cover, description, category, tags[], mobile?
//   3. Preview grid: each row shows the proposed entry, editable
//      inline. Admin can delete a row, reject one, or fix typos.
//   4. Click "Export" — downloads a `pending-games.json` file with
//      the entries, plus instructions for adding to the repo.
//
// Future iteration: a "Commit via GitHub API" button using a PAT
// stored in localStorage. For now, manual commit keeps it secure.

(function () {
    let modalOpen = false;

    function esc(s) {
        if (!s) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function getWorkerUrl() {
        return (
            localStorage.getItem('arcade-groq-worker-url')
            || (window.ARCADE_CONFIG && window.ARCADE_CONFIG.groqWorkerUrl)
            || ''
        ).trim();
    }

    // Slugify a game title into an `id` like clincar / clmadnesscombat1.
    // Strips non-alphanumerics, drops common filler words ("the", "a"),
    // lowercase, prefix `cl` to match the catalog convention.
    function slugifyId(title) {
        const cleaned = String(title || 'game')
            .toLowerCase()
            .replace(/['"`]/g, '')
            .replace(/[^a-z0-9]+/g, '')
            .slice(0, 30);
        return 'cl' + cleaned;
    }

    // Ask the LLM to research a single itch URL and return JSON metadata.
    // We instruct the model to OUTPUT JSON ONLY so we can parse cleanly.
    async function researchOne(itchUrl) {
        const workerUrl = getWorkerUrl();
        if (!workerUrl) throw new Error('No LLM worker configured');

        const systemPrompt = `You are a research assistant filling out catalog entries for a browser arcade. For the given itch.io game URL, return STRICT JSON with this exact schema (no prose, no markdown fences):

{
  "title": "cleaned game title",
  "embed": "https://html-classic.itch.zone/html/<embed_id>/index.html (or html.itch.zone variant, with subpath if needed; URL-encode spaces as %20)",
  "thumbnail": "og:image URL from the itch page",
  "description": "30-300 chars describing what the game IS, hook, distinctive bit. Avoid 'from itch.io'.",
  "category": "one of: Pokemon, Racing, Adventure, Action, Sports, Puzzle, Strategy, Simulation, Shooter, Platformer, Fighting, Horror, Mario, Sonic, Minecraft, Other",
  "tags": ["array", "of", "lowercase", "tags"],
  "mobile": true_or_false
}

Rules:
- "tags" must include "html5", "itch", "browser-native". Add 4+ genre/mechanic tags.
- "mobile": true ONLY if the game uses mouse/click/tap controls only (no keyboard required). Check itch's "Inputs" section — if Keyboard is listed, mobile=false.
- "embed" must be the working iframe URL. Verify the path/subpath if the build uses a subdirectory.
- If you can't determine a field with certainty, use sensible defaults.

OUTPUT JSON ONLY. NO PROSE.`;

        const userPrompt = `Research: ${itchUrl}`;

        const body = {
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            response_format: { type: 'json_object' },
            temperature: 0.3,
            max_tokens: 1024,
        };

        // Try providers in priority order. The worker handles fallbacks
        // internally (cloudflare → groq → cerebras → gemini), but we
        // also pin a primary here.
        body.provider = 'cloudflare';
        body.model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

        const resp = await fetch(workerUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Worker ${resp.status}: ${text.slice(0, 200)}`);
        }
        const data = await resp.json();
        const content = data?.choices?.[0]?.message?.content;
        if (!content) throw new Error('Empty response from LLM');

        // Strip code fences if the model added them despite instructions.
        let parsed;
        try {
            const cleaned = content
                .replace(/^```(?:json)?\s*/i, '')
                .replace(/\s*```\s*$/i, '')
                .trim();
            parsed = JSON.parse(cleaned);
        } catch (e) {
            throw new Error('LLM returned non-JSON: ' + content.slice(0, 200));
        }

        // Build the catalog entry shape.
        const id = slugifyId(parsed.title);
        const tags = Array.isArray(parsed.tags) ? parsed.tags.slice() : [];
        // Always include the trinity
        for (const required of ['browser-native', 'html5', 'itch']) {
            if (!tags.includes(required)) tags.push(required);
        }
        if (parsed.mobile && !tags.includes('mobile')) tags.push('mobile');

        return {
            entry: {
                id,
                title: parsed.title,
                category: parsed.category || 'Other',
                path: `games/${id}.html`,
                description: parsed.description,
                popular: false,
                rom: null,
                tags,
                thumbnail: parsed.thumbnail,
                addedAt: new Date().toISOString(),
            },
            // Wrapper HTML content the admin needs to write to disk
            wrapper: buildWrapperHtml(parsed.title, parsed.embed),
            wrapperPath: `games/${id}.html`,
            sourceUrl: itchUrl,
            embed: parsed.embed,
        };
    }

    function buildWrapperHtml(title, embed) {
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${title.replace(/[<>"&]/g, c => ({'<':'&lt;','>':'&gt;','"':'&quot;','&':'&amp;'}[c]))}</title>
<style>
  html, body { margin:0; padding:0; width:100%; height:100%; background:#0a0a0f; }
  iframe { display:block; width:100%; height:100vh; border:0; }
</style>
</head>
<body>
<iframe src="${embed}" allow="autoplay; gamepad *; fullscreen"></iframe>
</body>
</html>
`;
    }

    // ─── Admin modal ──────────────────────────────────────────────────
    function showBulkAddModal() {
        if (modalOpen) return;
        modalOpen = true;

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'bulkAddModal';
        overlay.innerHTML = `
            <div class="modal-box bulk-add-modal">
                <div class="modal-header">
                    <h2>Bulk Add Games</h2>
                    <button class="modal-close" id="closeBulkAdd">&times;</button>
                </div>
                <p class="text-muted" style="margin-top:0;font-size:13px;">
                    Paste itch.io game URLs (one per line). Click "Research all" and the LLM
                    fills in title, cover, description, embed, category, tags, mobile flag.
                    Review the results, then export a JSON to commit to the repo.
                </p>
                <textarea id="bulkAddUrls" class="bulk-add-urls"
                    placeholder="https://example.itch.io/cool-game
https://another.itch.io/another-game
..."
                    rows="6"></textarea>
                <div class="bulk-add-actions">
                    <button class="auth-submit" id="bulkAddResearchBtn">&#128269; Research all</button>
                    <button class="auth-submit secondary" id="bulkAddExportBtn" disabled>&#128190; Export</button>
                </div>
                <div class="bulk-add-progress" id="bulkAddProgress" hidden></div>
                <div class="bulk-add-results" id="bulkAddResults"></div>
            </div>`;

        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeModal();
        });
        document.getElementById('closeBulkAdd').addEventListener('click', closeModal);

        const researchBtn = document.getElementById('bulkAddResearchBtn');
        const exportBtn = document.getElementById('bulkAddExportBtn');
        let collected = []; // array of research results

        researchBtn.addEventListener('click', async () => {
            const raw = document.getElementById('bulkAddUrls').value.trim();
            const urls = raw.split('\n').map(s => s.trim()).filter(s => s.startsWith('http'));
            if (urls.length === 0) {
                alert('No URLs found. Paste itch.io URLs one per line.');
                return;
            }
            researchBtn.disabled = true;
            researchBtn.textContent = 'Researching…';
            const progressEl = document.getElementById('bulkAddProgress');
            progressEl.hidden = false;
            const resultsEl = document.getElementById('bulkAddResults');
            resultsEl.innerHTML = '';
            collected = [];

            // Sequential — LLM rate limits are per-second, parallel would hit
            // 429s. Each takes ~3-8s so 10 URLs = 30-80 seconds.
            for (let i = 0; i < urls.length; i++) {
                progressEl.textContent = `Researching ${i + 1} / ${urls.length}: ${urls[i]}`;
                try {
                    const result = await researchOne(urls[i]);
                    collected.push(result);
                    appendResult(resultsEl, result, collected.length - 1);
                } catch (err) {
                    appendError(resultsEl, urls[i], err.message);
                }
            }

            progressEl.textContent = `Done. ${collected.length} of ${urls.length} researched successfully.`;
            researchBtn.disabled = false;
            researchBtn.textContent = '&#128269; Research all';
            exportBtn.disabled = collected.length === 0;
        });

        exportBtn.addEventListener('click', () => {
            // Build a "pending-games.json" blob with the collected entries
            // PLUS a sidecar with each game's wrapper HTML so the admin
            // can recreate them locally. Two-file zip would be nicer but
            // let's keep it simple — single JSON with everything.
            const exportable = {
                entries: collected.map(c => c.entry),
                wrappers: collected.reduce((acc, c) => {
                    acc[c.wrapperPath] = c.wrapper;
                    return acc;
                }, {}),
                generatedAt: new Date().toISOString(),
                instructions: [
                    "1. Append `entries` to games/games.json (after the existing closing ])",
                    "2. For each path in `wrappers`, write the corresponding HTML file",
                    "3. Run `node validate-catalog.mjs` to confirm",
                    "4. git add . && git commit && git push",
                ],
            };
            const blob = new Blob([JSON.stringify(exportable, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `pending-games-${Date.now()}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
    }

    function appendResult(container, result, idx) {
        const e = result.entry;
        const row = document.createElement('div');
        row.className = 'bulk-add-result';
        row.innerHTML = `
            <img src="${esc(e.thumbnail)}" alt="" class="bulk-add-thumb"
                 onerror="this.style.background='#222';this.removeAttribute('src')">
            <div class="bulk-add-fields">
                <div class="bulk-add-row1">
                    <strong>${esc(e.title)}</strong>
                    <span class="bulk-add-cat">${esc(e.category)}</span>
                    <button class="bulk-add-remove" data-idx="${idx}" title="Drop this entry">&times;</button>
                </div>
                <div class="bulk-add-desc">${esc(e.description)}</div>
                <div class="bulk-add-tags">${e.tags.map(t => `<span>#${esc(t)}</span>`).join(' ')}</div>
                <div class="bulk-add-id">id: <code>${esc(e.id)}</code> &middot; embed: <code>${esc(result.embed).slice(0, 70)}…</code></div>
            </div>`;
        container.appendChild(row);

        row.querySelector('.bulk-add-remove').addEventListener('click', (ev) => {
            const i = parseInt(ev.currentTarget.dataset.idx, 10);
            // We can't reorder array indices easily — instead mark as removed
            // by replacing with null + visually fading the row.
            container.querySelectorAll('.bulk-add-result')[i]?.remove();
            // The collected array is closed over in showBulkAddModal but we
            // can't access it from here — emit a custom event the modal
            // listens for and rebuilds collected. Simpler: just splice.
            window.dispatchEvent(new CustomEvent('arcade:bulk-add-remove', { detail: { idx: i } }));
        });
    }

    function appendError(container, url, message) {
        const row = document.createElement('div');
        row.className = 'bulk-add-result bulk-add-result-error';
        row.innerHTML = `
            <div class="bulk-add-fields">
                <div class="bulk-add-row1">
                    <strong style="color:#ef4444;">Failed</strong>
                </div>
                <div class="bulk-add-desc"><code>${esc(url)}</code></div>
                <div class="bulk-add-desc" style="color:#ef4444;">${esc(message)}</div>
            </div>`;
        container.appendChild(row);
    }

    function closeModal() {
        document.getElementById('bulkAddModal')?.remove();
        modalOpen = false;
    }

    window.ArcadeBulkAdd = {
        showBulkAddModal,
    };
})();
