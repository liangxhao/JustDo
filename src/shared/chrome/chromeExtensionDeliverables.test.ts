import { describe, expect, it } from 'vitest';

import { getChromeAssistantDeliverables, getWebLaunchAssistantDeliverables } from './chromeExtensionDeliverables';

describe('assistant deliverables', () => {
  it('uses explicit MEDIA declarations and keeps the exact reference for each file', () => {
    const text = [
      'Report generated.',
      'MEDIA: ./outputs/报表.xlsx',
      '- MEDIA: "C:\\work\\results\\screenshot.png"',
      '[Ordinary link](./another.pdf)',
      '```text',
      'MEDIA: ./example.pdf',
      '```',
    ].join('\n');
    expect(getWebLaunchAssistantDeliverables({ role: 'assistant', content: text })).toEqual([
      {
        source: './outputs/报表.xlsx',
        name: '报表.xlsx',
        kind: 'document',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      {
        source: '"C:\\work\\results\\screenshot.png"',
        name: 'screenshot.png',
        kind: 'image',
        mimeType: 'image/png',
      },
    ]);
    expect(getWebLaunchAssistantDeliverables({ role: 'user', content: text })).toEqual([]);
  });

  it('uses the native delivery list and resolves metadata by exact reference', () => {
    const source = '/api/chat/media/outgoing/agent%3Amain%3Atest/fd19f214-a8c8-419f-9e5b-4ca8b53520c3/full';
    expect(getWebLaunchAssistantDeliverables({
      role: 'assistant',
      content: 'Old generation.\nMEDIA: ./old.pdf',
      openclawDelivery: { mediaUrls: [source, source] },
      __openclaw: {
        media: [{ path: './report.pdf', url: source, fileName: 'reports/report.pdf', contentType: 'application/pdf' }],
      },
    })).toEqual([{ source, name: 'report.pdf', kind: 'document', mimeType: 'application/pdf' }]);
  });

  it('describes the projected native managed image and document blocks', () => {
    const folder = '/api/chat/media/outgoing/agent%3Amain%3Atest/';
    const image = folder + 'fd19f214-a8c8-419f-9e5b-4ca8b53520c3/full';
    const document = folder + 'c202755b-ad24-43b5-a8ec-b345c4276e23/full';
    const projected = {
      role: 'assistant',
      content: [
        { type: 'image', url: image, alt: '图表.png', mimeType: 'image/png' },
        { type: 'image', url: 'data:image/png;base64,AA==', mimeType: 'image/png' },
        { type: 'attachment', attachment: { kind: 'document', url: document, label: 'report.pdf', mimeType: 'application/pdf' } },
      ],
    };
    const expected = [
      { source: image, name: '图表.png', kind: 'image', mimeType: 'image/png' },
      { source: document, name: 'report.pdf', kind: 'document', mimeType: 'application/pdf' },
    ];
    expect(getWebLaunchAssistantDeliverables(projected)).toEqual(expected);
    expect(getWebLaunchAssistantDeliverables({
      ...projected,
      openclawDelivery: { mediaUrls: ['./图表.png', './report.pdf'] },
    })).toEqual(expected);
  });

  it('keeps a local document when a same-name managed file is a different kind', () => {
    const local = './out/report.pdf';
    const managed = '/api/chat/media/outgoing/agent%3Amain%3Atest/fd19f214-a8c8-419f-9e5b-4ca8b53520c3/full';
    const message = {
      role: 'assistant',
      openclawDelivery: { mediaUrls: [local] },
      content: [{ type: 'image', url: managed, alt: 'report.pdf', mimeType: 'image/png' }],
    };

    expect(getChromeAssistantDeliverables(message)).toMatchObject([
      { source: managed, name: 'report.pdf', kind: 'image' },
      { source: local, name: 'report.pdf', kind: 'document' },
    ]);
  });
});
