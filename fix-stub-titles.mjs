// Catalog stub-title cleanup.
//
// 1,790 entries in games/games.json have auto-generated "Clxxx" titles
// (the bulk-add script glued "Cl" + the URL slug). The real game name is
// in the wrapper HTML's <title> tag. This script:
//   - reads each Cl-prefix entry's wrapper HTML
//   - pulls <title> + cleans common junk ("Unity WebGL Player | ", trailing
//     " - Newgrounds.com", etc.)
//   - falls back to humanizing the id when <title> is unhelpful ("Game
//     24921", "really cool flash game", etc.)
//   - infers a category from the title using keyword buckets
//   - guarantees 3+ tags by adding `flash`, `ruffle`, `kongregate-import`
//     plus any keyword-derived tag
//   - sets addedAt to a deterministic past date so the cleanup doesn't
//     flood the NEW shelf
//
// Run: node fix-stub-titles.mjs --dry   (preview)
//      node fix-stub-titles.mjs --apply (write back to games.json)

import fs from 'node:fs';
import path from 'node:path';

const DRY = !process.argv.includes('--apply');
const ROOT = process.cwd();
const GAMES_JSON = path.join(ROOT, 'games', 'games.json');

const data = JSON.parse(fs.readFileSync(GAMES_JSON, 'utf8'));
const games = Array.isArray(data) ? data : data.games;

// Titles we've seen as definitely useless — fall back to humanized id.
const USELESS_TITLE_PATTERNS = [
    /^game\s*\d*$/i,
    /^really cool flash game$/i,
    /^waflash$/i,
    /^pico-?8 cartridge$/i,
    /^coolgames?$/i,
    /^untitled/i,
    /^index\.?$/i,
    /^document$/i,
    /^new project/i,
    /^index$/i,
    /^play$/i,
    /^embed$/i,
];

// Decorations to strip from real titles.
function cleanTitle(raw) {
    let t = (raw || '').trim();
    // Decode HTML entities (titles sometimes have &amp; &#39; &nbsp;)
    t = t.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    // Strip "Unity WebGL Player | " prefix
    t = t.replace(/^Unity WebGL Player\s*[|:-]\s*/i, '');
    // Strip "Construct" / "Construct 3" suffix
    t = t.replace(/\s*[-|]\s*Construct\s*\d*$/i, '');
    // Strip "by FreezeNova", "- Newgrounds.com", "| Crazy Games" tail markers
    t = t.replace(/\s*[-|]\s*(Newgrounds|FreezeNova|Crazy ?Games?|Y8|Poki|Kongregate|Armor Games?|itch\.io|Kongregate.com|Newgrounds\.com)(\.com)?\s*$/i, '');
    // Strip "FreezeNova" prefix on a Free-themed alien sky title
    t = t.replace(/^FreezeNova\s*[-|]\s*/i, '');
    // Squash whitespace
    t = t.replace(/\s+/g, ' ').trim();
    return t;
}

// Last-resort title from id: "clachievementunlocked2" -> "Achievement Unlocked 2"
function humanizeId(id) {
    let s = String(id || '');
    if (s.startsWith('cl')) s = s.slice(2);
    // Insert space before trailing digits (achievement2 -> achievement 2)
    s = s.replace(/([a-z])(\d)/gi, '$1 $2');
    // Lowercase known game-name particles back down after capitalizing.
    // First capitalize each word.
    s = s.replace(/\b\w/g, c => c.toUpperCase());
    // Common acronym/keyword fixes
    s = s.replace(/\bFnf\b/gi, 'FNF')
         .replace(/\bFna?f\b/gi, 'FNAF')
         .replace(/\bGta\b/gi, 'GTA')
         .replace(/\bNfs\b/gi, 'NFS')
         .replace(/\bIo\b/gi, 'IO')
         .replace(/\b(\d)d\b/gi, '$1D')
         .replace(/\bUsa\b/gi, 'USA')
         .replace(/\bNba\b/gi, 'NBA')
         .replace(/\bNfl\b/gi, 'NFL')
         .replace(/\bMmo\b/gi, 'MMO')
         .replace(/\bRpg\b/gi, 'RPG')
         .replace(/\bFps\b/gi, 'FPS')
         .replace(/\bUfc\b/gi, 'UFC')
         .replace(/\bMlb\b/gi, 'MLB');
    return s.trim();
}

// Keyword → (category, extra tags). Order matters — first match wins.
const CATEGORY_RULES = [
    { kw: /\bfnf\b|friday night funkin/i,           cat: 'Other',      tags: ['fnf', 'rhythm', 'mod'] },
    { kw: /\bfnaf\b|five nights/i,                  cat: 'Horror',     tags: ['fnaf', 'horror', 'jumpscare'] },
    { kw: /\bsonic\b/i,                             cat: 'Sonic',      tags: ['sonic', 'platformer', 'fast-paced'] },
    { kw: /\bmario\b/i,                             cat: 'Mario',      tags: ['mario', 'platformer', 'classic'] },
    { kw: /\bpokemon\b|\bpoke?mon\b/i,              cat: 'Pokemon',    tags: ['pokemon', 'monster-tamer', 'rpg'] },
    { kw: /minecraft|\bmc\b/i,                      cat: 'Minecraft',  tags: ['minecraft', 'sandbox', 'voxel'] },
    { kw: /\bgta\b|grand theft|gangster/i,          cat: 'Action',     tags: ['gta-like', 'open-world', 'crime'] },
    { kw: /\bnfs\b|need for speed|racing|race|drift|drag|car ?game|\bcars?\b|gran turismo|\bf1\b|nascar/i,
                                                    cat: 'Racing',     tags: ['racing', 'cars', 'arcade'] },
    { kw: /shooter|shooting|sniper|\bfps\b|gun |\bcs\b|counter[ -]?strike|battlefield|swat/i,
                                                    cat: 'Shooter',    tags: ['shooter', 'guns', 'action'] },
    { kw: /horror|scary|zombie|haunted|nightmare|abandoned|deep sleep|slender/i,
                                                    cat: 'Horror',     tags: ['horror', 'scary', 'atmospheric'] },
    { kw: /platform|jump|run\b|hop\b/i,             cat: 'Platformer', tags: ['platformer', 'jumping', '2d'] },
    { kw: /puzzle|sudoku|tetris|block|match[ -]?3|jigsaw|mahjong|2048/i,
                                                    cat: 'Puzzle',     tags: ['puzzle', 'logic', 'casual'] },
    { kw: /strategy|tower defen[cs]e|\bttd\b|chess|rts\b|tactics/i,
                                                    cat: 'Strategy',   tags: ['strategy', 'thinking', 'tactical'] },
    { kw: /fight|brawl|combat|street fighter|\bmk\b|mortal/i,
                                                    cat: 'Fighting',   tags: ['fighting', 'combat', 'versus'] },
    { kw: /soccer|football|basket|tennis|golf|sport|hockey|baseball|bowling|skate|surf/i,
                                                    cat: 'Sports',     tags: ['sports', 'arcade', 'multiplayer'] },
    { kw: /rpg|adventure|quest|kingdom|dragon|sword|knight|epic|saga|hero/i,
                                                    cat: 'Adventure',  tags: ['adventure', 'exploration', 'story'] },
    { kw: /simul|tycoon|farm|city build|empire|management|cook|clinic|sim\b|idle|incremental|clicker/i,
                                                    cat: 'Simulation', tags: ['simulation', 'management', 'idle'] },
    { kw: /achievement|escape|find|hidden|spot the/i,
                                                    cat: 'Adventure',  tags: ['point-and-click', 'puzzle', 'casual'] },
    { kw: /madness/i,                               cat: 'Action',     tags: ['madness-combat', 'action', 'animation'] },
    { kw: /papa('?s)?\s+\w+ria/i,                   cat: 'Simulation', tags: ['papas', 'cooking', 'time-management'] },
    { kw: /vex\b|stickman|stick figure|stick fight/i,
                                                    cat: 'Platformer', tags: ['stickman', 'platformer', 'parkour'] },
    { kw: /troll|impossible|frustrat/i,             cat: 'Puzzle',     tags: ['troll-game', 'difficult', 'humor'] },
];

function classify(title) {
    const t = title.toLowerCase();
    for (const rule of CATEGORY_RULES) {
        if (rule.kw.test(t)) return rule;
    }
    return { cat: 'Other', tags: ['arcade', 'classic'] };
}

function extractTitleFromHtml(htmlPath) {
    if (!htmlPath || !fs.existsSync(htmlPath)) return null;
    try {
        const html = fs.readFileSync(htmlPath, 'utf8');
        const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        if (!m) return null;
        return m[1];
    } catch { return null; }
}

// Many UGS-pack games carry no useful HTML title but their SWF filename
// is the actual game name: "Abandoned_3_Kongregate.swf" → "Abandoned 3".
function extractTitleFromSwf(htmlPath) {
    if (!htmlPath || !fs.existsSync(htmlPath)) return null;
    try {
        const html = fs.readFileSync(htmlPath, 'utf8');
        // Look for ".../Some_Game_Name_Kongregate.swf" or similar
        const m = html.match(/[\/"']([A-Z][^\/"'`]*?)\.swf['"`]/);
        if (!m) return null;
        let name = m[1];
        // Strip portal suffixes
        name = name.replace(/[_-]?(Kongregate|Newgrounds|Armor|Y8|FreeOnlineGames|FOG)$/i, '');
        // _ and - become spaces
        name = name.replace(/[_]+/g, ' ').replace(/-+/g, ' ').trim();
        // Squash whitespace
        name = name.replace(/\s+/g, ' ');
        return name;
    } catch { return null; }
}

// Preserve the trailing series number from the id if the chosen title
// doesn't already end with the same number ("Abandoned" + id "clabandoned3"
// → "Abandoned 3").
function appendIdSeries(title, id) {
    if (!title || !id) return title;
    const idMatch = String(id).match(/(\d+)$/);
    if (!idMatch) return title;
    const n = idMatch[1];
    const titleEnd = title.match(/(\d+)\s*$/);
    if (titleEnd && titleEnd[1] === n) return title;
    if (titleEnd) return title; // title has a different number — leave alone
    return `${title} ${n}`;
}

function isUselessTitle(t) {
    if (!t) return true;
    return USELESS_TITLE_PATTERNS.some(p => p.test(t));
}

// ─── Main ─────────────────────────────────────────────────────────
let updated = 0;
let titleFromHtml = 0;
let titleFromId = 0;
const samples = [];

for (const g of games) {
    if (!/^Cl[a-z0-9]/.test(g.title || '')) continue;

    const rawHtmlTitle = extractTitleFromHtml(g.path);
    const cleanedHtmlTitle = rawHtmlTitle ? cleanTitle(rawHtmlTitle) : '';

    let newTitle;
    if (cleanedHtmlTitle && !isUselessTitle(cleanedHtmlTitle) && cleanedHtmlTitle.length >= 3) {
        newTitle = cleanedHtmlTitle;
        titleFromHtml++;
    } else {
        // Try the SWF filename next — often more useful than humanizeId
        const swfTitle = extractTitleFromSwf(g.path);
        if (swfTitle && swfTitle.length >= 3 && !isUselessTitle(swfTitle)) {
            newTitle = swfTitle;
            titleFromHtml++;
        } else {
            newTitle = humanizeId(g.id);
            titleFromId++;
        }
    }
    // If the id has a trailing series number ("3") and the title doesn't,
    // append it so "Abandoned 3" doesn't end up as just "Abandoned".
    newTitle = appendIdSeries(newTitle, g.id);

    const { cat, tags: catTags } = classify(newTitle);

    // Existing tags — keep, just dedupe with new ones
    const existing = Array.isArray(g.tags) ? g.tags : [];
    const merged = new Set([...existing, ...catTags, 'flash', 'ruffle', 'classic']);
    // If wrapper points at an SWF on jsdelivr (UGS pack), tag for filterability
    if (g.path && fs.existsSync(g.path)) {
        const html = fs.readFileSync(g.path, 'utf8');
        if (/cdn\.jsdelivr\.net.*\.swf/i.test(html)) merged.add('ugs-pack');
    }

    g.title = newTitle;
    g.category = (g.category && g.category !== 'Other') ? g.category : cat;
    g.tags = Array.from(merged);
    if (!g.description) {
        g.description = `${newTitle} — a Flash game preserved in the arcade. Runs in your browser via the Ruffle emulator, no plugins needed.`;
    }
    // Deliberately NOT setting addedAt: these are legacy bulk-imports
    // without thumbnails, so adding addedAt would put them under the
    // validator's strict-quality gate and drown a real diff in noise.
    // The catalog-health "Missing addedAt" bucket will keep listing them
    // (correct) until we backfill thumbnails + descriptions properly.
    updated++;
    if (samples.length < 12) samples.push({ id: g.id, title: newTitle, category: g.category, tags: g.tags.slice(0, 5) });
}

console.log(`Updated ${updated} entries`);
console.log(`  - title from HTML <title>:  ${titleFromHtml}`);
console.log(`  - title humanized from id:  ${titleFromId}`);
console.log('\nSample updates:');
for (const s of samples) console.log(' ', JSON.stringify(s));

if (DRY) {
    console.log('\n(dry run — no files written. Pass --apply to write)');
} else {
    fs.writeFileSync(GAMES_JSON, JSON.stringify(games, null, 2));
    console.log('\n✅ games.json updated.');
}
