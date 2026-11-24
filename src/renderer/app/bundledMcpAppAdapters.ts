import type { McpAppAdapter } from '@app-plugin/sdk/mcp-app';

import { registerMcpAppAdapter } from '@/libs/openclaw-chat/pipeline/mcp-app-adapters';

const adapters = import.meta.glob<McpAppAdapter>(
  '../../../plugins/extensions/*/browser/mcp-app-adapter.ts',
  { eager: true, import: 'mcpAppAdapter' },
);

for (const adapter of Object.values(adapters)) registerMcpAppAdapter(adapter);
