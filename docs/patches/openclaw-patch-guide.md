# OpenClaw Runtime Patch

Patch files are compatibility shims for the bundled OpenClaw runtime.

## Rules

- Keep patches small and auditable.
- Explain why each patch exists.
- Explain when each patch can be removed.
- Do not create a second source of truth for runtime behavior.
- Prefer upstream fixes over patch growth.

## Current location

- `scripts/patches/README.md`
- `scripts/patches/v2026.6.9/`
- `scripts/patch-openclaw-runtime.cjs`

## Current patch set

- `001-thinking-stream.cjs`
- `002-session-write-lock-self-timeout.cjs`
- `003-agent-announce-reasoning-stream.cjs`
- `004-openai-content-reasoning-tags.cjs`
- `007-windows-mcp-package-runner.cjs`
- `008-history-thinking-and-subagent-yield.cjs`
- `009-sessions-yield-active-guard.cjs`

## Maintenance

- Update the patch directory when `openclaw.version` changes in `package.json`.
- Remove patches that are no longer needed by the runtime.
- Keep the document aligned with the actual patch directory.
