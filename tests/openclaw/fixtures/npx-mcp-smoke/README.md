# Local npx MCP smoke fixture

This development-only package has no dependencies, install scripts, network calls,
or file tools. It is launched as a real npm package binary through npx, rather than
using `node server.mjs` or a mocked npm CLI.

On Windows, run from the repository worktree:

```powershell
node scripts/test/prepare-npx-mcp-smoke.cjs
```

The preparation script packs the package, primes an isolated offline npm cache,
and verifies initialization, tool discovery and calls through the application Main
command projection and the bundled native MCP transport/SDK. Generated files stay
under `.agent-tasks/npx-mcp-smoke/`; no application configuration is modified.
The MCP process uses the runtime directory as its working directory, matching
the application's Gateway, with a separate test state/config path.

In the application's MCP page, manually add a server named **Npx MCP Smoke** with
transport **stdio**, command **npx**, and arguments copied from the generated
`args.txt`, one argument per line. No environment variables are needed. Save and
enable it. The generated `mcp-config.json` records the same fields for inspection;
the application's current form does not import JSON directly.

In a new conversation, ask the assistant to call `npx_smoke_runtime_info`, then
`npx_smoke_echo` with `text` set to `npx MCP 验证成功`. The first tool should return
`startedByNpx`, `electronNodeMode`, and `windowsHidePreload` all `true` on Windows;
the second should return the exact text. A successful server probe/discovery alone
does not establish that an assistant has invoked a tool.

The config contains absolute worktree paths. Keep the generated archive/cache while
testing; rerun preparation after relocating the checkout or changing the fixture.
Disable or delete this MCP entry after testing.
