import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test } from 'vitest';

import { i18nService } from '@/services/i18n';

import ToolIntegrationSettingsTab from './ToolIntegrationSettingsTab';

afterEach(() => {
  i18nService.setLanguage('zh', { persist: false });
});

test('shows both integration directions and opens external access by default', () => {
  i18nService.setLanguage('en', { persist: false });

  const html = renderToStaticMarkup(createElement(ToolIntegrationSettingsTab));

  expect(html).toContain('Connect external tools');
  expect(html).toContain('Accept external connections');
  expect(html).toContain('id="tool-integration-tab-inbound"');
  expect(html).toContain('aria-selected="true"');
  expect(html).toContain('Multica integration');
  expect(html).toContain('Local-only management; no Multica server access');
  expect(html).not.toContain('Safely restart daemon');
  expect(html).not.toContain('Connect Claude Code, Codex, and other tools');
});
