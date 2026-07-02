import { describe, expect, test } from 'vitest';

import type { CoworkMessage } from '../../../types/cowork';
import { coworkMessageToGateway } from './cowork-to-gateway';

describe('coworkMessageToGateway', () => {
  test('converts user image metadata into renderable base64 attachments', () => {
    const message: CoworkMessage = {
      id: 'message-1',
      type: 'user',
      content: '看看这张图',
      timestamp: 1,
      metadata: {
        imageAttachments: [
          {
            name: 'example.png',
            mimeType: 'image/png',
            base64Data: 'YWJj',
          },
        ],
      },
    };

    expect(coworkMessageToGateway(message).content).toEqual([
      { type: 'text', text: '看看这张图' },
      {
        type: 'attachment',
        attachment: {
          url: 'data:image/png;base64,YWJj',
          kind: 'image',
          label: 'example.png',
          mimeType: 'image/png',
        },
      },
    ]);
  });

  test('keeps plain user messages as strings', () => {
    const message: CoworkMessage = {
      id: 'message-2',
      type: 'user',
      content: 'hello',
      timestamp: 2,
    };

    expect(coworkMessageToGateway(message).content).toBe('hello');
  });
});
