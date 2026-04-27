// WebRTC co-op — share-your-game with a friend, optionally let them
// drive your inputs.
//
// Host: clicks "Co-op" in a game info modal, gets a 6-char room code,
// shares their viewport (game + arcade chrome) via getDisplayMedia.
// Viewer: opens coop.html?room=CODE, sees the host's stream.
//
// REMOTE CONTROL (NEW):
//   Beyond the original 1:1 spectator stream, we now ship a WebRTC
//   DataChannel ("input") with the connection. When the host enables
//   "Allow viewer to control" in the modal, viewer-side keyboard /
//   mouse / touch events are captured, serialized as compact JSON, and
//   shipped down the channel. The host receives them and dispatches
//   synthetic KeyboardEvent / MouseEvent / TouchEvent into the active
//   game iframe's document — same trick our touch-overlay uses for
//   mobile games. Works for any game that listens on document/window/
//   canvas (which is most HTML5/Unity/Godot/etc).
//
//   IMPORTANT: synthetic events into a CROSS-ORIGIN iframe's document
//   are blocked by the browser. So remote-control only works for
//   same-origin games — i.e. games whose wrapper html lives at
//   /games/<id>.html (which is most of the catalog). Cross-origin
//   itch / arcade-direct iframes won't accept the events, but the
//   spectator stream still works fine.
//
// Signaling: Firestore.
//   coopRooms/{code}
//     hostUid, hostName, gameId, gameTitle
//     offer:  { type, sdp }    — SDP offer JSON written by host
//     answer: { type, sdp }    — SDP answer JSON written by viewer
//     state:  "waiting" | "connected" | "ended"
//     createdAt, lastActivityAt
//
//   coopRooms/{code}/iceCandidates/{auto}
//     from: "host" | "viewer"
//     candidate: RTCIceCandidateInit JSON
//
// WebRTC: standard RTCPeerConnection with Google's public STUN. No
// TURN configured — peers behind strict NAT will fail to connect.
// Acceptable for MVP; add TURN later if needed.
//
// Cleanup: rooms auto-end when host closes modal or page unloads.
// Idle rooms with no activity for >1 hour should be cleaned up by a
// scheduled task (out of scope for MVP).

(function () {
    let db;
    let modalOpen = false;
    let activeRoom = null; // { code, role: 'host'|'viewer', pc, stream, unsub: [] }

    // Confusing-char-stripped alphabet for room codes
    const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

    // ─── Remote-input dispatch (host side) ──────────────────────────
    // Synthesizes a KeyboardEvent / MouseEvent / TouchEvent and fires
    // it into the currently-loaded game iframe (if same-origin) AND
    // into the host's own document (so games that read from the
    // top-level page also work). Called from the input DataChannel
    // onmessage handler when remote control is enabled.
    function dispatchRemoteInput(msg) {
        const targets = [document, window];
        // If we're playing inside an iframe (play.html embeds the game),
        // dispatch into THAT document too so the game code receives it.
        const playFrame = document.querySelector('iframe.play-frame, iframe#gameFrame, iframe[data-game-frame]');
        if (playFrame && playFrame.contentDocument) {
            targets.push(playFrame.contentDocument);
            try { targets.push(playFrame.contentWindow); } catch {}
        }
        // Fallback: any same-origin iframe on the page.
        document.querySelectorAll('iframe').forEach(f => {
            try {
                const d = f.contentDocument;
                if (d && !targets.includes(d)) targets.push(d);
            } catch {}
        });

        try {
            if (msg.t === 'k') {
                // Keyboard event: { t:'k', d:'down'|'up', code, key, kc }
                const ev = new KeyboardEvent(msg.d === 'down' ? 'keydown' : 'keyup', {
                    code: msg.code, key: msg.key,
                    keyCode: msg.kc, which: msg.kc,
                    bubbles: true, cancelable: true, composed: true,
                    ctrlKey: !!msg.ctrl, shiftKey: !!msg.shift, altKey: !!msg.alt, metaKey: !!msg.meta,
                });
                for (const t of targets) try { t.dispatchEvent(ev); } catch {}
            } else if (msg.t === 'm') {
                // Mouse event: { t:'m', d:'move'|'down'|'up', x, y, btn }
                // x,y are normalized [0..1] of the SHARED viewport.
                // We multiply by the iframe canvas dimensions so the
                // pointer lands on the same logical spot regardless of
                // resolution mismatch between host and viewer.
                const canvas = (playFrame?.contentDocument?.querySelector('canvas'))
                    || document.querySelector('iframe canvas')
                    || document.querySelector('canvas');
                let cx = window.innerWidth, cy = window.innerHeight;
                if (canvas) {
                    const rect = canvas.getBoundingClientRect();
                    cx = rect.width; cy = rect.height;
                }
                const px = msg.x * cx;
                const py = msg.y * cy;
                const type = msg.d === 'move' ? 'mousemove'
                          : msg.d === 'down' ? 'mousedown'
                          : 'mouseup';
                const ev = new MouseEvent(type, {
                    clientX: px, clientY: py, button: msg.btn || 0,
                    bubbles: true, cancelable: true, view: window,
                });
                if (canvas) try { canvas.dispatchEvent(ev); } catch {}
                for (const t of targets) try { t.dispatchEvent(ev); } catch {}
            } else if (msg.t === 'w') {
                // Wheel event: { t:'w', dx, dy }
                const ev = new WheelEvent('wheel', {
                    deltaX: msg.dx || 0, deltaY: msg.dy || 0,
                    bubbles: true, cancelable: true,
                });
                for (const t of targets) try { t.dispatchEvent(ev); } catch {}
            }
        } catch (e) {
            // Cross-origin iframe? No-op.
        }
    }

    // ─── Viewer-side control toggle UI ───────────────────────────────
    // Pinned to the bottom-right of the video container; flips a flag
    // returned by the toggle predicate (so the caller owns the state
    // and we just give them a clickable button).
    function showControlToggle(videoEl, toggleFn) {
        if (document.getElementById('coopViewerControlToggle')) return;
        const btn = document.createElement('button');
        btn.id = 'coopViewerControlToggle';
        btn.type = 'button';
        btn.textContent = '\u{1F3AE} Take control';
        btn.style.cssText = [
            'position:fixed', 'bottom:16px', 'right:16px',
            'background:linear-gradient(135deg,#7c3aed,#a855f7)',
            'color:white', 'border:none', 'border-radius:999px',
            'padding:12px 18px', 'font-weight:700', 'font-size:14px',
            'cursor:pointer', 'z-index:99999',
            'box-shadow:0 6px 18px rgba(124,58,237,0.45)',
        ].join(';');
        btn.addEventListener('click', () => {
            const on = toggleFn();
            btn.textContent = on ? '\u{1F3AE} Stop controlling' : '\u{1F3AE} Take control';
            btn.style.background = on
                ? 'linear-gradient(135deg,#dc2626,#ef4444)'
                : 'linear-gradient(135deg,#7c3aed,#a855f7)';
        });
        document.body.appendChild(btn);
    }

    function getDb() {
        if (!db) db = window.ArcadeAuth?.getDb?.();
        return db;
    }

    function esc(s) {
        if (!s) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function generateRoomCode() {
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
        }
        return code;
    }

    // Standard ICE config — Google's public STUN. No TURN; peers
    // behind strict-NAT will fail. STUN-only is fine for ~80% of
    // home networks.
    const RTC_CONFIG = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
        ],
        iceCandidatePoolSize: 4,
    };

    // ───────────────────────────────────────────────────────────────
    // HOST FLOW
    // ───────────────────────────────────────────────────────────────
    //
    //  1. Click "Co-op" → modal asks user to grant screen share
    //  2. Generate code, write coopRooms/{code} with state=waiting
    //  3. Show invite link + code, wait for viewer to set 'answer'
    //  4. Once viewer joins (writes answer), establish connection
    //  5. Stream sends viewport video to viewer
    //  6. Cleanup: deletes Firestore doc on close

    async function startCoopAsHost(game) {
        if (!getDb()) {
            alert('Co-op requires Firestore (sign in first).');
            return;
        }
        if (!navigator.mediaDevices?.getDisplayMedia) {
            alert('Your browser does not support screen sharing (need a desktop browser, not mobile).');
            return;
        }
        if (modalOpen) return;
        modalOpen = true;

        const code = generateRoomCode();
        const inviteUrl = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}coop.html?room=${code}`;
        const overlay = buildCoopOverlay(code, inviteUrl, game);
        document.body.appendChild(overlay);

        // Bind close button + outside-click
        const close = () => endHostSession(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        overlay.querySelector('#coopHostClose').addEventListener('click', close);
        overlay.querySelector('#coopHostCopy').addEventListener('click', () => {
            navigator.clipboard.writeText(inviteUrl).then(
                () => setStatus(overlay, 'Invite link copied!'),
                () => setStatus(overlay, 'Couldn\'t copy — select and copy manually.'),
            );
        });

        // 1. Get screen share BEFORE creating the room (user might cancel)
        let stream;
        try {
            setStatus(overlay, 'Asking for screen share permission…');
            stream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: { ideal: 30, max: 60 } },
                audio: false,
            });
        } catch (e) {
            setStatus(overlay, 'Screen share cancelled. Close and try again.');
            return;
        }

        // 2. Create the room doc
        setStatus(overlay, 'Creating room…');
        const user = window.ArcadeAuth?.getUser?.();
        const username = window.ArcadeAuth?.getUsername?.() || 'Anonymous';
        const roomDoc = getDb().collection('coopRooms').doc(code);
        try {
            await roomDoc.set({
                hostUid: user?.uid || null,
                hostName: username,
                gameId: game?.id || null,
                gameTitle: game?.title || 'Co-op',
                state: 'waiting',
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                lastActivityAt: firebase.firestore.FieldValue.serverTimestamp(),
            });
        } catch (e) {
            setStatus(overlay, 'Couldn\'t create room: ' + e.message);
            stream.getTracks().forEach(t => t.stop());
            return;
        }

        // 3. Set up peer connection
        const pc = new RTCPeerConnection(RTC_CONFIG);
        for (const track of stream.getTracks()) {
            pc.addTrack(track, stream);
        }

        // DataChannel for remote-control input from viewer → host.
        // Negotiated by the host (offerer) so the SDP includes it before
        // the viewer answers. Reliable + ordered — input events are
        // small (tens of bytes each) and dropping them produces stuck
        // keys, so we accept the small latency cost of full-reliability.
        let inputAllowed = false; // host's toggle; messages ignored unless on
        const inputChannel = pc.createDataChannel('input', { ordered: true });
        inputChannel.onmessage = (ev) => {
            if (!inputAllowed) return;
            try {
                const msg = JSON.parse(ev.data);
                dispatchRemoteInput(msg);
            } catch (e) {
                // Bad payload — ignore silently.
            }
        };
        inputChannel.onopen = () => {
            // Wake the toggle row in the host UI now that the channel
            // is actually live.
            const toggleRow = overlay.querySelector('.coop-control-toggle-row');
            if (toggleRow) toggleRow.style.display = 'flex';
        };

        // Make the toggle button accessible to the open() callback above.
        // Wired by buildCoopOverlay -> click handler set right after we
        // append it.
        const ctlBtn = overlay.querySelector('#coopAllowControl');
        if (ctlBtn) {
            ctlBtn.addEventListener('click', () => {
                inputAllowed = !inputAllowed;
                ctlBtn.classList.toggle('is-on', inputAllowed);
                ctlBtn.textContent = inputAllowed
                    ? '\u{1F512} Stop letting viewer control'
                    : '\u{1F513} Allow viewer to control';
            });
        }

        // ICE candidate listener — push to Firestore as host
        pc.onicecandidate = (ev) => {
            if (ev.candidate) {
                roomDoc.collection('iceCandidates').add({
                    from: 'host',
                    candidate: ev.candidate.toJSON(),
                    addedAt: firebase.firestore.FieldValue.serverTimestamp(),
                }).catch(() => {});
            }
        };

        pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            if (state === 'connected') {
                setStatus(overlay, '✓ Friend connected! They can see your screen.');
                roomDoc.update({ state: 'connected', lastActivityAt: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
            } else if (state === 'failed') {
                setStatus(overlay, '✗ Connection failed. Friend may be behind strict NAT.');
            } else if (state === 'disconnected' || state === 'closed') {
                setStatus(overlay, 'Friend disconnected.');
            }
        };

        // 4. Create offer + write to Firestore
        setStatus(overlay, 'Generating connection offer…');
        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await roomDoc.update({
                offer: { type: offer.type, sdp: offer.sdp },
                lastActivityAt: firebase.firestore.FieldValue.serverTimestamp(),
            });
        } catch (e) {
            setStatus(overlay, 'Failed: ' + e.message);
            stream.getTracks().forEach(t => t.stop());
            return;
        }

        // 5. Listen for viewer's answer
        const unsubRoom = roomDoc.onSnapshot(async (snap) => {
            const data = snap.data();
            if (!data) return;
            if (data.answer && !pc.currentRemoteDescription) {
                try {
                    await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
                    setStatus(overlay, 'Connecting…');
                } catch (e) {
                    console.error('setRemoteDescription failed:', e);
                }
            }
        }, () => {});

        // 6. Listen for viewer's ICE candidates
        const unsubIce = roomDoc.collection('iceCandidates').onSnapshot((snap) => {
            snap.docChanges().forEach(change => {
                if (change.type !== 'added') return;
                const data = change.doc.data();
                if (data.from !== 'viewer') return;
                pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(e => {
                    console.warn('addIceCandidate failed:', e);
                });
            });
        }, () => {});

        // Stash for cleanup
        activeRoom = {
            code,
            role: 'host',
            pc,
            stream,
            roomDoc,
            unsub: [unsubRoom, unsubIce],
        };

        setStatus(overlay, 'Waiting for friend to join… share the link below.');

        // Stop sharing if user clicks the browser's stop-sharing toolbar
        stream.getTracks().forEach(track => {
            track.onended = () => {
                setStatus(overlay, 'Stopped sharing.');
                close();
            };
        });

        // Cleanup on page unload
        const beforeunload = () => {
            try { roomDoc.update({ state: 'ended' }); } catch {}
            try { roomDoc.delete(); } catch {}
        };
        window.addEventListener('beforeunload', beforeunload, { once: true });
    }

    function buildCoopOverlay(code, inviteUrl, game) {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'coopHostOverlay';
        overlay.innerHTML = `
            <div class="modal-box coop-host-modal">
                <div class="modal-header">
                    <h2>Co-op: ${esc(game?.title || 'Game')}</h2>
                    <button class="modal-close" id="coopHostClose">&times;</button>
                </div>
                <div class="coop-room-code">
                    <span class="coop-room-code-label">Room code</span>
                    <code class="coop-room-code-value">${code.match(/.{1,3}/g).join(' ')}</code>
                </div>
                <div class="coop-invite-row">
                    <input type="text" class="coop-invite-input" readonly value="${esc(inviteUrl)}">
                    <button class="auth-submit" id="coopHostCopy">Copy</button>
                </div>
                <p class="text-muted coop-hint">
                    Send this link to your friend. They open it, you share your screen,
                    they watch you play. Optionally let them drive your inputs (only works
                    for same-origin browser games).
                </p>
                <div class="coop-control-toggle-row" style="display:none;">
                    <button class="coop-allow-control-btn" id="coopAllowControl" type="button">
                        &#x1F513; Allow viewer to control
                    </button>
                </div>
                <p class="coop-status" id="coopHostStatus">Initializing…</p>
            </div>`;
        return overlay;
    }

    function setStatus(overlay, text) {
        const el = overlay?.querySelector('#coopHostStatus');
        if (el) el.textContent = text;
    }

    async function endHostSession(overlay) {
        if (activeRoom) {
            activeRoom.stream?.getTracks().forEach(t => t.stop());
            activeRoom.unsub?.forEach(u => { try { u(); } catch {} });
            activeRoom.pc?.close();
            try {
                await activeRoom.roomDoc?.update({ state: 'ended' });
                // Optional: cascade-delete iceCandidates subcollection (left for cleanup task)
                await activeRoom.roomDoc?.delete();
            } catch {}
            activeRoom = null;
        }
        overlay?.remove();
        modalOpen = false;
    }

    // ───────────────────────────────────────────────────────────────
    // VIEWER FLOW (used by coop.html)
    // ───────────────────────────────────────────────────────────────

    async function joinAsViewer(roomCode, videoEl, statusEl) {
        if (!getDb()) {
            statusEl.textContent = 'Sign in first to join a co-op room.';
            return;
        }
        const setStatus = (t) => statusEl.textContent = t;
        const roomDoc = getDb().collection('coopRooms').doc(roomCode.toUpperCase());

        setStatus('Looking up room…');
        let snap;
        try {
            snap = await roomDoc.get();
        } catch (e) {
            setStatus('Failed to look up room: ' + e.message);
            return;
        }
        if (!snap.exists) {
            setStatus(`Room "${roomCode}" not found. Ask the host for a fresh link.`);
            return;
        }
        const data = snap.data();
        if (data.state === 'ended') {
            setStatus('Host ended the session.');
            return;
        }
        if (!data.offer) {
            setStatus('Host hasn\'t started sharing yet — waiting…');
            // Listen for the offer to appear
            const unsub = roomDoc.onSnapshot(async (s) => {
                const d = s.data();
                if (d?.offer) {
                    unsub();
                    actuallyJoin(roomDoc, d, videoEl, statusEl);
                }
                if (d?.state === 'ended') {
                    unsub();
                    setStatus('Host ended before connecting.');
                }
            });
            return;
        }
        actuallyJoin(roomDoc, data, videoEl, statusEl);
    }

    async function actuallyJoin(roomDoc, data, videoEl, statusEl) {
        const setStatus = (t) => statusEl.textContent = t;
        setStatus('Connecting to host…');

        const pc = new RTCPeerConnection(RTC_CONFIG);

        // Receive the host's input DataChannel (negotiated host-side as
        // offerer, so we just listen for the reverse).
        let inputCh = null;
        let inputEnabled = false;
        pc.ondatachannel = (ev) => {
            if (ev.channel?.label === 'input') {
                inputCh = ev.channel;
                inputCh.onopen = () => {
                    setStatus('Connected. Press the keyboard/mouse-control button to drive the host\'s game.');
                    showControlToggle(videoEl, () => {
                        inputEnabled = !inputEnabled;
                        return inputEnabled;
                    });
                };
            }
        };

        // Send a captured event over the channel if remote control is on.
        function sendInput(msg) {
            if (!inputEnabled) return;
            if (!inputCh || inputCh.readyState !== 'open') return;
            try { inputCh.send(JSON.stringify(msg)); } catch {}
        }

        // Capture viewer-side keyboard. Bind to window so we get keys
        // even when the video element isn't focused.
        function onKey(ev) {
            if (!inputEnabled) return;
            // Don't swallow OS-level shortcuts (ctrl+w, etc.) or text
            // input — only commandeer when the user is actually focused
            // on the video container.
            if (document.activeElement && /^(input|textarea|select)$/i.test(document.activeElement.tagName)) return;
            ev.preventDefault();
            sendInput({
                t: 'k',
                d: ev.type === 'keydown' ? 'down' : 'up',
                code: ev.code, key: ev.key, kc: ev.keyCode,
                ctrl: ev.ctrlKey, shift: ev.shiftKey, alt: ev.altKey, meta: ev.metaKey,
            });
        }
        window.addEventListener('keydown', onKey);
        window.addEventListener('keyup', onKey);

        // Capture pointer events on the video element. Coords are
        // normalized to [0..1] so the host's canvas-aspect-ratio
        // mismatch doesn't put the cursor in the wrong place.
        function pointer(ev, type) {
            if (!inputEnabled) return;
            ev.preventDefault();
            const rect = videoEl.getBoundingClientRect();
            const x = (ev.clientX - rect.left) / rect.width;
            const y = (ev.clientY - rect.top) / rect.height;
            sendInput({ t: 'm', d: type, x, y, btn: ev.button || 0 });
        }
        videoEl.addEventListener('mousemove', e => pointer(e, 'move'));
        videoEl.addEventListener('mousedown', e => pointer(e, 'down'));
        videoEl.addEventListener('mouseup',   e => pointer(e, 'up'));
        videoEl.addEventListener('wheel', (ev) => {
            if (!inputEnabled) return;
            ev.preventDefault();
            sendInput({ t: 'w', dx: ev.deltaX, dy: ev.deltaY });
        }, { passive: false });
        // Touch → mousedown/move/up
        videoEl.addEventListener('touchstart', (ev) => {
            if (!inputEnabled || !ev.touches?.[0]) return;
            ev.preventDefault();
            const t0 = ev.touches[0];
            const rect = videoEl.getBoundingClientRect();
            sendInput({
                t: 'm', d: 'down',
                x: (t0.clientX - rect.left) / rect.width,
                y: (t0.clientY - rect.top) / rect.height, btn: 0,
            });
        }, { passive: false });
        videoEl.addEventListener('touchmove', (ev) => {
            if (!inputEnabled || !ev.touches?.[0]) return;
            ev.preventDefault();
            const t0 = ev.touches[0];
            const rect = videoEl.getBoundingClientRect();
            sendInput({
                t: 'm', d: 'move',
                x: (t0.clientX - rect.left) / rect.width,
                y: (t0.clientY - rect.top) / rect.height, btn: 0,
            });
        }, { passive: false });
        videoEl.addEventListener('touchend', (ev) => {
            if (!inputEnabled) return;
            ev.preventDefault();
            sendInput({ t: 'm', d: 'up', x: 0, y: 0, btn: 0 });
        }, { passive: false });

        pc.ontrack = (ev) => {
            // First track event = host's video stream
            videoEl.srcObject = ev.streams[0];
            videoEl.play().catch(() => {});
            setStatus('Connected. Enjoy the show.');
        };

        pc.onicecandidate = (ev) => {
            if (ev.candidate) {
                roomDoc.collection('iceCandidates').add({
                    from: 'viewer',
                    candidate: ev.candidate.toJSON(),
                    addedAt: firebase.firestore.FieldValue.serverTimestamp(),
                }).catch(() => {});
            }
        };

        pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            if (state === 'failed') setStatus('Connection failed. Try refreshing.');
            else if (state === 'disconnected') setStatus('Disconnected.');
            else if (state === 'closed') setStatus('Closed.');
        };

        // 1. Set host's offer
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        } catch (e) {
            setStatus('Failed to accept host offer: ' + e.message);
            return;
        }

        // 2. Create + write our answer
        try {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await roomDoc.update({
                answer: { type: answer.type, sdp: answer.sdp },
                lastActivityAt: firebase.firestore.FieldValue.serverTimestamp(),
            });
        } catch (e) {
            setStatus('Failed to create answer: ' + e.message);
            return;
        }

        // 3. Listen for host's ICE candidates
        roomDoc.collection('iceCandidates').onSnapshot((snap) => {
            snap.docChanges().forEach(change => {
                if (change.type !== 'added') return;
                const c = change.doc.data();
                if (c.from !== 'host') return;
                pc.addIceCandidate(new RTCIceCandidate(c.candidate)).catch(e => {
                    console.warn('addIceCandidate failed:', e);
                });
            });
        }, () => {});

        // 4. Listen for room state changes (e.g. host ended)
        roomDoc.onSnapshot((s) => {
            const d = s.data();
            if (!d || d.state === 'ended') {
                setStatus('Host ended the session.');
                pc.close();
            }
        });

        activeRoom = { code: roomDoc.id, role: 'viewer', pc, roomDoc };
    }

    // Public API
    window.ArcadeCoop = {
        startCoopAsHost,
        joinAsViewer,
    };
})();
