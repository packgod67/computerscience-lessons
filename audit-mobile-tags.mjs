// Heuristic audit of #mobile tags across the catalog.
//
// "Mobile" = playable on a phone with only touch input (no physical
// keyboard). This includes mouse-only, click-only, tap-only, and
// drag-and-drop games. ROM games never qualify (they always need a
// gamepad). Most platformers/shooters/racing don't qualify.
//
// We score each game's tags + description against three buckets:
//   - STRONG_MOBILE: signals that strongly suggest mouse/click/tap-only
//   - WEAK_MOBILE: signals that often (but not always) mean mobile
//   - STRONG_NOT_MOBILE: signals that rule it out (keyboard required)
//
// Plus a few title-keyword overrides for common patterns.
//
// Output:
//   - Games that SHOULD have #mobile but don't (suggested additions)
//   - Games that DO have #mobile but probably shouldn't (false positives)
//   - Games where the heuristic is unsure (manual review)
//
// Use --apply to write changes to games/games.json. Default is dry-run.

import fs from 'node:fs';

const APPLY = process.argv.includes('--apply');

const STRONG_MOBILE = new Set([
    'clicker', 'idle', 'incremental',
    'point-and-click', 'point_and_click',
    'mouse-only',
    'drag-and-drop',
    'visual-novel', 'renpy',
    'fnaf-clone', 'fnaf-parody', 'fnaf', 'fangame-fnaf',
    'tower-defense', // most TDs are mouse-only
    'card-roguelite', 'deckbuilder', 'card-game',
    'merge', 'match-3',
    'one-button',
    'flappy-bird',
    'crossy-road',
    'micro-game',
    'sprunki',
    'mixer',
    'phonk', // sprunki-style mixers
    'satire', // text-based satire usually click-only
    'multiple-endings', // visual-novel-y
    'narrative', // story-rich often click-only
    'novelty',
    'frogger',
    'physics', // most physics games (slingshot, etc.) are mouse
    'angry-birds', 'slingshot',
    'contraption', 'vehicle-builder',
    'chud', 'wojak', // most wojak games are click-only memes
    'meme', // most meme games — contextual; use weak weight
    'simulation', // Many sims are click-only — but balance with NOT signals
]);

const WEAK_MOBILE = new Set([
    'puzzle', 'cozy', 'casual',
    'sandbox',
    'simulation', // already in strong but reinforce as weak too
    'meme',
    'hex',
    'tile-based',
    'planet-sim',
    'incredibox',
    'gdevelop',
    'rpg-maker', // turn-based, usually click+keyboard but works on mobile-ish
    'auto-attacker', // bullet-heavens with pure auto-attack
    'bullet-heaven', // some are keyboard-only, some tap-only
]);

const STRONG_NOT_MOBILE = new Set([
    // Real-time twitch games — always need keyboard
    'platformer', '2d-platformer', 'metroidvania',
    'shooter', 'fps', 'first-person', 'third-person-shooter',
    'twin-stick-shooter',
    'bullet-hell', 'shmup', 'danmaku',
    'rhythm', 'ddr', // tap rhythm games could work but most are keyboard
    'racing', 'kart', 'driving', // arrow keys
    'fighting', 'beat-em-up',
    'rpg', 'jrpg', 'crpg',
    'roguelike', 'roguelite', // most are arrow/wasd
    'action-roguelite', 'action-roguelike',
    '2d-roguelite',
    'minecraft-like', 'voxel',
    'parkour',
    'speedrun',
    'arena-shooter',
    'tank',
    'flight-sim', // unless tagged mouse-only
    'survival-horror',
    'soulslike', 'souls-like',
    'metroidvania',
    'monster-tamer', // pokemon-likes
    'pokemon',
    'gba', 'gbc', 'nes', 'snes', 'n64', 'genesis', 'arcade',
    'ps2', 'psx', 'ds', 'atari', 'lynx', // platform tags = ROM games
    'dungeon-crawler',
    'twin-stick',
    'wave-survival', // usually wasd
    'auto-attacker', // varies — moved to weak above too
    'as2', 'as3', 'flash', 'ruffle', // most flash games are keyboard
    'gmod-inspired', 'nextbot',
    'monster-tamer-roguelite',
    'arena-roguelite',
    'crash', 'gran-turismo', 'nfs', 'tuner',
    'football', 'basketball', 'soccer', 'tennis',
    'fps-shooter',
    'gameboy-style', // arrow keys on GB
    'gb-studio',
    'godot', // most Godot games keyboard-required (but not all)
    'unity', // most Unity games keyboard-required (but not all)
    'webgl',
    'mario', 'sonic',
]);

// Per-game manual overrides — admin certified these. Highest priority.
// id -> 'mobile' | 'not-mobile'
const MANUAL_OVERRIDES = {
    // Known-good mobile games (touch confirmed)
    clpenguinstrike: 'mobile',
    clfreakybob: 'mobile',
    cltrexwales: 'mobile',
    clfemboyclicker: 'mobile',
    clwhatsappclicker: 'mobile',
    clwormomancy: 'mobile',
    cleggdogextend: 'mobile',

    // Known-bad — keyboard-required despite simulator/physics tags
    cltonypigeon: 'not-mobile',           // arrow keys
    clhappywheels: 'not-mobile',           // arrow keys + spacebar
    clbadtimesimulator: 'not-mobile',      // arrow + Z
    clbadmondaysimulator: 'not-mobile',    // arrow + Z (Sans-fight clone)
    clyanderesimulator: 'not-mobile',      // WASD
    clbananasimulator: 'not-mobile',       // unclear, default safe to not-mobile
    clthebattle: 'not-mobile',             // strategy with keyboard
    clthefinalearth: 'not-mobile',         // city-builder with keyboard pan
    clelasticman: 'mobile',                // pure mouse drag — IS mobile
    clhackertype: 'mobile',                // typing-only "fake hacker"
    clpapaspizzaria: 'mobile',             // mouse-only flash games
    clcsgoclicker: 'mobile',
    clidlebreakout: 'mobile',
    clidledice: 'mobile',
    clsandgame: 'mobile',
    clcapybaraclicker: 'mobile',
    clbobasimulator: 'mobile',
    clsodasimulator: 'mobile',
    clcookieclicker: 'mobile',
    'clcookie-clicker': 'mobile',
    clcookieclickergood: 'mobile',
    clcookieclickermodmenu: 'mobile',
    clparticleclicker: 'mobile',
    clidleshark: 'mobile',
    clyouarebezos: 'mobile',
    cltownscaper: 'mobile',
    clsolitaire: 'mobile',
    cldandysworldclicker: 'mobile',
    clomeganuggetclicker: 'mobile',
    clrevolutionidle: 'mobile',
    clroomclicker: 'mobile',
    clspacebarclicker: 'mobile',
    clmagetoweridle: 'mobile',
    cllearntoflyidle: 'mobile',
    cllearntoflyidlehack: 'mobile',
    clidleidlegamedev: 'mobile',
    clidleminertycoon: 'mobile',
    clidleminorzamnshes12: 'mobile',
    clrevolutionidle: 'mobile',
    clbitlife: 'mobile',
    clbitlifeencrypted: 'mobile',
    clantarttycoon: 'mobile',
    clairlinetycoonidle: 'mobile',
    clhardwaretycoon: 'mobile',
    clprocessortycoon: 'mobile',
};

function scoreGame(g) {
    if (g.rom) return { mobile: false, score: -100, reason: 'ROM game (needs gamepad)' };
    if (MANUAL_OVERRIDES[g.id]) {
        const v = MANUAL_OVERRIDES[g.id];
        return { mobile: v === 'mobile', score: 100 * (v === 'mobile' ? 1 : -1), reason: 'manual override' };
    }
    const tags = (g.tags || []).map(t => String(t).toLowerCase());
    const desc = String(g.description || '').toLowerCase();

    // Hard YES: explicit mouse-only / tap-only / touch tags trump everything.
    // These are admin-curated signals that we trust.
    if (tags.includes('mouse-only') || tags.includes('tap-only') || tags.includes('touch-only')) {
        return { mobile: true, score: 100, reason: 'explicit mouse-only/tap-only tag' };
    }

    let score = 0;
    const hits = [];
    for (const t of tags) {
        if (STRONG_NOT_MOBILE.has(t)) { score -= 3; hits.push('-' + t); }
        if (STRONG_MOBILE.has(t))     { score += 3; hits.push('+' + t); }
        if (WEAK_MOBILE.has(t))       { score += 1; hits.push('~' + t); }
    }

    // Description signals
    if (/\b(mouse[\s-]only|click[\s-]only|tap[\s-]only|tap to|click to|mouse-driven)\b/i.test(desc)) {
        score += 4;
        hits.push('+desc:mouse-only');
    }
    if (/\b(arrow keys|wasd|keyboard|spacebar|w\/a\/s\/d)\b/i.test(desc)) {
        score -= 4;
        hits.push('-desc:keyboard');
    }
    if (/\b(drag|tap|click)\b/i.test(desc) && !/\b(arrow|wasd)\b/i.test(desc)) {
        score += 1;
        hits.push('~desc:tap-words');
    }

    // Threshold: score >= 3 = mobile, <= -2 = not mobile, else uncertain
    let mobile;
    if (score >= 3) mobile = true;
    else if (score <= -2) mobile = false;
    else mobile = null; // uncertain

    return { mobile, score, reason: hits.join(' ') };
}

const catalog = JSON.parse(fs.readFileSync('games/games.json', 'utf8'));

const results = catalog.map(g => {
    const scoring = scoreGame(g);
    const hasTag = (g.tags || []).map(t => t.toLowerCase()).includes('mobile');
    return { ...g, _scoring: scoring, _hasMobile: hasTag };
});

const shouldAdd = results.filter(r => r._scoring.mobile === true && !r._hasMobile);
const shouldRemove = results.filter(r => r._scoring.mobile === false && r._hasMobile);
const uncertain = results.filter(r => r._scoring.mobile === null && r._hasMobile);
const correctMobile = results.filter(r => r._scoring.mobile === true && r._hasMobile);
const correctNotMobile = results.filter(r => r._scoring.mobile === false && !r._hasMobile);

console.log(`\n========== AUDIT RESULTS ==========`);
console.log(`Total games:              ${catalog.length}`);
console.log(`Currently #mobile:        ${results.filter(r => r._hasMobile).length}`);
console.log(`Should ADD #mobile:       ${shouldAdd.length}`);
console.log(`Should REMOVE #mobile:    ${shouldRemove.length}`);
console.log(`Uncertain (has mobile):   ${uncertain.length}`);
console.log(`Correct (mobile):         ${correctMobile.length}`);

console.log(`\n=== ADD MOBILE TO (${shouldAdd.length}) ===`);
for (const r of shouldAdd.slice(0, 80)) {
    console.log(`  +mobile  ${r.id.padEnd(28)} ${(r.title || '').slice(0, 35).padEnd(36)} score=${r._scoring.score}  ${r._scoring.reason.slice(0, 70)}`);
}
if (shouldAdd.length > 80) console.log(`  ... (${shouldAdd.length - 80} more)`);

console.log(`\n=== REMOVE MOBILE FROM (${shouldRemove.length}) ===`);
for (const r of shouldRemove) {
    console.log(`  -mobile  ${r.id.padEnd(28)} ${(r.title || '').slice(0, 35).padEnd(36)} score=${r._scoring.score}  ${r._scoring.reason.slice(0, 70)}`);
}

if (APPLY) {
    let changed = 0;
    for (const r of shouldAdd) {
        const g = catalog.find(x => x.id === r.id);
        if (!g.tags) g.tags = [];
        if (!g.tags.includes('mobile')) {
            g.tags.push('mobile');
            changed++;
        }
    }
    for (const r of shouldRemove) {
        const g = catalog.find(x => x.id === r.id);
        if (g.tags) {
            g.tags = g.tags.filter(t => t !== 'mobile');
            changed++;
        }
    }
    fs.writeFileSync('games/games.json', JSON.stringify(catalog, null, 2));
    console.log(`\n✅ Applied ${changed} tag changes to games/games.json.`);
} else {
    console.log(`\nDry run. Re-run with --apply to write changes.`);
}
