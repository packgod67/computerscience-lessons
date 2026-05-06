// Replace the placeholder SVG covers on the curated batch with
// AI-generated cover-art images via Pollinations.ai. Each game gets
// a tailored prompt based on its title/category that produces a
// thematic 1024x576 (16:9) cover.
//
// Pollinations URLs are deterministic (same prompt + seed = same
// image, cached for a year on their CDN), so referring to the URL
// directly from games.json works as a thumbnail forever.

import fs from 'node:fs';

const NEW_IDS = [
    'clUniversalPaperclips', 'clADarkRoom', 'clCandyBox2',
    'clTheWikipediaGame', 'clCookieClicker', 'clDrawasaurus',
    'clSkribblIo', 'clGarticIo', 'clTrimps', 'clAntimatterDimensions',
    'clShellShockIo', 'clKrunkerIo', 'clSurvevIo', 'clCelesteClassic',
    'clHempuliBaba',
];

// Hand-tuned prompts so each cover actually evokes the game's vibe
// instead of a generic "video game cover" image.
const PROMPTS = {
    clUniversalPaperclips:
        'minimalist game cover for an existential AI clicker game, simple paperclip iconography, deep blue background with a single glowing paperclip, futuristic typography, sci-fi mood',
    clADarkRoom:
        'dark atmospheric game cover, lonely campfire glowing in pitch black wilderness, minimalist text adventure, foreboding mood, parchment + ember palette',
    clCandyBox2:
        'pink ASCII RPG game cover, candy themed, single piece of candy on dark pink background, kawaii but minimal, retro pixel art style',
    clTheWikipediaGame:
        'minimalist game cover, glowing hyperlinks connecting nodes, knowledge graph aesthetic, blue and white, scholarly mood',
    clCookieClicker:
        'cookie clicker game cover, golden chocolate chip cookie centered on dark warm brown background, simple iconic, classic clicker game art',
    clDrawasaurus:
        'multiplayer drawing game cover, cartoon dinosaur holding a paintbrush, bright green and friendly, party game vibe',
    clSkribblIo:
        'multiplayer guess the doodle game cover, abstract scribble art on yellow background, fun and chaotic, paint splatters',
    clGarticIo:
        'pictionary multiplayer game cover, paint palette with vibrant colors, pink and purple gradient, party game aesthetic',
    clTrimps:
        'incremental city builder game cover, tiny pixel village expanding into massive empire, isometric view, purple twilight palette',
    clAntimatterDimensions:
        'cosmic incremental game cover, abstract antimatter physics, glowing equations and dimensions, deep space cyan and dark blue',
    clShellShockIo:
        'multiplayer egg shooter game cover, cartoon eggs with weapons in playful battle, bright yellow and brown, comic style',
    clKrunkerIo:
        'low poly browser FPS game cover, blocky 3D characters in arena, cel-shaded red and white style, fast paced action',
    clSurvevIo:
        '2D top-down battle royale browser game cover, lush green field with shrinking gas circle, tactical shooter overhead view',
    clCelesteClassic:
        'pico-8 pixel art platformer cover, small character climbing snowy mountain, purple and pink retro palette, 8-bit aesthetic',
    clHempuliBaba:
        'baba is you style puzzle game cover, white square character on grass tiles with text-block puzzle pieces, minimalist puzzle aesthetic',
};

function pollinationsUrl(prompt) {
    const params = new URLSearchParams({
        model: 'flux',
        width: '1024',
        height: '576',
        // Stable seed so the same prompt = same image forever
        seed: '42',
        nologo: 'true',
    });
    return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;
}

const data = JSON.parse(fs.readFileSync('games/games.json', 'utf8'));
const games = Array.isArray(data) ? data : data.games;

let updated = 0;
for (const id of NEW_IDS) {
    const g = games.find(x => x.id === id);
    if (!g) { console.log(`SKIP (missing): ${id}`); continue; }
    const prompt = PROMPTS[id];
    if (!prompt) { console.log(`SKIP (no prompt): ${id}`); continue; }
    g.thumbnail = pollinationsUrl(prompt);
    console.log(`✓ ${id}: ${g.title}`);
    updated++;
}

// Also remove Dola entry while we're here
const dolaIdx = games.findIndex(x => x.id === 'clDolaChat');
if (dolaIdx >= 0) {
    games.splice(dolaIdx, 1);
    console.log('Removed Dola entry');
}

fs.writeFileSync('games/games.json', JSON.stringify(games, null, 2));
console.log(`\nUpdated ${updated} thumbnails. Catalog total: ${games.length}.`);
