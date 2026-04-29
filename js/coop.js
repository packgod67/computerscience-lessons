// WebRTC co-op + watch parties — multi-viewer screen share with optional
// collaborative input.
//
// Host: clicks "Co-op" in a game info modal, gets a 6-char room code,
// shares their viewport (game + arcade chrome) via getDisplayMedia.
// Viewers: open coop.html?room=CODE — multiple can join the same room.
// Each viewer can opt-in to driving the host's game; the host has a
// master "Allow viewers to control" toggle that gates all input.
//
// REMOTE CONTROL:
//   Each viewer has its own RTCDataChannel ("input"). When a viewer
//   enables "Take control", their keyboard / mouse / touch events are
//   serialized as compact JSON and shipped down THEIR channel to the
//   host. The host receives them and dispatches synthetic
//   KeyboardEvent / MouseEvent into the active iframe's document.
//
//   Same-origin only — synthetic events into a CROSS-ORIGIN iframe's
//   document are blocked by the browser. So remote-control only works
//   for games whose wrapper html lives at /games/<id>.html. Cross-
//   origin itch games still get the spectator stream.
//
//   Multiple viewers can hold control simultaneously. The host applies
//   all incoming inputs in order. For most games (single-key keyboard,
//   single-cursor mouse) this means viewers cooperate naturally —
//   competing inputs cancel out, agreement compounds.
//
// MULTI-VIEWER WEBRTC:
//   The host runs N parallel RTCPeerConnections, one per viewer. Each
//   PC has its own offer/answer exchange via Firestore. The screen-
//   share stream's tracks are added to every PC, so the host's
//   getDisplayMedia is called once and N viewers see the same feed.
//
// SCHEMA (Firestore):
//   coopRooms/{code}                 — host metadata + master flags
//     { hostUid, hostName, gameId, gameTitle,
//       state: 'waiting'|'connected'|'ended',
//       allowControl: bool,          // host's master toggle
//       viewerCount: int,
//       createdAt, lastActivityAt }
//
//   coopRooms/{code}/viewers/{viewerId}   — per-viewer SDP exchange
//     { name, joinedAt, offer?, answer? }
//
//   coopRooms/{code}/viewers/{viewerId}/ice/{auto}
//     { from: 'host'|'viewer', candidate, addedAt }
//
// FIRESTORE RULES — paste into Firebase Console (replaces the previous
// coopRooms block from the old 1:1 schema):
//
//   match /coopRooms/{roomCode} {
//     allow read:   if signedIn();
//     allow create: if signedIn()
//                   && request.resource.data.hostUid == request.auth.uid;
//     allow update: if signedIn() && (
//                     resource.data.hostUid == request.auth.uid
//                     || request.resource.data.diff(resource.data)
//                         .affectedKeys()
//                         .hasOnly(['lastActivityAt', 'viewerCount'])
//                   );
//     allow delete: if signedIn()
//                   && resource.data.hostUid == request.auth.uid;
//
//     match /viewers/{viewerId} {
//       allow read:   if signedIn();
//       // Viewers create their own doc to join. The doc id == auth.uid
//       // (or a random id for anon) so any signed-in user can claim a
//       // slot but can't claim someone else's.
//       allow create: if signedIn();
//       // Viewer can update their own answer; host can update offer.
//       allow update: if signedIn();
//       allow delete: if signedIn();
//
//       match /ice/{candId} {
//         allow read:   if signedIn();
//         allow create: if signedIn();
//         allow update, delete: if false;
//       }
//     }
//   }

(function () {
    let db;
    let modalOpen = false;
    let activeRoom = null; // host: { code, role, stream, roomDoc, viewers: Map, unsub: [] }
                           // viewer: { code, role, pc, roomDoc, viewerDoc, viewerId }

    // Confusing-char-stripped alphabet for room codes
    const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

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

    // ─── Remote-input dispatch (host side) ─────────────────────────
    // Synthesizes a KeyboardEvent / MouseEvent / TouchEvent and fires
    // it into the currently-loaded game iframe (if same-origin) AND
    // into the host's own document. Called from each viewer's input
    // DataChannel onmessage handler (only when the host's master toggle
    // is on AND the viewer themselves enabled their toggle).
    function dispatchRemoteInput(msg) {
        const targets = [document, window];
        const playFrame = document.querySelector('iframe.play-frame, iframe#gameFrame, iframe[data-game-frame]');
        if (playFrame && playFrame.contentDocument) {
            targets.push(playFrame.contentDocument);
            try { targets.push(playFrame.contentWindow); } catch {}
        }
        document.querySelectorAll('iframe').forEach(f => {
            try {
                const d = f.contentDocument;
                if (d && !targets.includes(d)) targets.push(d);
            } catch {}
        });
        try {
            if (msg.t === 'k') {
                const ev = new KeyboardEvent(msg.d === 'down' ? 'keydown' : 'keyup', {
                    code: msg.code, key: msg.key,
                    keyCode: msg.kc, which: msg.kc,
                    bubbles: true, cancelable: true, composed: true,
                    ctrlKey: !!msg.ctrl, shiftKey: !!msg.shift, altKey: !!msg.alt, metaKey: !!msg.meta,
                });
                for (const t of targets) try { t.dispatchEvent(ev); } catch {}
            } else if (msg.t === 'm') {
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

    // ─── Viewer-side "Take control" toggle UI ──────────────────────
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

    // ─── HOST FLOW ─────────────────────────────────────────────────
    // 1. getDisplayMedia → stream
    // 2. Create coopRooms/{code} with hostUid, allowControl: false,
    //    viewerCount: 0
    // 3. Listen for adds in viewers/* subcollection
    // 4. For each new viewer, spin up a fresh PC + DataChannel,
    //    create offer, write to viewer doc, watch for answer + ICE
    // 5. Maintain a Map<viewerId, {pc, dataChannel, name}>
    // 6. Cleanup: stop tracks, close all PCs, delete room doc
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

        const close = () => endHostSession(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        overlay.querySelector('#coopHostClose').addEventListener('click', close);
        overlay.querySelector('#coopHostCopy').addEventListener('click', () => {
            navigator.clipboard.writeText(inviteUrl).then(
                () => setStatus(overlay, 'Invite link copied!'),
                () => setStatus(overlay, 'Couldn\'t copy — select and copy manually.'),
            );
        });

        // 1. Get screen share BEFORE creating the room
        let stream;
        try {
            setStatus(overlay, 'Asking for screen share permission…');
            stream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: { ideal: 30, max: 60 } },
                audio: false,
            });
        } catch (e) {
            setStatus(overlay, 'Screen share cancelled. Close and try again.');
            modalOpen = false;
            overlay.remove();
            return;
        }

        // 2. Create the room
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
                allowControl: false,
                viewerCount: 0,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                lastActivityAt: firebase.firestore.FieldValue.serverTimestamp(),
            });
        } catch (e) {
            setStatus(overlay, 'Couldn\'t create room: ' + e.message);
            stream.getTracks().forEach(t => t.stop());
            modalOpen = false;
            overlay.remove();
            return;
        }

        // 3. State for tracking viewers
        const viewers = new Map(); // viewerId -> { pc, dataChannel, name, unsubIce }
        let allowControl = false;  // host's master toggle

        // 4. Wire the master "Allow viewers to control" toggle
        const ctlBtn = overlay.querySelector('#coopAllowControl');
        const ctlRow = overlay.querySelector('.coop-control-toggle-row');
        if (ctlRow) ctlRow.style.display = 'flex'; // always visible in party mode
        if (ctlBtn) {
            ctlBtn.addEventListener('click', async () => {
                allowControl = !allowControl;
                ctlBtn.classList.toggle('is-on', allowControl);
                ctlBtn.textContent = allowControl
                    ? '\u{1F512} Stop letting viewers control'
                    : '\u{1F513} Allow viewers to control';
                try {
                    await roomDoc.update({ allowControl });
                } catch {}
            });
        }

        // 5. Helper: spawn a PC for a new viewer
        async function spawnViewerPc(viewerId, viewerData) {
            if (viewers.has(viewerId)) return; // already handled
            const pc = new RTCPeerConnection(RTC_CONFIG);
            // Add the screen-share tracks to this viewer's PC. The same
            // stream is shared across all PCs — getDisplayMedia is only
            // called once.
            for (const track of stream.getTracks()) {
                pc.addTrack(track, stream);
            }
            // Per-viewer input channel
            const inputChannel = pc.createDataChannel('input', { ordered: true });
            inputChannel.onmessage = (ev) => {
                if (!allowControl) return; // master gate
                try {
                    const msg = JSON.parse(ev.data);
                    dispatchRemoteInput(msg);
                } catch {}
            };

            const viewerDocRef = roomDoc.collection('viewers').doc(viewerId);

            pc.onicecandidate = (ev) => {
                if (ev.candidate) {
                    viewerDocRef.collection('ice').add({
                        from: 'host',
                        candidate: ev.candidate.toJSON(),
                        addedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    }).catch(() => {});
                }
            };

            pc.onconnectionstatechange = () => {
                const s = pc.connectionState;
                if (s === 'failed' || s === 'closed' || s === 'disconnected') {
                    // Drop the viewer if they disconnect
                    setTimeout(() => removeViewer(viewerId), 500);
                }
            };

            // Create offer + write to viewer doc
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                await viewerDocRef.update({
                    offer: { type: offer.type, sdp: offer.sdp },
                });
            } catch (e) {
                console.error('host createOffer failed:', e);
                pc.close();
                return;
            }

            // Watch for viewer's answer
            const unsubAns = viewerDocRef.onSnapshot(async (snap) => {
                const d = snap.data();
                if (d?.answer && !pc.currentRemoteDescription) {
                    try {
                        await pc.setRemoteDescription(new RTCSessionDescription(d.answer));
                    } catch (e) {
                        console.error('host setRemoteDescription failed:', e);
                    }
                }
            });

            // Watch for viewer's ICE
            const unsubIce = viewerDocRef.collection('ice').onSnapshot((snap) => {
                snap.docChanges().forEach(change => {
                    if (change.type !== 'added') return;
                    const c = change.doc.data();
                    if (c.from !== 'viewer') return;
                    pc.addIceCandidate(new RTCIceCandidate(c.candidate)).catch(() => {});
                });
            });

            viewers.set(viewerId, {
                pc,
                dataChannel: inputChannel,
                name: viewerData?.name || 'Viewer',
                unsub: [unsubAns, unsubIce],
            });
            updateViewerListUi(overlay, viewers);

            await roomDoc.update({
                state: 'connected',
                viewerCount: viewers.size,
                lastActivityAt: firebase.firestore.FieldValue.serverTimestamp(),
            }).catch(() => {});
        }

        function removeViewer(viewerId) {
            const v = viewers.get(viewerId);
            if (!v) return;
            try { v.pc.close(); } catch {}
            v.unsub?.forEach(u => { try { u(); } catch {} });
            viewers.delete(viewerId);
            updateViewerListUi(overlay, viewers);
            roomDoc.update({ viewerCount: viewers.size }).catch(() => {});
            // Best-effort cleanup of the viewer's doc + ice subcollection
            roomDoc.collection('viewers').doc(viewerId).delete().catch(() => {});
        }

        // 6. Listen for viewers joining the room
        const unsubViewers = roomDoc.collection('viewers').onSnapshot((snap) => {
            snap.docChanges().forEach(async (change) => {
                const id = change.doc.id;
                const data = change.doc.data();
                if (change.type === 'added' && data && !viewers.has(id)) {
                    await spawnViewerPc(id, data);
                } else if (change.type === 'removed') {
                    if (viewers.has(id)) {
                        const v = viewers.get(id);
                        try { v.pc.close(); } catch {}
                        v.unsub?.forEach(u => { try { u(); } catch {} });
                        viewers.delete(id);
                        updateViewerListUi(overlay, viewers);
                        roomDoc.update({ viewerCount: viewers.size }).catch(() => {});
                    }
                }
            });
        }, (err) => console.warn('viewers listener:', err));

        activeRoom = { code, role: 'host', stream, roomDoc, viewers, unsub: [unsubViewers] };

        setStatus(overlay, 'Waiting for viewers to join — share the link below. Multiple people can watch.');

        // Stop sharing if user clicks the browser's stop-sharing toolbar
        stream.getTracks().forEach(track => {
            track.onended = () => {
                setStatus(overlay, 'Stopped sharing.');
                close();
            };
        });

        const beforeunload = () => {
            try { roomDoc.update({ state: 'ended' }); } catch {}
            try { roomDoc.delete(); } catch {}
        };
        window.addEventListener('beforeunload', beforeunload, { once: true });
    }

    function updateViewerListUi(overlay, viewers) {
        const listEl = overlay.querySelector('#coopViewerList');
        if (!listEl) return;
        const count = viewers.size;
        if (count === 0) {
            listEl.innerHTML = '<span class="coop-no-viewers">No viewers connected yet.</span>';
            return;
        }
        const names = Array.from(viewers.values()).map(v => esc(v.name)).join(', ');
        listEl.innerHTML = `<strong>${count} viewer${count === 1 ? '' : 's'} connected:</strong> ${names}`;
    }

    function buildCoopOverlay(code, inviteUrl, game) {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'coopHostOverlay';
        overlay.innerHTML = `
            <div class="modal-box coop-host-modal">
                <div class="modal-header">
                    <h2>Watch party: ${esc(game?.title || 'Game')}</h2>
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
                    Send this link to friends — multiple people can join the same room.
                    Toggle below to let any viewer drive your game; same-origin browser
                    games only.
                </p>
                <div class="coop-control-toggle-row" style="display:none;">
                    <button class="coop-allow-control-btn" id="coopAllowControl" type="button">
                        &#x1F513; Allow viewers to control
                    </button>
                </div>
                <div class="coop-viewer-list" id="coopViewerList">
                    <span class="coop-no-viewers">No viewers connected yet.</span>
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
        if (activeRoom && activeRoom.role === 'host') {
            // Close every viewer PC
            for (const v of activeRoom.viewers.values()) {
                try { v.pc.close(); } catch {}
                v.unsub?.forEach(u => { try { u(); } catch {} });
            }
            activeRoom.viewers.clear();
            activeRoom.stream?.getTracks().forEach(t => t.stop());
            activeRoom.unsub?.forEach(u => { try { u(); } catch {} });
            try {
                await activeRoom.roomDoc?.update({ state: 'ended' });
                await activeRoom.roomDoc?.delete();
            } catch {}
            activeRoom = null;
        }
        overlay?.remove();
        modalOpen = false;
    }

    // ─── VIEWER FLOW (used by coop.html) ────────────────────────────
    // 1. Look up coopRooms/{code}; bail if missing or ended
    // 2. Create a viewers/{viewerId} doc — viewerId is auth uid if logged
    //    in, else a random id (anon viewers allowed)
    // 3. Wait for host to write `offer` to the viewer doc
    // 4. setRemoteDescription, createAnswer, write back
    // 5. ondatachannel('input') from host → wire input forwarding
    // 6. Per-viewer ICE subcollection
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
        const roomData = snap.data();
        if (roomData.state === 'ended') {
            setStatus('Host ended the session.');
            return;
        }

        // 2. Create our viewer slot
        const user = window.ArcadeAuth?.getUser?.();
        const viewerId = user?.uid || ('anon-' + Math.random().toString(36).slice(2, 11));
        const viewerName = window.ArcadeAuth?.getUsername?.()
            || (user?.email ? user.email.split('@')[0] : 'Anonymous');
        const viewerDoc = roomDoc.collection('viewers').doc(viewerId);

        try {
            await viewerDoc.set({
                name: viewerName,
                joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
            });
        } catch (e) {
            setStatus('Failed to join: ' + e.message);
            return;
        }

        setStatus('Joined room. Waiting for host to send the stream…');

        // 3-6. Set up the PC and exchange SDP
        const pc = new RTCPeerConnection(RTC_CONFIG);

        // Receive host's input DataChannel (host creates it as offerer)
        let inputCh = null;
        let inputEnabled = false;
        pc.ondatachannel = (ev) => {
            if (ev.channel?.label === 'input') {
                inputCh = ev.channel;
                inputCh.onopen = () => {
                    setStatus('Connected. Tap "Take control" to drive the host\'s game.');
                    showControlToggle(videoEl, () => {
                        inputEnabled = !inputEnabled;
                        return inputEnabled;
                    });
                };
            }
        };

        function sendInput(msg) {
            if (!inputEnabled) return;
            if (!inputCh || inputCh.readyState !== 'open') return;
            try { inputCh.send(JSON.stringify(msg)); } catch {}
        }

        function onKey(ev) {
            if (!inputEnabled) return;
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
        videoEl.addEventListener('touchstart', (ev) => {
            if (!inputEnabled || !ev.touches?.[0]) return;
            ev.preventDefault();
            const t0 = ev.touches[0];
            const rect = videoEl.getBoundingClientRect();
            sendInput({ t: 'm', d: 'down',
                x: (t0.clientX - rect.left) / rect.width,
                y: (t0.clientY - rect.top) / rect.height, btn: 0 });
        }, { passive: false });
        videoEl.addEventListener('touchmove', (ev) => {
            if (!inputEnabled || !ev.touches?.[0]) return;
            ev.preventDefault();
            const t0 = ev.touches[0];
            const rect = videoEl.getBoundingClientRect();
            sendInput({ t: 'm', d: 'move',
                x: (t0.clientX - rect.left) / rect.width,
                y: (t0.clientY - rect.top) / rect.height, btn: 0 });
        }, { passive: false });
        videoEl.addEventListener('touchend', (ev) => {
            if (!inputEnabled) return;
            ev.preventDefault();
            sendInput({ t: 'm', d: 'up', x: 0, y: 0, btn: 0 });
        }, { passive: false });

        pc.ontrack = (ev) => {
            videoEl.srcObject = ev.streams[0];
            videoEl.play().catch(() => {});
            setStatus('Connected. Enjoy the show.');
        };

        pc.onicecandidate = (ev) => {
            if (ev.candidate) {
                viewerDoc.collection('ice').add({
                    from: 'viewer',
                    candidate: ev.candidate.toJSON(),
                    addedAt: firebase.firestore.FieldValue.serverTimestamp(),
                }).catch(() => {});
            }
        };

        pc.onconnectionstatechange = () => {
            const s = pc.connectionState;
            if (s === 'failed') setStatus('Connection failed. Try refreshing.');
            else if (s === 'disconnected') setStatus('Disconnected.');
            else if (s === 'closed') setStatus('Closed.');
        };

        // Wait for host's offer to appear on our viewer doc, then handshake.
        let handshakeStarted = false;
        const unsubViewerDoc = viewerDoc.onSnapshot(async (s) => {
            const d = s.data();
            if (!d || handshakeStarted) return;
            if (d.offer) {
                handshakeStarted = true;
                try {
                    await pc.setRemoteDescription(new RTCSessionDescription(d.offer));
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    await viewerDoc.update({
                        answer: { type: answer.type, sdp: answer.sdp },
                    });
                } catch (e) {
                    setStatus('Handshake failed: ' + e.message);
                }
            }
        });

        // Listen for host's ICE candidates
        const unsubIce = viewerDoc.collection('ice').onSnapshot((snap) => {
            snap.docChanges().forEach(change => {
                if (change.type !== 'added') return;
                const c = change.doc.data();
                if (c.from !== 'host') return;
                pc.addIceCandidate(new RTCIceCandidate(c.candidate)).catch(() => {});
            });
        });

        // Watch room state for end signal
        const unsubRoom = roomDoc.onSnapshot((s) => {
            const d = s.data();
            if (!d || d.state === 'ended') {
                setStatus('Host ended the session.');
                pc.close();
            }
        });

        // Cleanup on unload — best-effort delete our viewer slot so the
        // host can free up resources without waiting for connection-state
        // disconnected.
        window.addEventListener('beforeunload', () => {
            try { viewerDoc.delete(); } catch {}
        }, { once: true });

        activeRoom = {
            code: roomDoc.id,
            role: 'viewer',
            pc,
            roomDoc,
            viewerDoc,
            viewerId,
            unsub: [unsubViewerDoc, unsubIce, unsubRoom],
        };
    }

    // Public API
    window.ArcadeCoop = {
        startCoopAsHost,
        joinAsViewer,
    };
})();
