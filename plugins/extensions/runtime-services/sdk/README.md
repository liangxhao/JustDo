# Runtime Services SDK

Versioned library contracts for optional native plugins. Install the compiled npm
package; importing this library does not install, start or authorize Runtime Services.

Pure entry points (`app-input`, `admission`, `custody`, `filesystem-contract`,
`permissions`, `session-key`, `session-namespace`) contain generic contracts and
parsers. They are safe for Browser and presentation graphs. Input markers and
decoded identities never authorize execution. Business modes, discussion schemas,
workflow rules and planning-state interpretation belong to their consumers.

`filesystem`, native clients and owner proof helpers are Node-only. Filesystem
admission must originate from the real native tool context and be revalidated
before effects. Generic custody stores opaque input only in hidden, non-executable
native sessions; its own ledger contains identities, hashes and lifecycle metadata.
Business receipt stores are not part of this SDK.

The native capability client binds to an authenticated Runtime Services instance.
The capability protocol is version 2 and exposes only generic execution-lane
occupancy. Missing or retired capabilities fail closed. Read tokens do not grant
write access. Writers separately prove their actual native registration through a
single-use challenge on the original Gateway; leases retire with that registration
and cannot cross provider scopes. Managed operations retain the original calling
plugin's native executor.

Create native clients and providers during registration. They capture an ordinary
registration context before probing the original public background runner. A later
admitted cleanup callback cannot keep a quiescing registration's business handles
alive. Once retired, those handles and write leases remain invalid; recovery needs
a fresh native registration.
Unknown sends are never retried automatically. A supported runtime must supply exact
whole-run settlement and owned tool cleanup; pristine runtimes without that protocol
are unsupported for managed execution.

Authenticated backend maintenance can inspect, cancel, close or reconcile existing
exact resources after a writer retires. It cannot create resources, append input or
start execution. Cancellation, owner retirement, native whole-run settlement and
owned cleanup remain distinct facts. A retired run's fence does not become a tool
restriction on later ordinary chat turns. No legacy protocol or data migration
fallback is provided; existing data files are left in place without replay.

Use the repository's `plugins:runtime:sdk` command to emit JavaScript and declarations,
then pack its output as an npm artifact. External builds consume the resulting
package through exports, without sibling plugin or application source paths.
