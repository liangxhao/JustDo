import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';

import { defaultLocalSpeechSettings } from '../../../shared/speech/localSpeechSettings';
import {
  type BuiltinSpeechPreviewResult,
  isBuiltinSpeechPreviewRequestId,
  parseBuiltinSpeechPreviewRequest,
  SpeechSynthesisIpc,
} from '../../../shared/speech/speechSynthesis';
import { getLocalTtsStatus } from '../../openclaw/config/speech/localTtsConfig';
import { synthesizeLocalSpeech } from '../../speech/localTtsService';

interface PreviewInvocation {
  requestId: string;
  controller: AbortController;
  settled: Promise<void>;
  revoke: () => void;
}

function requirePreviewOwner(event: IpcMainInvokeEvent): WebContents {
  const owner = event.sender;
  if (owner.isDestroyed() || owner.getType() !== 'window' || event.senderFrame !== owner.mainFrame)
    throw new Error('Speech preview requires an application window frame.');
  return owner;
}

export function registerBuiltinSpeechPreviewHandlers(): void {
  const active = new WeakMap<WebContents, PreviewInvocation>();
  ipcMain.handle(
    SpeechSynthesisIpc.PreviewBuiltin,
    async (event, value: unknown): Promise<BuiltinSpeechPreviewResult> => {
      const owner = requirePreviewOwner(event);
      const request = parseBuiltinSpeechPreviewRequest(value);
      if (!getLocalTtsStatus(request.modelId).available)
        throw new Error('The builtin speech model is not installed.');
      const previous = active.get(owner);
      previous?.revoke();
      const frame = event.senderFrame;
      const controller = new AbortController();
      const detach = () => {
        owner.removeListener('destroyed', revoke);
        owner.removeListener('did-navigate', revoke);
        owner.removeListener('render-process-gone', revoke);
      };
      const revoke = () => {
        controller.abort();
        detach();
      };
      let markSettled!: () => void;
      const invocation: PreviewInvocation = {
        requestId: request.requestId,
        controller,
        revoke,
        settled: new Promise(resolve => {
          markSettled = resolve;
        }),
      };
      const assertCurrent = () => {
        if (
          controller.signal.aborted ||
          active.get(owner) !== invocation ||
          owner.isDestroyed() ||
          owner.mainFrame !== frame
        )
          throw new Error('Builtin speech preview was cancelled.');
      };
      active.set(owner, invocation);
      owner.once('destroyed', revoke);
      owner.once('did-navigate', revoke);
      owner.once('render-process-gone', revoke);
      try {
        if (previous) await previous.settled;
        assertCurrent();
        if (!getLocalTtsStatus(request.modelId).available)
          throw new Error('The builtin speech model is not installed.');
        const result = await synthesizeLocalSpeech(
          request.text,
          {
            ...defaultLocalSpeechSettings,
            outputEnabled: true,
            synthesisMode: 'local',
            ttsModelId: request.modelId,
            voiceId: request.voiceId,
          },
          { signal: controller.signal },
        );
        assertCurrent();
        if (!getLocalTtsStatus(request.modelId).available)
          throw new Error('The builtin speech model is no longer installed.');
        return { ...result, requestId: request.requestId };
      } finally {
        detach();
        if (active.get(owner) === invocation) active.delete(owner);
        markSettled();
      }
    },
  );
  ipcMain.handle(SpeechSynthesisIpc.CancelBuiltinPreview, (event, requestId: unknown): void => {
    const owner = requirePreviewOwner(event);
    if (!isBuiltinSpeechPreviewRequestId(requestId))
      throw new Error('Invalid speech preview request.');
    const invocation = active.get(owner);
    if (invocation?.requestId === requestId) invocation.revoke();
  });
}
