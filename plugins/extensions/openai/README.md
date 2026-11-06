# Configured OpenAI provider extension

This package contains the version-locked OpenClaw OpenAI extension and its local
explicit-endpoint adaptations. Source identity and original file hashes are recorded
in [upstream-source.json](upstream-source.json). Registration and configuration
capabilities are declared by [openclaw.plugin.json](openclaw.plugin.json) and
[index.ts](index.ts).

The integrating host supplies the matching native SDK, prepared SecretRefs and
explicitly configured services. A missing endpoint is not permission to use a public
service, a different configured model or an environment credential. The distributed
package must contain its required assets and production dependencies.

This documentation does not claim that configuration tests validate real devices,
service availability or every provider capability. Those require separate host and
service acceptance.
