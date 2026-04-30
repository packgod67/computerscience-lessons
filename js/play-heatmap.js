// Steam-style play heatmap + game time leaderboard.
//
// Both render from data we already track on the user document:
//   - `playCounts: { [gameId]: number }`  (total plays per game)
//   - `recentPlays: [{ gameId, at: ms }]` (last 12 plays)
//
// Heatmap: a GitHub-contributions-style grid of the last ~12 weeks.
// Counts plays per day from recentPlays. (The per-day counts are
// approximate since recentPlays caps at 12 entries — if we want true
// historical data we'd need a `playLog` subcollection. Phase-2 work.)
//
// Leaderboard: top 5 games by playCounts, with bar chart bars
// proportional to the highest-played game.

(function () {
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Build a 12-week × 7-day grid (most recent week on the right).
    // Returns [{ date: 'YYYY-MM-DD', plays: N }] indexed by week then day.
    function buildHeatmapCells(recentPlays) {
        const now = new Date();
        const days = 7 * 12; // 84 days
        const startMs = now.getTime() - (days - 1) * 24 * 60 * 60 * 1000;
        // Bucket plays by yyyy-mm-dd
        const buckets = {};
        if (Array.isArray(recentPlays)) {
            for (const e of recentPlays) {
                if (!e || typeof e.at !== 'number') continue;
                if (e.at < startMs) continue;
                const d = new Date(e.at);
                const key = d.toISOString().slice(0, 10);
                buckets[key] = (buckets[key] || 0) + 1;
            }
        }
        const cells = [];
        for (let i = 0; i < days; i++) {
            const d = new Date(startMs + i * 24 * 60 * 60 * 1000);
            const key = d.toISOString().slice(0, 10);
            cells.push({ date: key, plays: buckets[key] || 0, dow: d.getDay() });
        }
        return cells;
    }

    // Heat level for a play count. 0 = empty, 4 = brightest.
    function heatLevel(n) {
        if (n <= 0) return 0;
        if (n === 1) return 1;
        if (n <= 3) return 2;
        if (n <= 6) return 3;
        return 4;
    }

    function renderHeatmap(target, profile) {
        if (!target) return;
        const cells = buildHeatmapCells(profile.recentPlays || []);
        // Group into 12 columns of 7 (one week per column).
        // Cells are ordered Sun→Sat per column. Our cell array is ordered
        // chronologically; we need to re-bin by dow.
        const cols = [];
        for (let w = 0; w < 12; w++) {
            const col = new Array(7).fill(null);
            for (let dow = 0; dow < 7; dow++) {
                col[dow] = cells[w * 7 + dow];
            }
            cols.push(col);
        }
        const totalPlays = cells.reduce((a, b) => a + b.plays, 0);

        target.innerHTML = `
            <div class="profile-heatmap-wrap">
                <div class="profile-heatmap-summary">
                    <strong>${totalPlays}</strong> play${totalPlays === 1 ? '' : 's'} in the last 12 weeks
                </div>
                <div class="profile-heatmap-grid">
                    ${cols.map(col => `
                        <div class="profile-heatmap-col">
                            ${col.map(c => c
                                ? `<div class="profile-heatmap-cell" data-level="${heatLevel(c.plays)}" title="${c.date}: ${c.plays} play${c.plays === 1 ? '' : 's'}"></div>`
                                : `<div class="profile-heatmap-cell" data-level="0"></div>`).join('')}
                        </div>
                    `).join('')}
                </div>
                <div class="profile-heatmap-legend">
                    <span>Less</span>
                    ${[0,1,2,3,4].map(l => `<div class="profile-heatmap-cell" data-level="${l}"></div>`).join('')}
                    <span>More</span>
                </div>
            </div>
        `;
    }

    // ─── Game time leaderboard ─────────────────────────────────────
    function renderLeaderboard(target, profile, gamesIndex) {
        if (!target) return;
        const counts = profile.playCounts || {};
        const top = Object.entries(counts)
            .map(([id, n]) => ({ id, n, game: gamesIndex[id] }))
            .filter(x => x.game)
            .sort((a, b) => b.n - a.n)
            .slice(0, 5);
        if (!top.length) {
            target.innerHTML = '<div class="profile-leaderboard-empty">No games played yet.</div>';
            return;
        }
        const max = top[0].n || 1;
        target.innerHTML = `
            <div class="profile-leaderboard">
                ${top.map((entry, i) => {
                    const pct = Math.max(8, Math.round(entry.n / max * 100));
                    const g = entry.game;
                    const thumb = g.thumbnail
                        ? `<img class="profile-lb-thumb" src="${esc(g.thumbnail)}" alt="">`
                        : `<div class="profile-lb-thumb profile-lb-thumb-placeholder">${esc((g.title||'?').charAt(0).toUpperCase())}</div>`;
                    return `
                        <a class="profile-lb-row" href="play.html?game=${encodeURIComponent(g.id)}">
                            <span class="profile-lb-rank">#${i + 1}</span>
                            ${thumb}
                            <div class="profile-lb-meat">
                                <div class="profile-lb-title">${esc(g.title || g.id)}</div>
                                <div class="profile-lb-bar"><div class="profile-lb-bar-fill" style="width: ${pct}%"></div></div>
                            </div>
                            <span class="profile-lb-count">${entry.n}</span>
                        </a>
                    `;
                }).join('')}
            </div>
        `;
    }

    window.ArcadePlayHeatmap = { renderHeatmap, renderLeaderboard };
})();
