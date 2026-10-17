# ACPX source and integration record

The source target is OpenClaw `v2026.10.4`, commit
`383c124cc32ffee3f8e56f549b88da94d269a4af`, under `extensions/acpx/`.
The local package is `2026.10.4-local.1`, requiring plugin API `>=2026.10.4`.

The previous local package label, `2026.9.8-local.1`, described SDK integration,
not a complete upstream source refresh. Its actual source ancestor was
`v2026.9.2` (`3928bad9badfcb6c7d140530435e806fb8092190`). This refresh compared
that ancestor, the local fork, and the 10.4 target; it also inspected the official
9.8 checkpoint (`fc23bc864e4553c2d215e479eeec47b67a0bf943`) to distinguish
already-applied API adaptations from missing implementation changes.

## Upstream changes adopted

| Area              | Adopted behavior and location                                                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime ownership | `runtime-generations.ts` and `runtime-session-store.ts` retain exact physical records and generation custody across admission, reset, ordinary close and late writes. Retired owners cannot mutate successors. The existing owner-qualified resource and persisted handle formats are unchanged. |
| ACP transport     | `runtime.ts` uses the current dynamic MCP and session permission callbacks, structured argv, process lifecycle hooks, pre-active cancellation, typed model capability errors and explicit `timeoutMs: 0` for turns.                                                                              |
| Diagnostics       | `runtime-probe.ts` serializes temporary probe owners and waits for their shutdown. Failed probe cleanup remains owned and is reported by runtime/service shutdown. Turn diagnostics capture the admitted lease before reset; late errors cannot read a successor's stderr.                       |
| Process cleanup   | `runtime-process-cleanup.ts` captures immutable cleanup evidence before backend close. Reaper recovery rechecks ownership after awaits and before signals; lease APIs accept structured argv.                                                                                                    |
| Windows bridge    | `command-line.ts` recognizes Node, Bun and the managed executable invoking the OpenClaw ACP entry. It preserves raw Windows separators, empty arguments and native argv.                                                                                                                         |
| Service lifecycle | Stable lazy facades, inspection/promotion separation, live allowed-agent access, bounded Tokio pools and asynchronous shutdown are adopted. Partial activation joins cleanup; failure retains an observable failed stop barrier.                                                                 |
| Task deadlines    | `index.ts` forwards reply dispatch directly. The connection timeout no longer aborts a long native ACP task; OpenClaw owns its execution deadline.                                                                                                                                               |
| Session catalog   | Pi paging, timestamp, file-range and node/terminal contracts use the target public SDK. The unused timestamp facade and obsolete MCP proxy scripts are removed.                                                                                                                                  |
| Offline Doctor    | The obsolete JSON gateway-instance/process-lease migration and constants are removed. Owner repair validates the real record ID in a private store before atomic publication, and uses the managed native state directory.                                                                       |

## Product customizations retained

| Customization                                                                            | Owning code                                                                                                      | Regression coverage                                                                  |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Build-time catalog, explicit commands and path tokens                                    | `config.ts`, `command-tokens.ts`, `service.ts`                                                                   | `acpx-command-tokens`, `config-state-dir`, `service-lifecycle`                       |
| No fallback downloads                                                                    | `codex-auth-bridge.ts`; managed registry in `service.ts` rejects missing commands before ACPX fallback selection | `adapter-wrapper`, `acpx-plugin-contract`, `service-lifecycle`                       |
| Isolated Codex home, auth copying, Claude executable and configured-command pass-through | `codex-auth-bridge.ts`, `codex-auth-file.ts`, `codex-trust-config.ts`                                            | `codex-auth-bridge`, `adapter-wrapper`                                               |
| Disabled-agent diagnostics, redaction and default no-probe policy                        | `index.ts`, `runtime-proxy.ts`, `runtime-probe.ts`, `service.ts`                                                 | plugin contract, probe and service lifecycle suites                                  |
| Product permission/MCP defaults and exact session context                                | `config-schema.ts`, `config.ts`, `runtime.ts`                                                                    | runtime dynamic-MCP test, runtime/reset/probe suites and real ACPX stdio fixture     |
| Narrow process ownership checks, including earlier JSON-quoted Windows argv              | `command-line.ts`, `process-reaper.ts`                                                                           | process-reaper and lease suites; wrapper process cleanup tests                       |
| Managed state location and unknown-owner rejection                                       | `config.ts`, `session-owner.ts`, `session-resource.ts`, `session-owner-migration.ts`                             | state-directory, generation/reset and persisted 0.19.1-to-0.19.5 compatibility tests |

The product does not register upstream native-agent harnesses, a second model
picker, `acpx.agents.list`, or runtime package installation. It does not adopt
`<workspace>/state` into the managed state directory. Only the existing explicit
offline owner repair remains; ambiguous histories stay intact. The public
`json-store` SDK helper is retained in the customized auth bridge, so upstream's
direct `@openclaw/fs-safe` JSON-helper dependency is unnecessary there.

## Independently pinned ACPX 0.19.5

OpenClaw 10.4 selects ACPX 0.19.1. This product additionally pins published ACPX
0.19.5, evaluated against 0.19.1 using its release, source comparison, npm metadata
and real synthetic stdio peers. Its runtime exports and method signatures remain
compatible; permission policies and Node engine constraints remain compatible.
The newer package improves first-turn persistent-session loading, scoped
concurrent ensure/import, reconnect session options, history persistence and
shutdown error aggregation. Its changed default package runners are inaccessible
through the managed registry.

The npm-generated lock records integrity
`sha512-V88l8w3Opv1xWmMmFyO4RrR6Y695RrRJ/q5WgIlE/BNetQgxRaM4p8h7BsKPjdDHVBKpesCnXNd3r5Cwzz2Lmw==`.
Its transitive `@openclaw/fs-safe@0.22.0` optional platform packages remain in
that lock. No integrity values were edited manually. The product's explicit
Claude ACP 0.79.0 and Codex ACP 1.12.0 pins remain unchanged.

The existing direct MCP SDK and TOML parser dependencies are also pinned to
`@modelcontextprotocol/sdk@1.31.0` and `smol-toml@1.9.0` to address
[GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h) and
[GHSA-r4xh-jqrq-34v2](https://github.com/advisories/GHSA-r4xh-jqrq-34v2).
The MCP issue affects HTTP OAuth rather than this product's stdio-only ACP MCP
projection; the TOML parser is used by the isolated Codex config bridge. A
production dependency audit after these npm-generated lock updates reports zero
vulnerabilities. The real wrapper/config-overlay regression uses the new parser.

## Validation boundary

Run the ACPX Vitest configuration with `OPENCLAW_RUNTIME` pointing to the
prepared 10.4 SDK. It includes the retained desktop tests and upstream-derived
runtime, reset, probe, lease, reaper, proxy and lazy registration behavior tests.
Test-only upstream SDK exports are replaced by local temporary-directory and
keyed-store fixtures; native persistence remains the host's responsibility.

The `tests/openclaw/acpx/runtime-upgrade-fixture.mjs` runner uses real ACPX with
local synthetic ACP peers. It exercises concurrent admission, permission denial
followed by another turn, cancellation, stream closing, process cleanup, and
reuse of a store and handle created by real ACPX 0.19.1 without losing history or
creating a new physical session. It calls no model, reads no user transcripts
and uses only its temporary state. Node and Electron runs are recorded by the
integration owner alongside fresh runtime and packaging checks.

Complete strict static checking of this extension is limited by missing type
declarations for several upstream public SDK facades, including
`acp-runtime-backend` and `runtime-doctor-migrations`, in the published artifact.
The SDK export/load and behavior tests provide direct runtime evidence; no
ambient declarations or broad casts are added to claim full static coverage.

Real-agent login/expired credentials, actual delegated model work, MCP tools,
permissions, long tasks, cancellation and application exit still require manual
acceptance from the final packaged runtime on each supported platform, including
Chinese/space-containing install paths. Synthetic process success does not
establish the execution/cleanup guarantees of an arbitrary external executor.
