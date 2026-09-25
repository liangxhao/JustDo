# ACPX runtime

This directory vendors the OpenClaw `@openclaw/acpx` extension from the
`v2026.9.2` source tree. It is compiled and packaged with the desktop application,
which does not download the plugin at runtime.

OpenClaw remains responsible for ACP task scheduling, durable task state,
session recovery, and delivery. This extension owns the ACP transport,
adapter processes, isolated adapter state, and permission mediation.

## Local customizations

- Startup probing is disabled by default so an unavailable optional adapter
  does not mark the entire ACP backend unhealthy.
- The product catalog selects which adapters are shipped. Adapter commands are
  build-time definitions and are never accepted from desktop settings.
- All local extensions use `scripts/openclaw/sync-openclaw-runtime-resources.cjs`.
  Extensions with production dependencies are installed from their lockfile for
  the runtime target, then reused by later packaging passes through a verified
  target/fingerprint manifest. The first install allows 20 minutes by default;
  slow registries may set `JUSTDO_EXTENSION_NPM_CI_TIMEOUT_MS` to a
  bounded value from 60000 through 3600000.

The installed application never downloads adapters. A clean source build still
needs these locked npm artifacts through an approved registry or a pre-warmed
npm cache. Product variants add or replace adapters through the build-time
catalog and this vendored extension without patching OpenClaw core. Removing an
agent from a product also requires removing its packages from this manifest and
lockfile before assembling the runtime; disabling it in settings prevents
execution but does not remove packaged files. External agents start disabled
with read-only permissions. The complete extension template is documented in
`docs/features/external-agent-adapters.md`.

## Compatibility

- Plugin id: `acpx`
- Source baseline: OpenClaw `v2026.9.2`
- Minimum plugin API: `2026.9.6`

The desktop adapter retains its product-specific source fork. With OpenClaw 2026.9.6,
it uses acpx 0.19.1, Claude ACP 0.76.0 and Codex ACP 1.11.0.
The upstream native-agent model picker/harness registration is not enabled by
this product: the managed external-agent catalog still owns admission and diagnostics.
