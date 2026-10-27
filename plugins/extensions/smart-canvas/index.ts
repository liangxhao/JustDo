import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import { uiContentKind } from './ui/content-kind.js';

export default {
  id: 'smart-canvas',
  name: 'Smart Canvas',
  description: 'Interactive webpages, visualizations and compact cards in conversations.',
  register(api: OpenClawPluginApi) {
    api.registerBoardWidgetContentKind(uiContentKind);
  },
};
