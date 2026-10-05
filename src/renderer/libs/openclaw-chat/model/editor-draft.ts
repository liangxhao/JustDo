import { type BrowserAnnotationDraft, parseBrowserAnnotationPrompt } from '@shared/browser/browser';
import {
  type BrowserRecordingDraft,
  recordingImageFingerprint,
} from '@shared/browser/browserRecording';
import type { CoworkAttachmentPayload } from '@shared/cowork/attachments';
import { stripSwarmInstruction } from '@shared/cowork/swarm';
import { extractGoalFollowUpRequest } from '@shared/prompts/goalFollowUpPrompt';

import { splitMediaFromOutput } from '@/libs/openclaw-chat/shims/backend-helpers';

export interface EditorDraftPayload {
  text: string;
  attachments: CoworkAttachmentPayload[];
  filePaths: string[];
  browserAnnotations?: BrowserAnnotationDraft[];
  browserRecording?: BrowserRecordingDraft;
}

export function parseEditorDraftPayload(
  editorText: unknown,
  editorAttachments: unknown,
  options: { restoreBrowserAnnotations?: boolean } = {},
): EditorDraftPayload {
  const rawEditorText = typeof editorText === 'string' ? stripSwarmInstruction(editorText) : '';
  const browserPrompt = parseBrowserAnnotationPrompt(rawEditorText);
  const visibleText = browserPrompt?.userText ?? rawEditorText;
  const goalText = extractGoalFollowUpRequest(visibleText) ?? visibleText;
  const parsedMedia = splitMediaFromOutput(goalText);
  const filePaths = parsedMedia.mediaUrls ?? [];
  const text = filePaths.length
    ? (parsedMedia.segments ?? [])
        .filter(segment => segment.type === 'text')
        .map(segment => segment.text)
        .join('\n\n')
    : goalText;
  const rawAttachments = (Array.isArray(editorAttachments) ? editorAttachments : []).flatMap(
    (attachment, index) => {
      if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) return [];
      const record = attachment as Record<string, unknown>;
      const mimeType = typeof record.mimeType === 'string' ? record.mimeType.trim() : '';
      const base64Data = typeof record.data === 'string' ? record.data.trim() : '';
      if (!mimeType || !base64Data) return [];
      const subtype = mimeType
        .split('/')[1]
        ?.split(/[;+]/u)[0]
        ?.replace(/[^a-z0-9]+/giu, '');
      return [
        {
          name: `restored-attachment-${index + 1}${subtype ? `.${subtype}` : ''}`,
          mimeType,
          base64Data,
        },
      ];
    },
  );
  const browserAnnotationCount =
    options.restoreBrowserAnnotations && browserPrompt ? browserPrompt.annotations.length : 0;
  const browserAttachmentStart = Math.max(0, rawAttachments.length - browserAnnotationCount);
  const browserAttachmentCandidates = rawAttachments.slice(browserAttachmentStart);
  const modelContextParts = browserPrompt?.modelContext.split(/\n\n/u) ?? [];
  const modelContexts =
    modelContextParts.length === browserAnnotationCount
      ? modelContextParts
      : browserPrompt?.modelContext
        ? [browserPrompt.modelContext, ...Array(Math.max(0, browserAnnotationCount - 1)).fill('')]
        : [];
  const browserAnnotations =
    options.restoreBrowserAnnotations && browserPrompt
      ? browserPrompt.annotations.flatMap((display, index) => {
          const screenshot = browserAttachmentCandidates[index];
          if (!screenshot) return [];
          return [
            {
              id: display.id || `restored-browser-annotation-${index + 1}`,
              modelContext: modelContexts[index] ?? '',
              title: display.title,
              displayUrl: display.displayUrl,
              markedRegionCount: display.markedRegionCount,
              inspectedElement: Boolean(display.element),
              display,
              dataUrl: `data:${screenshot.mimeType};base64,${screenshot.base64Data}`,
              fileName: `browser-annotation-${index + 1}.png`,
              addedAt: Date.now() + index,
            },
          ];
        })
      : [];
  let attachments = browserAnnotations.length
    ? rawAttachments.slice(0, browserAttachmentStart)
    : rawAttachments;
  let browserRecording: BrowserRecordingDraft | undefined;
  if (browserPrompt?.recording) {
    const parsed = browserPrompt.recording;
    const files = parsed.steps.flatMap(step =>
      (step.screenshotFiles ?? []).map((fileName, index) => ({
        stepId: step.id,
        fileName,
        fingerprint: step.screenshotFingerprints?.[index],
      })),
    );
    const imageEnd = Math.max(0, rawAttachments.length - browserPrompt.annotations.length);
    const fingerprints = rawAttachments.map((payload, index) =>
      index < imageEnd && payload.mimeType.startsWith('image/')
        ? recordingImageFingerprint(payload.mimeType, payload.base64Data)
        : '',
    );
    const matched = new Set<number>();
    const images = files.flatMap(({ fingerprint, ...file }) => {
      if (!fingerprint) return [];
      const index = fingerprints.findIndex(
        (candidate, index) => !matched.has(index) && candidate === fingerprint,
      );
      if (index < 0) return [];
      matched.add(index);
      const payload = rawAttachments[index];
      return [{ ...file, dataUrl: `data:${payload.mimeType};base64,${payload.base64Data}` }];
    });
    browserRecording = {
      ...parsed,
      id: crypto.randomUUID(),
      incomplete: parsed.incomplete || images.length !== files.length,
      images,
    };
    attachments = attachments.filter((_item, index) => !matched.has(index));
  }
  return {
    text,
    attachments,
    filePaths,
    ...(browserRecording ? { browserRecording } : {}),
    ...(options.restoreBrowserAnnotations ? { browserAnnotations } : {}),
  };
}
