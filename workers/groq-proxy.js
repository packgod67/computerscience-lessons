// Cloudflare Worker: multi-provider LLM proxy for the Arcade.
//
// Routes chat-completion requests to multiple backends based on a
// `provider` field in the request body. All return an OpenAI-compatible
// shape so the browser code doesn't care which one served the request.
//
// Providers:
//   cloudflare — Workers AI binding (env.AI). 10k neurons/day free.
//                No external API key needed. Lowest latency since it
//                runs on the same Cloudflare edge as this worker.
//   cerebras   — api.cerebras.ai. 30 RPM / 14,400 RPD / 1M tokens/day.
//   groq       — api.groq.com. 30 RPM / 14.4K RPD (Llama 3.1 8B) or
//                1K RPD (Llama 3.3 70B). Very fast.
//   gemini     — Google AI Studio. 10-15 RPM / 500-1K RPD.
//
// ─────────────────────────────────────────────────────────────────
// DEPLOY
//
// 1. Paste this entire file into your Cloudflare Worker's editor, Deploy.
//
// 2. Bindings (Worker → Settings → Bindings):
//      AI            binding type=Workers AI, variable name=AI
//
// 3. Secrets (Worker → Settings → Variables and Secrets):
//      CEREBRAS_API_KEY   optional, 14K req/day free
//      GROQ_API_KEY       optional, existing
//      GEMINI_API_KEY     optional, extra fallback pool
//
// 4. Client (js/chatbot.js) sends `{ provider, model, messages, ... }`
//    and this worker routes accordingly.
// ─────────────────────────────────────────────────────────────────

const PROVIDERS = {
    cloudflare: {
        kind: 'native',   // uses env.AI, no external fetch
        defaultModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    },
    cerebras: {
        kind: 'openai',
        url: 'https://api.cerebras.ai/v1/chat/completions',
        defaultModel: 'llama-3.3-70b',
        keys: ['CEREBRAS_API_KEY', 'cerebras', 'CEREBRAS'],
    },
    groq: {
        kind: 'openai',
        url: 'https://api.groq.com/openai/v1/chat/completions',
        defaultModel: 'llama-3.3-70b-versatile',
        keys: ['GROQ_API_KEY', 'groq', 'GROQ'],
    },
    gemini: {
        kind: 'openai',
        url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        defaultModel: 'gemini-2.5-flash-lite',
        keys: ['GEMINI_API_KEY', 'gemini', 'GEMINI'],
    },
};

const ALLOWED_ORIGIN = '*';
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    // GET/HEAD so the ROM proxy accepts range probes + actual downloads.
    // Range is in Allow-Headers so Play!'s parallel downloader can send it.
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range',
    'Access-Control-Max-Age': '86400',
};

function pickKey(env, names) {
    for (const n of names) {
        if (env[n]) return env[n];
    }
    return null;
}

// Hosts the ROM proxy will fetch from. The full allow-list is checked
// in `isHostAllowed()` below, which understands wildcards. Anything else
// returns 403. Adding a host here means we trust its content and our
// users to not abuse it as a generic open proxy.
//
// Mix of:
//   - Archive.org (primary retail-ROM source)
//   - GitHub family (ROM hacks in repos, big files via Releases)
//   - Mirroring CDNs (jsDelivr, Statically — both proxy GitHub)
//   - Other code-hosting platforms (GitLab, Codeberg) for projects
//     that moved off GitHub
//   - Cloudflare Pages / R2 — for self-hosted ROM mirrors
//   - itch.io's underlying CDN (game assets, occasionally needed for
//     CORS-blocked fetches inside iframed itch games)
const ROM_ALLOWED_HOSTS_DOC = `
  archive.org and *.archive.org      retail console ROMs
  raw.githubusercontent.com          GitHub raw files (100 MB cap)
  objects.githubusercontent.com      GitHub Releases assets (up to 2 GB)
  github.com                         direct repo URLs (rare)
  cdn.jsdelivr.net                   GitHub + npm CDN proxy
  cdn.statically.io                  alt CDN proxy for GitHub
  gitlab.com                         GitLab raw URLs
  *.gitlab.io                        GitLab Pages
  codeberg.org                       Gitea-based GitHub alternative
  *.pages.dev                        Cloudflare Pages
  *.r2.dev                           Cloudflare R2 public buckets
  *.itch.zone                        itch.io game asset CDN
  uploads.ungrounded.net             Newgrounds Flash SWF + HTML5 game
                                     uploads. ACAO is pinned to
                                     newgrounds.com so direct fetch from
                                     the arcade fails — Ruffle needs the
                                     SWF bytes via fetch(), so they have
                                     to come through this proxy.
`;

function isHostAllowed(host) {
    // archive.org and any subdomain (us.archive.org, dn720006.ca.archive.org, …)
    if (host === 'archive.org' || host.endsWith('.archive.org')) return true;

    // Exact-match hosts
    const exact = new Set([
        'raw.githubusercontent.com',
        'objects.githubusercontent.com',
        'github.com',
        'cdn.jsdelivr.net',
        'cdn.statically.io',
        'gitlab.com',
        'codeberg.org',
        'uploads.ungrounded.net',  // Newgrounds Flash SWFs (Ruffle source)
    ]);
    if (exact.has(host)) return true;

    // Wildcard suffixes — any subdomain of these
    const suffixes = ['.gitlab.io', '.pages.dev', '.r2.dev', '.itch.zone'];
    for (const s of suffixes) if (host.endsWith(s)) return true;

    return false;
}

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        const reqUrl = new URL(request.url);

        // ───────────────────────────────────────────────────────────
        // itch.io HTML proxy: GET /itch/<game_path>
        //
        // Routes around itch's hotlink protection. itch injects
        // `static.itch.io/htmlgame.js` into HTML5 games — that script
        // reads the parent frame's origin and redirects to
        // itch.io/embed-hotlink/<id> when the parent isn't itch.io.
        // 40% of recent itch games have it; modern Godot/GameMaker
        // games hotlink-redirect before their own engine takes over,
        // so they're broken when iframed from our arcade.
        //
        // Bypass: serve the game HTML through this worker, strip the
        // htmlgame.js script tag, inject a <base href> so the game's
        // relative-URL asset fetches loop back through this worker
        // (which proxies them through to itch). The iframe's origin
        // becomes the worker domain, the parent-origin check sees
        // the same worker domain (which doesn't match itch.io →
        // would normally trigger), but the script is gone before it
        // can fire.
        //
        // Pattern:
        //   /itch/<everything>           proxies html-classic.itch.zone/html/<everything>
        //
        //   /itch/17009622/index.html    →  html-classic.itch.zone/html/17009622/index.html
        //   /itch/17009622/foo/bar.js    →  html-classic.itch.zone/html/17009622/foo/bar.js
        //   /itch/1418191-733102/Vapor%20Trails/index.html
        //                                →  html-classic.itch.zone/html/1418191-733102/Vapor%20Trails/index.html
        //
        // HTML responses get rewritten; everything else passes through
        // with CORS + CORP headers added.
        if (reqUrl.pathname.startsWith('/itch/')) {
            const itchPath = reqUrl.pathname.slice('/itch/'.length);
            if (!itchPath) return json({ error: 'missing itch path' }, 400);
            const upstreamUrl = `https://html-classic.itch.zone/html/${itchPath}`;

            let upstream;
            try {
                // Forward Range so the browser's video/audio streaming
                // works. No special headers — itch returns a normal
                // public asset for anonymous-and-no-referer requests.
                const fwdHeaders = { 'User-Agent': 'arcade-itch-proxy' };
                const range = request.headers.get('range');
                if (range) fwdHeaders['Range'] = range;
                upstream = await fetch(upstreamUrl, {
                    method: request.method,
                    headers: fwdHeaders,
                    redirect: 'follow',
                });
            } catch (e) {
                return json({ error: 'fetch failed: ' + (e.message || String(e)) }, 502);
            }

            const contentType = upstream.headers.get('content-type') || '';

            // Build response headers — copy useful ones, force CORS,
            // add CORP for cross-origin-isolation friendliness, set a
            // short cache to keep proxy load down.
            const respHeaders = new Headers();
            for (const k of ['content-type', 'content-length', 'cache-control', 'last-modified', 'etag', 'accept-ranges', 'content-range']) {
                const v = upstream.headers.get(k);
                if (v) respHeaders.set(k, v);
            }
            respHeaders.set('Access-Control-Allow-Origin', '*');
            respHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
            respHeaders.set('Cross-Origin-Resource-Policy', 'cross-origin');
            if (!respHeaders.get('cache-control')) {
                respHeaders.set('Cache-Control', 'public, max-age=3600');
            }

            // HTML pages — rewrite to strip hotlink check + inject base href.
            if (contentType.includes('text/html') && upstream.status === 200) {
                let body = await upstream.text();

                // Strip itch's hotlink-check script. Matches all known
                // forms (https://, //, http://, with/without defer,
                // any quoting). The script is `<script defer src="..."></script>`
                // standalone — never inline content — so a single tag
                // remove is safe.
                body = body.replace(
                    /<script[^>]*\bsrc\s*=\s*["'][^"']*\/\/static\.itch\.io\/htmlgame\.js[^"']*["'][^>]*><\/script>\s*/gi,
                    ''
                );

                // Inject <base href> pointing back at this proxy so
                // every relative URL in the page resolves to /itch/...
                // and loops through this proxy. The base directory is
                // everything up to (and including) the last slash of
                // the original path.
                const lastSlash = itchPath.lastIndexOf('/');
                const baseDir = lastSlash >= 0 ? itchPath.slice(0, lastSlash + 1) : '';
                const baseTag = `<base href="https://${reqUrl.host}/itch/${baseDir}">`;

                // Insert right after <head ...>, falling back to before
                // </head> or to the start of the doc if no head exists.
                if (/<head[^>]*>/i.test(body)) {
                    body = body.replace(/<head[^>]*>/i, m => `${m}${baseTag}`);
                } else if (/<\/head>/i.test(body)) {
                    body = body.replace(/<\/head>/i, `${baseTag}</head>`);
                } else {
                    body = `<head>${baseTag}</head>` + body;
                }

                // Drop content-length since we rewrote the body.
                respHeaders.delete('content-length');
                respHeaders.set('Content-Type', 'text/html; charset=utf-8');

                return new Response(body, {
                    status: upstream.status,
                    headers: respHeaders,
                });
            }

            // Everything else — passthrough binary stream.
            return new Response(upstream.body, {
                status: upstream.status,
                headers: respHeaders,
            });
        }

        // ───────────────────────────────────────────────────────────
        // ROM proxy: GET /rom?src=<url>
        // Forwards a request to archive.org (and friends) with CORS
        // headers added. Needed because EmulatorJS fetches the ROM
        // directly and archive.org's download endpoint doesn't send
        // Access-Control-Allow-Origin.
        // ───────────────────────────────────────────────────────────
        if (reqUrl.pathname.startsWith('/rom')) {
            const src = reqUrl.searchParams.get('src');
            if (!src) return json({ error: 'missing src' }, 400);

            let target;
            try { target = new URL(src); } catch { return json({ error: 'invalid src url' }, 400); }
            if (target.protocol !== 'https:') {
                return json({ error: 'https only' }, 400);
            }
            const host = target.hostname;
            if (!isHostAllowed(host)) {
                return json({ error: 'host not allowed', host }, 403);
            }

            // Forward the request, preserving Range so EmulatorJS can
            // stream chunks. Follow redirects (archive.org 302s to a
            // region-specific download node).
            const fwdHeaders = { 'User-Agent': 'arcade-rom-proxy' };
            const range = request.headers.get('range');
            if (range) fwdHeaders['Range'] = range;

            let upstream;
            try {
                upstream = await fetch(src, {
                    // Forward the client's actual method. Previously this
                    // was hardcoded to GET, which meant a client HEAD probe
                    // caused the worker to GET the full file (multi-GB)
                    // before returning headers — turning a 200ms size check
                    // into a 30s+ stall and wrecking download speed when
                    // the page tried to check size before parallelizing.
                    method: request.method,
                    headers: fwdHeaders,
                    redirect: 'follow',
                });
            } catch (e) {
                return json({ error: 'fetch failed: ' + (e.message || String(e)) }, 502);
            }

            // Pass through status + body with CORS added
            const respHeaders = new Headers();
            // Copy essential headers from upstream
            for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
                const v = upstream.headers.get(key);
                if (v) respHeaders.set(key, v);
            }
            respHeaders.set('Access-Control-Allow-Origin', '*');
            respHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
            respHeaders.set('Cache-Control', 'public, max-age=86400');
            // The /play PS2 emulator runs under Cross-Origin-Embedder-Policy:
            // require-corp (mandatory for SharedArrayBuffer). Under that
            // policy, cross-origin subresources must advertise CORP or the
            // browser blocks them. Adding CORP: cross-origin here lets the
            // Play! iframe fetch PS2 ROMs through this proxy.
            respHeaders.set('Cross-Origin-Resource-Policy', 'cross-origin');
            return new Response(upstream.body, {
                status: upstream.status,
                headers: respHeaders,
            });
        }

        // ───────────────────────────────────────────────────────────
        // POST /  (LLM proxy — existing)
        // ───────────────────────────────────────────────────────────
        if (request.method !== 'POST') {
            return json({ error: 'POST only' }, 405);
        }

        let body;
        try {
            body = await request.json();
        } catch {
            return json({ error: 'Body must be JSON' }, 400);
        }

        const providerName = (body.provider || 'groq').toLowerCase();
        const provider = PROVIDERS[providerName];
        if (!provider) {
            return json({
                error: `Unknown provider '${providerName}'. Valid: ${Object.keys(PROVIDERS).join(', ')}`,
            }, 400);
        }

        const messages = Array.isArray(body.messages) ? body.messages : null;
        if (!messages || messages.length === 0) {
            return json({ error: 'Missing messages[]' }, 400);
        }
        const raw = JSON.stringify(messages);
        if (raw.length > 80_000) {
            return json({ error: 'Request too large (>80KB)' }, 413);
        }

        const model = body.model || provider.defaultModel;
        const temperature = typeof body.temperature === 'number' ? body.temperature : 0.4;
        const max_tokens = Math.min(body.max_tokens || 1024, 2048);
        const wantStream = body.stream === true;

        // ───────────────────────────────────────────────────────────
        // Cloudflare Workers AI — native binding, no external fetch.
        // Response is already OpenAI-shaped for most models.
        // ───────────────────────────────────────────────────────────
        if (provider.kind === 'native') {
            if (!env.AI) {
                return json({
                    error: 'Cloudflare AI binding not configured on this worker',
                }, 503);
            }
            try {
                const aiArgs = {
                    messages,
                    temperature,
                    max_tokens,
                    stream: wantStream,
                };
                if (Array.isArray(body.tools)) aiArgs.tools = body.tools;
                if (body.tool_choice) aiArgs.tool_choice = body.tool_choice;

                if (wantStream) {
                    // env.AI.run returns a ReadableStream for stream:true
                    const stream = await env.AI.run(model, aiArgs);
                    return new Response(stream, {
                        status: 200,
                        headers: {
                            ...CORS_HEADERS,
                            'Content-Type': 'text/event-stream',
                            'Cache-Control': 'no-cache, no-transform',
                            'Connection': 'keep-alive',
                        },
                    });
                }

                const result = await env.AI.run(model, aiArgs);
                // Normalize to OpenAI shape. Workers AI responses vary:
                //   - Most recent Llama: { response: "text", tool_calls?: [...] }
                //   - Some:              { choices: [{ message: {...} }] }
                if (result && result.choices) return json(result, 200);

                // Workers AI tool_calls look like [{name, arguments: {...}}]
                // but clients expect OpenAI format:
                //   [{id, type:'function', function:{name, arguments:'{...}'}}]
                // Rewrite them so the client's standard tool-call handler works.
                const rawCalls = result?.tool_calls || [];
                const toolCalls = rawCalls.map((tc, i) => {
                    if (tc.function) return tc;   // already in OpenAI shape
                    const argsObj = tc.arguments;
                    const argsStr = typeof argsObj === 'string'
                        ? argsObj
                        : JSON.stringify(argsObj || {});
                    return {
                        id: tc.id || `call_${Date.now()}_${i}`,
                        type: 'function',
                        function: {
                            name: tc.name,
                            arguments: argsStr,
                        },
                    };
                });

                return json({
                    id: `cf-${Date.now()}`,
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: result?.response || '',
                            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
                        },
                        finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
                    }],
                }, 200);
            } catch (e) {
                return json({
                    error: `cloudflare AI failed: ${e.message || String(e)}`,
                }, 502);
            }
        }

        // ───────────────────────────────────────────────────────────
        // External OpenAI-compatible providers (cerebras / groq / gemini)
        // ───────────────────────────────────────────────────────────
        const apiKey = pickKey(env, provider.keys);
        if (!apiKey) {
            return json({
                error: `${providerName} API key not configured. Add one of: ${provider.keys.join(', ')}`,
            }, 503);
        }

        const upstreamPayload = {
            model,
            messages,
            temperature,
            max_tokens,
            stream: wantStream,
        };
        if (body.response_format) upstreamPayload.response_format = body.response_format;
        if (body.seed !== undefined) upstreamPayload.seed = body.seed;
        if (Array.isArray(body.tools)) upstreamPayload.tools = body.tools;
        if (body.tool_choice) upstreamPayload.tool_choice = body.tool_choice;
        if (providerName === 'gemini') delete upstreamPayload.seed;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);

        let upstream;
        try {
            upstream = await fetch(provider.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + apiKey,
                },
                body: JSON.stringify(upstreamPayload),
                signal: controller.signal,
            });
        } catch (e) {
            clearTimeout(timeout);
            return json({
                error: `${providerName} request failed: ${e.message || 'timeout'}`,
            }, 504);
        }
        clearTimeout(timeout);

        if (upstream.status === 429) {
            const retryAfter = upstream.headers.get('retry-after') || '60';
            const text = await upstream.text();
            return new Response(JSON.stringify({
                error: `${providerName} rate limit`,
                detail: text.slice(0, 400),
            }), {
                status: 429,
                headers: {
                    ...CORS_HEADERS,
                    'Content-Type': 'application/json',
                    'Retry-After': retryAfter,
                },
            });
        }

        if (!upstream.ok) {
            const text = await upstream.text();
            return json({
                error: `${providerName} upstream error`,
                status: upstream.status,
                detail: text.slice(0, 400),
            }, upstream.status);
        }

        if (wantStream && upstream.body) {
            return new Response(upstream.body, {
                status: 200,
                headers: {
                    ...CORS_HEADERS,
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache, no-transform',
                    'Connection': 'keep-alive',
                },
            });
        }

        const data = await upstream.json();
        return json(data, 200);
    },
};

function json(obj, status) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json',
        },
    });
}
