# Multi-file game upload — setup guide

The worker exposes a `POST /upload` endpoint that lets admins push
entire multi-file game projects to the arcade GitHub repo from the
browser. No Firebase Storage / R2 / billing required.

## How it works

```
Browser (admin)
    │
    │  1. Read folder/zip → list of {relpath, base64}
    │  2. POST /upload  +  Authorization: Bearer <Firebase ID token>
    ▼
Worker (arcad-groq.gatabanumai.workers.dev)
    │
    │  3. Decode JWT → get uid
    │  4. GET firestore /users/{uid} with the same token (Firestore
    │     verifies the signature; we just check role == 'admin')
    │  5. Build a git tree from the uploaded files
    │  6. Commit to GitHub via the git-data API (one atomic commit
    │     for any number of files)
    │  7. Update refs/heads/main to the new commit
    ▼
GitHub
    │
    │  8. Push triggers each deploy host (Render / Vercel / CF / etc)
    │
    ▼
Live arcade
    │
    │  9. ~30s-2min later, files at games/uploads/<id>/... are
    │     served by every deployed host. Player iframes them.
```

## One-time setup

### 1. Generate a GitHub fine-grained PAT

1. Go to https://github.com/settings/personal-access-tokens/new
2. Repository access → "Only select repositories" → pick
   `packgod67/computerscience-lessons`
3. Permissions → Repository permissions:
   - **Contents: Read and write**
   - Metadata: Read-only (auto-included)
4. Expiration: pick whatever — 1 year is reasonable
5. Generate the token. **Copy it now**, GitHub won't show it again.

### 2. Push secrets + env vars to the worker

Open a terminal in `D:\game_website\workers` and run:

```sh
# Auth secret — never appears in code or logs
wrangler secret put GITHUB_TOKEN
# Paste the PAT when prompted

# Public-ish identifiers — fine in wrangler.toml [vars] but secret
# put works too:
wrangler secret put GITHUB_OWNER       # type: packgod67
wrangler secret put GITHUB_REPO        # type: computerscience-lessons
wrangler secret put GITHUB_BRANCH      # type: main
wrangler secret put FIREBASE_PROJECT_ID  # type: <your firebase project id>
```

Find your Firebase project ID at
https://console.firebase.google.com → Project settings → General → Project ID.

### 3. Deploy the updated worker

```sh
cd D:\game_website\workers
wrangler deploy
```

You should see something like
`Uploaded arcad-groq (X sec) Published arcad-groq...`.

### 4. Test it

Settings → Admin tools → Custom games → "+ Multi-file folder/zip" →
drop a small test folder → click upload. You should see:

- "Reading N files..."
- "Pushing N files to GitHub via worker..."
- "✅ Pushed to GitHub (commit abc1234). Game playable in ~1 min..."

The commit should appear in your repo at
https://github.com/packgod67/computerscience-lessons/commits/main.

After the deploys finish (~1 min), the game will load when clicked
in the arcade.

## Limits

- 100 MB total upload per game
- 500 files max per game
- 1 admin upload at a time per session (the request is synchronous)
- GitHub API rate limit: 5,000/hour for authed requests — you'd have
  to upload ~1000 games an hour to hit it

## Troubleshooting

**`{"error":"admin auth required"}`** — the Firebase ID token wasn't
sent or the user isn't admin in Firestore. Check that you're signed
in as packgod67 and that `users/<uid>.role === "admin"`.

**`{"error":"GitHub worker secrets missing"}`** — `wrangler secret put`
didn't take. Re-run and confirm with `wrangler secret list`.

**`{"error":"refs lookup failed: 404"}`** — wrong repo owner / name,
or PAT lacks access to that repo.

**`{"error":"blob create failed: 403"}`** — PAT doesn't have
`contents:write` permission. Regenerate with the correct scope.

**Game uploads succeed but don't appear** — deploy hosts cache. Hard-
refresh (Ctrl+Shift+R). For Render specifically, deploys can take 2-3
minutes; for Cloudflare Pages it's usually <30s.

## Removing a game

Settings → Admin tools → Custom games → Delete button on the row.
This sends `DELETE /uploads/<gameId>` to the worker, which removes
all files in `games/uploads/<gameId>/...` in a single commit, then
deletes the Firestore doc.
