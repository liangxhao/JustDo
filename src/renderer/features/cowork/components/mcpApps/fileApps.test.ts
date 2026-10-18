import type { McpAppDiscovery } from '@shared/plugins/mcpApps';
import { expect, test } from 'vitest';

import { findFileApp } from './fileApps';

const catalog: McpAppDiscovery = {
  servers: [
    {
      serverName: 'sheets',
      label: 'Sheets',
      entrypoints: [
        {
          toolName: 'open_editor',
          title: 'Sheets',
          resourceUri: 'ui://sheets/app.html',
          entrypoint: { type: 'global' },
        },
        {
          toolName: 'preview_file',
          title: 'Preview',
          resourceUri: 'ui://sheets/app.html',
          entrypoint: { type: 'file', extensions: ['.xlsx', '.csv'] },
        },
      ],
    },
  ],
};

test('routes only one exact discovered file extension and preserves the original path', () => {
  const filePath = 'E:\\项目资料\\预算.XLSX';
  expect(findFileApp(catalog, filePath)).toEqual({
    serverName: 'sheets',
    toolName: 'preview_file',
    entrypointType: 'file',
    filePath,
  });
  expect(findFileApp(catalog, `${filePath}.exe`)).toBeUndefined();
  expect(findFileApp(undefined, filePath)).toBeUndefined();
  expect(
    findFileApp(
      { servers: [...catalog.servers, { ...catalog.servers[0], serverName: 'other' }] },
      filePath,
    ),
  ).toBeUndefined();
});
