# WebRTC co-op — implementation plan (deferred)

This is a real piece of work that deserves a focused session, not a stub
in a multi-feature session. Below is what to build when picked up.

## Goal

A "Watch with a friend" button on game info modals. One user starts a
room, another joins via a code. The host shares their viewport (game +
arcade chrome) via WebRTC video stream. Viewer just watches — no input
echo in MVP.

## Why it's worth building (vs "just use Discord")

- One-click within the arcade context, no third-party account needed
- Future expansion: input echo for "couch co-op" of single-player games
- Future expansion: per-game integration where the host's Pokemon trade
  is actually a real Pokemon trade between two emulator instances
- For users who don't already use Discord, no friction

## Architecture

### Signaling — Firestore

We already have Firestore for chat. New collection:

```
coopRooms/{roomCode}
  hostUid:    string
  hostJoined: timestamp
  offer:      string  (SDP offer JSON)
  answer:     string  (SDP answer JSON)
  state:      "waiting" | "connecting" | "connected" | "ended"
  createdAt:  timestamp
  expiresAt:  timestamp  (delete docs after 1 hour idle)
```

ICE candidates as a subcollection:

```
coopRooms/{roomCode}/iceCandidates/{auto}
  from:      "host" | "viewer"
  candidate: string  (ICE candidate JSON)
```

Firestore security rule: only host or viewer can update; doc TTL 1hr.

### WebRTC peer connection

Standard `RTCPeerConnection` with public STUN servers (Google's
`stun.l.google.com:19302`). For TURN fallback (when peers are behind
strict NAT), Cloudflare offers free TURN at `cloudflareportal.com/turn`.

### Display capture

```js
const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30, max: 60 } },
    audio: false,  // MVP — audio adds permission complexity
});
peerConnection.addTrack(stream.getVideoTracks()[0], stream);
```

Browser's "share screen" picker lets host pick: full screen, app window,
or Chrome tab. Recommend Chrome tab so they can also see the friend
list etc. on their screen without leaking.

### Room code format

6 characters, uppercase letters + digits, easy to type. e.g. `K7M9PW`.
Generate via `Array.from({length:6}, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('')`.
Avoid confusing chars (I, L, O, 0, 1).

## UI

### Host flow

1. Click "Co-op" button in game info modal
2. Modal: "Share with a friend"
   - Generate room code (auto-shown big)
   - "Copy invite link" → `https://arcade/play.html?game=X&coop=K7M9PW`
   - "Start sharing" → triggers getDisplayMedia consent
3. Once friend joins, status changes to "Connected — your friend can see your screen"
4. "End co-op" stops the stream + deletes the room

### Viewer flow

1. Open invite link OR enter code on a `/coop` page
2. Modal: "Joining room K7M9PW…"
3. Once host accepts (their getDisplayMedia consent), viewer sees stream
4. Stream renders in a fullscreen `<video>` element
5. Read-only — viewer can't interact

## Files to create

- `js/coop.js` — entry points, room creation, signaling
- `js/coop-rtc.js` — WebRTC peer connection lifecycle
- `coop.html` — viewer-only page that takes `?room=CODE`
- CSS in `style.css` for the co-op modal

## Files to modify

- `js/app.js` — co-op button in game info modal
- `firestore.rules` — coopRooms + iceCandidates rules

## Estimated effort

- Firestore schema + rules: 30 min
- Signaling client code: 1.5 hours
- WebRTC peer connection: 2 hours
- UI (host modal + viewer page): 1.5 hours
- Testing across browsers: 1 hour

**Total: ~6–7 hours**

## Open questions for future me

- Do we want audio? Adds permission complexity but enables voice chat
- Do we want input echo? That's a per-game can of worms
- Room expiry — auto-close after N minutes idle?
- TURN server credentials — store in worker secret?
- What happens when the host's tab is backgrounded (Chrome throttles
  display capture frame rate)?
