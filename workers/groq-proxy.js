// Cloudflare Worker: Groq proxy for the Arcade AI recommender.
//
// Deploy this on a free Cloudflare Workers account, set the GROQ_API_KEY
// secret, and point js/recommender.js at your worker's URL. Users get
// Llama-3.3-70B-quality recommendations without ever seeing a key.
//
// ─────────────────────────────────────────────────────────────────
// DEPLOY (one-time setup, ~5 minutes):
//
// 1. Sign up for Groq at  https://console.groq.com/keys
//    Copy your API key (starts with `gsk_...`)
//
// 2. Sign up for Cloudflare at  https://dash.cloudflare.com/
//    Go to  Workers & Pages → Create → Create Worker
//    Name it  arcade-groq  (or anything you like)
//
// 3. Click "Edit Code" and paste the CONTENTS OF THIS FILE
//    Click "Deploy"
//
// 4. Go to the worker's Settings → Variables and Secrets
//    Add a SECRET (not a variable):
//      name:  GROQ_API_KEY
//      value: your gsk_... key from step 1
//    Click "Deploy" again
//
// 5. Copy the worker URL (something like
//    https://arcade-groq.yourname.workers.dev)
//    Paste it into the recommender settings (see README in this folder)
//
// Free tier covers 100,000 requests/day — more than enough unless the
// arcade gets TikTok-famous.
// ─────────────────────────────────────────────────────────────────

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

// Allow your arcade origin(s). "*" is fine here since the worker is just a
// recommender proxy with no secrets exposed to the client. If you want to
// lock it down, replace with your specific origin (e.g.
// 'https://packgod67.github.io').
const ALLOWED_ORIGIN = '*';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
};

export default {
    async fetch(request, env) {
        // CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        if (request.method !== 'POST') {
            return json({ error: 'POST only' }, 405);
        }

        // Accept the secret under either the canonical `GROQ_API_KEY` name
        // or the shorter `groq` name, so admins who configured it either
        // way Just Work without needing to rename.
        const groqKey = env.GROQ_API_KEY || env.groq || env.GROQ;
        if (!groqKey) {
            return json({ error: 'Groq API key secret not set on this worker (expected GROQ_API_KEY or groq)' }, 500);
        }

        let body;
        try {
            body = await request.json();
        } catch {
            return json({ error: 'Body must be JSON' }, 400);
        }

        const messages = Array.isArray(body.messages) ? body.messages : null;
        if (!messages || messages.length === 0) {
            return json({ error: 'Missing messages[]' }, 400);
        }

        // Basic request-size guard so nobody can abuse the worker to blast
        // Groq quota with enormous prompts.
        const raw = JSON.stringify(messages);
        if (raw.length > 50_000) {
            return json({ error: 'Request too large (>50KB)' }, 413);
        }

        // Build upstream payload. Pass through streaming + tools so the
        // chat assistant can use compound-beta's web browsing and receive
        // token-by-token deltas.
        const wantStream = body.stream === true;
        const upstreamPayload = {
            model: body.model || DEFAULT_MODEL,
            messages: messages,
            temperature: typeof body.temperature === 'number' ? body.temperature : 0.4,
            max_tokens: Math.min(body.max_tokens || 1024, 2048),
            stream: wantStream,
        };
        if (body.response_format) upstreamPayload.response_format = body.response_format;
        if (body.seed !== undefined) upstreamPayload.seed = body.seed;
        if (Array.isArray(body.tools)) upstreamPayload.tools = body.tools;
        if (body.tool_choice) upstreamPayload.tool_choice = body.tool_choice;

        // Forward to Groq with OUR key
        const upstream = await fetch(GROQ_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + groqKey,
            },
            body: JSON.stringify(upstreamPayload),
        });

        if (!upstream.ok) {
            const text = await upstream.text();
            return json({
                error: 'Groq upstream error',
                status: upstream.status,
                detail: text.slice(0, 400),
            }, upstream.status);
        }

        // Streaming: pipe the upstream SSE body straight back to the
        // browser. Keep the CORS headers and the text/event-stream type.
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
