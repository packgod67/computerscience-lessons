// Build sitemap.xml from games.json so search engines can index every
// game card via the /?game=<id> universal-link route.
//
// Run: node generate-sitemap.mjs
// Hosts that auto-deploy from main pick up the rebuilt sitemap on push.
//
// Search engines need a hint that the same .html file with different
// query strings represents distinct pages. We use the universal-link
// pattern ?game=<id> which app.js's init() already handles to open the
// matching info modal. Each entry gets the game's addedAt as <lastmod>
// where available so reindexing focuses on recently-changed games.

import fs from 'node:fs';

const PRIMARY_HOST = 'https://computerscience-lessons.onrender.com';
const games = JSON.parse(fs.readFileSync('games/games.json', 'utf8'));

const today = new Date().toISOString().slice(0, 10);

const urls = [
    { loc: `${PRIMARY_HOST}/`, priority: '1.0', changefreq: 'daily', lastmod: today },
    { loc: `${PRIMARY_HOST}/install.html`, priority: '0.7', changefreq: 'weekly', lastmod: today },
    { loc: `${PRIMARY_HOST}/status.html`, priority: '0.3', changefreq: 'hourly', lastmod: today },
];

for (const g of games) {
    if (!g.id) continue;
    const lastmod = g.addedAt ? g.addedAt.slice(0, 10) : today;
    urls.push({
        loc: `${PRIMARY_HOST}/?game=${encodeURIComponent(g.id)}`,
        priority: '0.6',
        changefreq: 'monthly',
        lastmod,
    });
}

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `    <url>
        <loc>${u.loc}</loc>
        <lastmod>${u.lastmod}</lastmod>
        <changefreq>${u.changefreq}</changefreq>
        <priority>${u.priority}</priority>
    </url>`).join('\n')}
</urlset>
`;

fs.writeFileSync('sitemap.xml', xml);
console.log(`Wrote sitemap.xml — ${urls.length} URLs.`);
