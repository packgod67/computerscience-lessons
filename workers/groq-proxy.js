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

const TOUCH_OVERLAY_SCRIPT = `(function () {
    if (window.__arcadeTouchOverlayInstalled) return;
    window.__arcadeTouchOverlayInstalled = true;
    function isTouchDevice() {
        if (window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches) return true;
        if ('ontouchstart' in window && (navigator.maxTouchPoints || 0) > 0) return true;
        return false;
    }
    if (!isTouchDevice()) return;
    var KEY_OPTIONS = {
        ArrowUp:    { code: 'ArrowUp',    key: 'ArrowUp',    keyCode: 38, label: '↑ Arrow Up' },
        ArrowDown:  { code: 'ArrowDown',  key: 'ArrowDown',  keyCode: 40, label: '↓ Arrow Down' },
        ArrowLeft:  { code: 'ArrowLeft',  key: 'ArrowLeft',  keyCode: 37, label: '← Arrow Left' },
        ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', keyCode: 39, label: '→ Arrow Right' },
        KeyW: { code: 'KeyW', key: 'w', keyCode: 87, label: 'W' },
        KeyA: { code: 'KeyA', key: 'a', keyCode: 65, label: 'A' },
        KeyS: { code: 'KeyS', key: 's', keyCode: 83, label: 'S' },
        KeyD: { code: 'KeyD', key: 'd', keyCode: 68, label: 'D' },
        KeyZ: { code: 'KeyZ', key: 'z', keyCode: 90, label: 'Z' },
        KeyX: { code: 'KeyX', key: 'x', keyCode: 88, label: 'X' },
        KeyC: { code: 'KeyC', key: 'c', keyCode: 67, label: 'C' },
        KeyV: { code: 'KeyV', key: 'v', keyCode: 86, label: 'V' },
        KeyJ: { code: 'KeyJ', key: 'j', keyCode: 74, label: 'J' },
        KeyK: { code: 'KeyK', key: 'k', keyCode: 75, label: 'K' },
        KeyL: { code: 'KeyL', key: 'l', keyCode: 76, label: 'L' },
        KeyM: { code: 'KeyM', key: 'm', keyCode: 77, label: 'M' },
        KeyN: { code: 'KeyN', key: 'n', keyCode: 78, label: 'N' },
        KeyQ: { code: 'KeyQ', key: 'q', keyCode: 81, label: 'Q' },
        KeyE: { code: 'KeyE', key: 'e', keyCode: 69, label: 'E' },
        KeyR: { code: 'KeyR', key: 'r', keyCode: 82, label: 'R' },
        KeyF: { code: 'KeyF', key: 'f', keyCode: 70, label: 'F' },
        Digit1: { code: 'Digit1', key: '1', keyCode: 49, label: '1' },
        Digit2: { code: 'Digit2', key: '2', keyCode: 50, label: '2' },
        Digit3: { code: 'Digit3', key: '3', keyCode: 51, label: '3' },
        Digit4: { code: 'Digit4', key: '4', keyCode: 52, label: '4' },
        Space:      { code: 'Space',      key: ' ',      keyCode: 32, label: 'Space' },
        Enter:      { code: 'Enter',      key: 'Enter',  keyCode: 13, label: 'Enter' },
        Escape:     { code: 'Escape',     key: 'Escape', keyCode: 27, label: 'Esc' },
        ShiftLeft:  { code: 'ShiftLeft',  key: 'Shift',  keyCode: 16, label: 'Shift' },
        ControlLeft:{ code: 'ControlLeft',key: 'Control',keyCode: 17, label: 'Ctrl' },
        AltLeft:    { code: 'AltLeft',    key: 'Alt',    keyCode: 18, label: 'Alt' },
        Tab:        { code: 'Tab',        key: 'Tab',    keyCode: 9,  label: 'Tab' },
        Backspace:  { code: 'Backspace',  key: 'Backspace', keyCode: 8, label: 'Backspace' },
    };
    var SLOTS = ['Up', 'Down', 'Left', 'Right', 'A', 'B', 'Start'];
    var DEFAULT_MAPPING = {
        Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
        A: 'KeyZ', B: 'KeyX', Start: 'Enter',
    };
    var WASD_MAPPING = {
        Up: 'KeyW', Down: 'KeyS', Left: 'KeyA', Right: 'KeyD',
        A: 'KeyJ', B: 'KeyK', Start: 'Enter',
    };
    var STORAGE_KEY = 'arcade-touch-mapping';
    function loadMapping() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                var parsed = JSON.parse(raw);
                var valid = SLOTS.every(function (s) { return KEY_OPTIONS[parsed[s]]; });
                if (valid) return parsed;
            }
        } catch (e) {}
        return Object.assign({}, DEFAULT_MAPPING);
    }
    function saveMapping(m) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(m)); } catch (e) {}
    }
    var mapping = loadMapping();
    function fireKey(type, info) {
        try {
            var ev = new KeyboardEvent(type, {
                code: info.code,
                key: info.key,
                keyCode: info.keyCode,
                which: info.keyCode,
                bubbles: true,
                cancelable: true,
                composed: true,
            });
            document.dispatchEvent(ev);
            window.dispatchEvent(ev);
            var canvas = document.querySelector('canvas');
            if (canvas) canvas.dispatchEvent(ev);
        } catch (e) {}
    }
    function styleEl(el, css) {
        for (var k in css) el.style[k] = css[k];
    }
    var overlay = document.createElement('div');
    overlay.id = '__arcadeTouchOverlay';
    styleEl(overlay, {
        position: 'fixed',
        left: '0', right: '0', bottom: '0',
        zIndex: '999999',
        pointerEvents: 'none',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        padding: '12px 16px',
        paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
        paddingLeft: 'calc(16px + env(safe-area-inset-left, 0px))',
        paddingRight: 'calc(16px + env(safe-area-inset-right, 0px))',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        touchAction: 'none',
        font: '14px/1 system-ui, sans-serif',
    });
    var slotButtons = {}; // slot -> { btn, label }
    function makeBtn(label, slot, opts) {
        opts = opts || {};
        var b = document.createElement('button');
        b.textContent = label;
        b.setAttribute('aria-label', opts.ariaLabel || label);
        styleEl(b, Object.assign({
            width: '52px',
            height: '52px',
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.18)',
            color: 'white',
            border: '2px solid rgba(255,255,255,0.4)',
            fontSize: '18px',
            fontWeight: '700',
            pointerEvents: 'auto',
            cursor: 'pointer',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            textShadow: '0 1px 2px rgba(0,0,0,0.6)',
            boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
            touchAction: 'none',
        }, opts.style || {}));
        function press(e) {
            e.preventDefault();
            e.stopPropagation();
            b.style.background = 'rgba(255,255,255,0.45)';
            var info = KEY_OPTIONS[mapping[slot]] || KEY_OPTIONS[DEFAULT_MAPPING[slot]];
            if (info) fireKey('keydown', info);
        }
        function release(e) {
            e.preventDefault();
            e.stopPropagation();
            b.style.background = opts.releaseBg || 'rgba(255,255,255,0.18)';
            var info = KEY_OPTIONS[mapping[slot]] || KEY_OPTIONS[DEFAULT_MAPPING[slot]];
            if (info) fireKey('keyup', info);
        }
        b.addEventListener('touchstart', press, { passive: false });
        b.addEventListener('touchend', release, { passive: false });
        b.addEventListener('touchcancel', release, { passive: false });
        b.addEventListener('mousedown', press);
        b.addEventListener('mouseup', release);
        b.addEventListener('mouseleave', release);
        slotButtons[slot] = { btn: b, defaultLabel: label };
        return b;
    }
    var dpad = document.createElement('div');
    styleEl(dpad, {
        position: 'relative',
        width: '160px',
        height: '160px',
        pointerEvents: 'none',
    });
    function placeDpadBtn(btn, x, y) {
        styleEl(btn, { position: 'absolute', left: x, top: y });
        dpad.appendChild(btn);
    }
    placeDpadBtn(makeBtn('▲', 'Up',    { ariaLabel: 'Up' }),    '54px', '0');
    placeDpadBtn(makeBtn('▼', 'Down',  { ariaLabel: 'Down' }),  '54px', '108px');
    placeDpadBtn(makeBtn('◀', 'Left',  { ariaLabel: 'Left' }),  '0',    '54px');
    placeDpadBtn(makeBtn('▶', 'Right', { ariaLabel: 'Right' }), '108px', '54px');
    var actions = document.createElement('div');
    styleEl(actions, {
        position: 'relative',
        width: '160px',
        height: '160px',
        pointerEvents: 'none',
    });
    function placeActionBtn(btn, x, y, color) {
        styleEl(btn, {
            position: 'absolute',
            left: x, top: y,
            background: color,
        });
        actions.appendChild(btn);
    }
    var bBtn = makeBtn('B', 'B', { style: { width: '60px', height: '60px' }, releaseBg: 'rgba(239, 68, 68, 0.4)' });
    var aBtn = makeBtn('A', 'A', { style: { width: '60px', height: '60px' }, releaseBg: 'rgba(34, 197, 94, 0.4)' });
    var startBtn = makeBtn('Start', 'Start', { style: { width: '70px', height: '32px', fontSize: '12px', borderRadius: '16px' }, releaseBg: 'rgba(124, 58, 237, 0.4)' });
    placeActionBtn(bBtn,     '0',     '50px', 'rgba(239, 68, 68, 0.4)');
    placeActionBtn(aBtn,     '100px', '50px', 'rgba(34, 197, 94, 0.4)');
    placeActionBtn(startBtn, '45px', '0',     'rgba(124, 58, 237, 0.4)');
    overlay.appendChild(dpad);
    overlay.appendChild(actions);
    var hidden = false;
    var toggle = document.createElement('button');
    toggle.textContent = '⊟';
    toggle.setAttribute('aria-label', 'Hide controls');
    styleEl(toggle, {
        position: 'fixed',
        top: 'calc(8px + env(safe-area-inset-top, 0px))',
        right: '8px',
        width: '32px',
        height: '32px',
        borderRadius: '50%',
        background: 'rgba(0,0,0,0.5)',
        color: 'white',
        border: '1px solid rgba(255,255,255,0.3)',
        zIndex: '999999',
        fontSize: '16px',
        cursor: 'pointer',
        pointerEvents: 'auto',
    });
    toggle.addEventListener('click', function () {
        hidden = !hidden;
        overlay.style.display = hidden ? 'none' : 'flex';
        toggle.textContent = hidden ? '⊞' : '⊟';
        toggle.setAttribute('aria-label', hidden ? 'Show controls' : 'Hide controls');
    });
    var settingsBtn = document.createElement('button');
    settingsBtn.textContent = '⚙';
    settingsBtn.setAttribute('aria-label', 'Remap controls');
    styleEl(settingsBtn, {
        position: 'fixed',
        top: 'calc(8px + env(safe-area-inset-top, 0px))',
        right: '48px',
        width: '32px',
        height: '32px',
        borderRadius: '50%',
        background: 'rgba(0,0,0,0.5)',
        color: 'white',
        border: '1px solid rgba(255,255,255,0.3)',
        zIndex: '999999',
        fontSize: '16px',
        cursor: 'pointer',
        pointerEvents: 'auto',
    });
    settingsBtn.addEventListener('click', openRemapModal);
    var modal = null;
    function buildModal() {
        modal = document.createElement('div');
        styleEl(modal, {
            position: 'fixed',
            inset: '0',
            background: 'rgba(0,0,0,0.85)',
            zIndex: '9999999',
            display: 'none',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
            paddingTop: 'calc(16px + env(safe-area-inset-top, 0px))',
            paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
            font: '14px/1.4 system-ui, sans-serif',
        });
        var card = document.createElement('div');
        styleEl(card, {
            background: '#1a1a2a',
            color: 'white',
            borderRadius: '12px',
            padding: '20px',
            width: '100%',
            maxWidth: '360px',
            maxHeight: '100%',
            overflowY: 'auto',
            boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            border: '1px solid rgba(255,255,255,0.1)',
        });
        var title = document.createElement('h3');
        title.textContent = 'Remap Controls';
        styleEl(title, { margin: '0 0 4px', fontSize: '18px', fontWeight: '700' });
        card.appendChild(title);
        var sub = document.createElement('p');
        sub.textContent = 'Pick which keyboard key each button sends.';
        styleEl(sub, { margin: '0 0 16px', opacity: '0.7', fontSize: '13px' });
        card.appendChild(sub);
        var presetRow = document.createElement('div');
        styleEl(presetRow, { display: 'flex', gap: '6px', marginBottom: '14px', flexWrap: 'wrap' });
        function presetBtn(label, m) {
            var pb = document.createElement('button');
            pb.textContent = label;
            styleEl(pb, {
                flex: '1', minWidth: '0',
                padding: '8px 10px',
                borderRadius: '6px',
                background: 'rgba(124, 58, 237, 0.3)',
                color: 'white',
                border: '1px solid rgba(124, 58, 237, 0.6)',
                fontSize: '12px',
                fontWeight: '600',
                cursor: 'pointer',
            });
            pb.addEventListener('click', function () {
                Object.assign(mapping, m);
                refreshSelects();
            });
            return pb;
        }
        presetRow.appendChild(presetBtn('Arrows + ZX', DEFAULT_MAPPING));
        presetRow.appendChild(presetBtn('WASD + JK', WASD_MAPPING));
        card.appendChild(presetRow);
        var selects = {}; // slot -> <select>
        SLOTS.forEach(function (slot) {
            var row = document.createElement('div');
            styleEl(row, {
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '8px 0',
                borderBottom: '1px solid rgba(255,255,255,0.08)',
            });
            var lbl = document.createElement('div');
            lbl.textContent = slot;
            styleEl(lbl, { flex: '0 0 60px', fontWeight: '600', opacity: '0.9' });
            row.appendChild(lbl);
            var sel = document.createElement('select');
            styleEl(sel, {
                flex: '1',
                padding: '8px 10px',
                borderRadius: '6px',
                background: '#0e0e1a',
                color: 'white',
                border: '1px solid rgba(255,255,255,0.15)',
                fontSize: '14px',
            });
            Object.keys(KEY_OPTIONS).forEach(function (code) {
                var opt = document.createElement('option');
                opt.value = code;
                opt.textContent = KEY_OPTIONS[code].label;
                sel.appendChild(opt);
            });
            sel.value = mapping[slot];
            sel.addEventListener('change', function () {
                mapping[slot] = sel.value;
            });
            selects[slot] = sel;
            row.appendChild(sel);
            card.appendChild(row);
        });
        function refreshSelects() {
            SLOTS.forEach(function (slot) { selects[slot].value = mapping[slot]; });
        }
        var footer = document.createElement('div');
        styleEl(footer, { display: 'flex', gap: '8px', marginTop: '16px' });
        var resetBtn = document.createElement('button');
        resetBtn.textContent = 'Reset';
        styleEl(resetBtn, {
            padding: '10px 14px',
            borderRadius: '6px',
            background: 'rgba(255,255,255,0.08)',
            color: 'white',
            border: '1px solid rgba(255,255,255,0.15)',
            fontWeight: '600',
            cursor: 'pointer',
        });
        resetBtn.addEventListener('click', function () {
            Object.assign(mapping, DEFAULT_MAPPING);
            refreshSelects();
        });
        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        styleEl(cancelBtn, {
            flex: '1',
            padding: '10px 14px',
            borderRadius: '6px',
            background: 'rgba(255,255,255,0.08)',
            color: 'white',
            border: '1px solid rgba(255,255,255,0.15)',
            fontWeight: '600',
            cursor: 'pointer',
        });
        cancelBtn.addEventListener('click', function () {
            mapping = loadMapping();
            refreshSelects();
            modal.style.display = 'none';
        });
        var saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save';
        styleEl(saveBtn, {
            flex: '1',
            padding: '10px 14px',
            borderRadius: '6px',
            background: 'rgba(34, 197, 94, 0.7)',
            color: 'white',
            border: '1px solid rgba(34, 197, 94, 0.9)',
            fontWeight: '700',
            cursor: 'pointer',
        });
        saveBtn.addEventListener('click', function () {
            saveMapping(mapping);
            modal.style.display = 'none';
        });
        footer.appendChild(resetBtn);
        footer.appendChild(cancelBtn);
        footer.appendChild(saveBtn);
        card.appendChild(footer);
        modal.appendChild(card);
        document.body.appendChild(modal);
    }
    function openRemapModal() {
        if (!modal) buildModal();
        var selects = modal.querySelectorAll('select');
        var i = 0;
        SLOTS.forEach(function (slot) {
            if (selects[i]) selects[i].value = mapping[slot];
            i++;
        });
        modal.style.display = 'flex';
    }
    function mount() {
        if (!document.body) {
            setTimeout(mount, 50);
            return;
        }
        document.body.appendChild(overlay);
        document.body.appendChild(toggle);
        document.body.appendChild(settingsBtn);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        mount();
    }
})();`;

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
            // Enable cross-origin isolation in the iframe so Godot 4 /
            // any other engine that needs SharedArrayBuffer (Web Workers
            // with WASM threads) actually starts up. credentialless is
            // the permissive flavor — sub-resources don't need explicit
            // CORP to load (they're stripped of credentials instead).
            // We can be aggressive here because every sub-resource for
            // itch games is proxied through this same worker, which sets
            // CORP cross-origin above.
            respHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
            respHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');
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

                // Inject the touch-control overlay before </body> so
                // mobile users get on-screen D-pad + A/B/Start buttons
                // for keyboard-required games. Source of the script
                // body lives at js/touch-overlay.js — the source-of-
                // truth gets copy-pasted in here. Update both when
                // editing.
                const touchOverlayTag = `<script>${TOUCH_OVERLAY_SCRIPT}</script>`;
                if (/<\/body>/i.test(body)) {
                    body = body.replace(/<\/body>/i, `${touchOverlayTag}</body>`);
                } else {
                    body = body + touchOverlayTag;
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
        // Multi-file game upload: POST /upload
        //
        // Accepts a JSON body { gameId, files: [{ relpath, contentB64 }] }
        // and commits all files atomically to the GitHub repo at
        // games/uploads/<gameId>/<relpath>. The arcade auto-deploys on
        // every push to main, so games are playable ~1 minute after
        // upload finishes.
        //
        // Auth: requires Authorization: Bearer <Firebase ID token>
        // from an admin user. We verify by decoding the token's UID
        // (no crypto needed — Firestore checks the signature for us)
        // then fetching the user's doc with the same token. If the
        // doc says role: 'admin', we proceed.
        //
        // Required env / secrets (set via wrangler):
        //   GITHUB_TOKEN          — fine-grained PAT with contents:write
        //   GITHUB_OWNER          — repo owner (e.g. "packgod67")
        //   GITHUB_REPO           — repo name (e.g. "computerscience-lessons")
        //   GITHUB_BRANCH         — usually "main"
        //   FIREBASE_PROJECT_ID   — your Firebase project id
        // ───────────────────────────────────────────────────────────
        if (reqUrl.pathname === '/upload' && request.method === 'POST') {
            return handleUpload(request, env);
        }
        if (reqUrl.pathname.startsWith('/uploads/') && request.method === 'DELETE') {
            const gameId = reqUrl.pathname.slice('/uploads/'.length).replace(/\/$/, '');
            return handleUploadDelete(request, env, gameId);
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

// ─── Multi-file game upload handlers ───────────────────────────────
// Used by /upload and /uploads/<id> DELETE. Both require admin auth
// via Firebase, then talk to GitHub's git-data API to commit a tree.

// Decode a JWT's payload without verifying the signature. We don't
// trust this for auth — Firestore's REST API verifies the token
// cryptographically when we use it as Bearer. We only decode here
// to extract the uid for the Firestore path lookup.
function decodeJwtPayload(token) {
    try {
        const [, payload] = token.split('.');
        const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
        const json = atob(padded + '==='.slice((padded.length + 3) % 4));
        return JSON.parse(json);
    } catch { return null; }
}

// Returns the uid if the token is valid AND the user has role 'admin'
// in Firestore. Returns null otherwise. Firestore performs the
// cryptographic JWT verification (we just decode to get the uid path).
async function verifyAdmin(request, env) {
    const auth = request.headers.get('Authorization') || '';
    if (!auth.startsWith('Bearer ')) return null;
    const token = auth.slice(7);
    const claims = decodeJwtPayload(token);
    if (!claims?.user_id && !claims?.sub) return null;
    const uid = claims.user_id || claims.sub;

    const projectId = env.FIREBASE_PROJECT_ID;
    if (!projectId) return null;

    const r = await fetch(
        `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}`,
        { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) return null;
    const doc = await r.json();
    if (doc?.fields?.role?.stringValue !== 'admin') return null;
    return uid;
}

// Commit a batch of files to GitHub atomically. Uses the git-data API
// (blobs → tree → commit → ref) so all files land in one commit
// regardless of how many there are. Returns the new commit SHA.
async function githubCommit(env, paths, message) {
    const owner  = env.GITHUB_OWNER;
    const repo   = env.GITHUB_REPO;
    const branch = env.GITHUB_BRANCH || 'main';
    const token  = env.GITHUB_TOKEN;
    if (!owner || !repo || !token) {
        throw new Error('GitHub worker secrets missing (GITHUB_OWNER/REPO/TOKEN)');
    }

    const headers = {
        Authorization: `token ${token}`,
        'User-Agent': 'arcade-uploader',
        Accept: 'application/vnd.github+json',
    };
    const api = `https://api.github.com/repos/${owner}/${repo}`;

    // 1. Get the latest commit SHA on the branch
    const refResp = await fetch(`${api}/git/refs/heads/${branch}`, { headers });
    if (!refResp.ok) throw new Error(`refs lookup failed: ${refResp.status}`);
    const ref = await refResp.json();
    const baseCommitSha = ref.object.sha;

    // 2. Get its tree SHA
    const baseCommit = await fetch(`${api}/git/commits/${baseCommitSha}`, { headers })
        .then(r => r.json());
    const baseTreeSha = baseCommit.tree.sha;

    // 3. Create a blob per file (parallel)
    const treeEntries = await Promise.all(paths.map(async (p) => {
        const blobResp = await fetch(`${api}/git/blobs`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: p.contentB64, encoding: 'base64' }),
        });
        if (!blobResp.ok) throw new Error(`blob create failed for ${p.path}: ${blobResp.status}`);
        const blob = await blobResp.json();
        return {
            path: p.path,
            mode: '100644',
            type: 'blob',
            sha: p.delete ? null : blob.sha,
        };
    }));

    // 4. Create a new tree based on the existing one
    const newTreeResp = await fetch(`${api}/git/trees`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
    });
    if (!newTreeResp.ok) throw new Error(`tree create failed: ${newTreeResp.status}`);
    const newTree = await newTreeResp.json();

    // 5. Create a commit
    const commitResp = await fetch(`${api}/git/commits`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message,
            tree: newTree.sha,
            parents: [baseCommitSha],
        }),
    });
    if (!commitResp.ok) throw new Error(`commit create failed: ${commitResp.status}`);
    const newCommit = await commitResp.json();

    // 6. Update the branch ref
    const updateResp = await fetch(`${api}/git/refs/heads/${branch}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha: newCommit.sha }),
    });
    if (!updateResp.ok) throw new Error(`ref update failed: ${updateResp.status}`);

    return newCommit.sha;
}

// List files under a path in the repo (for delete: we need to know
// which paths to remove from the tree).
async function githubListFiles(env, path) {
    const owner  = env.GITHUB_OWNER;
    const repo   = env.GITHUB_REPO;
    const branch = env.GITHUB_BRANCH || 'main';
    const token  = env.GITHUB_TOKEN;
    const headers = {
        Authorization: `token ${token}`,
        'User-Agent': 'arcade-uploader',
        Accept: 'application/vnd.github+json',
    };
    const api = `https://api.github.com/repos/${owner}/${repo}`;

    // Use the recursive tree API to grab everything under `path` in one call
    const refResp = await fetch(`${api}/git/refs/heads/${branch}`, { headers });
    const ref = await refResp.json();
    const treeResp = await fetch(`${api}/git/trees/${ref.object.sha}?recursive=1`, { headers });
    const tree = await treeResp.json();
    return tree.tree.filter(t => t.type === 'blob' && t.path.startsWith(path + '/'));
}

async function handleUpload(request, env) {
    const uid = await verifyAdmin(request, env);
    if (!uid) return json({ error: 'admin auth required' }, 403);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'invalid json' }, 400); }

    const gameId = String(body.gameId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!gameId) return json({ error: 'invalid gameId' }, 400);
    if (!Array.isArray(body.files) || !body.files.length) {
        return json({ error: 'no files' }, 400);
    }
    if (body.files.length > 500) {
        return json({ error: 'too many files (cap 500)' }, 400);
    }

    // Translate each { relpath, contentB64 } into a tree entry path.
    const paths = [];
    let totalBytes = 0;
    for (const f of body.files) {
        const relpath = String(f.relpath || '').replace(/^\/+/, '');
        if (!relpath || relpath.includes('..')) {
            return json({ error: `invalid path: ${relpath}` }, 400);
        }
        const b64 = String(f.contentB64 || '');
        // Approximate size: base64 → bytes ≈ b64.length * 3/4
        totalBytes += Math.floor(b64.length * 0.75);
        paths.push({
            path: `games/uploads/${gameId}/${relpath}`,
            contentB64: b64,
        });
    }
    if (totalBytes > 100 * 1024 * 1024) {
        return json({ error: 'total upload exceeds 100MB' }, 400);
    }

    try {
        const sha = await githubCommit(env, paths, `Upload custom game: ${gameId}`);
        return json({ ok: true, commitSha: sha, gameId, fileCount: paths.length }, 200);
    } catch (e) {
        return json({ error: e.message || 'commit failed' }, 500);
    }
}

async function handleUploadDelete(request, env, gameId) {
    const uid = await verifyAdmin(request, env);
    if (!uid) return json({ error: 'admin auth required' }, 403);
    const safeId = gameId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeId) return json({ error: 'invalid gameId' }, 400);

    try {
        const files = await githubListFiles(env, `games/uploads/${safeId}`);
        if (!files.length) return json({ ok: true, removed: 0 }, 200);
        // Mark each for deletion (sha: null in tree entry)
        const paths = files.map(f => ({ path: f.path, contentB64: '', delete: true }));
        const sha = await githubCommit(env, paths, `Remove custom game: ${safeId}`);
        return json({ ok: true, commitSha: sha, removed: files.length }, 200);
    } catch (e) {
        return json({ error: e.message || 'delete failed' }, 500);
    }
}
