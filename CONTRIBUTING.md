# Contributing to Helix

Thank you for your interest in contributing. Please read this before submitting
a pull request.

## Contribution license agreement

By submitting a contribution to Helix, you agree that your contribution may be
distributed by the Helix maintainers under both the AGPL-3.0-or-later and
Helix's commercial license terms. You represent that you have the right to
submit the contribution under these terms.

This is necessary because Helix is dual-licensed — community use is under the
AGPL and a separate commercial license is available. Keeping contribution rights
clear is what makes both tracks possible.

## Before you submit

**Run the test suite and type checks:**

```bash
pnpm typecheck   # must pass with zero errors
pnpm test        # must pass 381/381
pnpm build       # must succeed
```

**Do not include:**

- Secrets, API keys, tokens, or credentials of any kind
- Database files (`*.db`, `*.db-wal`, `*.db-shm`)
- Generated files (`dist/`, `node_modules/`, `data/`)
- Local `.env` files or `.helix_key`

**Security issues:** Do not open a public issue for security vulnerabilities.
Follow the process in [SECURITY.md](SECURITY.md).

## Pull request guidelines

- Keep PRs focused — one concern per PR
- Describe what changed and why, not just what
- Include test coverage for new behaviour where practical
- If your change touches the backend API, update the README API reference

## Questions

Open a GitHub Discussion or an issue before starting large changes — it avoids
wasted effort if something is already in progress or out of scope.
