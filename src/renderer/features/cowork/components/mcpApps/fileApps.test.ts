import type { McpAppDiscovery } from '@shared/plugins/mcpApps';
import { expect, test } from 'vitest';

import { findFileApp, findFileAppIcons } from './fileApps';

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

test('uses the selected file entry icon before the server icon and refuses ambiguous handlers', () => {
  const serverIcon = { src: 'data:image/png;base64,c2VydmVy' };
  const fileIcon = { src: 'data:image/png;base64,ZmlsZQ==' };
  const server = {
    ...catalog.servers[0],
    icons: [serverIcon],
    entrypoints: catalog.servers[0].entrypoints.map(entry => ({
      ...entry,
      ...(entry.entrypoint.type === 'file' ? { icons: [fileIcon] } : {}),
    })),
  };
  expect(findFileAppIcons({ servers: [server] }, '预算.XLSX')).toEqual([fileIcon]);
  expect(
    findFileAppIcons({ servers: [{ ...catalog.servers[0], icons: [serverIcon] }] }, '预算.xlsx'),
  ).toEqual([serverIcon]);
  expect(
    findFileAppIcons({ servers: [server, { ...server, serverName: 'other' }] }, '预算.xlsx'),
  ).toBeUndefined();
  expect(findFileAppIcons({ servers: [server] }, '图表.drawio')).toBeUndefined();
  expect(findFileAppIcons(undefined, '预算.xlsx')).toBeUndefined();
});
