import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';

import {
  EXTERNAL_MCP_CLOSE_METHOD,
  EXTERNAL_MCP_OPEN_METHOD,
  EXTERNAL_MCP_TOOL_NAME,
} from '../contracts/external-mcp';
import { ExternalMcpRegistry } from './registry';

const STATE_KEY = Symbol.for('runtime-services.external-mcp.registries');
const state = globalThis as typeof globalThis & {
  [STATE_KEY]?: Map<string, ExternalMcpRegistry>;
};
const POLICY_ID = 'external-mcp';

export function registerExternalMcp(api: OpenClawPluginApi): void {
  // Gateway handlers and factories may be loaded through separate plugin instances.
  // This registry is ephemeral and scoped to this runtime process and state root.
  const registries = (state[STATE_KEY] ??= new Map());
  const stateDir = api.runtime.state.resolveStateDir();
  let registry = registries.get(stateDir);
  if (!registry) {
    registry = new ExternalMcpRegistry({
      getEntry: sessionKey => getSessionEntry({ sessionKey, readConsistency: 'latest' }),
      connect: async (server, cwd, signal, assertCurrent) => {
        const { connectExternalMcpServer } = await import('./transport');
        // Loading cannot preserve a stale lease, owner, or native incarnation.
        signal.throwIfAborted();
        assertCurrent();
        return connectExternalMcpServer(server, cwd, signal);
      },
    });
    registries.set(stateDir, registry);
  }
  const current = registry;
  const enabled = () => {
    const config = api.runtime.config.current();
    return (
      config.plugins?.enabled !== false &&
      config.plugins?.entries?.['runtime-services']?.enabled !== false
    );
  };
  api.registerService({
    id: 'external-mcp',
    start() {},
    async stop() {
      await current.closeSession();
    },
  });
  api.lifecycle.registerRuntimeLifecycle({
    id: 'external-mcp',
    cleanup: async context => {
      await current.closeSession(context.sessionKey);
    },
  });
  // Native session admission requires a write descriptor; process startup remains admin-only.
  api.registerGatewayMethod(
    EXTERNAL_MCP_OPEN_METHOD,
    async invocation => {
      const assertOwner = () => {
        if (
          !invocation.client?.connect.scopes?.includes('operator.admin') ||
          !enabled() ||
          invocation.client?.connectionSignal?.aborted ||
          invocation.hasCurrentClientAuthority?.() === false
        )
          throw new Error('External MCP owner is unavailable.');
      };
      try {
        const signal = AbortSignal.any([
          ...(invocation.signal ? [invocation.signal] : []),
          ...(invocation.client?.connectionSignal ? [invocation.client.connectionSignal] : []),
        ]);
        const result = await current.open(
          invocation.params,
          signal,
          assertOwner,
          invocation.client?.connectionSignal,
        );
        invocation.respond(true, result);
      } catch {
        invocation.respond(false, undefined, {
          code: 'UNAVAILABLE',
          message: 'External MCP servers could not be prepared for this session.',
        });
      }
    },
    {
      scope: 'operator.write',
      profileAccess: 'required',
      sessionAccess: { mode: 'write' },
    },
  );
  api.registerGatewayMethod(
    EXTERNAL_MCP_CLOSE_METHOD,
    async ({ params, respond }) => {
      try {
        await current.close(params);
        respond(true, { ok: true });
      } catch {
        respond(false, undefined, {
          code: 'UNAVAILABLE',
          message: 'External MCP cleanup could not be confirmed.',
        });
      }
    },
    { scope: 'operator.admin' },
  );
  api.registerTrustedToolPolicy({
    id: POLICY_ID,
    description: 'Requires exact-session, one-use approval for caller-supplied MCP tools.',
    evaluate(event, context) {
      if (event.toolName !== EXTERNAL_MCP_TOOL_NAME) return;
      try {
        if (!enabled()) throw new Error('External MCP is unavailable.');
        const approval = current.approval(context, event.params);
        return approval
          ? { requireApproval: { ...approval, pluginId: 'runtime-services' } }
          : undefined;
      } catch {
        return { allow: false, reason: 'External MCP session or tool authority is unavailable.' };
      }
    },
  });
  api.registerTool(
    {
      contextVersion: 2,
      create(context) {
        if (!enabled() || !current.hasTools(context)) return null;
        return {
          name: EXTERNAL_MCP_TOOL_NAME,
          label: 'External client MCP',
          description:
            'Use action:"list" to inspect this external client session’s MCP tool names and original JSON input schemas. Then use action:"call" with the exact server, tool, and arguments object. Each call requires a one-use approval; server annotations do not grant permission. This tool cannot access another session’s MCP servers.',
          parameters: current.parameters(context) as never,
          execute: (toolCallId, input, signal) =>
            current.execute(context, toolCallId, input, signal),
        };
      },
    },
    { name: EXTERNAL_MCP_TOOL_NAME },
  );
}
