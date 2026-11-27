import {
  type BrowserRecordingDraft,
  recordingNetworkProjection,
} from '@shared/browser/browserRecording';
import type { CoworkAttachmentPayload } from '@shared/cowork/attachments';

export function recordingSubmissionIssue(
  recording: BrowserRecordingDraft | undefined,
  attachments: CoworkAttachmentPayload[],
  supportsImages: boolean,
): 'recordingVision' | 'recordingPayloadLimit' | 'recordingNetworkOnlySubmission' | null {
  if (!recording) return null;
  if (recording.images.length && !supportsImages) return 'recordingVision';
  if (
    attachments.reduce((bytes, item) => bytes + item.base64Data.length * 0.75, 0) >
    20 * 1024 * 1024
  )
    return 'recordingPayloadLimit';
  if (
    !recording.steps.length &&
    (recording.capturedNetwork || recording.network) &&
    !recordingNetworkProjection(recording).summary?.entries.length
  )
    return 'recordingNetworkOnlySubmission';
  return null;
}
