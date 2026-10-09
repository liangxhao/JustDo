import type { BrowserRecordingDraft } from '@shared/browser/browserRecording';
import type { CoworkAttachmentPayload } from '@shared/cowork/attachments';

export function recordingSubmissionIssue(
  recording: BrowserRecordingDraft | undefined,
  attachments: CoworkAttachmentPayload[],
  supportsImages: boolean,
): 'recordingVision' | 'recordingPayloadLimit' | null {
  if (!recording) return null;
  if (recording.images.length && !supportsImages) return 'recordingVision';
  if (
    attachments.reduce((bytes, item) => bytes + item.base64Data.length * 0.75, 0) >
    20 * 1024 * 1024
  )
    return 'recordingPayloadLimit';
  return null;
}
