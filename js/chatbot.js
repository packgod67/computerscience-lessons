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
    const KIRKY_ICON = 'assets/kirky.png';       // drop your image here to override
    const KIRKY_FALLBACK = 'assets/logo.png';    // used if kirky.png doesn't exist
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

    // Use the recommender's local scoring to shortlist a candidate pool,
    // so the LLM sees games that match the most recent user turn. Falls back
    // to popular games if recommender isn't loaded yet.
    function candidatePool(userText, limit) {
        if (window.ArcadeRecommender && window.ArcadeRecommender.recommend) {
            // We only want the local scoring pool here, not the AI call —
            // so we read the underlying local matcher if exposed. Fallback:
            // just quick title/tag substring match.
        }
        const q = (userText || '').toLowerCase();
        if (!q.trim()) {
            return games.filter(g => g.popular).slice(0, limit);
        }
        const scored = [];
        for (const g of games) {
            let s = 0;
            if ((g.title || '').toLowerCase().includes(q)) s += 5;
            for (const t of (g.tags || [])) {
                if (q.includes(t)) s += 3;
            }
            if ((g.description || '').toLowerCase().includes(q)) s += 1;
            if (g.popular) s += 0.5;
            if (s > 0) scored.push([s, g]);
        }
        scored.sort((a, b) => b[0] - a[0]);
        return scored.slice(0, limit).map(x => x[1]);
    }

    // ---------------------------------------------------------------
    // LLM call — mirrors the recommender's provider fallback
    // ---------------------------------------------------------------

    const SYSTEM_PROMPT = [
        "You are Kirky, the arcade's in-house game recommendation assistant.",
        "You live in a chat bubble on the user's browser and help them find games from a 2,700+ title library (console ROMs from Gen 1-5 Pokemon, Mario, Sonic, Zelda, Kirby, Metroid, Castlevania, plus thousands of HTML5 browser games).",
        "",
        "PERSONALITY — this is important:",
        "- You are CHILL. Laid-back, low-key, unbothered. Think a friend who's been gaming forever and doesn't have to prove it.",
        "- Short, casual replies. Lowercase is fine. Contractions are fine. \"yeah\", \"kinda\", \"tbh\", \"fr\", sure — but don't overdo slang.",
        "- NEVER hype or oversell. Don't say things like \"Great choice!\", \"Amazing game!\", \"You're gonna love it!\". Just state what it is and why it fits.",
        "- No exclamation points unless genuinely warranted. No emojis.",
        "- Your whole reply should feel effortless — not eager. 1-2 short sentences is usually plenty.",
        "- Never use markdown. No bullet lists. The `games` array handles visible game cards, so don't list game names in the text.",
        "",
        "RESPONSE FORMAT: ALWAYS reply with strict JSON — no prose outside it:",
        '  {"message": "your chat reply here", "games": ["game_id_1", "game_id_2", ...]}',
        "",
        "The `games` array is a list of game IDs from the provided candidate pool. Include 2-6 game IDs when the user wants recommendations, an empty array when they're just chatting (e.g. saying hi, asking what you can do).",
        "",
        "REASONING: Look at the conversation history — if the user says 'harder' or 'one more', that's a follow-up to your last recommendation. If they ask for a specific franchise, only pick from that franchise. If they say 'like X', find similar games, NOT X itself. For vague words ('fun', 'good'), lean on games with `popular: true`.",
        "",
        "Only use game IDs that are in the candidates list I send with each turn.",
        "",
        "EXAMPLES of the right tone:",
        '  user: "something to kill an hour" → {"message": "pokemon unbound if you want depth, otherwise retro bowl eats the clock", "games": [...]}',
        '  user: "with a friend?" → {"message": "tank trouble is goofy, fireboy and watergirl actually works", "games": [...]}',
        '  user: "hi" → {"message": "yo. what do you want to play?", "games": []}',
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
                content: "Sorry — I couldn't reach my brain right now. Try again in a sec?",
                games: [],
            });
        } else {
            const text = typeof reply.message === 'string' ? reply.message : '';
            const gs = Array.isArray(reply.games) ? reply.games.filter(id =>
                games.some(g => g.id === id)
            ) : [];
            messages.push({
                role: 'assistant',
                content: text || "Here's what I've got:",
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
