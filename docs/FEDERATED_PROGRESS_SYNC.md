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

Viewer identity on the source home is derived as a one-way hash of the caller's node ID. Multiple users on the viewer home map to a single per-node viewer identity at the source. This is a deliberate v1 simplification.

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

- v1 uses a per-node aggregate — if multiple users on the viewer home watch the same item, only the most recent record is returned.
- There is no automatic merge, real-time sync, or durable retry for failed pushes.
- Push is fire-and-forget — if the source home is unreachable, the push is dropped (not retried).
- Per-user identity across homes is not supported in v1.
