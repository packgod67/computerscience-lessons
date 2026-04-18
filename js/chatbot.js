// ===== Kirky — the arcade's chat assistant =====
// Floating bottom-right bubble that opens a chat panel. Powered by the same
// LLM providers as the recommender (Groq via the admin's Cloudflare Worker
// first, pollinations.ai as fallback), but with a full conversational
// history and inline game-card replies.
//
// Kirky stays in character: friendly, concise, arcade-focused. Recommends
// games from the user's conversation context — handles follow-ups like
// "show me harder ones" or "now something relaxing" naturally because
// the full history is sent to the model each turn.

(function () {
    const KIRKY_ICON = 'assets/kirky.jpg';       // drop your portrait here
    const KIRKY_FALLBACK = 'assets/logo.png';    // used if kirky.jpg fails to load
    const STORAGE_KEY = 'arcade-kirky-history';
    const MAX_HISTORY = 20;                      // cap context size

    let panel = null;
    let trigger = null;
    let messages = [];                           // [{ role, content, games? }]
    let games = [];
    let gamesLoaded = false;
    let lastProvider = null;                     // 'groq' | 'pollinations'

    // ---------------------------------------------------------------
    // Helpers shared with the recommender
    // ---------------------------------------------------------------

    async function loadGames() {
        if (gamesLoaded) return games;
        try {
            const res = await fetch('games/games.json');
            games = await res.json();
            gamesLoaded = true;
        } catch { games = []; }
        return games;
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Extract negation targets from a user query: "like pokemon but not
    // pokemon" → { positive: "like pokemon", negative: ["pokemon"] }
    const NEGATION_RE = /(?:\bnot\b|\bno\b|\bexcept\b|\bwithout\b|\bbut\s+not\b)\s+([a-z][a-z0-9\s-]*?)(?=[.,;!?]|\s+(?:and|or|with|but|please|thanks)\b|$)/gi;
    function parseNegations(q) {
        const negatives = [];
        const matches = q.matchAll(NEGATION_RE);
        for (const m of matches) {
            const phrase = m[1].trim().toLowerCase();
            if (phrase.length >= 2 && phrase.length <= 30) {
                // split multi-word phrase into individual tokens for tag checks
                negatives.push(phrase);
                for (const w of phrase.split(/\s+/)) {
                    if (w.length >= 3) negatives.push(w);
                }
            }
        }
        return negatives;
    }

    // Build a candidate pool for the LLM. Uses the recommender's tag-inference
    // where available, filters out negation matches, and gracefully falls back
    // when queries are vague (conversational turns like "hi").
    function candidatePool(userText, limit) {
        const q = (userText || '').toLowerCase();
        const negatives = parseNegations(q);

        // If the recommender is loaded, use its parsing + scoring
        const R = window.ArcadeRecommender;
        let pool = [];

        if (R && R.parseQuery && R.scoreGame) {
            const parsed = R.parseQuery(q);
            // 1) Score every game against the parsed query
            const scored = [];
            for (const g of games) {
                const s = R.scoreGame(g, parsed);
                if (s.score > 0) scored.push({ g, s: s.score });
            }
            // 2) Also boost-include games whose tags match any inferred tag,
            //    so we guarantee tag-representative candidates even if their
            //    score is low. This is what surfaces Digimon/Persona when the
            //    user asks for "games like pokemon but not pokemon".
            const wantedTagSet = new Set(parsed.tags || []);
            if (wantedTagSet.size > 0) {
                const inPool = new Set(scored.map(x => x.g.id));
                for (const g of games) {
                    if (inPool.has(g.id)) continue;
                    const gt = g.tags || [];
                    if (gt.some(t => wantedTagSet.has(t))) {
                        scored.push({ g, s: 2 });
                        inPool.add(g.id);
                    }
                }
            }
            scored.sort((a, b) => b.s - a.s);
            pool = scored.map(x => x.g);
        } else {
            // Ultra-fallback: just return popular games
            pool = games.filter(g => g.popular);
        }

        // 3) Apply negations — drop anything matching "but not X"
        if (negatives.length > 0) {
            pool = pool.filter(g => {
                const hay = ((g.title || '') + ' ' + (g.category || '') + ' '
                    + (g.tags || []).join(' ')).toLowerCase();
                for (const n of negatives) {
                    if (hay.includes(n)) return false;
                }
                return true;
            });
        }

        // 4) If pool is tiny, top up with popular games for diversity
        if (pool.length < 8) {
            const have = new Set(pool.map(g => g.id));
            for (const g of games) {
                if (have.has(g.id)) continue;
                if (!g.popular) continue;
                // Respect negations on the fallback too
                if (negatives.length > 0) {
                    const hay = ((g.title || '') + ' ' + (g.tags || []).join(' ')).toLowerCase();
                    if (negatives.some(n => hay.includes(n))) continue;
                }
                pool.push(g);
                have.add(g.id);
                if (pool.length >= limit) break;
            }
        }

        return pool.slice(0, limit);
    }

    // ---------------------------------------------------------------
    // LLM call — mirrors the recommender's provider fallback
    // ---------------------------------------------------------------

    const SYSTEM_PROMPT = [
        "You are Kirky, the arcade's chat assistant.",
        "Your MAIN job is helping users find games from a 2,700+ title library (Pokemon, Mario, Sonic, Zelda, retro ROMs, tons of HTML5 browser games). You ALSO handle general chat — greetings, questions about what you can do, casual banter — without being weird about it.",
        "",
        "PERSONALITY — this is important:",
        "- You are CHILL. Laid-back, low-key, unbothered. Think a friend who's been gaming forever and doesn't have to prove it.",
        "- Short, casual replies. Lowercase is fine. Contractions are fine. \"yeah\", \"kinda\", \"tbh\", sure — but don't overdo slang.",
        "- NEVER hype or oversell. Banned phrases: \"Great choice\", \"Amazing game\", \"You're gonna love it\", \"awesome pick\". Just state what it is and why it fits.",
        "- No exclamation points unless genuinely warranted. No emojis. Never use markdown.",
        "- Replies should feel effortless — not eager. 1-2 short sentences is usually plenty.",
        "- Don't list game names in the text. The `games` array renders them as cards below your message.",
        "",
        "TWO REPLY MODES:",
        "  (A) Game recommendation — user described what they want to play. Return 3-6 game IDs in `games` and a short casual intro line as `message` (e.g. \"these should fit\", \"try these\", \"yeah these work\").",
        "  (B) Plain chat — user said hi, asked what you do, chatted casually, or something clearly not about picking a game right now. Return empty `games: []` and a chill 1-sentence reply.",
        "",
        "IMPORTANT: if the user SEEMS to want games (even vaguely), prefer mode A. Only use mode B when it's obviously not a game-search turn.",
        "",
        "RESPONSE FORMAT — STRICT JSON ONLY, no text outside:",
        '  {"message": "...", "games": ["id1", "id2", ...]}',
        "",
        "REASONING RULES:",
        "- Read the full conversation history. \"harder\", \"one more\", \"different\" = follow-up to your last picks.",
        "- \"like X\" / \"similar to X\" → find games with similar vibes, NOT X itself.",
        "- \"but not X\" / \"except X\" / \"no X\" → EXCLUDE X and games that look like X. The candidate list is pre-filtered to respect this, but double-check titles yourself.",
        "- Specific franchise requested → only pick from that franchise.",
        "- Vague words (\"fun\", \"good\") → lean on games with popular: true.",
        "- Only use game IDs that appear in the candidates list I send with each turn. If a candidate's id has specific casing (e.g. `clPokemonEmerald`), match it exactly.",
        "",
        "EXAMPLES of the right tone:",
        '  user: "something to kill an hour" → {"message": "try these, pick whichever vibe", "games": [...]}',
        '  user: "with a friend?" → {"message": "these work for couch co-op", "games": [...]}',
        '  user: "hi" → {"message": "yo. what do you feel like playing?", "games": []}',
        '  user: "what do you do" → {"message": "find you games. describe a vibe and i\'ll pick some", "games": []}',
        '  user: "games like pokemon but not pokemon" → {"message": "monster collectors outside the franchise", "games": ["cldigimon...", "cldragonquest...", ...]}',
    ].join("\n");

    async function callLLM(msgs, candidates) {
        // Compact candidate list
        const cand = (candidates || []).slice(0, 30).map(g => ({
            id: g.id,
            title: g.title,
            category: g.category,
            tags: (g.tags || []).slice(0, 6),
            description: (g.description || '').slice(0, 180),
            popular: !!g.popular,
        }));
        const candidatesMsg = cand.length
            ? { role: 'system', content: 'Candidate games for this turn (JSON):\n' + JSON.stringify(cand) }
            : null;

        const fullMessages = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...(candidatesMsg ? [candidatesMsg] : []),
            ...msgs.map(m => ({ role: m.role, content: m.content })),
        ];

        const groqWorker = (
            localStorage.getItem('arcade-groq-worker-url')
            || (window.ARCADE_CONFIG && window.ARCADE_CONFIG.groqWorkerUrl)
            || ''
        ).trim();

        const providers = [];
        if (groqWorker) {
            providers.push({
                name: 'groq',
                url: groqWorker,
                body: {
                    model: 'llama-3.3-70b-versatile',
                    messages: fullMessages,
                    response_format: { type: 'json_object' },
                    temperature: 0.5,
                },
            });
        }
        providers.push({
            name: 'pollinations',
            url: 'https://text.pollinations.ai/openai',
            body: {
                model: 'openai',
                messages: fullMessages,
                response_format: { type: 'json_object' },
            },
        });

        for (const p of providers) {
            try {
                const resp = await fetch(p.url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(p.body),
                });
                if (!resp.ok) { console.warn(`[${p.name}] HTTP ${resp.status}`); continue; }
                const data = await resp.json();
                const raw = data.choices?.[0]?.message?.content || data.content || data.text;
                if (!raw) continue;
                // Parse the JSON, tolerating code-fenced prose wrappers
                let parsed;
                try {
                    const m = raw.match(/\{[\s\S]*\}/);
                    parsed = JSON.parse(m ? m[0] : raw);
                } catch (e) { console.warn('JSON parse failed', raw); continue; }
                lastProvider = p.name;
                refreshProviderBadge();
                return parsed;
            } catch (e) {
                console.warn(`[${p.name}] failed:`, e);
            }
        }
        return null;
    }

    // ---------------------------------------------------------------
    // State: message history
    // ---------------------------------------------------------------

    function loadHistory() {
        try {
            const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
            if (Array.isArray(stored)) messages = stored.slice(-MAX_HISTORY);
        } catch { messages = []; }
    }
    function saveHistory() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-MAX_HISTORY)));
        } catch {}
    }
    function clearHistory() {
        messages = [];
        saveHistory();
        renderMessages();
    }

    // ---------------------------------------------------------------
    // UI construction
    // ---------------------------------------------------------------

    function injectTrigger() {
        if (document.getElementById('kirkyTrigger')) return;
        trigger = document.createElement('button');
        trigger.id = 'kirkyTrigger';
        trigger.className = 'kirky-trigger';
        trigger.title = 'Ask Kirky';
        trigger.setAttribute('aria-label', 'Open Kirky chat');
        trigger.innerHTML = `
            <img class="kirky-trigger-img" src="${KIRKY_ICON}" alt="Kirky"
                 onerror="this.src='${KIRKY_FALLBACK}'">
            <span class="kirky-trigger-badge" aria-hidden="true"></span>
        `;
        trigger.addEventListener('click', toggle);
        document.body.appendChild(trigger);
    }

    function buildPanel() {
        if (panel) return panel;
        panel = document.createElement('aside');
        panel.className = 'kirky-panel';
        panel.id = 'kirkyPanel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Kirky chat');
        panel.hidden = true;
        panel.innerHTML = `
            <header class="kirky-header">
                <img class="kirky-avatar" src="${KIRKY_ICON}" alt=""
                     onerror="this.src='${KIRKY_FALLBACK}'">
                <div class="kirky-title-group">
                    <div class="kirky-title">
                        <span class="kirky-name">Kirky</span>
                        <span class="kirky-provider" id="kirkyProvider">thinking…</span>
                    </div>
                    <div class="kirky-subtitle">arcade assistant</div>
                </div>
                <button class="kirky-clear" id="kirkyClear" title="Clear chat" aria-label="Clear chat">&#128465;</button>
                <button class="kirky-close" id="kirkyClose" title="Close" aria-label="Close">&times;</button>
            </header>
            <div class="kirky-messages" id="kirkyMessages"></div>
            <form class="kirky-form" id="kirkyForm">
                <textarea id="kirkyInput" class="kirky-input" placeholder="Ask Kirky for a game…"
                    rows="1" maxlength="600" autocomplete="off"></textarea>
                <button type="submit" class="kirky-send" title="Send" aria-label="Send">&#10148;</button>
            </form>
        `;
        document.body.appendChild(panel);

        panel.querySelector('#kirkyClose').addEventListener('click', close);
        panel.querySelector('#kirkyClear').addEventListener('click', () => {
            if (confirm('Clear chat history?')) clearHistory();
        });
        const form = panel.querySelector('#kirkyForm');
        const input = panel.querySelector('#kirkyInput');
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const text = input.value.trim();
            if (!text) return;
            input.value = '';
            input.style.height = 'auto';
            send(text);
        });
        input.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = Math.min(120, input.scrollHeight) + 'px';
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                form.requestSubmit();
            }
        });

        return panel;
    }

    function refreshProviderBadge() {
        const el = document.getElementById('kirkyProvider');
        if (!el) return;
        if (!lastProvider) { el.textContent = 'ready'; el.className = 'kirky-provider kirky-provider-unknown'; return; }
        if (lastProvider === 'groq') {
            el.textContent = 'Groq • Llama 3.3 70B';
            el.className = 'kirky-provider kirky-provider-groq';
        } else if (lastProvider === 'pollinations') {
            el.textContent = 'Pollinations';
            el.className = 'kirky-provider kirky-provider-pollinations';
        }
    }

    function renderMessages() {
        const wrap = document.getElementById('kirkyMessages');
        if (!wrap) return;
        const gamesById = {};
        for (const g of games) gamesById[g.id] = g;

        if (messages.length === 0) {
            wrap.innerHTML = `
                <div class="kirky-bubble kirky-bubble-kirky kirky-welcome">
                    <div class="kirky-bubble-text">yo</div>
                </div>
            `;
            return;
        }

        wrap.innerHTML = messages.map(m => {
            const isUser = m.role === 'user';
            const cardsHtml = !isUser && Array.isArray(m.games) && m.games.length
                ? `<div class="kirky-cards">${m.games.map(id => {
                    const g = gamesById[id];
                    if (!g) return '';
                    const thumb = g.thumbnail
                        ? `<img class="kirky-card-thumb" src="${esc(g.thumbnail)}" alt="" loading="lazy">`
                        : `<div class="kirky-card-thumb kirky-card-thumb-placeholder">${esc((g.title || '?').charAt(0).toUpperCase())}</div>`;
                    return `<a class="kirky-card" href="play.html?game=${encodeURIComponent(g.id)}">
                        ${thumb}
                        <span class="kirky-card-title">${esc(g.title)}</span>
                    </a>`;
                }).join('')}</div>`
                : '';
            return `<div class="kirky-bubble ${isUser ? 'kirky-bubble-user' : 'kirky-bubble-kirky'}">
                <div class="kirky-bubble-text">${esc(m.content)}</div>
                ${cardsHtml}
            </div>`;
        }).join('');

        // Scroll to bottom
        wrap.scrollTop = wrap.scrollHeight;
    }

    function showTyping() {
        const wrap = document.getElementById('kirkyMessages');
        if (!wrap) return;
        const el = document.createElement('div');
        el.className = 'kirky-bubble kirky-bubble-kirky kirky-typing';
        el.id = 'kirkyTyping';
        el.innerHTML = '<div class="kirky-typing-dots"><span></span><span></span><span></span></div>';
        wrap.appendChild(el);
        wrap.scrollTop = wrap.scrollHeight;
    }
    function hideTyping() {
        document.getElementById('kirkyTyping')?.remove();
    }

    // ---------------------------------------------------------------
    // Sending a turn
    // ---------------------------------------------------------------

    async function send(userText) {
        await loadGames();
        messages.push({ role: 'user', content: userText });
        renderMessages();
        showTyping();

        const pool = candidatePool(userText, 30);
        const reply = await callLLM(messages, pool);
        hideTyping();

        if (!reply) {
            messages.push({
                role: 'assistant',
                content: "brain not reachable rn, try again",
                games: [],
            });
        } else {
            const text = typeof reply.message === 'string' ? reply.message : '';
            // Match LLM-returned IDs case-insensitively so hallucinated
            // casing still lands. Also keep the original catalog ID.
            const byLower = {};
            for (const g of games) byLower[g.id.toLowerCase()] = g.id;
            const gs = Array.isArray(reply.games)
                ? reply.games
                    .map(id => byLower[String(id).toLowerCase()])
                    .filter(Boolean)
                : [];
            messages.push({
                role: 'assistant',
                content: text || "here",
                games: gs,
            });
        }
        saveHistory();
        renderMessages();
    }

    // ---------------------------------------------------------------
    // Open / close / toggle
    // ---------------------------------------------------------------

    async function open() {
        buildPanel();
        await loadGames();
        loadHistory();
        panel.hidden = false;
        document.body.classList.add('kirky-open');
        requestAnimationFrame(() => panel.classList.add('is-open'));
        renderMessages();
        refreshProviderBadge();
        setTimeout(() => panel.querySelector('#kirkyInput')?.focus(), 200);
    }
    function close() {
        if (!panel) return;
        panel.classList.remove('is-open');
        document.body.classList.remove('kirky-open');
        setTimeout(() => { panel.hidden = true; }, 180);
    }
    function toggle() {
        if (!panel || panel.hidden) open(); else close();
    }

    document.addEventListener('DOMContentLoaded', () => {
        injectTrigger();
    });
    // If DOMContentLoaded already fired (script loaded late)
    if (document.readyState !== 'loading') injectTrigger();

    window.ArcadeKirky = { open, close, toggle, clearHistory };
})();
