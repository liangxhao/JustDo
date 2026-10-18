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
  it('admits embedded XLSX exports while preserving their binary bytes', () => {
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x80]);
    const file = prepareMcpAppDownload(
      embedded({
        uri: 'file:///%E9%A2%84%E7%AE%97.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        blob: bytes.toString('base64'),
      }),
    );
    expect(file.fileName).toBe('预算.xlsx');
    expect(Buffer.from(file.dataBase64, 'base64')).toEqual(bytes);
  });
  it.each(['xlsx.exe', 'book.xlsm', 'book.csv'])(
    'rejects a spreadsheet MIME with the mismatched name %s',
    name => {
      expect(() =>
        prepareMcpAppDownload(
          embedded({
            uri: `file:///${name}`,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            blob: 'UEsDBA==',
          }),
        ),
      ).toThrow();
    },
  );
});
