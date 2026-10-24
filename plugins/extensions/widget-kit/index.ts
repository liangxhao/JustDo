import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import { createOfflineHtmlContentKind } from './libraries/content-kind.js';
import { uiContentKind } from './ui/content-kind.js';

export default {
  id: 'widget-kit',
  name: 'Widget Kit',
  description: 'Visualization guidance and reusable components through native show_widget.',
  register(api: OpenClawPluginApi) {
    api.registerBoardWidgetContentKind(uiContentKind);
    api.registerBoardWidgetContentKind(
      createOfflineHtmlContentKind(new URL('./assets/', import.meta.url)),
    );
  },
};
