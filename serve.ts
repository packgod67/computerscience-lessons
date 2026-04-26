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

Deno.serve(async (req: Request) => {
    const url = new URL(req.url);

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
