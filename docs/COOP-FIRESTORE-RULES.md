# Firestore rules for the WebRTC co-op feature

Add these blocks to your existing `firestore.rules` (alongside the
other collection rules I gave you earlier). Then publish in Firebase
Console → Firestore → Rules.

```
match /coopRooms/{roomCode} {
  // Anyone signed-in can read room metadata (so a viewer can look
  // up the offer + state by room code).
  allow read: if signedIn();

  // Host creates the room with their own uid.
  allow create: if signedIn()
                && request.resource.data.hostUid == request.auth.uid;

  // Update is allowed in two cases:
  //   1. The host is mutating their own room (any field)
  //   2. ANY signed-in user is writing the `answer` field — that's
  //      the viewer joining. Locking down to a specific viewer uid
  //      isn't possible because the viewer didn't pre-register.
  // Updating only `answer` + `lastActivityAt` is enforced via the
  // diff-of-changed-keys check.
  allow update: if signedIn() && (
                  resource.data.hostUid == request.auth.uid
                  || (
                    request.resource.data.diff(resource.data).affectedKeys()
                      .hasOnly(['answer', 'lastActivityAt'])
                  )
                );

  // Only the host can delete the room.
  allow delete: if signedIn()
                && resource.data.hostUid == request.auth.uid;

  // ICE-candidate subcollection — both host and viewer write to it.
  match /iceCandidates/{candId} {
    allow read: if signedIn();
    allow create: if signedIn();
    // Candidates are immutable once written.
    allow update, delete: if false;
  }
}
```

## Why this shape

- **Read open to all signed-in users.** A viewer needs to look up
  a room by code without knowing the host's uid in advance. The
  6-character random code provides the obscurity; security would
  fall apart if codes were predictable, but the alphabet
  (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`) and length give 31^6 ≈ 887M
  combinations — fine for short-lived ephemeral rooms.

- **Update gated to host OR `answer`-only writes.** The viewer
  joining doesn't have a uid stored in the room doc yet (we don't
  know who they'll be), so we can't gate updates by `viewerUid ==
  request.auth.uid`. Instead we allow any signed-in user to write
  ONLY the answer field. The `affectedKeys().hasOnly([...])` check
  prevents a malicious user from overwriting the host's offer or
  hijacking the room state.

- **iceCandidates immutable once created.** Prevents replay /
  alteration attacks on a peer's network identity.

- **No room TTL.** Firestore has no built-in TTL; idle rooms stay
  forever unless cleaned up. For now the host's `endHostSession`
  deletes the room on close. A scheduled Cloud Function or a daily
  GitHub Actions job could sweep stale rooms (state=ended OR
  lastActivityAt > 1h old) — out of scope for the MVP.

## Optional: scheduled cleanup

If you want auto-cleanup, add a workflow at
`.github/workflows/coop-room-cleanup.yml` that runs `node
scripts/cleanup-coop-rooms.mjs` once a day. The script would use
the Firebase Admin SDK with a service-account secret to delete docs
where `lastActivityAt < now - 1 hour`. Worth it if rooms accumulate.
