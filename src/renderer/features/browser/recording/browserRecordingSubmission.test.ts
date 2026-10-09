import type { BrowserRecordingDraft } from '@shared/browser/browserRecording';
import { expect, it } from 'vitest';

import { recordingSubmissionIssue } from './browserRecordingSubmission';

const recording: BrowserRecordingDraft = {
  id: 'r',
  sessionId: 's',
  profile: 'embedded',
  title: '',
  note: '',
  startedAt: 0,
  steps: [],
  images: [{ stepId: 's', fileName: 's.jpg', dataUrl: 'data:image/jpeg;base64,QQ==' }],
};

it('requires explicit steps-only selection for a model without images', () => {
  expect(recordingSubmissionIssue(recording, [], false)).toBe('recordingVision');
  expect(recordingSubmissionIssue({ ...recording, images: [] }, [], false)).toBeNull();
});

it('counts all attachments when validating a recording submission', () => {
  const attachments = [
    { name: 'image.jpg', mimeType: 'image/jpeg', base64Data: 'A'.repeat(28 * 1024 * 1024) },
  ];
  expect(recordingSubmissionIssue(recording, attachments, true)).toBe('recordingPayloadLimit');
  expect(recordingSubmissionIssue(recording, [], true)).toBeNull();
});
