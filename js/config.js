// Arcade site config. Commit edits here so they ship to all users.
// Individual users can override by setting the matching localStorage key.

window.ARCADE_CONFIG = {
    // Cloudflare Worker URL that proxies the LLM providers for Kirky.
    // Leave empty (null) to fall back to pollinations.ai only.
    groqWorkerUrl: 'https://arcad-groq.gatabanumai.workers.dev',

    // EmulatorJS netplay signaling server. The official one
    // (https://netplay.emulatorjs.org) has been HTTP 525 since April
    // 2026 so multiplayer was broken until we self-hosted. Set this
    // to your own deployment URL after running the netplay-server/
    // directory as a Render Web Service (or similar). See
    // netplay-server/README.md for setup.
    //
    // If empty/null, EmulatorJS falls back to its `EJS_netplayServer`
    // default which is the broken official one.
    netplayServer: 'https://arcade-netplay.onrender.com',
};
