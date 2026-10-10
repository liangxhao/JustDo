import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import { scenarioContentKind } from './scenario/content-kind.js';
import { uiContentKind } from './ui/content-kind.js';

export default {
  id: 'interactive-ui',
  name: 'Interactive UI',
  description: 'Validated scenario and interactive answer widgets using native show_widget.',
  register(api: OpenClawPluginApi) {
    api.registerBoardWidgetContentKind(scenarioContentKind);
    api.registerBoardWidgetContentKind(uiContentKind);
  },
};
