---
name: acp-router
description: Route requests for a configured external coding agent through the native ACP runtime, including starting work, continuing an existing session, and checking an uncertain result. Use only agents and operations available under the current product configuration and tool schema.
user-invocable: false
---

# ACP Harness Router

Use this skill when the user asks to work through an external coding agent or an
ACP harness. Read it before starting that work. A named agent in the request
does not establish that it is installed, enabled, or authorized in this product.

## Check the current capability

- Use the currently advertised native tools, their complete schemas, and the
  product's configured external-agent catalog. Keep the requested agent when
  it is available; do not silently switch agents, runtimes, or credentials.
- Use the exact enabled catalog agent ID. Upstream acpx aliases are not a
  product availability list. Do not invent a catalog RPC or infer availability
  from a familiar executable name, package, or an earlier successful run.
- The product does not register the upstream native-agent harness or Codex
  app-server plugin. Do not route work to their slash commands or model picker.
- An unavailable or disabled agent remains unavailable. Report the actual
  configuration or connection diagnostic; do not install or enable an agent,
  alter command overrides, or change permissions as a fallback.

## Start work through the native ACP runtime

1. Use the advertised `sessions_spawn` tool with `runtime: "acp"` and an exact
   enabled catalog `agentId`. Put the requested work in `task`, including its
   objective, relevant context, working directory, and expected result.
2. Read the current schema before selecting `mode`, `thread`, or other options.
   Use a persistent session for requested ongoing work, or one-shot behavior
   when that is the requested outcome and the schema supports it. Request a
   thread only when the current surface supports native ACP thread binding.
3. Thread creation uses the native spawn operation. Do not use a message tool
   to manufacture a thread or ask the user to run a slash command when the
   supported native operation can complete the request.
4. Keep the returned native session and run identities for subsequent work.
   A successful send or spawn receipt confirms acceptance, not completion.
   Use the actual native execution result before reporting the task finished.

## Continue and control existing work

- Use the currently advertised native ACP/session operations and their exact
  parameters for follow-up input, status, cancellation, and cleanup. Address
  the returned session identity; a display name or agent ID is not a session.
- Reuse an existing authorized session for a continuation. Do not replace it
  with another session just because a request timed out or a connection closed.
- Preserve the current working-directory, authentication, permissions, and
  process ownership boundaries. Do not scrape a PTY or launch a different
  agent process to imitate an ACP result.
- A queue receipt or cancellation acknowledgement is not an execution
  terminal. Keep uncertain acceptance and cleanup outcomes visible and use
  native status evidence for the same operation.

## Missing dependencies and failures

The installed application ships locked ACP protocol adapters. Agent executables
are user supplied and must already be available through the configured managed
commands. The runtime never installs or downloads adapters or agents.

- A missing binary, manifest, adapter, or permission is a concrete diagnostic.
  Do not run package installation, a package runner, or a download command;
  edit global acpx agent overrides; restore upstream defaults; or restart the
  Gateway as automatic repair. Report the failing component and the supported
  configuration or maintenance action.
- On a timeout, disconnect, lost acknowledgement, or `NO_SESSION`, first use
  available native status evidence for the same session and run. Do not infer
  that a previously sent operation did not execute, resend its prompt, or
  create a replacement session. A fresh operation requires authoritative
  evidence that it was not sent or accepted, or an explicit user request for
  distinct new work, while retaining the earlier unknown outcome.
- On queue contention, observe the existing operation using supported native
  waiting/status behavior. Do not poll in a busy loop or submit duplicate work.
- A native policy refusal does not authorize another runtime, executable,
  identity, or permission mode. Explain the actual blocker without claiming
  that a different route completed the requested work.

## Explicit direct CLI requests

Direct CLI control is not a fallback for an unavailable native ACP path. Use an
existing direct capability only when the user explicitly requests it and the
current product configuration can establish the same configured command,
authentication, permissions, and lifecycle ownership for that operation. If
those facts cannot be established, explain that this route is unsupported.
Do not construct commands from bundled acpx aliases, ambient configuration,
guessed executable paths, or package URLs to bypass the managed runtime.

## Report the result

Relay the actual agent result and relevant execution status. Distinguish
accepted, running, completed, cancelled, failed, and unknown outcomes. Do not
expose raw credentials, environment values, or unrelated private tool output.
Provide verbose protocol diagnostics only when relevant and authorized.
