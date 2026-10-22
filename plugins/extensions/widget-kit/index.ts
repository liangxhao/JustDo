import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import { uiContentKind } from './ui/content-kind.js';

export default {
  id: 'widget-kit',
  name: 'Widget Kit',
  description: 'Visualization guidance and reusable components through native show_widget.',
  register(api: OpenClawPluginApi) {
    api.registerBoardWidgetContentKind(uiContentKind);
  },
};
