// One-shot: emits wrapper HTMLs for every Moemon ROM hosted on archive.org.
// Re-runnable; overwrites existing wrappers cleanly.
//
// Pattern: archive.org → worker /rom?src= → EmulatorJS (gba | desmume2015).
// /rom proxy already allowlists archive.org. Range-request friendly so
// EmulatorJS' built-in IDB cache works for big NDS files.

import fs from 'node:fs';
import path from 'node:path';

const WORKER = 'https://arcad-groq.gatabanumai.workers.dev/rom?src=';

// gameId, title, archive identifier, filename inside the item, core
const MOEMONS = [
    ['clmoemonfirered',     'Moemon FireRed',                   'MoemonFireRed',                    'Moemon Fire Red.gba',                                     'gba'],
    ['clmegamoemonfirered', 'Mega Moemon FireRed (v1.4c)',      'moemon-mega-fire-red-v-1.4c',      'Moemon Mega FireRed (v1.4c).gba',                         'gba'],
    ['clmegamoemonemerald', 'Mega Moemon Emerald (v0.4.2)',     'mega-moemon-emerald',              'Mega Moemon Emerald v0.4.2 - Extra Overworld Sprites.gba','gba'],
    ['clmoemonmystical',    'Moemon Mystical',                  'moemon_mystical_completed_v1_fixed','moemon_mystical_completed_v1_fixed.zip',                  'gba'],
    ['clmoemondevil3',      'Moemon Devil 3RdXPlus (v1.02)',    'moemon-devil-3-rd-xplus-v-1.02',   'Moemon Devil 3RdXPlus v1.02.gba',                         'gba'],
    ['clmoemonquetzal',     'Moemon Quetzal (English Alpha 8v4)','moemon-quetzal-english-alpha-8v-4','MoemonQuetzalEnglishAlpha8v4.zip',                        'gba'],
    ['clmoemonplatinum',    'Moemon Platinum (v1.4)',           'moemon-platinum',                  'Moemon Platinum (v1.4) by Kurisu.nds',                    'desmume2015'],
    ['clmoemonsoulsilver',  'Moemon SoulSilver (v1.4)',         'moemon-soulsilver',                'Moemon SoulSilver (v1.4) by Kurisu.nds',                  'desmume2015'],
    ['clmoemonheartgold',   'Moemon HeartGold (v1.4)',          'moemon-heartgold',                 'Moemon HeartGold (v1.4) by Kurisu.nds',                   'desmume2015'],
    ['clmoemonblack2',      'Moemon Black 2 (v1.1)',            'moemon-black-2',                   'Moemon Black 2 (v1.1) by Kurisu.nds',                     'desmume2015'],
    ['clmoemonwhite2',      'Moemon White 2 (v1.1)',            'moemon-white-2',                   'Moemon White 2 (v1.1) by Kurisu.nds',                     'desmume2015'],
];

function wrapper(gameId, title, src, core) {
    const isNds = core === 'desmume2015';
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>${isNds ? '\n<script src="../js/ds-mode.js"></script>' : ''}
<style>
  body, html { margin:0; padding:0; height:100%; background:#121212; color:#fff;
               font-family:Arial,sans-serif; display:flex; align-items:center;
               justify-content:center; }
  #game-container { width:100%; height:100%; text-align:center; }
  #loading-progress { font-size:18px; margin-top:20px; padding:10px;
                      background:rgba(255,255,255,0.1); border-radius:8px;
                      display:inline-block; }
</style>
</head>
<body>
  <div id="game-container">
    <div id="game"></div>
    <div id="loading-progress">Loading…</div>
  </div>
  <script>
    document.getElementById("loading-progress").remove();
    EJS_player = "#game";
    EJS_core = "${core}";
    EJS_gameName = ${JSON.stringify(title)};
    EJS_color = "#0064ff";
    EJS_startOnLoaded = true;
    EJS_cacheLimit = 0;${isNds ? `
    EJS_threads = false;
    if (typeof EJS_VirtualGamepadEnabled === 'undefined') EJS_VirtualGamepadEnabled = true;
    EJS_defaultControls = true;` : ''}
    EJS_pathtodata = "https://cdn.jsdelivr.net/gh/genizy/emu@master/";
    EJS_netplayServer = "https://netplay.emulatorjs.org";
    EJS_gameUrl = ${JSON.stringify(src)};

    var script = document.createElement("script");
    script.src = EJS_pathtodata + "loader.js";
    document.body.appendChild(script);
  </script>
  <script>
    // Cloud save (robust - polls for emulator)
    (function () {
        var GAME_ID = ${JSON.stringify(gameId)};
        var saveStarted = false;

        function saveToCloud() {
            try {
                var state = EJS_emulator.gameManager.getState();
                if (state && state.byteLength > 0) {
                    var bytes = new Uint8Array(state);
                    var binary = '';
                    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                    window.parent.postMessage({ type: 'save-data', gameId: GAME_ID, data: btoa(binary) }, '*');
                }
            } catch (e) {}
        }

        function startCloudSave() {
            if (saveStarted) return;
            saveStarted = true;
            window.parent.postMessage({ type: 'emu-ready', gameId: GAME_ID }, '*');
            setTimeout(saveToCloud, 10000);
            setInterval(saveToCloud, 60000);
        }

        EJS_onGameStart = function () { startCloudSave(); };

        var poll = setInterval(function () {
            try {
                if (typeof EJS_emulator !== 'undefined' && EJS_emulator.gameManager) {
                    clearInterval(poll);
                    startCloudSave();
                }
            } catch (e) {}
        }, 2000);
        setTimeout(function () { clearInterval(poll); }, 300000);

        window.addEventListener('message', function (e) {
            if (e.data && e.data.type === 'load-save' && e.data.data) {
                try {
                    var binary = atob(e.data.data);
                    var bytes = new Uint8Array(binary.length);
                    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                    EJS_emulator.gameManager.loadState(bytes.buffer);
                } catch (e) {}
            }
        });

        window.addEventListener('beforeunload', function () { saveToCloud(); });
    })();
  </script>
</body>
</html>
`;
}

const outDir = path.join(process.cwd(), 'games');
let written = 0;
for (const [gameId, title, identifier, filename, core] of MOEMONS) {
    const archiveUrl = `https://archive.org/download/${identifier}/${encodeURIComponent(filename)}`;
    const proxied = `${WORKER}${encodeURIComponent(archiveUrl)}`;
    const file = path.join(outDir, `${gameId}.html`);
    fs.writeFileSync(file, wrapper(gameId, title, proxied, core));
    console.log('wrote', file);
    written++;
}
console.log(`\nWrote ${written} Moemon wrapper files.`);
