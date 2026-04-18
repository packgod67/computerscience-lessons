// ===== Game Recommender =====
// A smart-matcher that answers natural-language queries ("something relaxing",
// "a roguelike like Slay the Spire", "short challenging platformer") with a
// ranked list of games from the catalog.
//
// Works entirely in the browser — no backend, no API key. It maps mood/intent
// words in the query to the site's tag vocabulary, then scores each game by:
//   - how many of its tags match the inferred tags (biggest factor)
//   - direct title/description keyword hits
//   - a small "popular" boost so well-known games surface first when ties
//
// The output is a short "reason" per game so the user sees why it was picked.

(function () {
    let games = [];
    let gamesLoaded = false;

    // -----------------------------------------------------------------
    // Mood / intent -> tags vocabulary.
    // Each entry: a list of phrases that should add a list of tags to the
    // inferred set. Longer phrases checked first so "battle royale" beats
    // "battle" alone.
    // -----------------------------------------------------------------
    const MOOD_MAP = [
        // Feel / energy
        { match: ['relaxing', 'relax', 'chill', 'chilled', 'calm', 'peaceful', 'zen', 'cozy', 'laid back', 'laidback', 'casual'],
          tags: ['casual', 'idle', 'puzzle', 'simulation', 'farming', 'sandbox'] },
        { match: ['intense', 'frantic', 'hectic', 'adrenaline', 'fast paced', 'fast-paced'],
          tags: ['action', 'shooter', 'fighting', 'runner', 'fps'] },
        { match: ['hard', 'difficult', 'challenging', 'challenge', 'punishing', 'brutal', 'tough'],
          tags: ['hard', 'roguelike', 'metroidvania'] },
        { match: ['easy', 'simple', 'beginner'],
          tags: ['casual', 'puzzle', 'idle'] },
        { match: ['quick', 'short', 'brief', 'few minutes', '5 minute', '10 minute'],
          tags: ['casual', 'arcade', 'runner', 'endless'] },
        { match: ['long', 'epic', 'hours', '100 hours'],
          tags: ['rpg', 'jrpg', 'adventure', 'metroidvania'] },
        { match: ['story', 'narrative', 'plot', 'lore'],
          tags: ['rpg', 'jrpg', 'adventure', 'visual-novel'] },
        { match: ['mindless', 'braindead', 'while watching'],
          tags: ['idle', 'clicker', 'runner', 'casual'] },
        { match: ['scary', 'horror', 'spooky', 'creepy', 'terror'],
          tags: ['horror'] },
        { match: ['funny', 'comedy', 'humor', 'humorous', 'silly', 'dumb'],
          tags: ['henry-stickmin', 'flash-classic', 'meta'] },
        { match: ['retro', 'old school', 'classic', 'nostalgic', 'nostalgia', '8 bit', '16 bit', '8-bit', '16-bit'],
          tags: ['retro', 'pixel-art', 'nes', 'snes', 'gba', 'arcade'] },
        { match: ['cute', 'kawaii', 'adorable'],
          tags: ['cute', 'casual'] },

        // Social
        { match: ['multiplayer', 'with friends', 'with my friend', 'with a friend', 'friend'],
          tags: ['multiplayer', '2-player', 'co-op', 'battle-royale', '1v1', '.io'] },
        { match: ['2 player', '2-player', 'two player', 'couch coop', 'couch co-op', 'same pc'],
          tags: ['2-player', 'co-op', 'split-screen'] },
        { match: ['co-op', 'coop', 'cooperative', 'together'],
          tags: ['co-op'] },
        { match: ['alone', 'solo', 'singleplayer', 'single player'],
          tags: ['rpg', 'adventure', 'platformer'] },

        // Format / genre hints
        { match: ['roguelike', 'roguelite', 'rogue lite', 'rogue-like'],
          tags: ['roguelike'] },
        { match: ['metroidvania', 'exploration'],
          tags: ['metroidvania', 'adventure'] },
        { match: ['tower defense', 'td ', 'defend'],
          tags: ['tower-defense', 'strategy'] },
        { match: ['platformer', 'platforming', 'jump and run'],
          tags: ['platformer'] },
        { match: ['racing', 'drive', 'driving', 'car', 'kart'],
          tags: ['racing', 'cars'] },
        { match: ['shooter', 'shooting', 'guns', 'fps', 'first person'],
          tags: ['shooter', 'fps'] },
        { match: ['fighting', 'fighter', 'beat em up', 'beat-em-up'],
          tags: ['fighting', 'beat-em-up'] },
        { match: ['puzzle', 'puzzles', 'think', 'thinking', 'brain'],
          tags: ['puzzle'] },
        { match: ['rpg', 'role playing', 'turn based', 'turn-based'],
          tags: ['rpg', 'jrpg', 'turn-based'] },
        { match: ['jrpg', 'japanese rpg', 'anime rpg'],
          tags: ['jrpg', 'rpg', 'turn-based'] },
        { match: ['strategy', 'tactical', 'tactics', 'war game'],
          tags: ['strategy', 'tactics', 'tower-defense'] },
        { match: ['simulation', 'simulator', 'sim ', 'tycoon', 'management'],
          tags: ['simulation', 'tycoon'] },
        { match: ['sports', 'football', 'soccer', 'basketball', 'baseball'],
          tags: ['sports'] },
        { match: ['card', 'cards', 'deck', 'poker', 'solitaire'],
          tags: ['card-game'] },
        { match: ['rhythm', 'music', 'beat', 'osu', 'fnf', 'friday night funkin'],
          tags: ['rhythm', 'fnf'] },
        { match: ['idle', 'incremental', 'clicker', 'auto'],
          tags: ['idle', 'clicker'] },
        { match: ['adventure', 'explore', 'open world'],
          tags: ['adventure', 'sandbox'] },
        { match: ['stealth', 'sneak'],
          tags: ['stealth'] },
        { match: ['sandbox', 'creative', 'build'],
          tags: ['sandbox', 'minecraft'] },

        // Franchises
        { match: ['pokemon', 'pokémon'],
          tags: ['pokemon'] },
        { match: ['mario'],
          tags: ['mario'] },
        { match: ['sonic'],
          tags: ['sonic'] },
        { match: ['zelda', 'hyrule', 'link '],
          tags: ['zelda'] },
        { match: ['kirby'],
          tags: ['kirby'] },
        { match: ['metroid'],
          tags: ['metroid'] },
        { match: ['mega man', 'megaman'],
          tags: ['mega-man'] },
        { match: ['castlevania'],
          tags: ['castlevania'] },
        { match: ['final fantasy', 'ff7', 'ff6'],
          tags: ['final-fantasy', 'jrpg'] },
        { match: ['dragon ball', 'dbz', 'goku'],
          tags: ['dragon-ball'] },
        { match: ['minecraft', 'blocky'],
          tags: ['minecraft', 'sandbox'] },
        { match: ['doom', 'quake', 'wolfenstein'],
          tags: ['fps', 'retro'] },
        { match: ['henry stickmin'],
          tags: ['henry-stickmin'] },
        { match: ['fireboy', 'watergirl'],
          tags: ['fireboy-and-watergirl', 'co-op'] },
        { match: ['fnaf', 'five nights'],
          tags: ['fnaf', 'horror'] },
        { match: ['fnf', 'friday night funkin'],
          tags: ['fnf', 'rhythm'] },

        // Platform hints
        { match: ['gba', 'game boy advance'],
          tags: ['gba'] },
        { match: ['nes', 'nintendo entertainment'],
          tags: ['nes'] },
        { match: ['snes', 'super nintendo'],
          tags: ['snes'] },
        { match: ['n64', 'nintendo 64'],
          tags: ['n64'] },
        { match: ['nds', 'nintendo ds'],
          tags: ['nds'] },
        { match: ['psx', 'playstation 1', 'ps1'],
          tags: ['psx'] },
        { match: ['arcade'],
          tags: ['arcade'] },
        { match: ['sega', 'genesis', 'mega drive'],
          tags: ['genesis', 'sega'] },

        // Misc vibes
        { match: ['anime'],
          tags: ['anime'] },
        { match: ['sci fi', 'sci-fi', 'space', 'cyberpunk', 'futuristic'],
          tags: ['sci-fi', 'space'] },
        { match: ['medieval', 'knight', 'sword'],
          tags: ['medieval'] },
        { match: ['fantasy', 'dragon', 'magic'],
          tags: ['fantasy'] },
        { match: ['zombie', 'undead'],
          tags: ['zombies', 'horror'] },
        { match: ['hardcore', 'kaizo'],
          tags: ['hard', 'hack'] },
        { match: ['randomized', 'randomizer', 'nuzlocke'],
          tags: ['randomizer'] },
    ];

    async function loadGames() {
        if (gamesLoaded) return games;
        try {
            const res = await fetch('games/games.json');
            games = await res.json();
            gamesLoaded = true;
        } catch (e) { games = []; }
        return games;
    }

    function norm(s) { return (s || '').toLowerCase(); }

    // Parse a user prompt into a set of tags we should look for + a set of
    // raw keywords (for title/description matching).
    function parseQuery(q) {
        const text = ' ' + norm(q) + ' ';
        const inferredTags = new Set();
        let matchedPhrases = [];
        for (const entry of MOOD_MAP) {
            for (const phrase of entry.match) {
                if (text.includes(' ' + phrase + ' ') ||
                    text.includes(' ' + phrase) ||
                    text.includes(phrase + ' ')) {
                    entry.tags.forEach(t => inferredTags.add(t));
                    matchedPhrases.push(phrase);
                    break;
                }
            }
        }
        // Also extract significant non-stopword keywords for direct matching
        const STOP = new Set(['a','an','the','and','or','but','for','of','to','in','on','with','without','about','i','me','my','want','like','something','game','games','play','playing','good','best','please','recommend','recommendation','recommendations']);
        const keywords = text
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length >= 3 && !STOP.has(w));
        return { tags: [...inferredTags], keywords, matchedPhrases };
    }

    // Score one game against the parsed query.
    function scoreGame(g, parsed) {
        let score = 0;
        const reasons = [];
        const gTags = g.tags || [];

        // Tag matches — biggest factor
        let tagHits = 0;
        for (const t of parsed.tags) {
            if (gTags.includes(t)) { tagHits++; score += 4; }
        }
        if (tagHits > 0) reasons.push(`matches ${tagHits} tag${tagHits > 1 ? 's' : ''}`);

        // Direct keyword hits in title
        const title = norm(g.title);
        let titleHits = 0;
        for (const k of parsed.keywords) {
            if (title.includes(k)) { titleHits++; score += 3; }
        }
        if (titleHits > 0) reasons.push(`title match`);

        // Description hits — smaller weight
        const desc = norm(g.description || '');
        let descHits = 0;
        for (const k of parsed.keywords) {
            if (desc.includes(k)) { descHits++; score += 1; }
        }

        // Tiebreaker: popular games surface first
        if (g.popular) score += 0.5;

        return { score, reasons };
    }

    // Local-only matcher. Returns top N by heuristic score.
    function localRecommend(parsed, topN) {
        const scored = [];
        for (const g of games) {
            const s = scoreGame(g, parsed);
            if (s.score > 0) scored.push({ game: g, score: s.score, reasons: s.reasons });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topN);
    }

    // AI-powered re-ranker. Tries in order:
    //   1. The admin's Cloudflare Worker proxy to Groq (Llama 3.3 70B).
    //      Set via localStorage.setItem('arcade-groq-worker-url', 'https://...')
    //   2. Pollinations.ai public endpoint (no key needed).
    // Both are called with the same OpenAI-compatible chat schema so the
    // rest of the code is provider-agnostic.
    async function aiRecommend(query, candidates) {
        if (!candidates.length) return null;

        // Compact representation — trim title + tags + short description
        const cand = candidates.slice(0, 40).map(c => ({
            id: c.game.id,
            title: c.game.title,
            category: c.game.category,
            tags: (c.game.tags || []).slice(0, 8),
            description: (c.game.description || '').slice(0, 220),
            popular: !!c.game.popular,
        }));

        const system = [
            'You are a thoughtful game recommender for a browser arcade with 2,700+ games.',
            'The user describes what they want in plain language — possibly messy or vague — and you pick the 6 games that best match.',
            '',
            'REASONING HINTS:',
            '- If the user references a specific game by name ("like Unbound", "similar to Zelda"), find games with similar vibes, franchises, mechanics, or tags. Do not just pick the referenced game itself.',
            '- If they mention specific features ("all the pokemons", "infinite replay", "co-op"), prioritize games whose description or tags mention that.',
            '- If they say "fun", "good", or other vague words, lean on the `popular` flag as a tiebreaker.',
            '- If the request is for a franchise (Pokemon/Mario/Sonic/etc), ONLY pick games from that franchise.',
            '- ROM hacks are legitimate picks. Don\'t avoid them.',
            '- Sort by how well each one matches the user\'s PRIMARY intent, not by raw tag count.',
            '',
            'RESPONSE FORMAT:',
            '- STRICT JSON only. No markdown, no prose outside the JSON.',
            '- Reasons should be SPECIFIC and PERSONALIZED to the user\'s query — mention what the game does that matches their ask. Max 100 characters each.',
            '- Use exactly 6 picks unless fewer than 6 candidates genuinely fit, in which case use as many as do.',
        ].join('\n');
        const user = 'User request: "' + query + '"\n\n'
            + 'Candidate games (JSON array, each with id/title/category/tags/description/popular):\n'
            + JSON.stringify(cand) + '\n\n'
            + 'Return this exact JSON shape:\n'
            + '{"picks":[{"id":"<game_id>","reason":"<specific reason tied to the query>"},...]}\n'
            + 'Use only ids that appear in the candidates list.';

        const messages = [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ];

        // Provider list in priority order. Groq worker first (better model),
        // pollinations as fallback. Both use OpenAI-compatible chat schema.
        // URL priority: per-user localStorage override > site-wide config.
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
                    messages,
                    response_format: { type: 'json_object' },
                    temperature: 0.4,
                },
            });
        }
        providers.push({
            name: 'pollinations',
            url: 'https://text.pollinations.ai/openai',
            body: {
                model: 'openai',
                messages,
                response_format: { type: 'json_object' },
                seed: 42,
            },
        });

        let raw = null;
        let providerUsed = null;
        for (const p of providers) {
            try {
                const resp = await fetch(p.url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(p.body),
                });
                if (!resp.ok) {
                    console.warn(`[${p.name}] HTTP ${resp.status}`);
                    continue;
                }
                const data = await resp.json();
                raw = data.choices?.[0]?.message?.content
                    || data.content
                    || data.text
                    || null;
                if (raw) { providerUsed = p.name; break; }
            } catch (e) {
                console.warn(`[${p.name}] failed:`, e);
            }
        }
        if (!raw) return null;

        // Parse the JSON — tolerate code-fenced or prose-wrapped responses
        let parsed;
        try {
            const m = raw.match(/\{[\s\S]*\}/);
            parsed = JSON.parse(m ? m[0] : raw);
        } catch (e) {
            console.warn('AI JSON parse failed:', e, raw);
            return null;
        }
        const picks = Array.isArray(parsed.picks) ? parsed.picks : [];
        if (picks.length === 0) return null;

        // Re-hydrate with the real game objects from our catalog
        const byId = {};
        for (const c of candidates) byId[c.game.id] = c;
        const out = [];
        for (const p of picks) {
            const c = byId[p.id];
            if (!c) continue;
            const reason = (p.reason || '').toString().slice(0, 120);
            out.push({ game: c.game, score: c.score, reasons: [reason] });
        }
        if (out.length === 0) return null;
        // Tag each result with which provider produced it so the UI can
        // show a more specific source badge.
        out.provider = providerUsed;
        return out;
    }

    // Combined entry point.
    async function recommend(query, topN = 6, useAI = true) {
        await loadGames();
        const parsed = parseQuery(query);
        if (parsed.tags.length === 0 && parsed.keywords.length === 0) {
            return { items: [], parsed, source: 'none' };
        }
        // Always compute local matches first — acts as a candidate pool for
        // the AI and as a fallback if AI is off/fails. Pool of 40 so the
        // LLM has room to rerank; users still see 6.
        const local = localRecommend(parsed, 40);
        if (!useAI) {
            return { items: local.slice(0, topN), parsed, source: 'local' };
        }
        const aiPicks = await aiRecommend(query, local);
        if (aiPicks && aiPicks.length) {
            const src = aiPicks.provider === 'groq' ? 'ai-groq' : 'ai-pollinations';
            return { items: aiPicks.slice(0, topN), parsed, source: src };
        }
        return { items: local.slice(0, topN), parsed, source: 'local-fallback' };
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ===== UI =====

    const AI_PREF_KEY = 'arcade-recommender-ai';
    function aiEnabled() {
        const v = localStorage.getItem(AI_PREF_KEY);
        return v === null ? true : v === '1';
    }
    function setAiEnabled(on) {
        localStorage.setItem(AI_PREF_KEY, on ? '1' : '0');
    }

    function openRecommender() {
        closeRecommender();
        const overlay = document.createElement('div');
        overlay.className = 'recommender-overlay';
        overlay.id = 'recommenderOverlay';
        overlay.innerHTML = `
            <div class="recommender-modal">
                <button class="recommender-close" aria-label="Close">&times;</button>
                <div class="recommender-header">
                    <h2>&#9889; Game Recommender</h2>
                    <p>Describe what you want to play — a mood, a genre, a franchise, anything. Works best with natural sentences.</p>
                </div>
                <form class="recommender-form" id="recommenderForm">
                    <input type="text" id="recommenderInput" class="recommender-input"
                        placeholder="e.g. a relaxing puzzle, something like Pokemon, 2-player racing..."
                        autocomplete="off" autofocus>
                    <button type="submit" class="recommender-submit">Go</button>
                </form>
                <div class="recommender-toolbar">
                    <label class="recommender-ai-toggle">
                        <input type="checkbox" id="recommenderAiToggle" ${aiEnabled() ? 'checked' : ''}>
                        <span>Use AI (free, via pollinations.ai)</span>
                    </label>
                </div>
                <div class="recommender-chips" id="recommenderChips">
                    ${['relaxing puzzle', 'roguelike', 'with a friend', 'like Pokemon', 'retro platformer', 'hardcore', 'rhythm', 'short & easy'].map(p =>
                        `<button type="button" class="recommender-chip" data-prompt="${esc(p)}">${esc(p)}</button>`
                    ).join('')}
                </div>
                <div class="recommender-results" id="recommenderResults"></div>
            </div>
        `;
        document.body.appendChild(overlay);

        document.getElementById('recommenderAiToggle').addEventListener('change', (e) => {
            setAiEnabled(e.target.checked);
        });

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeRecommender();
        });
        overlay.querySelector('.recommender-close').addEventListener('click', closeRecommender);

        const input = document.getElementById('recommenderInput');
        const form = document.getElementById('recommenderForm');
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            runSearch(input.value);
        });

        document.getElementById('recommenderChips').querySelectorAll('.recommender-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                input.value = chip.dataset.prompt;
                runSearch(chip.dataset.prompt);
            });
        });

        document.addEventListener('keydown', escHandler);
    }

    function escHandler(e) {
        if (e.key === 'Escape') closeRecommender();
    }

    function closeRecommender() {
        const el = document.getElementById('recommenderOverlay');
        if (el) el.remove();
        document.removeEventListener('keydown', escHandler);
    }

    async function runSearch(query) {
        const results = document.getElementById('recommenderResults');
        if (!results) return;
        if (!query || !query.trim()) return;
        const useAI = aiEnabled();
        results.innerHTML = `<div class="recommender-loading">
            ${useAI ? '&#9889; Asking the AI' : 'Searching the catalog'}…
        </div>`;
        const { items, parsed, source } = await recommend(query.trim(), 6, useAI);
        if (items.length === 0) {
            results.innerHTML = `<div class="recommender-empty">
                Couldn't match anything to that. Try mentioning a mood (relaxing, intense), genre (puzzle, platformer, rpg), or franchise (Pokemon, Mario).
            </div>`;
            return;
        }
        const sourceLabel =
            source === 'ai-groq'
                ? `<span class="recommender-source recommender-source-ai">&#9889; Groq (Llama 3.3 70B)</span>`
          : source === 'ai-pollinations'
                ? `<span class="recommender-source recommender-source-ai">&#9889; AI-picked</span>`
          : source === 'local-fallback'
                ? `<span class="recommender-source recommender-source-fallback">Tag-matched (AI unavailable)</span>`
          : `<span class="recommender-source">Tag-matched</span>`;
        const tagsUsed = parsed.tags.length
            ? `<div class="recommender-inferred">${sourceLabel} Understood as: ${parsed.tags.map(t => `<code>#${esc(t)}</code>`).join(' ')}</div>`
            : `<div class="recommender-inferred">${sourceLabel}</div>`;
        results.innerHTML = tagsUsed + items.map(({ game: g, reasons }) => {
            const thumb = g.thumbnail
                ? `<img class="recommender-thumb" src="${esc(g.thumbnail)}" alt="" loading="lazy">`
                : `<div class="recommender-thumb recommender-thumb-placeholder">${esc((g.title || '?').charAt(0).toUpperCase())}</div>`;
            const tags = (g.tags || []).slice(0, 4).map(t => `<span class="recommender-tag">#${esc(t)}</span>`).join('');
            return `<a class="recommender-card" href="play.html?game=${encodeURIComponent(g.id)}">
                ${thumb}
                <div class="recommender-card-body">
                    <div class="recommender-card-title">${esc(g.title)}</div>
                    <div class="recommender-card-tags">${tags}</div>
                    <div class="recommender-card-reason">${esc(reasons.join(' · ')) || 'Strong match'}</div>
                </div>
            </a>`;
        }).join('');
    }

    // Insert the trigger button near the search bar. Also hook ArcadeRecommender
    // so other code can call openRecommender() directly.
    function injectButton() {
        const search = document.querySelector('.search-wrapper');
        if (!search || document.getElementById('recommenderTriggerBtn')) return;
        const btn = document.createElement('button');
        btn.id = 'recommenderTriggerBtn';
        btn.className = 'recommender-trigger-btn';
        btn.type = 'button';
        btn.title = 'AI recommendations';
        btn.setAttribute('aria-label', 'AI recommendations');
        btn.innerHTML = '&#9889;';  // ⚡
        btn.addEventListener('click', openRecommender);
        // Insert before the random button
        const rand = document.getElementById('randomGameBtn');
        if (rand) search.insertBefore(btn, rand);
        else search.appendChild(btn);
    }

    document.addEventListener('DOMContentLoaded', injectButton);

    window.ArcadeRecommender = {
        open: openRecommender,
        recommend,
    };
})();
