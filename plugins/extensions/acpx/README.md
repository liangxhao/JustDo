# ACPX runtime

This directory vendors the OpenClaw `@openclaw/acpx` extension from the
`v2026.10.4` source tree (commit
`383c124cc32ffee3f8e56f549b88da94d269a4af`). It is compiled and packaged with the desktop application,
which does not download the plugin at runtime.

OpenClaw remains responsible for ACP task scheduling, durable task state,
session recovery, and delivery. This extension owns the ACP transport,
adapter processes, isolated adapter state, and permission mediation.

## Local customizations

- Startup probing is disabled by default so an unavailable optional adapter
  does not mark the entire ACP backend unhealthy.
- The product catalog selects which protocol adapters are shipped. Agent executables
  are supplied by the user and are never bundled. Adapter commands are
  build-time definitions and are never accepted from desktop settings.
- All local extensions use `scripts/openclaw/sync-openclaw-runtime-resources.cjs`.
  Extensions with production dependencies are installed from their lockfile for
  the runtime target, then reused by later packaging passes through a verified
  target/fingerprint manifest. The first install allows 20 minutes by default;
  slow registries may set `JUSTDO_EXTENSION_NPM_CI_TIMEOUT_MS` to a
  bounded value from 60000 through 3600000.

The installed application never downloads adapters or agents. Assembly removes the
Codex and Claude platform-binary packages pulled in by adapter dependencies, while
retaining protocol adapters, SDK JavaScript and required native runtime services.
The generated wrappers resolve local `codex`/`claude` commands from PATH (or
`CODEX_PATH`/`CLAUDE_CODE_EXECUTABLE`, including the plugin `claudeExecutable`
setting) at launch. Missing commands fail connection tests with an installation
diagnostic; they do not trigger a package runner or a bundled-agent fallback.
Assembly removes agent platform packages at every nested `node_modules` boundary;
packaging rejects their reintroduction at any depth. Dependency-directory links
are rejected rather than followed outside the assembled tree.

On Windows, Claude can use native executables, direct `.js`/`.mjs`/`.cjs` entries,
or npm/pnpm/Yarn Node forwarding `.cmd` shims. The wrapper reads the shim's actual
local entry, including nested shims, and retains literal fixed CLI arguments.
It never sends the path or SDK arguments through a command shell. Fixed arguments
use a generated main-module bridge in the same CLI process, preserving streams,
exit status and the SDK's direct Stop target.
Dynamic or ambiguous shims, business batch scripts and Node interpreter switches
are rejected with a diagnostic asking for the actual JS or executable path.
Configure that path through `CLAUDE_CODE_EXECUTABLE` or `claudeExecutable`;
custom interpreter/adapter behavior belongs in an explicit build-time adapter.

A clean source build still
needs these locked npm artifacts through an approved registry or a pre-warmed
npm cache. Product variants add or replace adapters through the build-time
catalog and this vendored extension without patching OpenClaw core. Removing an
agent from a product also requires removing its packages from this manifest and
lockfile before assembling the runtime; disabling it in settings prevents
execution but does not remove packaged files. External agents start disabled
with read-only permissions. The complete extension template is documented in
`docs/developer-integration/external-agent-integration-guide.md`.

## Compatibility

- Plugin id: `acpx`
- Source baseline: OpenClaw `v2026.10.4`
- Local package version: `2026.10.4-local.2`
- Minimum plugin API: `2026.10.4`

The desktop adapter retains its product-specific source fork. It uses acpx
0.19.5, Claude ACP 0.79.0 and Codex ACP 1.12.0. OpenClaw 10.4 itself selects
acpx 0.19.1; 0.19.5 is an independently evaluated, exact product dependency pin.
The upstream native-agent model picker/harness registration is not enabled by
this product: the managed external-agent catalog still owns admission and diagnostics.

The 2026.10.4 integration keeps the managed state directory and external-agent
catalog while adopting the upstream generation, reset, native permission,
process lifecycle, cleanup and Windows bridge contracts. Native harness
registration and workspace-state-directory adoption remain excluded. Generated wrappers
recheck captured bundled adapter paths before launch and fail with the managed
rebuild diagnostic when missing; they never download a replacement at runtime.

The managed registry also rejects an absent adapter command before ACPX can
select a package runner. Disabled catalog agents retain explicit diagnostic
wrappers. Startup probing stays disabled by default. The connection timeout
limits startup and control operations; native run policy owns task duration.
Stopping joins session and diagnostic cleanup, and a failed cleanup prevents a
replacement owner from being activated in that service instance.

See [UPSTREAM.md](UPSTREAM.md) for the three-way source comparison, retained
customizations, automated checks and remaining real-agent acceptance work.
