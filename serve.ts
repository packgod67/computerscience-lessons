// Deno Deploy entry point — serves the arcade as a static site with the
// same per-path COOP/COEP/CORP headers we use on Cloudflare Pages and
// Render's `_headers` file. Without this, /play/ would lose cross-origin
// isolation on the Deno mirror and PS2 emulation would break.
//
// Setup on Deno Deploy:
//   1. dash.deno.com → New Project → Deploy from GitHub
//   2. Pick packgod67/computerscience-lessons, branch main
//   3. Entrypoint: serve.ts  (this file)
//   4. Production branch: main
//   5. Deploy.
// The dashboard auto-redeploys on every push.

import { serveDir } from "https://deno.land/std@0.224.0/http/file_server.ts";

// Headers applied to every /play/* response so SharedArrayBuffer works
// inside the Play! PS2 emulator. Mirrors workers/groq-proxy.js + _headers
// + vercel.json — same rules, three different syntaxes per host.
const PLAY_HEADERS = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "cross-origin",
};

// itch.io HTML proxy at /itch/<game_path>.
//
// Mirror of the same-named handler in workers/groq-proxy.js, ported to
// Deno because *.workers.dev is on a lot of tracker blocklists (Chrome's
// Privacy Sandbox, security AVs, school/work network filters) — that
// bites users in their normal Chrome profile. *.deno.net isn't on those
// blocklists, so iframing through Deno just works.
//
// What this does:
//   1. Fetches html-classic.itch.zone/html/<game_path> server-side
//   2. If the response is HTML, strips the static.itch.io/htmlgame.js
//      script tag (itch's hotlink-check that redirects iframes from
//      foreign origins to itch.io/embed-hotlink/<id>) and injects a
//      <base href> so the game's relative-URL asset fetches loop back
//      through this proxy
//   3. Adds CORS + CORP headers to every response so the iframe works
//      cross-origin
//   4. Passes binary sub-resources straight through
//
// Pattern:
//   /itch/17009622/index.html         → html-classic.itch.zone/html/17009622/index.html
//   /itch/17009622/foo/bar.js         → html-classic.itch.zone/html/17009622/foo/bar.js
//   /itch/1418191-733102/Vapor%20Trails/index.html
//                                     → html-classic.itch.zone/html/1418191-733102/Vapor%20Trails/index.html
async function proxyItch(req: Request, url: URL): Promise<Response> {
    const itchPath = url.pathname.slice("/itch/".length);
    if (!itchPath) {
        return new Response('{"error":"missing itch path"}', {
            status: 400,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
    }
    const upstreamUrl = `https://html-classic.itch.zone/html/${itchPath}`;

    let upstream: Response;
    try {
        const fwdHeaders: Record<string, string> = { "User-Agent": "arcade-itch-proxy" };
        const range = req.headers.get("range");
        if (range) fwdHeaders["Range"] = range;
        upstream = await fetch(upstreamUrl, {
            method: req.method,
            headers: fwdHeaders,
            redirect: "follow",
        });
    } catch (e) {
        const msg = (e as Error).message || String(e);
        return new Response(JSON.stringify({ error: "fetch failed: " + msg }), {
            status: 502,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
    }

    const contentType = upstream.headers.get("content-type") || "";

    const respHeaders = new Headers();
    for (
        const k of [
            "content-type",
            "content-length",
            "cache-control",
            "last-modified",
            "etag",
            "accept-ranges",
            "content-range",
        ]
    ) {
        const v = upstream.headers.get(k);
        if (v) respHeaders.set(k, v);
    }
    respHeaders.set("Access-Control-Allow-Origin", "*");
    respHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
    respHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
    if (!respHeaders.get("cache-control")) {
        respHeaders.set("Cache-Control", "public, max-age=3600");
    }

    if (contentType.includes("text/html") && upstream.status === 200) {
        let body = await upstream.text();

        // Strip itch's hotlink-check script. Matches https://, //, and
        // any quoting style — the script is always a standalone tag
        // with no inline content.
        body = body.replace(
            /<script[^>]*\bsrc\s*=\s*["'][^"']*\/\/static\.itch\.io\/htmlgame\.js[^"']*["'][^>]*><\/script>\s*/gi,
            "",
        );

        // <base href> so relative URLs loop back through this proxy.
        const lastSlash = itchPath.lastIndexOf("/");
        const baseDir = lastSlash >= 0 ? itchPath.slice(0, lastSlash + 1) : "";
        const baseTag = `<base href="https://${url.host}/itch/${baseDir}">`;

        if (/<head[^>]*>/i.test(body)) {
            body = body.replace(/<head[^>]*>/i, (m) => `${m}${baseTag}`);
        } else if (/<\/head>/i.test(body)) {
            body = body.replace(/<\/head>/i, `${baseTag}</head>`);
        } else {
            body = `<head>${baseTag}</head>` + body;
        }

        respHeaders.delete("content-length");
        respHeaders.set("Content-Type", "text/html; charset=utf-8");
        return new Response(body, { status: upstream.status, headers: respHeaders });
    }

    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

Deno.serve(async (req: Request) => {
    const url = new URL(req.url);

    // /itch/* → itch HTML proxy. Must run before serveDir so it isn't
    // intercepted by the static file handler (there's no /itch/ dir
    // on disk anyway, but the static handler would return a 404 page
    // instead of running our proxy).
    if (url.pathname.startsWith("/itch/")) {
        return proxyItch(req, url);
    }
    if (req.method === "OPTIONS" && url.pathname === "/itch") {
        return new Response(null, {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Range",
                "Access-Control-Max-Age": "86400",
            },
        });
    }

    // Serve the repo as a static site rooted at /.
    const response = await serveDir(req, {
        fsRoot: ".",
        showDirListing: false,
        showIndex: true,
        quiet: true,
    });

    // Always wrap the response so we can attach a diagnostic header that
    // proves serve.ts is the active handler on Deno Deploy. Without this,
    // we can't tell from outside whether the deploy is using our handler
    // or Deno's zero-config static fallback (which would skip COOP/COEP).
    const headers = new Headers(response.headers);
    headers.set("x-arcade-serve-ts", "v1");

    // Layer on COOP/COEP for /play/* (and the WASM file specifically).
    if (url.pathname.startsWith("/play/")) {
        for (const [k, v] of Object.entries(PLAY_HEADERS)) {
            headers.set(k, v);
        }
        // Pin the WASM Content-Type — some Deno-served paths default to
        // application/octet-stream which makes the streaming compiler unhappy.
        if (url.pathname.endsWith(".wasm")) {
            headers.set("Content-Type", "application/wasm");
        }
    }

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
});
