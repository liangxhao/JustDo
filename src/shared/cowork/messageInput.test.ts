import { expect, test } from 'vitest';

import { composeBrowserGatewayPrompt } from '../browser/browserMessageContext';
import { getMessageTitleInput, hasMessageInput } from './messageInput';

const attachments = [{ name: 'diagram.png', mimeType: 'image/png', base64Data: 'aGVsbG8=' }];

test('accepts attachments and browser context but rejects empty or malformed content', () => {
  expect(hasMessageInput({ prompt: ' ', attachments })).toBe(true);
  expect(hasMessageInput({ prompt: '', gatewayPrompt: 'page context' })).toBe(true);
  expect(hasMessageInput({ prompt: ' ' })).toBe(false);
  expect(hasMessageInput({ prompt: '', attachments: [{}] })).toBe(false);
  expect(
    hasMessageInput({ prompt: '', attachments: [{ ...attachments[0], base64Data: '' }] }),
  ).toBe(false);
});

test('prefers user text and otherwise derives titles from filenames without local paths', () => {
  expect(getMessageTitleInput(' Explain this\n\nMEDIA:C:\\private\\report.pdf', attachments)).toBe(
    'Explain this',
  );
  expect(getMessageTitleInput('', attachments)).toBe('diagram.png');
  expect(getMessageTitleInput('MEDIA:C:\\private\\report.pdf')).toBe('report.pdf');
  expect(getMessageTitleInput('')).toBe('');
});

test('uses annotation comments and page titles instead of internal browser context', () => {
  const gatewayPrompt = composeBrowserGatewayPrompt('', [
    {
      id: 'annotation-1',
      title: 'Dashboard',
      displayUrl: 'https://example.com',
      markedRegionCount: 1,
      inspectedElement: false,
      comment: 'Fix this chart',
      modelContext: 'PRIVATE INTERNAL CONTEXT',
      dataUrl: 'data:image/png;base64,aGVsbG8=',
      fileName: 'annotation.png',
      addedAt: 1,
    },
  ]);
  expect(getMessageTitleInput('', attachments, gatewayPrompt)).toBe('Fix this chart\nDashboard');
  expect(getMessageTitleInput('My request', attachments, gatewayPrompt)).toBe('My request');
});
