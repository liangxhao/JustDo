import { type BrowserAnnotationDraft, composeBrowserGatewayPrompt } from '@shared/browser/browser';
import { type BrowserRecordingDraft, recordingImagesInStepOrder } from '@shared/browser/browserRecording';
import { expect, it } from 'vitest';

import { parseEditorDraftPayload } from './editor-draft';

it('restores demonstration screenshots for editing without duplicating regular attachments', () => {
  const prompt = composeBrowserGatewayPrompt('Find order', [], {
    id: 'r',
    sessionId: 's',
    profile: 'embedded',
    title: 'Orders',
    note: '',
    startedAt: 1,
    steps: [
      {
        id: 'step',
        action: 'input',
        pageId: 'tab',
        at: 0,
        url: 'https://example.com',
        title: '',
        value: '123',
      },
    ],
    images: [{ stepId: 'step', fileName: 'step.jpg', dataUrl: 'data:image/jpeg;base64,AA==' }],
  });
  const restored = parseEditorDraftPayload(prompt, [
    { mimeType: 'text/plain', data: 'QQ==' },
    { mimeType: 'image/jpeg', data: 'AA==' },
  ]);
  expect(restored.attachments).toHaveLength(1);
  expect(restored.browserRecording?.images).toEqual([
    { stepId: 'step', fileName: 'step.jpg', dataUrl: 'data:image/jpeg;base64,AA==' },
  ]);
  expect(restored.text).toBe('Find order');
});

it('does not borrow annotation images when recording screenshots are missing from history', () => {
  const recording: BrowserRecordingDraft = {
    id: 'r',
    sessionId: 's',
    profile: 'embedded',
    title: '',
    note: '',
    startedAt: 0,
    steps: [
      { id: 'step', action: 'click', pageId: 'tab', at: 0, url: 'https://example.com', title: '' },
    ],
    images: [{ stepId: 'step', fileName: 'recording.jpg', dataUrl: 'data:image/jpeg;base64,AA==' }],
  };
  const annotation: BrowserAnnotationDraft = {
    id: 'a',
    modelContext: 'Annotated page',
    title: 'Page',
    displayUrl: 'https://example.com',
    markedRegionCount: 1,
    inspectedElement: false,
    addedAt: 0,
    fileName: 'annotation.png',
    dataUrl: 'data:image/png;base64,QQ==',
  };
  const restored = parseEditorDraftPayload(
    composeBrowserGatewayPrompt('Replay', [annotation], recording),
    [{ mimeType: 'image/png', data: 'QQ==' }],
    { restoreBrowserAnnotations: true },
  );
  expect(restored.browserRecording?.images).toEqual([]);
  expect(restored.browserRecording?.incomplete).toBe(true);
  expect(restored.browserAnnotations?.[0].dataUrl).toBe(annotation.dataUrl);
});

it('orders asynchronous screenshots by steps before sending and restoring their references', () => {
  const recording: BrowserRecordingDraft = {
    id: 'r',
    sessionId: 's',
    profile: 'embedded',
    title: '',
    note: '',
    startedAt: 0,
    steps: ['first', 'second'].map(id => ({
      id,
      action: 'click',
      pageId: 'tab',
      at: 0,
      url: 'https://example.com',
      title: '',
    })),
    images: [
      { stepId: 'second', fileName: 'second.jpg', dataUrl: 'data:image/jpeg;base64,Qg==' },
      { stepId: 'first', fileName: 'first.jpg', dataUrl: 'data:image/jpeg;base64,QQ==' },
    ],
  };
  const ordered = recordingImagesInStepOrder(recording);
  const restored = parseEditorDraftPayload(
    composeBrowserGatewayPrompt('Replay', [], recording),
    ordered.map(image => ({ mimeType: 'image/jpeg', data: image.dataUrl.split(',')[1] })),
  );
  expect(restored.browserRecording?.images).toEqual(ordered);
});

it('keeps a normal image attachment when a same-type recording screenshot is missing', () => {
  const recording: BrowserRecordingDraft = {
    id: 'r',
    sessionId: 's',
    profile: 'embedded',
    title: '',
    note: '',
    startedAt: 0,
    steps: [
      { id: 'step', action: 'click', pageId: 'tab', at: 0, url: 'https://example.com', title: '' },
    ],
    images: [{ stepId: 'step', fileName: 'recording.jpg', dataUrl: 'data:image/jpeg;base64,QQ==' }],
  };
  const restored = parseEditorDraftPayload(composeBrowserGatewayPrompt('Replay', [], recording), [
    { mimeType: 'image/jpeg', data: 'Qg==' },
  ]);
  expect(restored.browserRecording?.images).toEqual([]);
  expect(restored.browserRecording?.incomplete).toBe(true);
  expect(restored.attachments).toEqual([
    { name: 'restored-attachment-1.jpeg', mimeType: 'image/jpeg', base64Data: 'Qg==' },
  ]);
  recording.images[0].dataUrl = 'data:image/jpeg;base64,Qg==';
  const changed = parseEditorDraftPayload(
    composeBrowserGatewayPrompt('Replay updated screenshot', [], recording),
    [{ mimeType: 'image/jpeg', data: 'Qg==' }],
  );
  expect(changed.browserRecording?.images).toEqual(recording.images);
  expect(changed.attachments).toEqual([]);
});
