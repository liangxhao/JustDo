// Isolated-Gateway fixture only. Never installed into a user profile.
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';
import { appendSessionTranscriptMessageByIdentityStrict } from 'openclaw/plugin-sdk/session-transcript-runtime';
import { registerMcpAppHistory } from '../../openclaw-extensions/runtime-services/mcp-app-history';

export default {
  id: 'runtime-services',
  name: 'MCP history recovery probe',
  register(api: OpenClawPluginApi) {
    registerMcpAppHistory(api);
    api.registerGatewayMethod(
      'historyProbe.seed',
      async ({ params, respond }) => {
        const { sessionKey, message } = params;
        if (sessionKey !== 'agent:main:mcp-app-smoke')
          throw new Error('Isolated test session required');
        const entry = getSessionEntry({ sessionKey, agentId: 'main', readConsistency: 'latest' });
        if (!entry?.sessionId) throw new Error('Fixture session missing');
        const result = await appendSessionTranscriptMessageByIdentityStrict({
          sessionKey,
          agentId: 'main',
          sessionId: entry.sessionId,
          message,
        });
        respond(true, { appended: result.kind === 'result' });
      },
      { scope: 'operator.admin' },
    );
  },
};
