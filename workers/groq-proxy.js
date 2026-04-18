// Cloudflare Worker: multi-provider LLM proxy for the Arcade.
//
// Routes to Cerebras / Groq / Gemini based on a `provider` field in the
// request body. All three expose OpenAI-compatible chat completion APIs,
// so the request/response shape stays identical from the browser's
// perspective. Keeps streaming (SSE) + tool calling passthroughs.
//
// ─────────────────────────────────────────────────────────────────
// DEPLOY
//
// 1. Paste this entire file into your Cloudflare Worker's editor and Deploy.
//
// 2. Add secrets (Worker → Settings → Variables and Secrets):
//      CEREBRAS_API_KEY   (recommended, 14K req/day free)
//      GROQ_API_KEY       (current, 1K req/day free)
//      GEMINI_API_KEY     (optional 3rd pool, 1K req/day free)
//    You only need ONE of them, but the more you add, the more headroom
//    the arcade's Kirky chatbot gets before hitting rate limits.
//
// 3. The client (js/chatbot.js) sends `{ provider, model, messages, ... }`
//    and this worker routes accordingly.
// ─────────────────────────────────────────────────────────────────

const PROVIDERS = {
    cerebras: {
        url: 'https://api.cerebras.ai/v1/chat/completions',
        defaultModel: 'llama-3.3-70b',
        keys: ['CEREBRAS_API_KEY', 'cerebras', 'CEREBRAS'],
    },
    groq: {
        url: 'https://api.groq.com/openai/v1/chat/completions',
        defaultModel: 'llama-3.3-70b-versatile',
        keys: ['GROQ_API_KEY', 'groq', 'GROQ'],
    },
    gemini: {
        url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        defaultModel: 'gemini-2.5-flash-lite',
        keys: ['GEMINI_API_KEY', 'gemini', 'GEMINI'],
    },
};

const ALLOWED_ORIGIN = '*';
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
};

function pickKey(env, names) {
    for (const n of names) {
        if (env[n]) return env[n];
    }
    return null;
}

export default {
    async fetch(request, env) {
        // CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        if (request.method !== 'POST') {
            return json({ error: 'POST only' }, 405);
        }

        let body;
        try {
            body = await request.json();
        } catch {
            return json({ error: 'Body must be JSON' }, 400);
        }

        // Resolve provider. Default to 'groq' for backward-compat with clients
        // that predate the multi-provider routing.
        const providerName = (body.provider || 'groq').toLowerCase();
        const provider = PROVIDERS[providerName];
        if (!provider) {
            return json({
                error: `Unknown provider '${providerName}'. Valid: cerebras, groq, gemini`,
            }, 400);
        }

        const upstreamUrl = provider.url;
        const apiKey = pickKey(env, provider.keys);
        if (!apiKey) {
            return json({
                error: `${providerName} API key not configured. Add one of: ${provider.keys.join(', ')}`,
            }, 503);
        }

        const messages = Array.isArray(body.messages) ? body.messages : null;
        if (!messages || messages.length === 0) {
            return json({ error: 'Missing messages[]' }, 400);
        }

        // Size guard so nobody abuses this worker to blast quota with
        // enormous prompts
        const raw = JSON.stringify(messages);
        if (raw.length > 80_000) {
            return json({ error: 'Request too large (>80KB)' }, 413);
        }

        // Build the upstream payload. All three providers accept the same
        // OpenAI-compatible shape, with minor quirks handled below.
        const wantStream = body.stream === true;
        const upstreamPayload = {
            model: body.model || provider.defaultModel,
            messages: messages,
            temperature: typeof body.temperature === 'number' ? body.temperature : 0.4,
            max_tokens: Math.min(body.max_tokens || 1024, 2048),
            stream: wantStream,
        };
        if (body.response_format) upstreamPayload.response_format = body.response_format;
        if (body.seed !== undefined) upstreamPayload.seed = body.seed;
        if (Array.isArray(body.tools)) upstreamPayload.tools = body.tools;
        if (body.tool_choice) upstreamPayload.tool_choice = body.tool_choice;

        // Gemini's OpenAI-compat layer doesn't accept `seed`, and sometimes
        // rejects other unknown fields. Prune defensively.
        if (providerName === 'gemini') {
            delete upstreamPayload.seed;
        }

        // 30s timeout so a slow upstream can't tie up the worker
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);

        let upstream;
        try {
            upstream = await fetch(upstreamUrl, {
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

        // Propagate 429 with Retry-After so the client can cool down
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

        // Streaming: pipe SSE back with proper headers
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
