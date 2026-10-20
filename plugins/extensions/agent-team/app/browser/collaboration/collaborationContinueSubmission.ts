import type { CollaborationContinueTarget } from '../teamContracts';
import { isLocalAudioAttachment } from '../media';
import type { CoworkAttachmentPayload } from '@app-plugin/sdk/application';

import { isImagePath } from '../composer/composerAttachmentFiles';
import type {
  CollaborationContinueRequest,
  CollaborationContinueStatus,
} from './collaborationContinueDraft';
import { collaborationMemberTurnId } from './collaborationContinueDraft';

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
    target: CollaborationContinueTarget,
    message: string,
    images: CoworkAttachmentPayload[],
    clientTurnId: string,
  ) => Promise<CollaborationContinueStatus>;
}

/** A user turn for the selected member, independent of the source chat and its drafts. */
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
  context.assertCurrent();
  await context.beforeSubmit();
  context.assertCurrent();
  return context.submit(
    context.target,
    display,
    images,
    collaborationMemberTurnId(input.requestId),
  );
}
