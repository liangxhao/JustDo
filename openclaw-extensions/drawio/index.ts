import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import { registerDiagramRecovery } from './restore';
import { registerDiagramEditing } from './editing';

export default {
  id: 'drawio',
  name: 'draw.io',
  register(api: OpenClawPluginApi) {
    registerDiagramRecovery(api);
    registerDiagramEditing(api);
  },
};
