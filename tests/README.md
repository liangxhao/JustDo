# Test organization

Repository-level tests are grouped by the production area they cover:

- `build/`: packaging, installer, update manifest, and package-script contracts.
- `scripts/`: standalone build and resource-preparation scripts.
- `openclaw/runtime/`: OpenClaw runtime staging, verification, and launcher behavior.
- `openclaw/patches/<version>/`: patch behavior pinned to a specific OpenClaw release.

Use kebab-case `*.test.ts` filenames. Keep source-level unit tests co-located under
`src/`; add tests here only when they exercise repository scripts, packaged assets,
or integration contracts spanning multiple source domains.

The opt-in plugin marketplace probe lives in `electron/plugin-marketplace/` and
runs with `npm run test:plugins:marketplace -- --runtime <prepared-runtime-root>`.
It uses real Electron IPC, production installers and a disposable native Gateway,
with generated packages served by a loopback-only HTTP market. See the
[marketplace integration guide](../docs/developer-integration/plugin-marketplace-integration.md#本地市场联调探针)
for prerequisites, isolation, outputs and the boundary with enterprise SDK testing.

Existing extension import packages can also be reused without regenerating or
changing their inputs:

```powershell
node scripts/test/extension-import-fixtures-probe.cjs --fixtures <existing-fixture-root> --runtime <worktree-runtime-snapshot>
node scripts/test/extension-import-ui-probe.cjs --fixtures <existing-fixture-root> --runtime <worktree-runtime-snapshot>
```

The fixture root must contain the existing `catalog.json`, `SHA256SUMS.txt`,
`verify.cjs`, `sources/`, `packages/`, `formats/` and `negative/` suite. The cold
probe retains its 68 checks, verifies the original archive hashes and checks that
the inputs stay unchanged. Use the complete locked runtime snapshot already
verified under this worktree's `build/`; neither probe downloads dependencies or
uses the original suite's saved runtime state. Generated bundles stay in `build/`
and each run keeps separate state and evidence under `.agent-tasks/`.

The UI probe uses the production `ExtensionsManager`, preload channels, Main
handlers and a disposable real Gateway. Only the file picker selection is supplied
by the driver. The Gateway reuses the production launch environment, including
Windows polling and native watcher intervals; a different watcher mode can hold
directory handles and invalidate update results. After a successful mutation,
read-only inventory confirmation allows up to 45 seconds for native discovery,
with at least two seconds between completed reads. The report retains each
snapshot and mismatch; a failed mutation is never repeated by this confirmation.
It supplements the cold checks with capability review, actual progress and error
dialogs, parent/child inventory, and lifecycle controls. It
needs the same local Playwright and Electron native ABI prerequisites as the
marketplace probe. Neither suite demonstrates model-driven Skill execution;
the cold Hook checks dispatch synthetic events through registered handlers.

Cold `--f01-only` and `--update-only` runs isolate repeated import and version
replacement. UI `--suite negative`, `--suite update` and `--suite uninstall`
isolate the corresponding workflows. Every invocation creates fresh state; a
failed native mutation is recorded and never replayed automatically. Focused
checks overlap the full suite and must not be added together as unique coverage.

For a filesystem investigation, the UI probe accepts an explicit
`--rename-observer <build-only-preload.cjs>`. Its real path must stay inside this
worktree's `build/`. This diagnostic preload is absent from normal runs and the
product; it observes rejected filesystem calls without editing the locked runtime
or repeating a failed installation. The report identifies instrumented runs.

Windows publication recovery also has an opt-in real sharing-lock regression:

```powershell
node scripts/test/extension-publication-lock-probe.cjs --fixtures <existing-fixture-root> --runtime <verified-runtime-snapshot> --expect recovered
node scripts/test/extension-publication-lock-probe.cjs --fixtures <existing-fixture-root> --runtime <verified-runtime-snapshot> --expect bounded
```

It uses the same original v1/v2 packages and actual import UI. A test-only helper
holds the copied v2 entry file without DELETE sharing for 800 ms or 8 seconds;
every observed rename is the actual syscall, never a fabricated rejection. The
short case requires publication of the same copied inode and one v2 install
request. The long case requires a bounded failure, the production error dialog,
intact v1 files and capabilities, and clean process/temporary-directory shutdown.
The raw UI result remains false for expected failures; separate assertion and
wrapper reports record whether the expected failure behavior passed. The helper
and generated preload do not enter the product. `--expect baseline` can verify
the same refusal against a separately verified runtime without recovery; an
invalid or changed runtime is rejected before starting Native.

Acceptance on Windows, 2026-10-23, used a freshly prepared OpenClaw 2026.10.4
runtime with all 33 patches and the original 32 unchanged archives. The complete
cold suite passed 68/68 checks, the import UI passed all eight workflow groups,
and the loopback marketplace passed all nine groups. The real short lock lasted
805 ms: the second rename published the same copied inode 1,430 ms after the
first refusal. The 8,002 ms lock produced 11 actual `EPERM` refusals, stopped
publication attempts after 4,874 ms, displayed the production failure dialog,
and restored every v1 source byte and its Skill/MCP/Hook inventory. Each lock
scenario sent exactly one v1 and one v2 install RPC; the failed raw UI report
remained false. Process shutdown, runtime hashes and temporary-directory cleanup
were verified. The four focused patch/runtime suites passed 130/130 tests.
The publication patch was numbered 033 for this run and became 034 when rebased
onto dev, which already contained the independent run-progress patch 033.
This demonstrates the blocking-handle mechanism and bounded recovery; the owner
of the earlier intermittent, uncontrolled refusal remains unconfirmed.

The source runtime must have completed its original package lifecycle before
patching and bundling. Build/frozen proofs and fixture snapshots reject pending,
legacy-install or lifecycle-lock markers; copying only dependencies from an older
runtime does not complete the new package's preinstall/postinstall. Complete that
work through the upstream owned lifecycle API in fresh staging, never by deleting
markers or running postinstall over already patched `dist` files.

The focused 034 tests additionally accept `PLUGIN_PUBLICATION_PRISTINE`, pointing
to a read-only directory containing the four exact pristine target files and
fs-safe metadata. This enables actual source transformation, idempotence,
syscall-boundary and final-bundle behavior checks; ordinary runs still execute
the platform-independent recovery guard tests without cached native packages.
