import type { McpAppDiscovery } from '@shared/plugins/mcpApps';
import { createContext } from 'react';

/** The current workspace's discovered file handlers; never a global plugin cache. */
export const WorkspaceFileIconContext = createContext<McpAppDiscovery | undefined>(undefined);
