// Arcade site config. Commit edits here so they ship to all users.
// Individual users can override by setting the matching localStorage key.

window.ARCADE_CONFIG = {
    // Cloudflare Worker URL that proxies the Groq API for the AI recommender.
    // Leave empty (null) to fall back to the free pollinations.ai provider.
    //
    // To set up: deploy workers/groq-proxy.js to your Cloudflare account
    //            with a GROQ_API_KEY secret, then paste the worker URL here.
    //            See workers/README.md for step-by-step instructions.
    //
    // Example:  groqWorkerUrl: 'https://arcade-groq.packgod67.workers.dev',
    groqWorkerUrl: 'https://arcad-groq.gatabanumai.workers.dev',
};
