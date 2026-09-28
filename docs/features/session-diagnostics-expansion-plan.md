# Session diagnostics: evidence expansion

Status: implementation and automated verification complete (2026-09-28); live fault-injection and packaged/cross-platform checks remain explicitly unverified. This supplements the first-version plan.

## Outcome and ownership

The session context menu should explain what is known about the selected run and export a locally prepared support package for AI analysis. Evidence must cover application lifecycle records and available Main, Cowork, Gateway capture, and OpenClaw native logs. A missing terminal event never proves model completion. Tool failures, retry attempts, and global incidents never independently establish the selected run's outcome.

OpenClaw remains the transcript authority. This feature does not copy transcripts or change execution, configuration, logging levels, or start an offline runtime. Main owns collection, bounded files, sanitization, snapshot ownership, and archive publication. Renderer presents sanitized evidence and coverage only.

## Implementation sequence

1. Review this plan against local OpenClaw source and actual log writers with an independent Agent before implementing the expansion.
2. Add an explicit **collect local evidence** action. Keep initial diagnostics fast and metadata-only; collection returns a new immutable snapshot. Export uses that exact snapshot, including log evidence, rather than silently collecting different files later.
3. Resolve fixed local sources in Main: authoritative main logger accessor; application Cowork log and rotation; managed Gateway capture. Read native logs through the existing connected client's `logs.tail`, allowing OpenClaw to resolve its configured source. Never accept file paths from Renderer or stdout announcements. Report native source as unavailable offline or when the RPC fails.
4. Collect bounded tails, recognizing record boundaries, JSONL numeric arguments, local-time main timestamps, ISO timestamps, local rotations, oversized records, and concurrent file disappearance. Do not load an unbounded Gateway file. Enforce the explicit budgets below. Reject non-regular local files and links. Every source reports availability, scanned bytes, truncation, parse failures, and emitted counts; native rotation/source handling belongs to its RPC.
5. Associate records while still inside Main. Prefer exact native/product run IDs, then session identity, then a limited time window. A time match is context only. Export only finite diagnostic codes and allowlisted numeric fields; arbitrary prompts, tool output, credentials, URLs, paths, stack text, and unknown free text must not cross the bridge. Record suppression explicitly. Preserve useful error categories, HTTP status, retry/attempt, durations, queue/transport/process signals where safely available.
6. Preview sanitized evidence and per-source coverage before export. Use stable record IDs, finite codes, and clear association labels. Keep all failures partial: one unreadable source cannot prevent other evidence or metadata export. Do not revise the authoritative run conclusion using keyword matches in logs.
7. Export summary, report, manifest, source evidence, and an AI analysis guide. Include source provenance category, time-window assumptions, limits and losses; exclude real paths and raw identities. The guide requires citations to evidence IDs, separates confirmed facts from hypotheses, and lists missing evidence and next checks.
8. Independent Agent review of implementation, then focused behavioral tests, lint, renderer build and Electron compilation. Run the broader suite as warranted; distinguish baseline failures and untested live fault scenarios.

## Acceptance matrix

| Area | Scenarios and required behavior |
| --- | --- |
| Run semantics | settled completion, chat final without settled execution, finishing, attempt error then success, length limit, timeout, cancellation requested/failed/acknowledged, system abort, yielded/waiting, supersession, restart, conflicting generations: report only supported conclusions |
| Transport/process | disconnect before terminal, reconnect, unavailable runtime, startup/auth failures, process termination, malformed payload: retain partial evidence without starting runtime |
| Provider/tools | 401/403, 429, billing, context limits, 5xx, DNS/reset/TLS/timeout, tool error and retry: finite categorized evidence, never equate one failed call with whole-run failure |
| Association | concurrent sessions, overlapping runs, repeated IDs, short identity substrings, global errors near run time: explicit association and no false exact run match |
| Files | missing/denied file, symlink/non-file, rotation, removal during read, huge tail/single record, malformed/truncated JSON, invalid encoding, multiline records, Chinese/spaced paths: bounded work and source-specific coverage |
| Time | midnight, UTC filename/local main timestamp, absent timestamp, old long run outside tail, ongoing run: explicit time assumptions and incomplete coverage |
| Privacy | tokens, passwords, authorization, cookie/JWT, URLs/query credentials, paths/email, prompt/tool text disguised as error, multiline secret, prototype keys: no arbitrary strings exported; canary assertions over bridge/report/ZIP |
| Interaction | repeated collection, stale response, switched run, closed window, deleted session, expired snapshot, offline collection, partial success: preserve ownership and stale-result guards |
| Export | same displayed snapshot, cancel, destination failure, existing target, oversized package, write failure, expiration during save: no partial published archive and no silent target deletion |

## Limits to state explicitly

Existing condensed logs cannot reconstruct every event. Old runs may fall outside retained tails. Safe projection intentionally omits unknown text; a package is diagnostic evidence, not a full raw-log backup. Main-process crash before a write, renderer-only faults not forwarded to Main, and native logs unavailable under current configuration remain observable gaps. Cross-platform real fault injection and packaged UI verification must not be claimed based on unit fixtures.

## Independent review amendments (2026-09-28)

The pre-implementation Agent identified four blockers; the implementation must use these corrected rules:

- Native logs come from the existing connected runtime's bounded `logs.tail` RPC, whose source selection is owned by OpenClaw. A stdout `log file:` message is never file-read authorization. Offline native collection is explicitly unavailable; no guessed temporary path.
- Limits: 16 local files, 512 KiB per file, 4 MiB aggregate local input, 64 KiB per record, 400 output records, 5 seconds local collection; native RPC requests at most 1000 lines / 512 KiB with a 3-second timeout. Budgets are enforced again on returned native data.
- Exact association requires full equality in parsed identity fields, never arbitrary substring matches. Untrusted free-text signal classification is labeled inferred, and never changes the run outcome.
- Offset-less Main timestamps use collector-local timezone assumptions explicitly; tail truncation does not establish coverage of the entire requested run interval.

## Implementation review and resulting refinements

- Independent review of service/export/IPC identified coupled source discovery and unbounded inspection of malformed native array entries. Discovery is now isolated per source with explicit unreadable status; the native response inspects at most 1000 entries, including malformed entries.
- Each source has a reserved quota: at most 4 files, 1 MiB and 100 output records (native input still 512 KiB), within the global caps. Main prioritizes the selected run's end date, then adjacent dates, with active files before same-day rotations. This prevents application noise from exhausting native evidence capacity and improves historical run collection.
- Collector review identified distinct product/native session identity domains and oldest-first selection dropping final failures. Native transcript session IDs cannot be compared with product UUIDs; known run identity and time context must remain separate. Recent records are selected before chronological presentation.
- Log hints remain inferred even when a finite category is present in a logged JSON string. No log string becomes authoritative lifecycle evidence. Numeric preview/export bounds are identical.
- File deadlines bound waiting and admission of further operations. The OS may not cancel an outstanding local filesystem request; late results are discarded and opened handles close when that request finishes. No late result can mutate a published snapshot.
- A final service-level review caught an oversized native line suppressing all later records. Native response validation now inspects the newest 1000 entries, skips individual oversized/malformed records, and retains recent valid failures under the byte budget. A dedicated regression covers a large tool-output line followed by a timeout.

## Verification record

Environment: Windows x64, Node 24.21.0; independent worktree `E:/workspace/JustDo-session-diagnostics`, branch `feat/session-diagnostics`. OpenClaw source and the existing installed `gateway-bundle.mjs` both contain `logs.tail`; this is protocol/source verification, not a live RPC fault-injection claim.

| Check | Result |
| --- | --- |
| Final focused behavioral suite | 14 files, 123/123 tests passed: collector, historical source ordering, classifier, snapshot service, real ZIP extraction/privacy, IPC, SQLite, runtime projection/cancellation/connection and session UI |
| Expanded collector regressions | 19/19 passed, including native/product identity distinction, newest-error retention, source quotas, junction/UNC rejection, malformed encoding/JSON, numeric bounds, private text canaries, delayed I/O cleanup and no late open |
| Lint | Full `npm run lint` passed; final changed-file lint passed after review fixes |
| Build | `npm run build` passed |
| Electron typing | `npx tsc --project electron-tsconfig.json --noEmit` passed after final changes |
| Full repository suite | 5,998 tests: 5,926 passed, 7 failed, 65 skipped; all 7 match previously reproduced baseline failures. Final oversized-line and historical-source regressions were subsequently validated in the focused suite |
| Native ABI restoration | Test wrapper restored and verified Electron ABI 146 |

The seven baseline failures are one renderer motion-style expectation, one packaged Windows runtime patch-proof expectation, and five OpenClaw config/logout plugin ownership/restoration/discovery/trust/disabled-plugin expectations. Baseline reproduction and original limitations are documented in the first-version plan, section 11. Do not report the repository suite as fully green.

Automated fixtures cover the acceptance matrix's relevant collection/association/privacy/lifecycle paths; the matrix is not a claim that every real-world fault was injected. Remaining manual validation: packaged Windows UI against a real running runtime, abrupt process termination and network interruption, real provider failures/rate limiting, actual concurrent rotation during heavy writes, and macOS/Linux paths/permissions. Unknown error text and full stacks are intentionally not exported; this can limit diagnosis of unclassified failures.

## Fresh independent review (2026-09-28)

A second independent review covered lifecycle/store semantics against OpenClaw source, log collection/export, and UI/IPC interaction. Six concrete issues were found and fixed:

1. Settled interruption/failure must take precedence over `yielded`; native terminal events can carry both flags. Otherwise a timeout is incorrectly labeled waiting. Regression cases use native lifecycle combinations for end/error and preserve normal yielded behavior.
2. Log timestamps containing milliseconds such as `.401` / `.429` must not be classified as HTTP failures. Numeric codes now require structured status fields or explicit HTTP/status context; hints exclude the outer timestamp framing.
3. Native byte budgets include line separators in both validation layers. Both layers prioritize recent evidence, preventing a near-limit response from dropping its final failure.
4. An empty lifecycle event list must not imply no diagnostic evidence exists when collected logs are present. Both locales now state the narrower event-record gap.
5. During collection, the initiating button can become disabled while retaining keyboard focus. The modal trap now handles focus outside the current enabled control list, for both Tab directions.
6. Native `chat aborted` can precede actual execution settlement (`server.chat-abort-settlement.test.ts`). It now produces a separate `reply_aborted` observation with unknown whole-run outcome, instead of confirmed whole-run abort. A later settled lifecycle event can establish user cancellation or another terminal outcome.

The fixes have focused regressions. This review does not replace the outstanding real-runtime fault injection and cross-platform checks listed above.

Post-fix verification: the final focused suite passed **145/145 tests across 14 files**; the UI/menu/translation review suite passed **22/22**. Renderer build and Electron TypeScript checks passed. Test wrapper restored Electron ABI 146. Final independent reread confirmed the chat-abort distinction and lifecycle precedence; no remaining concrete blockers were identified in the reviewed scope. The previously recorded full-suite baseline failures and live fault-injection limitations remain separate from this focused verification.
