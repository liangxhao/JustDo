# Third-party notices for the bundled ACP runtime

This extension redistributes protocol adapters and runtime libraries, but not
third-party Codex or Claude agent executables. The
corresponding `LICENSE`, `NOTICE`, and license-bearing `README` files are kept
inside `node_modules` when the OpenClaw runtime is pruned and packaged.

Direct runtime dependencies include:

- `@agentclientprotocol/claude-agent-acp` — Apache-2.0
- `@agentclientprotocol/codex-acp` — Apache-2.0
- `@anthropic-ai/sdk` — MIT
- `@modelcontextprotocol/sdk` — MIT
- `acpx` — MIT
- `smol-toml` — BSD-3-Clause
- `zod` — MIT

The Claude Agent SDK JavaScript uses the license identified in its package
metadata and bundled license-bearing files. Codex and Claude agent platform
packages are excluded during assembly. Transitive dependency terms remain
available beside each shipped package.

ACPX 0.19.5 additionally brings the MIT-licensed `@openclaw/fs-safe` runtime
and its optional platform packages. Their package license files remain beside
the installed artifacts under the same pruning and packaging policy.
