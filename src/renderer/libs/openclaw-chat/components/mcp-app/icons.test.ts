import type { McpAppDiscovery } from '@shared/plugins/mcpApps';
import { expect, test } from 'vitest';

import { resolveMcpAppIcons, selectMcpAppIcon } from './icons';

const serverIcons = [{ src: 'data:image/png;base64,c2VydmVy' }];
const entryIcons = [{ src: 'data:image/png;base64,ZW50cnk=' }];
const catalog: McpAppDiscovery = {
  servers: [
    {
      serverName: 'editor',
      label: 'Editor',
      icons: serverIcons,
      entrypoints: [
        {
          toolName: 'open',
          title: 'Open',
          resourceUri: 'ui://editor/app',
          entrypoint: { type: 'global' },
          icons: entryIcons,
        },
      ],
    },
  ],
};

test('matches the exact view identity and shares the declared entry icon during loading', () => {
  expect(
    resolveMcpAppIcons(catalog, {
      serverName: 'editor',
      toolName: 'open',
      uiResourceUri: 'ui://editor/app',
    }),
  ).toBe(entryIcons);
  expect(resolveMcpAppIcons(catalog, { serverName: 'editor', toolName: 'open' })).toBe(entryIcons);
  expect(
    resolveMcpAppIcons(catalog, {
      serverName: 'editor',
      toolName: 'open',
      uiResourceUri: 'ui://editor/other',
    }),
  ).toBe(serverIcons);
  expect(resolveMcpAppIcons(catalog, { serverName: 'editor', toolName: 'model_only' })).toBe(
    serverIcons,
  );
  expect(resolveMcpAppIcons(catalog, { serverName: 'unknown' })).toBeUndefined();
});

test('theme selection rejects URLs, oversized images and failed images with a neutral fallback', () => {
  const neutral = { src: 'data:image/svg+xml,%3Csvg/%3E' };
  const light = { src: 'data:image/webp;base64,bGlnaHQ=', theme: 'light' as const };
  const icons = [
    { src: 'https://example.com/icon.png' },
    { src: 'file:///E:/icon.png' },
    { src: `data:image/png;base64,${'a'.repeat(2048)}` },
    neutral,
    light,
  ];
  expect(selectMcpAppIcon(icons, 'light')).toBe(light);
  expect(selectMcpAppIcon(icons, 'dark')).toBe(neutral);
  expect(selectMcpAppIcon(icons, 'light', [light.src])).toBe(neutral);
  expect(selectMcpAppIcon(icons, 'dark', [light.src, neutral.src])).toBeUndefined();
});
