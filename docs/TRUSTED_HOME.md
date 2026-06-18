# Trusted Home

A Trusted Home is another Helix instance that you have explicitly connected to your own. Once connected, you can browse and play media from its libraries, and optionally sync watch progress in both directions.

## Concept

Each Helix installation is a "Home". Homes are private by default — they do not advertise themselves and do not accept incoming connections unless you explicitly generate an invite. The bilateral trust model means both admins must agree to every capability before it is active.

## Connection setup

1. Admin A generates an invite on their home (`Trusted Homes → This Home → Generate invite`).
2. Admin A sends the compact invite string to Admin B out-of-band (direct message, email, etc.).
3. Admin B pastes the invite string on their home (`Trusted Homes → Connect using invite`).
4. Both homes negotiate a shared federation token and begin catalog sync.

After connection, Admin B must explicitly grant their users access to Admin A's libraries via `Manage Access` on the connected home.

## Invite flow

- Invites are single-use. After Admin B connects, the invite is consumed and cannot be reused.
- Invites can carry an optional label and expiry date.
- Revoke unused invites immediately if leaked.

## Bilateral trust model

Every federation capability requires explicit opt-in on both sides:

| Capability | Source Home must enable | Viewer Home must enable |
|---|---|---|
| Catalog sync | (automatic after connect) | (automatic after connect) |
| Progress push | `allow_progress_receive` | `allow_progress_push` |
| Remote playback | `BASE_URL` configured | Proxy or direct mode |

There is no way for one home to pull capabilities from another without that other home's explicit opt-in.

## Per-user viewer identity

By default, watch progress pushed to a source home is stored under a **per-node aggregate** identity: everyone on the viewer home shares one resume point per item at the source. Per-user viewer identity is an optional upgrade so two people sharing a viewer home keep separate remote resume points.

Key properties:

- **Off by default, admin-only, bilateral.** Each side sets `allow_progress_user_identity` for the connection. Per-user mode is used only when **both** homes have opted in.
- **No identifying data leaves the home.** The viewer home derives a stable opaque hash, `HMAC(secret, localNodeId + userId)`, truncated to 32 hex chars. Actual user IDs, names, and emails are never sent. The source stores only the bare hash and cannot reverse it (it lacks the key).
- **Transport is server-to-server only.** Push carries the hash in the federation PUT body; read carries it in `X-Viewer-Identity-*` federation headers (never a URL query parameter). The browser never receives the federation token or the hash.
- **One-sided opt-in downgrades safely.** If only one side has opted in, the push is stored in node-aggregate mode and a `per_user_identity_downgraded` audit event is recorded (no hash). A per-user *read* with no matching row returns `available: false` — it never falls back to another household member's aggregate position.
- **Affects future progress only.** Enabling per-user identity does not relabel previously stored node-mode rows. Rotating `TRUSTED_HOME_VIEWER_IDENTITY_SECRET` resets continuity and orphans prior per-user rows on the source (opaque, never reversible).

Enable it per connection under `Trusted Homes → <home> → Progress sync → Use per-user progress identity` (visible once progress push is enabled and the peer advertises support).

## Release candidate gate

Before shipping a Trusted Home release, run the consolidated readiness gate:

```bash
pnpm --filter @helix/backend release-check:trusted-home          # full gates
pnpm --filter @helix/backend release-check:trusted-home --quick  # in-process only (smoke + docs scan)
```

It prints the operator release checklist and runs safe gates, exiting non-zero if any fails:

- **smoke_harness** — the in-process federation smoke harness (above).
- **docs_no_leak_scan** — static scan of `docs/*.md` for accidental secrets, bearer tokens, credentialed URLs, hash-like hex runs, or absolute user paths.
- **typecheck / lint / build / backend_tests / frontend_tests** — the workspace gates (full mode only).

Gate output is a safe per-gate pass/fail summary only — it never echoes raw child output, secrets, tokens, viewer hashes, URLs, or paths. The recommended release process: take a pre-upgrade backup, run the full gate, review admin diagnostics, then deploy. For the next step after a green gate, rehearse on two real Homes (see the manual checklist below).

## Automated smoke harness

For a fast, deterministic, local-first sanity check of the federation stack (no real network, no secrets, no second machine required):

```bash
pnpm --filter @helix/backend smoke:trusted-home
```

It boots one in-process Home against a temporary SQLite database, drives the real federation/source routes, and uses a stubbed source for the viewer-side proxy read. It prints a machine-readable JSON report plus a `✓/✗` line per check and exits non-zero if any check fails. Covered checks: readiness/health, federation token issuance, source-side progress write (node mode), per-user bilateral push + read, one-sided downgrade (push stored node-mode; user read returns `available:false` with no aggregate fallback), audit event creation, viewer-side proxy read + resume suggestion, diagnostics structure, and a no-leak scan over every federation/diagnostics/viewer response (federation token, viewer identity hash, secret, user ID, raw URL, and filesystem path must not appear). The same harness runs in CI via `tests/trustedHomeSmoke.test.ts`.

The manual two-home checklist below remains the authoritative pre-production validation across two real Homes (it covers catalog visibility, real proxy playback, and signed refresh behavior that the single-process harness cannot fully exercise).

## Deployment smoke checklist (two homes)

Run end-to-end after deploying or upgrading two connected homes (A = source with libraries, B = viewer). Each step should succeed before moving on.

1. [ ] **Connect:** On A, generate an invite; on B, connect with it. Both homes show the connection as online.
2. [ ] **Sync health:** Admin diagnostics on B show `trustedHomeSync` healthy (not degraded/stale) for A.
3. [ ] **Remote catalog:** A's library items appear in B's catalog after access is granted via `Manage Access`.
4. [ ] **Proxy playback:** A remote item plays in B's browser via proxy. The browser never contacts A directly and never receives a federation token.
5. [ ] **Signed refresh:** During playback the player refreshes its `?rt=` token before expiry (default 3 min) without interruption; the refresh token is scoped to that node + media item.
6. [ ] **Write local progress:** Watch part of a remote item on B; local watch state records a position.
7. [ ] **Push enqueues:** B's progress outbox shows the push enqueued (status `pending`).
8. [ ] **Outbox sync/abandon:** With A reachable, the job transitions to `synced`. With A unreachable, it retries up to `PROGRESS_OUTBOX_MAX_ATTEMPTS` then `abandoned` — no user-facing error, a safe audit event is recorded.
9. [ ] **Source read:** A's `remote-progress` read returns the pushed position for B's caller node.
10. [ ] **Resume suggestion:** Reloading the item on B surfaces a "Use remote position" suggestion (never an automatic overwrite).
11. [ ] **Enable per-user identity on both:** Toggle `allow_progress_user_identity` on for the connection on both A and B.
12. [ ] **Two users separate:** Two different users on B watching the same item produce two distinct remote resume points at A (verify each user only sees their own).
13. [ ] **One-sided downgrade:** Disable per-user identity on A only. New pushes from B downgrade to node mode; a per-user read returns `available: false` (no aggregate fallback). A `per_user_identity_downgraded` audit event appears.
14. [ ] **Audit + pruning:** Audit events appear in the Trusted Home activity panel; retention/prune-cutoff/last-cleanup diagnostics render correctly.
15. [ ] **No leakage:** Inspect browser network responses and admin API output — confirm no federation token, viewer identity hash, raw remote URL, filesystem path, request header, raw upstream error, stack trace, user ID, username, or email appears anywhere.

## Backup and restore

Federation state lives in the SQLite database. The tables that matter operationally:

| Table | Holds | Importance | Safe to lose? |
|---|---|---|---|
| `nodes` | Trusted node records + `federation_token_hash` (credential material) | **Critical** — losing it breaks every connection and requires re-inviting | No — back up |
| `remote_watch_progress` | Progress stored at a source home (node-mode + per-user opaque hashes) | Valuable — losing it loses cross-home resume points | Tolerable loss (resume points only) |
| `federated_progress_outbox` | Pending/in-flight progress pushes from this home | Transient — bounded-retry queue | Yes — safe to lose (see stale note) |

### Progress data retention (automatic pruning)

A background pruner (startup, then daily — same style as the audit/tombstone pruners) bounds long-term growth of the progress tables:

- **Outbox:** only **terminal** rows are pruned — `synced` (delivered) and `abandoned` (gave up after max attempts) — older than `TRUSTED_HOME_PROGRESS_OUTBOX_RETENTION_DAYS` (default 30). `pending`, `in_progress`, and `failed` (retry-pending) jobs are **never** pruned, so no in-flight work is lost.
- **Remote progress:** `remote_watch_progress` rows older than `TRUSTED_HOME_REMOTE_PROGRESS_RETENTION_DAYS` (default 365), by `updated_at`. Recent progress is preserved. Pruning is purely time-based — it never interprets viewer identity hashes and never deletes by user, profile, or username.
- Pruning is best-effort and non-blocking; a failure is logged and retried on the next cycle. Aggregate state (cutoffs, last-prune time/count/status) is surfaced in `sync-diagnostics.progressRetention`.
| `trusted_home_audit_events` | Privacy-safe audit trail | Operational record only | Yes — safe to lose |

Guidance:

- **Must back up:** the whole SQLite database, primarily for `nodes` (federation credentials and connection state). Take a backup before any upgrade.
- **Safe to lose:** the outbox and audit tables. Worst case is some progress pushes never deliver and audit history is shorter.
- **If the outbox is restored stale** (from an old backup): already-`synced` jobs may re-send. This is safe — the source applies newer-wins conflict rules and idempotency via `clientEventId`, so a stale re-push is ignored or overwritten by newer progress. No corruption, at most a redundant write.
- **If the viewer identity secret changes** between backup and restore: per-user resume points no longer match and prior per-user rows become orphan opaque hashes (they age out via retention). Node-aggregate progress is unaffected. Keep `TRUSTED_HOME_VIEWER_IDENTITY_SECRET` in your secret store alongside the DB backup.
- **Recommended pre-upgrade step:** stop the server (or quiesce writes), copy the SQLite DB file (and WAL/SHM if present) to durable storage, then upgrade. Record which secrets were in effect.

## Migration rollback notes (0017–0019)

These migrations are **additive** — they add tables and nullable/defaulted columns; none drop or rewrite existing data.

| Migration | Adds |
|---|---|
| `0017_progress_outbox` | `federated_progress_outbox` table |
| `0018_audit_events` | `trusted_home_audit_events` table (audit retention/pruning is config-driven, not schema) |
| `0019_per_user_viewer_identity` | `nodes.allow_progress_user_identity`, `remote_watch_progress.viewer_identity_kind`, `federated_progress_outbox.viewer_identity_hash` |

Rollback guidance:

- **Code rollback with a migrated DB is safe.** The schema additions are backward-tolerant: older code ignores the extra tables and columns (added columns are nullable or defaulted, consistent with how this project applies migrations). You do **not** need to drop anything to run a prior build.
- **Destructive rollback (dropping the tables/columns) is not recommended without a backup.** It permanently discards queued pushes, audit history, and per-user identity state.
- **Per-user rows persist as opaque hashes** after a code rollback. Older code simply treats all stored progress as node-mode; the extra `viewer_identity_kind`/hash data is inert until per-user-aware code runs again.
- **Node-mode fallback remains safe** at every step: with per-user code disabled or rolled back, progress sync continues in node-aggregate mode with no data loss and no errors.

## Disconnecting

Disconnecting a Trusted Home removes its synced catalog and all user access grants from your home. It does not affect media on the remote home. The remote home retains its copy of any synced catalog data from your home; the admin of the remote home must disconnect from their side to remove it.
