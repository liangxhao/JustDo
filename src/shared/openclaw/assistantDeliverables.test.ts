import { expect, it } from 'vitest';

import { isLocalAssistantDeliverableSource } from './assistantDeliverables';

it('separates local references from web, network and managed routes before filesystem checks', () => {
  expect(isLocalAssistantDeliverableSource('"C:\\work\\report.docx"')).toBe(true);
  expect(isLocalAssistantDeliverableSource('file:///C:/work/report.docx')).toBe(true);
  expect(isLocalAssistantDeliverableSource('file://device/work/report.docx')).toBe(false);
  expect(isLocalAssistantDeliverableSource('//device/work/report.docx')).toBe(false);
  expect(isLocalAssistantDeliverableSource('/api/chat/media/outgoing/test/id/full')).toBe(false);
  expect(isLocalAssistantDeliverableSource('https://example.test/report.docx')).toBe(false);
});
