import { describe, expect, it } from 'vitest';

import { prepareMcpAppDownload } from './download';

const embedded = (resource: unknown) => [{ type: 'resource', resource }];
describe('MCP App download admission', () => {
  it('preserves Unicode source and binary exports as embedded bytes', () => {
    const file = prepareMcpAppDownload(
      embedded({
        uri: 'file:///%E6%B5%81%E7%A8%8B.drawio',
        mimeType: 'application/vnd.jgraph.mxfile',
        text: '<mxfile>流程</mxfile>',
      }),
    );
    expect(file.fileName).toBe('流程.drawio');
    expect(Buffer.from(file.dataBase64, 'base64').toString()).toBe('<mxfile>流程</mxfile>');
    expect(
      prepareMcpAppDownload(
        embedded({ uri: 'file:///diagram.png', mimeType: 'image/png', blob: 'aGVsbG8=' }),
      ).dataBase64,
    ).toBe('aGVsbG8=');
  });
  it.each(
    [
      [{ type: 'resource_link', uri: 'https://example.test/file.png', name: 'file.png' }],
      embedded({ uri: 'file:///diagram.png', mimeType: 'image/png' }),
      embedded({ uri: 'file:///%2e%2e%2fdiagram.png', mimeType: 'image/png', blob: 'aGVsbG8=' }),
      embedded({ uri: 'file:///diagram.exe', mimeType: 'image/png', blob: 'aGVsbG8=' }),
      embedded({ uri: 'file:///con.png', mimeType: 'image/png', blob: 'aGVsbG8=' }),
      embedded({ uri: 'file:///diagram.png', mimeType: 'image/png', blob: 'not base64' }),
      [
        { type: 'resource', resource: { uri: 'file:///x.txt', mimeType: 'text/plain', text: 'x' } },
        { type: 'resource', resource: { uri: 'file:///y.txt', mimeType: 'text/plain', text: 'y' } },
      ],
    ].map(contents => ({ contents })),
  )('rejects remote references, invalid paths and unsupported payloads', ({ contents }) => {
    expect(() => prepareMcpAppDownload(contents)).toThrow();
  });
});
