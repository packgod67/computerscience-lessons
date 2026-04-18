"""Scrape Pokemon cover art URLs from PokemonCoders (and fallbacks).

For each game in the target list, fetch the article page, extract the
first content image (ignoring logos/UI chrome), and record the URL.

Outputs: scripts/pokemon_covers.json  (mapping from game_id -> url)
"""
import json
import re
import sys
import urllib.request
import urllib.error
from pathlib import Path

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

# Map game_id -> (source_url, preferred source)
# source_url template may contain {slug}; source one of: pokemoncoders, pokeharbor
# We try multiple slug variants.
GAMES = {
    # High priority
    "clpokedarkrising":           ["pokemon-dark-rising"],
    "clpokeradicalred":           ["pokemon-radical-red"],
    "clpokemegapower":            ["pokemon-mega-power-rom-hack", "pokemon-mega-power"],
    "clpokemonemeraldkaizo":      ["pokemon-emerald-kaizo"],
    "clpokeflora":                ["pokemon-flora-sky"],
    "clpokemegamoemon":           ["pokemon-mega-moemon-firered", "pokemon-mega-moemon-emerald", "pokemon-moemon-emerald"],
    "clpokefrlgplus":             ["pokemon-firered-and-leafgreen-plus", "pokemon-firered-leafgreen-plus", "pokemon-firered-plus"],
    "clpokegschronicles":         ["pokemon-gs-chronicles"],
    "clpokeemeraldrogue":         ["pokemon-emerald-rogue"],
    "clPokeEmeraldRogueEX":       ["pokemon-emerald-rogue-ex"],
    "clpokeemeraldhorizons":      ["pokemon-emerald-horizons"],
    "clpokeemeraldimperium":      ["pokemon-emerald-imperium"],
    "clpokeemeraldz":             ["pokemon-emerald-z"],
    "clpokeemeraldrandom":        ["pokemon-emerald-randomizer", "pokemon-emerald-randomized"],
    "clpokefuseddimension":       ["pokemon-fused-dimensions", "pokemon-fused-dimension"],
    "clPokeFusion3":              ["pokemon-fusion-3"],
    "clpokeclassic":              ["pokemon-classic"],
    "clpokedreamstone":           ["pokemon-dreamstone", "pokemon-dream-stone"],
    "clpokeelysiuma":             ["pokemon-elysium-a", "pokemon-elysium"],
    "clpokeelysiumb":             ["pokemon-elysium-b", "pokemon-elysium"],
    "clpokeemeraldenhanced":      ["pokemon-emerald-enhanced"],
    "clpokefiregold":             ["pokemon-fire-gold", "pokemon-firegold"],
    "clPokeAmbrosia":             ["pokemon-ambrosia"],
    "clpokecrystaladvanceredux":  ["pokemon-crystal-advance-redux", "pokemon-crystal-advance"],
    "clpokeallin":                ["pokemon-all-in-one"],
    "clpokebattlefact":           ["pokemon-battle-factory"],
    # Extra scanned Pokemon games
    "clpokeblack2":               ["pokemon-black-2"],
    "clpokeblue":                 ["pokemon-blue"],
    "clpokemonamnesia":           ["pokemon-amnesia"],
    "clpokemoncrystal":           ["pokemon-crystal"],
    "clpokemonevolvedsfdgsdfs":   ["pokemon-evolved"],
    "clpokemonfireredandleafgreenplusedition": ["pokemon-firered-and-leafgreen-plus", "pokemon-firered-leafgreen-plus"],
    "clpokemonfireredrandomized": ["pokemon-firered-randomizer", "pokemon-firered-randomized"],
    "clpokemongold":              ["pokemon-gold"],
    "clpokemonkaizoironfirered":  ["pokemon-kaizo-iron-firered", "pokemon-iron-firered"],
    "clpokemonmodernemerald":     ["pokemon-modern-emerald"],
    "clpokemonperfectemerald5.5": ["pokemon-perfect-emerald"],
    "clpokemonroaringred":        ["pokemon-roaring-red"],
    "clPokemonrocketedition":     ["pokemon-rocket-edition"],
    "clpokemonsaiph":             ["pokemon-saiph"],
    "clpokemonsaiph2":            ["pokemon-saiph-2"],
    "clpokemonshinsigma":         ["pokemon-shin-sigma"],
    "clpokemonslgreen":           ["pokemon-sl-green"],
    "clpokemonsmred":             ["pokemon-sm-red"],
    "clpokemonsors":              ["pokemon-sors"],
    "clpokemonsors2":             ["pokemon-sors-2"],
    "clpokemonultimatefusion":    ["pokemon-ultimate-fusion"],
    "clpokemoonemerald":          ["pokemon-moon-emerald"],
    "clpokeperfectfirered":       ["pokemon-perfect-firered"],
    "clpokepolishedcrystal":      ["pokemon-polished-crystal"],
    "clpokepureblue":             ["pokemon-pure-blue"],
    "clpokepuregreen":            ["pokemon-pure-green"],
    "clpokepurered":              ["pokemon-pure-red"],
    "clpokerechargedpink":        ["pokemon-recharged-pink"],
    "clpokerechargedyellow":      ["pokemon-recharged-yellow"],
    "clpokerecordkeepers":        ["pokemon-record-keepers"],
    "clpokered":                  ["pokemon-red"],
    "clpokethepit":               ["pokemon-the-pit"],
    "clpoketoomanytypes2":        ["pokemon-too-many-types-2", "pokemon-too-many-types"],
    "clpokeunovaemerald":         ["pokemon-unova-emerald"],
    "clpokewhite2":               ["pokemon-white-2"],
    "clpokeyellow":               ["pokemon-yellow"],
}

IMG_RE = re.compile(r'(?:data-src|src)="(https?://[^"]+?\.(?:jpg|jpeg|png))(?:\?[^"]*)?"', re.IGNORECASE)

# These substrings mean the image is chrome, not a cover
BAD_SUBSTRINGS = [
    "logo",
    "avatar",
    "icon",
    "screenshots",
    "screenshot",
    "gravatar",
    "footer",
    "header",
    "pokeharbor-logo",
    "pokemoncoders-logo",
    "-150x150",
    "-100x100",
    "-180x180",
]


def fetch(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            if r.status != 200:
                return None
            data = r.read()
            return data.decode("utf-8", errors="replace")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
        return None


def head_ok(url, timeout=10):
    """Verify image URL responds 200 with an image content-type."""
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            if r.status != 200:
                return False, None
            ct = r.headers.get("Content-Type", "")
            cl = int(r.headers.get("Content-Length", "0") or 0)
            return ct.startswith("image/"), cl
    except Exception:
        return False, None


def candidates_from_html(html):
    """Extract candidate image URLs (in order of appearance)."""
    seen = set()
    out = []
    for m in IMG_RE.finditer(html):
        url = m.group(1)
        if url in seen:
            continue
        seen.add(url)
        lower = url.lower()
        if any(b in lower for b in BAD_SUBSTRINGS):
            continue
        if "/uploads/" not in lower:
            continue
        out.append(url)
    return out


def pick_cover(html):
    cands = candidates_from_html(html)
    # Prefer one with "cover" or game name in it; otherwise first
    for c in cands:
        if "cover" in c.lower():
            return c
    return cands[0] if cands else None


def try_pokemoncoders(slug):
    for path in ("pokemon-" + slug if not slug.startswith("pokemon-") else slug,
                 slug):
        url = f"https://www.pokemoncoders.com/{path}/"
        html = fetch(url)
        if html and "/uploads/" in html:
            cov = pick_cover(html)
            if cov:
                return cov, url
    return None, None


def try_pokeharbor(slug):
    # PokeHarbor URLs have year/month prefix; we search via their tag system
    # Simpler: fetch the site-search endpoint
    for path in (slug, "pokemon-" + slug if not slug.startswith("pokemon-") else slug):
        url = f"https://www.pokeharbor.com/?s={path}"
        html = fetch(url)
        if not html:
            continue
        # Find first article link
        m = re.search(r'href="(https://www\.pokeharbor\.com/20\d\d/\d\d/[^"]+)"', html)
        if not m:
            continue
        article_url = m.group(1)
        art_html = fetch(article_url)
        if not art_html:
            continue
        cov = pick_cover(art_html)
        if cov:
            return cov, article_url
    return None, None


def main():
    out_path = Path(__file__).parent / "pokemon_covers.json"
    existing = {}
    if out_path.exists():
        try:
            existing = json.loads(out_path.read_text("utf-8"))
        except Exception:
            existing = {}

    results = dict(existing)
    target_ids = [g for g in GAMES if g not in results]
    print(f"Already have: {len(results)}; target: {len(target_ids)}")

    for i, gid in enumerate(target_ids, 1):
        slugs = GAMES[gid]
        print(f"[{i}/{len(target_ids)}] {gid}")
        found = None
        source = None
        for slug in slugs:
            cov, src = try_pokemoncoders(slug)
            if cov:
                found, source = cov, src
                break
        if not found:
            for slug in slugs:
                cov, src = try_pokeharbor(slug)
                if cov:
                    found, source = cov, src
                    break
        if found:
            ok, size = head_ok(found)
            if ok:
                results[gid] = {"url": found, "source": source, "size": size}
                print(f"  OK {size}B  {found}")
            else:
                print(f"  HEAD failed: {found}")
        else:
            print(f"  NOT FOUND")

        # Checkpoint every 5
        if i % 5 == 0:
            out_path.write_text(json.dumps(results, indent=2), encoding="utf-8")

    out_path.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"\nWrote {len(results)} records to {out_path}")


if __name__ == "__main__":
    main()
