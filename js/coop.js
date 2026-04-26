// WebRTC co-op — share-your-game with a friend.
//
// Host: clicks "Co-op" in a game info modal, gets a 6-char room code,
// shares their viewport (game + arcade chrome) via getDisplayMedia.
// Viewer: opens coop.html?room=CODE, sees the host's stream.
//
// MVP scope: one host, one viewer. Read-only — viewer just watches,
// no input echo. Future: multi-viewer (would need an SFU), input
// relay for couch co-op of single-player games.
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
                    they watch you play. View-only — they can't input.
                </p>
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
