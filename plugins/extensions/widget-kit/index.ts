import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import { htmlPageContentKind, prepareHtmlPageToolCall } from './document/content-kind.js';
import { registerHtmlPageRoute } from './document/http-route.js';
import { uiContentKind } from './ui/content-kind.js';

export default {
  id: 'widget-kit',
  name: 'Widget Kit',
  description: 'Native visualization components and capability-aware webpage delivery guidance.',
  register(api: OpenClawPluginApi) {
    api.on('before_tool_call', prepareHtmlPageToolCall, { matcher: ['show_widget'] });
    api.registerBoardWidgetContentKind(uiContentKind);
    api.registerBoardWidgetContentKind(htmlPageContentKind);
    registerHtmlPageRoute(api, htmlPageContentKind.resources.readPublicResource);
  },
};
