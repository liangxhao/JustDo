import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import { htmlPageContentKind, prepareHtmlPageToolCall } from './document/content-kind.js';
import { registerHtmlPageRoute } from './document/http-route.js';
import { uiContentKind } from './ui/content-kind.js';

export default {
  id: 'smart-canvas',
  name: 'Smart Canvas',
  description: 'Interactive visualizations, HTML pages and embedded webpages in conversations.',
  register(api: OpenClawPluginApi) {
    api.on('before_tool_call', prepareHtmlPageToolCall, { matcher: ['show_widget'] });
    api.registerBoardWidgetContentKind(uiContentKind);
    api.registerBoardWidgetContentKind(htmlPageContentKind);
    registerHtmlPageRoute(api, htmlPageContentKind.resources.readPublicResource);
  },
};
