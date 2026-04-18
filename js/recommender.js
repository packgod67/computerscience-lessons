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

    // Top N recommendations for a query
    async function recommend(query, topN = 6) {
        await loadGames();
        const parsed = parseQuery(query);
        // If no tags and no keywords were extracted, give up gracefully
        if (parsed.tags.length === 0 && parsed.keywords.length === 0) {
            return { items: [], parsed };
        }
        const scored = [];
        for (const g of games) {
            const s = scoreGame(g, parsed);
            if (s.score > 0) scored.push({ game: g, score: s.score, reasons: s.reasons });
        }
        scored.sort((a, b) => b.score - a.score);
        return { items: scored.slice(0, topN), parsed };
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ===== UI =====

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
                    <p>Describe what you want to play — a mood, a genre, a franchise, anything.</p>
                </div>
                <form class="recommender-form" id="recommenderForm">
                    <input type="text" id="recommenderInput" class="recommender-input"
                        placeholder="e.g. a relaxing puzzle, something like Pokemon, 2-player racing..."
                        autocomplete="off" autofocus>
                    <button type="submit" class="recommender-submit">Go</button>
                </form>
                <div class="recommender-chips" id="recommenderChips">
                    ${['relaxing puzzle', 'roguelike', 'with a friend', 'like Pokemon', 'retro platformer', 'hardcore', 'rhythm', 'short & easy'].map(p =>
                        `<button type="button" class="recommender-chip" data-prompt="${esc(p)}">${esc(p)}</button>`
                    ).join('')}
                </div>
                <div class="recommender-results" id="recommenderResults"></div>
            </div>
        `;
        document.body.appendChild(overlay);

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
        results.innerHTML = '<div class="recommender-loading">Thinking…</div>';
        const { items, parsed } = await recommend(query.trim(), 6);
        if (items.length === 0) {
            results.innerHTML = `<div class="recommender-empty">
                Couldn't match anything to that. Try mentioning a mood (relaxing, intense), genre (puzzle, platformer, rpg), or franchise (Pokemon, Mario).
            </div>`;
            return;
        }
        const tagsUsed = parsed.tags.length
            ? `<div class="recommender-inferred">Understood as: ${parsed.tags.map(t => `<code>#${esc(t)}</code>`).join(' ')}</div>`
            : '';
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
