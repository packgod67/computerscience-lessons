// Arcade site config. Commit edits here so they ship to all users.
// Individual users can override by setting the matching localStorage key.

window.ARCADE_CONFIG = {
    // Cloudflare Worker URL that proxies the LLM providers for Kirky.
    // Leave empty (null) to fall back to pollinations.ai only.
    groqWorkerUrl: 'https://arcad-groq.gatabanumai.workers.dev',
};
