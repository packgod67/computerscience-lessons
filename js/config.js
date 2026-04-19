// Arcade site config. Commit edits here so they ship to all users.
// Individual users can override by setting the matching localStorage key.

window.ARCADE_CONFIG = {
    // Cloudflare Worker URL that proxies the Groq API for the AI recommender.
    // Leave empty (null) to fall back to the free pollinations.ai provider.
    groqWorkerUrl: 'https://arcad-groq.gatabanumai.workers.dev',

    // Supabase Storage — used for cloud save blobs that exceed Firestore's
    // 1MB per-doc limit (DS/PSX games). The publishable key is safe to
    // expose in the browser; Storage policies restrict access.
    supabaseUrl: 'https://xwdnykqugsikkzpfcodk.supabase.co',
    supabaseKey: 'sb_publishable_8bzpmxaeDUPu1mMhrnvk6A_ZBZzQ9oY',
};
