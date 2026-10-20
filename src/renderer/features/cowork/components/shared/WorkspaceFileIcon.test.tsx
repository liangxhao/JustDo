// @vitest-environment jsdom
import type { McpAppDiscovery, McpAppIcon } from '@shared/plugins/mcpApps';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';

import WorkspaceFileIcon from './WorkspaceFileIcon';
import { WorkspaceFileIconContext } from './WorkspaceFileIconContext';

afterEach(cleanup);

const light = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E';
const dark = 'data:image/png;base64,aWNvbg==';
const catalog = (icons: McpAppIcon[]): McpAppDiscovery => ({
  servers: [
    {
      serverName: 'diagrams',
      label: 'Diagrams',
      entrypoints: [
        {
          toolName: 'open_file',
          title: 'Diagrams',
          resourceUri: 'ui://diagrams/editor',
          icons,
          entrypoint: { type: 'file', extensions: ['.drawio'] },
        },
      ],
    },
  ],
});

test('renders discovered theme icons and removes them when the workspace catalog changes', () => {
  const view = (value?: McpAppDiscovery) => (
    <WorkspaceFileIconContext.Provider value={value}>
      <WorkspaceFileIcon fileName="采购.DRAWIO" />
      <WorkspaceFileIcon fileName="notes.md" />
    </WorkspaceFileIconContext.Provider>
  );
  const { container, rerender } = render(
    view(
      catalog([
        { src: light, theme: 'light' },
        { src: dark, theme: 'dark' },
      ]),
    ),
  );
  expect([...container.querySelectorAll('img')].map(img => img.getAttribute('src'))).toEqual([
    light,
    dark,
  ]);
  expect(container.querySelector('[data-file-icon-kind="markdown"]')?.textContent).toBe('M↓');
  rerender(view());
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('[data-file-icon-kind="file"] svg')).not.toBeNull();
});

test.each([
  'https://public.example/icon.svg',
  'file:///private/icon.png',
  'data:image/png;base64,' + 'x'.repeat(2048),
])('keeps the built-in icon for an unavailable or disallowed plugin icon: %s', src => {
  const { container } = render(
    <WorkspaceFileIconContext.Provider value={catalog([{ src }])}>
      <WorkspaceFileIcon fileName="diagram.drawio" />
    </WorkspaceFileIconContext.Provider>,
  );
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('svg')).not.toBeNull();
});

test('falls back to the file type icon when a plugin image cannot be decoded', () => {
  const { container } = render(
    <WorkspaceFileIconContext.Provider value={catalog([{ src: light }])}>
      <WorkspaceFileIcon fileName="diagram.drawio" />
    </WorkspaceFileIconContext.Provider>,
  );
  fireEvent.error(container.querySelector('img')!);
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('svg')).not.toBeNull();
});
