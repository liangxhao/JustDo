/**
 * ACPX runtime plugin entry. It registers the embedded ACP backend service and
 * wires reply-dispatch hooks into the plugin SDK runtime.
 */
import { tryDispatchAcpReplyHook } from 'openclaw/plugin-sdk/acp-runtime-backend';
import { redactSensitiveText } from 'openclaw/plugin-sdk/security-runtime';

import { createAcpxRuntimeService } from './register.runtime.js';
import type { OpenClawPluginApi } from './runtime-api.js';
import { getAcpRuntimeBackend } from './runtime-api.js';
import { registerPiSessionCatalog } from './src/pi-session-catalog-plugin.js';

function resolveDoctorAgentIds(pluginConfig?: Record<string, unknown>): ReadonlySet<string> {
  const configuredAgents = Array.isArray(pluginConfig?.diagnosticAgents)
    ? pluginConfig.diagnosticAgents
    : [];
  return new Set(
    configuredAgents.filter(
      (agentId): agentId is string =>
        typeof agentId === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(agentId),
    ),
  );
}

const plugin = {
  id: 'acpx',
  name: 'ACPX Runtime',
  description: 'Embedded ACP runtime backend with plugin-owned session and transport management.',
  register(api: OpenClawPluginApi) {
    const doctorAgentIds = resolveDoctorAgentIds(api.pluginConfig);
    registerPiSessionCatalog(api);
    api.registerService(
      createAcpxRuntimeService({
        pluginConfig: api.pluginConfig,
        getAllowedAgents: () => api.runtime.config.current().acp?.allowedAgents,
        openKeyedStore: options => api.runtime.state.openKeyedStore(options),
      }),
    );
    api.registerGatewayMethod(
      'acpx.agent.doctor',
      async ({ params, respond }) => {
        const agentId = typeof params.agentId === 'string' ? params.agentId.trim() : '';
        if (!doctorAgentIds.has(agentId)) {
          respond(false, undefined, {
            code: 'INVALID_REQUEST',
            message: 'The ACP agent is not available for diagnostics.',
          });
          return;
        }
        const runtime = getAcpRuntimeBackend('acpx')?.runtime;
        if (!runtime || !('doctorAgent' in runtime)) {
          respond(false, undefined, {
            code: 'UNAVAILABLE',
            message: 'ACPX runtime is not available.',
          });
          return;
        }
        try {
          const report = await (
            runtime as { doctorAgent: (id: string) => Promise<unknown> }
          ).doctorAgent(agentId);
          respond(true, report);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'ACP agent test failed.';
          respond(false, undefined, {
            code: 'UNAVAILABLE',
            message: redactSensitiveText(message).slice(0, 2_000),
          });
        }
      },
      { scope: 'operator.read' },
    );
    api.on('reply_dispatch', tryDispatchAcpReplyHook, { eligibleDispatchKinds: ['acp'] });
  },
};

export default plugin;
