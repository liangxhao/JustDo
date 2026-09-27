# Gateway reload and restart audit (OpenClaw v2026.9.6)

JustDo should let OpenClaw apply configuration and plugin changes in its running
Gateway before requesting a process restart. The running Gateway owns config
classification and plugin lifecycle; JustDo should not duplicate their rules.

| Change or action | Current application path | When a restart remains necessary |
| --- | --- | --- |
| Managed model, provider, agent, tools, hooks, skills, or browser configuration | Write `openclaw.json`, wait for the native config reload event. Secret-only rotation uses `secrets.reload`. | The native watcher reports no successful application, rejects the change, or the launch environment changes. Request `gateway.restart.request` first. |
| Gateway port | Save the new port; the active listener retains its old port. | Cold restart to change launch arguments and the listener. |
| Gateway launch environment | Update the manager's pending launch environment. | Cold restart to replace inherited process environment. |
| Extension configuration | Write the entry and wait for native config reload. | Native reload fails; request an in-process restart, then cold restart if unavailable. |
| Extension install, enable, disable, uninstall through Gateway RPC | OpenClaw 9.6 applies the plugin lifecycle and returns `restartRequired: false`. | Honor an explicit `restartRequired` result or an independently changed proxy policy. |
| CLI extension install | Wait for the CLI's final runtime receipt. Its Gateway route already applies the plugin; a locally saved install uses `plugins.reload` for the package. | Reload unavailable or rejected: request an in-process restart, then cold restart if unavailable. Proxy policy changed or Gateway was starting: cold restart. |
| CLI extension uninstall or enable/disable recovery | Call `plugins.refresh` to reconcile the running plugin registry. | Refresh unavailable or rejected: request an in-process restart, then cold restart if unavailable. Proxy policy changed or Gateway was starting: cold restart. |
| Outbound header proxy policy | Reconcile the policy digest. | Restart the Gateway network generation to rotate its proxy capability and inherited proxy environment. |
| Explicit user restart | Request `gateway.restart.request`. | Cold restart if the request fails, the Gateway is not running, or launch arguments/environment changed. |
| Extension directory lock recovery | Suspend and stop the Gateway before a locked filesystem operation. | Cold start afterward because Windows file locks require the owning process to exit. |

OpenClaw's `config-reload-plan.ts` classifies most agent, model, tool, hook,
skill, plugin, and browser related paths as no restart or hot reload. Gateway
listener and authentication paths, `mcp.apps` listener settings, and
`secrets.egressProxy` still require a process restart. A successful plugin
management RPC is already a runtime application receipt; an additional JustDo
restart would discard active work without applying anything further.

The CLI's intermediate `Installed plugin` message only confirms persistence.
JustDo requires the expected plugin's completion line followed by `Applied in
Gateway generation` or `Saved for the next Gateway start` on stdout before
treating the process as complete. Error output cannot authorize successful
termination, and a CLI that exits with an error keeps its nonzero exit status.
This prevents terminating the
CLI during runtime application and avoids replacing a plugin generation that
the CLI's Gateway route has already activated.

The config-sync fallback keeps the native restart coordinator's deferral for
active work. It must not race a deferred in-process restart with a host cold
restart. Cold restart remains the last resort for launch-state changes and
failed or unavailable native coordination.
