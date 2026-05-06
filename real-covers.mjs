// Replace AI-generated covers on the curated batch with real cover
// art sourced from each game's official site (og:image, hero image,
// or Wikipedia thumbnail). Falls back to image.thum.io free
// screenshot service for the few games that publish nothing.

import fs from 'node:fs';

const COVERS = {
    clUniversalPaperclips:
        'https://www.decisionproblem.com/paperclips/title.png',
    clADarkRoom:
        'https://adarkroom.doublespeakgames.com/img/adr.png',
    clCandyBox2:
        'https://image.thum.io/get/width/1024/crop/600/https://candybox2.github.io/candybox/',
    clTheWikipediaGame:
        'https://image.thum.io/get/width/1024/crop/600/https://www.thewikigame.com/',
    clCookieClicker:
        'https://upload.wikimedia.org/wikipedia/en/thumb/0/06/Cookie_Clicker_logo.png/330px-Cookie_Clicker_logo.png',
    clDrawasaurus:
        'https://www.drawasaurus.org/_next/static/media/cover.b97fbc1a.png',
    clSkribblIo:
        'https://skribbl.io/img/thumbnail.png',
    clGarticIo:
        'https://gartic.io/static/images/thumb.png?v=10',
    clTrimps:
        'https://image.thum.io/get/width/1024/crop/600/https://trimps.github.io/',
    clAntimatterDimensions:
        'https://ivark.github.io/AntimatterDimensions/icon.png',
    clShellShockIo:
        'https://www.shellshock.io/img/previewImage_shellShockers.webp',
    clKrunkerIo:
        'https://assets.krunker.io/promo/og.png',
    clSurvevIo:
        'https://surviv.io/img/title.png',
    clCelesteClassic:
        'https://www.lexaloffle.com/bbs/preview/pico15133.png',
    clHempuliBaba:
        'https://www.hempuli.com/baba/logo.gif',
};

const data = JSON.parse(fs.readFileSync('games/games.json', 'utf8'));
const games = Array.isArray(data) ? data : data.games;

let updated = 0;
for (const [id, url] of Object.entries(COVERS)) {
    const g = games.find(x => x.id === id);
    if (!g) { console.log(`SKIP (missing): ${id}`); continue; }
    g.thumbnail = url;
    console.log(`✓ ${id}`);
    updated++;
}
fs.writeFileSync('games/games.json', JSON.stringify(games, null, 2));
console.log(`\nUpdated ${updated} thumbnails.`);
