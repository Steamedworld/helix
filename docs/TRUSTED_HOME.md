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

## Disconnecting

Disconnecting a Trusted Home removes its synced catalog and all user access grants from your home. It does not affect media on the remote home. The remote home retains its copy of any synced catalog data from your home; the admin of the remote home must disconnect from their side to remove it.
