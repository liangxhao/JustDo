import type { CollaborationContinueTarget } from '@shared/cowork/agent-team/collaboration';
import { appendCollaborationContinuation } from '@shared/cowork/agent-team/collaborationContinuationPrompt';
import { isLocalAudioAttachment } from '@shared/speech/localAsr';

import type { CoworkAttachmentPayload } from '@/features/cowork/coworkTypes';

import { isImagePath } from '../composer/composerAttachmentFiles';
import type {
  CollaborationContinueRequest,
  CollaborationContinueStatus,
} from './collaborationContinueDraft';

interface ContinueSubmissionContext {
  target: CollaborationContinueTarget;
  cwd: string;
  assertCurrent: () => void;
  supportsImages: () => boolean;
  stageAudio: (
    path: string,
    cwd: string,
  ) => Promise<{ success: boolean; path?: string; error?: string }>;
  readImage: (path: string) => Promise<{ success: boolean; dataUrl?: string; error?: string }>;
  /** Refresh the exact source/room/member admission after any slow attachment work. */
  beforeSubmit: () => Promise<void>;
  submit: (
    display: string,
    images: CoworkAttachmentPayload[],
    gateway: string,
    clientTurnId: string,
  ) => Promise<boolean>;
  outcomeUnknown: () => boolean;
}

/** An independent source-user turn: it neither sends directly to the peer nor consumes main drafts. */
export async function submitCollaborationContinuation(
  input: CollaborationContinueRequest,
  context: ContinueSubmissionContext,
): Promise<CollaborationContinueStatus> {
  if (!input.message.trim() || input.message.trimStart().startsWith('/')) return 'rejected';
  context.assertCurrent();
  const images: CoworkAttachmentPayload[] = [];
  const media: string[] = [];
  for (const path of input.attachmentPaths ?? []) {
    context.assertCurrent();
    if (isLocalAudioAttachment(path)) {
      const staged = await context.stageAudio(path, context.cwd);
      context.assertCurrent();
      if (!staged.success || !staged.path)
        throw new Error(staged.error || 'collaborationContinuationUnavailable');
      media.push(staged.path);
    } else if (isImagePath(path)) {
      if (!context.supportsImages()) throw new Error('imageInputNotSupported');
      const read = await context.readImage(path);
      context.assertCurrent();
      const match = read.success && read.dataUrl?.match(/^data:([^;]+);base64,([\s\S]+)$/);
      if (!match) throw new Error(read.error || 'collaborationContinuationUnavailable');
      images.push({
        name: path.split(/[\\/]/).pop() ?? path,
        mimeType: match[1],
        base64Data: match[2],
      });
    } else media.push(path);
  }
  const display = [
    input.message,
    ...media.map(path => `MEDIA:${path.replace(/[\r\n]/g, '')}`),
  ].join('\n');
  const gateway = appendCollaborationContinuation(display, context.target);
  context.assertCurrent();
  await context.beforeSubmit();
  context.assertCurrent();
  const accepted = await context.submit(
    display,
    images,
    gateway,
    `justdo-continue-${input.requestId}`,
  );
  if (context.outcomeUnknown()) return 'unknown';
  return accepted ? 'source_accepted' : 'rejected';
}
