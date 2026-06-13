# Federated Progress Sync

Federated progress sync allows watch progress to be shared between connected Trusted Homes, so you can resume where you left off when switching between homes.

## What is sent

When progress is pushed, the viewer home sends:
- `positionSeconds` — current playback position in seconds
- `durationSeconds` — known duration of the item
- `watched` — whether the item is considered fully watched
- `updatedAt` — ISO8601 timestamp of when the progress was recorded
- `clientEventId` — optional stable event identifier for idempotency

## What is NOT sent

The following are **never** included in a progress push:
- Local user ID or username
- Session token or cookie
- Filesystem paths
- Federation token or Authorization header values
- Stack traces or raw error messages
- Any credential-like value

## Viewer identity modes

There are two identity modes for stored progress at the source home:

- **Node aggregate (default):** Viewer identity is a one-way hash of the caller's node ID. All users on the viewer home map to a single per-node identity at the source. This is the default and requires no extra configuration.
- **Per-user identity (opt-in, both sides):** Each user on the viewer home is represented by a stable, opaque HMAC hash so that two people sharing a viewer home get separate remote resume points. See `docs/TRUSTED_HOME.md` → "Per-user viewer identity" for the full model, transport, and downgrade rules. The hash is derived server-side from `HMAC(secret, localNodeId + userId)` and is never reversible by the source — it carries no user ID, username, email, or profile name.

Per-user identity is **off by default**, admin-only, and used only when **both** homes have enabled `allow_progress_user_identity` for the connection. One-sided opt-in safely downgrades to node-aggregate mode.

## Bilateral opt-in model

Progress sync requires explicit opt-in on both sides:

| Setting | Home | Meaning |
|---|---|---|
| `progress_sync_enabled` | Viewer home | Master enable/disable switch |
| `allow_progress_push` | Viewer home | This home will send progress to the source |
| `allow_progress_receive` | Source home | This home will accept progress from the viewer |

If either side has not opted in, progress is not pushed and no error is shown to users.

## Conflict rules (write path)

When a new progress record arrives, the source home applies these rules:
1. Newer `updatedAt` wins — older records are silently ignored.
2. If timestamps are equal, higher `positionSeconds` wins.
3. `watched=true` is only accepted if `positionSeconds >= durationSeconds * 0.90`.
4. `positionSeconds` must not exceed `durationSeconds * 1.01` (1% rounding tolerance).
5. `updatedAt` must not be more than 5 minutes in the future.

## Reconciliation rules (read path)

When a user loads a media item and remote progress is available, the local home evaluates whether to suggest using it:

| Condition | Outcome |
|---|---|
| No remote progress | No suggestion |
| Remote has no duration or timestamp | No suggestion |
| Position > duration × 1.01 | No suggestion (invalid) |
| `watched=true` but < 85% complete | No suggestion (invalid) |
| Duration mismatch > 10% | No suggestion (different encode) |
| Remote older than local | No suggestion |
| Remote stale > 7 days | No suggestion |
| No local progress yet | Suggest using remote |
| Delta < 30s and < 5% of duration | No suggestion (tiny difference) |
| Remote ahead ≥ 60s and ≥ 5% of duration | Suggest using remote |
| Otherwise | Keep local |

## User action required

The reconciliation result is a **suggestion only**. Applying it requires the user to click "Use remote position". Progress is never overwritten automatically.

## Known limitations

- In node-aggregate mode, if multiple users on the viewer home watch the same item, only the most recent record is returned. Per-user identity (opt-in) addresses this.
- There is no automatic merge between node-mode and per-user rows, no real-time sync, and no cross-node fanout.
- Reconciliation is a suggestion only — progress is never overwritten automatically (automatic progress merge is a deferred phase).
- Pushes are durably queued in the progress outbox with bounded retry; after the attempt budget is exhausted a job is abandoned (a safe audit event is recorded, never the payload).
- Rotating the viewer identity secret resets per-user continuity and leaves prior per-user rows on the source as orphan opaque hashes (they age out via audit/normal retention; they are never reversible).
