import type { McpAppDiscovery } from '@shared/plugins/mcpApps';
import { expect, test } from 'vitest';

import { decodeFileAppLaunch, findFileApp, findFileAppIcons, findFileApps } from './fileApps';

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
  expect(findFileApp(catalog, filePath)?.input).toEqual({
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

test('selects an exact file entry despite ambiguity and rejects a replaced resource', () => {
  const filePath = 'E:/results.csv';
  const other = { ...catalog.servers[0], serverName: 'analysis', label: 'Analysis' };
  const ambiguous = { servers: [...catalog.servers, other] };
  const [sheet, analysis] = findFileApps(ambiguous, filePath);
  expect(findFileApp(ambiguous, filePath)).toBeUndefined();
  expect(findFileApp(ambiguous, filePath, sheet.id)).toBeDefined();
  expect(findFileApp(ambiguous, filePath, analysis.id)?.input.serverName).toBe('analysis');
  expect(findFileApp({ servers: [{
    ...other,
    entrypoints: other.entrypoints.map(entry => ({ ...entry, resourceUri: 'ui://analysis/replaced' })),
  }] }, filePath, analysis.id)).toBeUndefined();
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

test('validates the returned native file view against the selected service, resource and session', () => {
  const handler = findFileApp(catalog, '/workspace/budget.csv')!;
  const descriptor = {
    viewId: 'mcp-app-file',
    serverName: 'sheets',
    toolName: 'open_editor',
    uiResourceUri: 'ui://sheets/app.html',
    toolCallId: 'call-file',
    originSessionKey: 'agent:main:current',
  };
  const response = (overrides: Partial<typeof descriptor> = {}) => ({
    viewId: descriptor.viewId,
    preview: {
      kind: 'canvas',
      mcpApp: { ...descriptor, ...overrides },
      view: { id: descriptor.viewId, title: 'Sheets' },
      presentation: { target: 'assistant_message', sandbox: 'scripts' },
    },
  });
  expect(decodeFileAppLaunch(response(), handler, descriptor.originSessionKey)?.viewId)
    .toBe(descriptor.viewId);
  for (const change of [
    { serverName: 'other' },
    { uiResourceUri: 'ui://sheets/replaced' },
    { originSessionKey: 'agent:main:other' },
  ]) {
    expect(decodeFileAppLaunch(response(change), handler, descriptor.originSessionKey))
      .toBeUndefined();
  }
});
