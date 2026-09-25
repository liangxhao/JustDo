# OpenClaw v2026.9.6 runtime patches

This directory is the authoritative capability inventory for the locked pristine
`openclaw@2026.9.6` npm artifact in `source-lock.json`. Rebuild from that artifact;
never upgrade a previously patched runtime in place. Historical and partial
markers must fail. Original v2026.9.2 files remain historical evidence only.

## Audit disposition

Of the 25 previous capabilities, 22 still need product integration. Two are
provided natively and have no replacement patch:

- **009, forced memory reembedding:** the new memory index uses a shadow database
  and generation-owned embedding cache (`MemoryIndexDatabase.openShadow`,
  `withReindexDatabase`). It no longer seeds a force rebuild from the previous
  database's cache. Preserve native atomic publication and rollback.
- **024, ACP admission hot reload:** `acp.allowedAgents` is now a native hot
  operation-policy update. The native config reload tests cover this boundary.

The former **017 segmented live recovery snapshot** enhancement is retired.
Native `chat.history` already returns persisted display messages, buffered
`inFlightRun.text`, and tool/item progress events. Exact replay of unfinished
Thinking/Content segments is not a prerequisite for reply recovery. The Renderer
uses the native snapshot and does not require injected segment identifiers.

One newly exposed Windows integration gap requires patch 031. There are **23**
patches in this version. They are not a migration of the old runtime.

| Patch | Capability retained | 2026.9.6 implementation boundary |
| --- | --- | --- |
| 001 | Managed pip configuration provenance | Both host environment sanitizers |
| 002 | Windows MCP npm launch under Electron | Owned stdio process options; native process lifecycle retained |
| 003 | Windows Chrome MCP launch | Native launch seam; upstream owns early stderr capture |
| 005 | Final system prompt replacements | Model-aware prompt assembly before routing/cache observation, including worker copies |
| 006 | Agent metadata and hidden turns | Chat schema, prepared request and provider payload |
| 007 | Request-purpose metadata | Payload wrapper and prepared simple completion |
| 008 | App-process restart boundary | Fenced durable task maintenance and main-session restart recovery |
| 013 | Explicit Goal resume after pause | Restart-safe admission; only resume relaxes previous-abort check |
| 014 | Provider-safe replay | Native assistant transport projection |
| 015 | Trusted local file delivery | Managed attachment MIME fallback and display media references; native disposition retained |
| 016 | Offline official plugin catalog | Native catalog loader with offline intent |
| 018 | Mixed commentary ordering | Native grouped commentary fallbacks and sanitization |
| 019 | No automatic plugin repair downloads | Installed-index lease writer; explicit installs remain native |
| 020 | Configured realtime ASR URL | Native OpenAI realtime provider factory |
| 021 | Independent image/video providers | Capability-scoped config with native authentication dependencies |
| 022 | Visible planning history after reset | Transcript boundary window; model reset remains native |
| 023 | Managed atomic fork | Explicit target namespace, assistant cut, repository/workspace fields and work-context editor text |
| 025 | MXC external skill paths | Canonical host read-only skill materialization |
| 026 | Private untrusted turn context | Authorized agent-only body; raw transcript text unchanged |
| 027 | Shared session-access providers | Process-wide native Map registry |
| 028 | Managed session cwd | Authenticated admin JustDo namespace only |
| 030 | Scheduled task permissions | Native cron schema, job persistence and executor boundaries |
| 031 | Windows credential launcher ACL | Only justdo_login, exact System32 PowerShell path, verified TrustedInstaller SID; other untrusted writers rejected |

All patches are temporary product integration seams, with their removal conditions,
scope and safety constraints in the module headers. No upstream issue number is
claimed where no issue has been filed. Re-audit each capability on the next upgrade.

Removing 017 requires a rebuild from the locked pristine artifact. Do not undo
injections in an existing runtime or rewrite its proof manifest. See
`docs/features/openclaw-2026.9.6-message-sync.md` for the native recovery audit.

The npm artifact has hashed `.mjs` modules plus two worker bundles. Target counts
include the relevant worker copies and the generated Gateway bundle; esbuild may
rename locals and remove comments, so verification checks current code contracts.
The facade static-import transform is packaging-only and lives in
`../../openclaw-facade-runtime-patch.cjs`.

`verify-openclaw-pristine-contracts.cjs` checks native execution, stop, approval,
Goal, history, tool-discovery and compaction contracts before applying the patch
set. `verify-openclaw-runtime-patches.cjs` verifies the exact source proof, build
recipe, patch fingerprints and final artifacts. Never repair a failed proof by
rewriting its manifest.
