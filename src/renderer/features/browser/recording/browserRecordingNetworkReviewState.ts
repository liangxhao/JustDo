import type { BrowserRecordingDraft } from '@shared/browser/browserRecording';
import {
  type RecordingNetworkCapture,
  RecordingNetworkGroup,
  RecordingNetworkType,
} from '@shared/browser/browserRecordingNetwork';

import { i18nService } from '@/services/i18n';

export function recordingNetworkCaptureForReview(
  draft: BrowserRecordingDraft,
): RecordingNetworkCapture | undefined {
  if (draft.capturedNetwork) return draft.capturedNetwork;
  if (!draft.network) return undefined;
  const entries = draft.network.entries.map((entry, index) => ({
    ...entry,
    id: `history-${index}`,
  }));
  return {
    entries,
    coverage: [],
    omittedCount: draft.network.omittedCount ?? 0,
    include: true,
    selections: Object.fromEntries(entries.map(entry => [entry.id, true])),
  };
}

export function detachRecordingNetworkStep(
  draft: BrowserRecordingDraft,
  stepId: string,
): BrowserRecordingDraft {
  const capture = recordingNetworkCaptureForReview(draft);
  const related = capture?.entries.filter(entry => entry.stepId === stepId);
  if (!capture || !related?.length) return draft;
  return {
    ...draft,
    capturedNetwork: {
      ...capture,
      entries: capture.entries.map(entry => {
        if (entry.stepId !== stepId) return entry;
        return entry.type === RecordingNetworkType.Document
          ? { ...entry, stepId: undefined }
          : {
              ...entry,
              stepId: undefined,
              loadSequence: undefined,
              group: RecordingNetworkGroup.Unassigned,
            };
      }),
      selections: {
        ...capture.selections,
        ...Object.fromEntries(related.map(entry => [entry.id, false])),
      },
    },
  };
}

export function recordingNetworkReviewSummary(captured: number, attached: number): string {
  return i18nService
    .t('recordingNetworkSummary')
    .replace('{captured}', String(captured))
    .replace('{attached}', String(attached));
}
