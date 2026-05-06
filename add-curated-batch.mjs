// One-shot script that adds a curated batch of confirmed-embeddable
// browser games. For each game it:
//   1. Creates a thin wrapper HTML at games/<id>.html that iframes
//      the game's external URL (allow="autoplay; fullscreen; gamepad")
//   2. Generates a tiny SVG cover at games/<id>-cover.svg with the
//      game's name + a color-coded gradient (so we don't need to host
//      an external image to satisfy the validator's thumbnail rule)
//   3. Appends a catalog entry to games/games.json
// Then prints a summary so you can inspect what's about to ship.
//
// Re-runnable: skips entries whose id is already in the catalog.

import fs from 'node:fs';

const NOW = new Date().toISOString();

// Curated batch — all URLs HEAD-checked to confirm no X-Frame-Options
// or CSP frame-ancestors blocking. Embed permission is implicit
// (these are intentionally-public free browser games whose authors
// expect them to be embedded / linked / shared).
const GAMES = [
    {
        id: 'clUniversalPaperclips',
        title: 'Universal Paperclips',
        category: 'Simulation',
        description: 'Existential clicker about an AI tasked with making paperclips. Starts as text + buttons, ends... elsewhere. Genre-defining incremental.',
        tags: ['incremental', 'clicker', 'idle', 'narrative', 'sci-fi', 'ai', 'text-game', 'html5', 'browser-native'],
        url: 'https://www.decisionproblem.com/paperclips/',
        c1: '#dcdcdc', c2: '#7a7a7a',
    },
    {
        id: 'clADarkRoom',
        title: 'A Dark Room',
        category: 'Adventure',
        description: 'Minimalist text adventure. Starts cold by a fire, ends in a way you will not predict. Open-source, played in the browser, takes ~3 hours.',
        tags: ['text-adventure', 'survival', 'narrative', 'minimalist', 'open-source', 'html5', 'browser-native'],
        url: 'https://adarkroom.doublespeakgames.com/',
        c1: '#222', c2: '#666',
    },
    {
        id: 'clCandyBox2',
        title: 'Candy Box 2',
        category: 'Adventure',
        description: 'ASCII-art incremental RPG that gets weirder the longer you play. Starts with one candy and ends with a sword. Free, open-source.',
        tags: ['incremental', 'rpg', 'ascii', 'narrative', 'open-source', 'html5', 'browser-native'],
        url: 'https://candybox2.github.io/candybox/',
        c1: '#ff6b9d', c2: '#a64d79',
    },
    {
        id: 'clTheWikipediaGame',
        title: 'The Wikipedia Game',
        category: 'Puzzle',
        description: 'Click-only navigation race: get from one Wikipedia article to another using only the links inside. Solo or multiplayer.',
        tags: ['puzzle', 'wikipedia', 'race', 'multiplayer', 'casual', 'html5', 'browser-native'],
        url: 'https://www.thewikigame.com/',
        c1: '#3366cc', c2: '#1a1a2e',
    },
    {
        id: 'clCookieClicker',
        title: 'Cookie Clicker',
        category: 'Simulation',
        description: 'The defining incremental. Click cookies, buy grandmas, ascend, prestige, repeat. By Orteil. Free + saved in localStorage.',
        tags: ['incremental', 'clicker', 'idle', 'casual', 'classic', 'html5', 'browser-native'],
        url: 'https://orteil.dashnet.org/cookieclicker/',
        c1: '#c8a165', c2: '#8b5a2b',
    },
    {
        id: 'clDrawasaurus',
        title: 'Drawasaurus',
        category: 'Multiplayer',
        description: 'Multiplayer Pictionary-style drawing + guessing game. Free public rooms or invite-only with friends. No login required.',
        tags: ['multiplayer', 'drawing', 'party', 'casual', 'real-time', 'html5', 'browser-native'],
        url: 'https://drawasaurus.org/',
        c1: '#22c55e', c2: '#15803d',
    },
    {
        id: 'clSkribblIo',
        title: 'Skribbl.io',
        category: 'Multiplayer',
        description: 'The other big multiplayer drawing-guessing game. Quick rounds, public lobbies, custom rooms with friends.',
        tags: ['multiplayer', 'drawing', 'party', 'casual', 'real-time', 'io', 'html5', 'browser-native'],
        url: 'https://skribbl.io/',
        c1: '#f59e0b', c2: '#b45309',
    },
    {
        id: 'clGarticIo',
        title: 'Gartic.io',
        category: 'Multiplayer',
        description: 'Pictionary-style drawing game with bigger lobbies + variants (animation, telephone). Free, browser-only.',
        tags: ['multiplayer', 'drawing', 'party', 'casual', 'real-time', 'io', 'html5', 'browser-native'],
        url: 'https://gartic.io/',
        c1: '#ec4899', c2: '#9d174d',
    },
    {
        id: 'clTrimps',
        title: 'Trimps',
        category: 'Simulation',
        description: 'Deep incremental city-builder + monster-fighter hybrid. Hundreds of hours of progression. Free, open-source.',
        tags: ['incremental', 'idle', 'city-builder', 'rpg', 'open-source', 'html5', 'browser-native'],
        url: 'https://trimps.github.io/',
        c1: '#7c3aed', c2: '#4c1d95',
    },
    {
        id: 'clAntimatterDimensions',
        title: 'Antimatter Dimensions',
        category: 'Simulation',
        description: 'Numbers go up forever. Layered prestige incremental that goes from antimatter to dimensions to dilation. Beloved by genre fans.',
        tags: ['incremental', 'idle', 'prestige', 'numbers', 'open-source', 'html5', 'browser-native'],
        url: 'https://ivark.github.io/AntimatterDimensions/',
        c1: '#06b6d4', c2: '#155e75',
    },
    {
        id: 'clShellShockIo',
        title: 'ShellShock.io',
        category: 'Shooter',
        description: 'Multiplayer egg shooter. Sounds dumb, plays great. Quick public lobbies, surprisingly tactical.',
        tags: ['multiplayer', 'shooter', 'fps', 'casual', 'io', 'real-time', 'html5', 'browser-native'],
        url: 'https://shellshock.io/',
        c1: '#fbbf24', c2: '#92400e',
    },
    {
        id: 'clKrunkerIo',
        title: 'Krunker.io',
        category: 'Shooter',
        description: 'Browser FPS that feels like classic Quake. Multiple game modes, low-poly art, free public servers.',
        tags: ['multiplayer', 'shooter', 'fps', 'arena', 'io', 'real-time', 'html5', 'browser-native'],
        url: 'https://krunker.io/',
        c1: '#ef4444', c2: '#7f1d1d',
    },
    {
        id: 'clSurvevIo',
        title: 'Survev.io',
        category: 'Shooter',
        description: 'Browser-based 2D battle royale. Top-down combat, large lobbies, fast rounds. Spiritual successor to surviv.io.',
        tags: ['multiplayer', 'shooter', 'battle-royale', 'top-down', 'io', 'real-time', 'html5', 'browser-native'],
        url: 'https://surviv.io/',
        c1: '#84cc16', c2: '#365314',
    },
    {
        id: 'clCelesteClassic',
        title: 'Celeste Classic (Pico-8)',
        category: 'Platformer',
        description: 'The original Pico-8 prototype that became Celeste. 30 screens, mountain climb, dash + jump. Tight, tiny, brilliant.',
        tags: ['platformer', 'pico-8', 'pixel-art', 'precision', 'classic', 'free', 'html5', 'browser-native'],
        url: 'https://www.lexaloffle.com/bbs/?pid=11722',
        c1: '#a78bfa', c2: '#5b21b6',
    },
    {
        id: 'clHempuliBaba',
        title: 'Hempuli Baba Experiments',
        category: 'Puzzle',
        description: 'Hempuli (Baba Is You creator) hosts dozens of small puzzle prototypes — early ideas + experiments + minigames in his Baba style.',
        tags: ['puzzle', 'hempuli', 'baba-is-you', 'sokoban', 'logic', 'experimental', 'html5', 'browser-native'],
        url: 'https://hempuli.com/baba/',
        c1: '#f5f5f5', c2: '#525252',
    },
];

// SVG thumbnail factory — bouncing-ball style we used for sample-game,
// but unique per game via title + color pair. Saves us from sourcing
// 15 external thumbnail URLs.
function svgCover({ title, c1, c2 }) {
    const safe = title.replace(/[<>&]/g, '');
    // Wrap long titles to two lines (cap each at 18 chars)
    const words = safe.split(/\s+/);
    let line1 = '', line2 = '';
    for (const w of words) {
        if ((line1 + ' ' + w).trim().length <= 18) line1 = (line1 + ' ' + w).trim();
        else line2 = (line2 + ' ' + w).trim();
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" width="320" height="180">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${c1}"/>
      <stop offset="100%" stop-color="${c2}"/>
    </linearGradient>
  </defs>
  <rect width="320" height="180" fill="url(#bg)"/>
  <text x="160" y="${line2 ? 90 : 100}" text-anchor="middle" fill="#fff" font-family="system-ui, sans-serif" font-size="22" font-weight="800" style="text-shadow: 0 2px 4px rgba(0,0,0,0.5);">${line1}</text>
  ${line2 ? `<text x="160" y="120" text-anchor="middle" fill="#fff" font-family="system-ui, sans-serif" font-size="22" font-weight="800" style="text-shadow: 0 2px 4px rgba(0,0,0,0.5);">${line2}</text>` : ''}
</svg>
`;
}

function wrapper({ title, url }) {
    const safe = title.replace(/[<>&]/g, '');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>${safe}</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #000; overflow: hidden; }
  iframe { display: block; width: 100%; height: 100%; border: 0; }
</style>
</head>
<body>
<iframe src="${url}" allow="autoplay; fullscreen; gamepad *; gyroscope; accelerometer; clipboard-write" allowfullscreen></iframe>
</body>
</html>
`;
}

const data = JSON.parse(fs.readFileSync('games/games.json', 'utf8'));
const games = Array.isArray(data) ? data : data.games;
const existingIds = new Set(games.map(g => g.id));

let added = 0, skipped = 0;
for (const g of GAMES) {
    if (existingIds.has(g.id)) {
        console.log(`SKIP (exists): ${g.id}`);
        skipped++;
        continue;
    }
    const wrapperPath = `games/${g.id}.html`;
    const coverPath = `games/${g.id}-cover.svg`;
    fs.writeFileSync(wrapperPath, wrapper({ title: g.title, url: g.url }));
    fs.writeFileSync(coverPath, svgCover(g));
    games.push({
        id: g.id,
        title: g.title,
        category: g.category,
        path: wrapperPath,
        description: g.description,
        tags: g.tags,
        thumbnail: coverPath,
        addedAt: NOW,
    });
    console.log(`+ ${g.id}: ${g.title}`);
    added++;
}

fs.writeFileSync('games/games.json', JSON.stringify(games, null, 2));
console.log(`\nAdded ${added}, skipped ${skipped}. Catalog total: ${games.length}.`);
