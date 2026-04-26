#!/usr/bin/env node
// Catalog validator — run before committing batch-game additions.
// Enforces the house rule from CLAUDE.md: every entry with addedAt
// must have a non-fallback thumbnail, a real description, 4+ tags
// including a platform tag, and a specific category.
//
// Usage:
//   node validate-catalog.mjs
//   exits 0 on clean, 1 on any issue.
//
// We only check entries with `addedAt` set so this doesn't fight
// thousands of legacy stub entries — the rule is for things WE add
// going forward.

import fs from 'fs';

const PLATFORM_TAGS = new Set([
    'gba', 'gbc', 'gb', 'ds', 'n64', 'psx', 'ps2', 'nes', 'snes',
    'genesis', 'arcade', 'html5', 'itch', 'browser-native', 'external',
    'rom-hack',
]);

const VALID_CATEGORIES = new Set([
    'Pokemon', 'Racing', 'Adventure', 'Action', 'Sports', 'Puzzle',
    'Strategy', 'Simulation', 'Shooter', 'Platformer', 'Fighting',
    'Horror', 'Mario', 'Sonic', 'Minecraft', 'Other', 'Retro',
    'Multiplayer', 'Arcade', 'RPG',
]);

function load() {
    return JSON.parse(fs.readFileSync('games/games.json', 'utf8'));
}

function validate(entry) {
    const issues = [];

    // 1. Cover image — non-fallback
    if (!entry.thumbnail) {
        issues.push('missing thumbnail');
    } else if (entry.thumbnail.includes('assets/thumbnails/platforms/')) {
        issues.push('thumbnail is platform-fallback (use a real cover)');
    }

    // 2. Description — real, not stub
    if (!entry.description) {
        issues.push('missing description');
    } else if (entry.description.length < 30) {
        issues.push(`description too short (${entry.description.length} chars, want 30+)`);
    } else if (/from\s+\w+\.(net|com|org)\s+via/i.test(entry.description)) {
        issues.push('description is a stub ("from X via Y")');
    }

    // 3. Tags — 4+ specific, including a platform tag
    const tags = entry.tags || [];
    if (tags.length < 4) {
        issues.push(`too few tags (${tags.length}, want 4+)`);
    }
    const hasPlatformTag = tags.some(t => PLATFORM_TAGS.has(t));
    if (!hasPlatformTag && entry.rom !== null) {
        issues.push(`missing platform tag (one of: ${[...PLATFORM_TAGS].slice(0, 8).join(', ')}…)`);
    }

    // 4. Category — specific
    if (!entry.category) {
        issues.push('missing category');
    } else if (!VALID_CATEGORIES.has(entry.category)) {
        issues.push(`unknown category "${entry.category}" — add to VALID_CATEGORIES if intended`);
    }

    return issues;
}

const games = load();
const recent = games.filter(x => x.addedAt);
console.log(`Validating ${recent.length} entries with addedAt timestamp…\n`);

let badCount = 0;
for (const entry of recent) {
    const issues = validate(entry);
    if (issues.length === 0) continue;
    badCount++;
    console.log(`❌ ${entry.id}  (${entry.title || '?'})`);
    for (const i of issues) console.log(`     · ${i}`);
}

if (badCount === 0) {
    console.log(`✅ All ${recent.length} recent entries pass.`);
    process.exit(0);
} else {
    console.log(`\n❌ ${badCount}/${recent.length} entries failed validation.`);
    process.exit(1);
}
