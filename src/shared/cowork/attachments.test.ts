import { describe, expect, test } from 'vitest';

import {
  parseCoworkAttachments,
  toAttachmentDataUrl,
  toGatewayAttachment,
} from './attachments';

describe('cowork attachment helpers', () => {
  test('maps images and files to their gateway attachment shapes', () => {
    expect(
      toGatewayAttachment({ name: 'photo.png', mimeType: 'image/png', base64Data: 'abc' }),
    ).toEqual({ type: 'image', mimeType: 'image/png', content: 'abc' });
    expect(
      toGatewayAttachment({ name: 'notes.txt', mimeType: 'text/plain', base64Data: 'xyz' }),
    ).toEqual({
      type: 'file',
      mimeType: 'text/plain',
      content: 'xyz',
      fileName: 'notes.txt',
    });
  });

  test('normalizes valid persisted attachments and ignores invalid entries', () => {
    expect(
      parseCoworkAttachments([
        { name: ' notes.txt ', mimeType: ' text/plain ', base64Data: ' eHl6 ' },
        null,
        { name: 'empty.txt', mimeType: 'text/plain', base64Data: '' },
      ]),
    ).toEqual([{ name: 'notes.txt', mimeType: 'text/plain', base64Data: 'eHl6' }]);
  });

  test('preserves data URLs and wraps raw base64 data', () => {
    expect(
      toAttachmentDataUrl({
        name: 'photo.png',
        mimeType: 'image/png',
        base64Data: 'data:image/png;base64,abc',
      }),
    ).toBe('data:image/png;base64,abc');
    expect(
      toAttachmentDataUrl({ name: 'photo.png', mimeType: 'image/png', base64Data: 'abc' }),
    ).toBe('data:image/png;base64,abc');
  });

});
