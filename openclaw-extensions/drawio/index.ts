import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import { registerDiagramRecovery } from './restore';

export default {
  id: 'drawio',
  name: 'draw.io',
  register(api: OpenClawPluginApi) {
    registerDiagramRecovery(api);
  },
};
