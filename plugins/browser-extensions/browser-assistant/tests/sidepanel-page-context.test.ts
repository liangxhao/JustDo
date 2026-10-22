import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const sidePanelSource = readFileSync(
  path.resolve('plugins/browser-extensions/browser-assistant/conversation-overlay/sidepanel.js'),
  'utf8',
);

describe('browser extension side panel page context', () => {
  it('reads the active tab from the window that owns the side panel', () => {
    expect(sidePanelSource).toContain('chrome.tabs.query({ active: true, currentWindow: true })');
    expect(sidePanelSource).not.toContain('lastFocusedWindow: true');
  });

  it('keeps title and URL context for restricted browser pages', () => {
    expect(sidePanelSource).toContain('if (!tab?.id) return undefined;');
    expect(sidePanelSource).not.toContain("!/^https?:/u.test(tab.url ?? '')");
    expect(sidePanelSource).toContain(
      "return { title: tab.title ?? '', url: tab.url ?? '', selectedText, pageText };",
    );
  });

  it('collects bounded visible page text along with the selection', () => {
    expect(sidePanelSource).toContain(
      "chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] })",
    );
    expect(sidePanelSource).toContain("document.querySelector('main')?.innerText");
    expect(sidePanelSource).toContain('result.result.pageText.slice(0, 24000)');
  });
});
