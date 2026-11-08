import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';

import type { LocalAsrLanguage } from '../../../shared/speech/localAsr';
import type { LocalSpeechSettings } from '../../../shared/speech/localSpeechSettings';
import { OnlineAsrIpc, type OnlineAsrTranscribeResult } from '../../../shared/speech/onlineAsr';
import {
  getRecordedOnlineAsrSettingsKey,
  MAX_RECORDED_ASR_AUDIO_BYTES,
  resolveRecordedOnlineAsrProfile,
  transcribeRecordedOnlineAudio,
} from '../../speech/recordedOnlineAsrService';
import {
  getSpeechConfigurationRevision,
  onSpeechConfigurationChanged,
} from '../../speech/speechConfigurationRevision';

export interface RecordedOnlineAsrDependencies {
  getSettings: () => LocalSpeechSettings;
  getModelCategory: () => unknown;
}

const validRequestId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value);
const requireOwner = (event: IpcMainInvokeEvent): WebContents => {
  const owner = event.sender;
  if (owner.isDestroyed() || owner.getType() !== 'window' || event.senderFrame !== owner.mainFrame)
    throw new Error('Audio transcription requires an application window frame.');
  return owner;
};

export function registerRecordedOnlineAsrHandlers({
  getSettings,
  getModelCategory,
}: RecordedOnlineAsrDependencies): void {
  type Invocation = { requestId: string; revoke: () => void; settled: Promise<void> };
  const active = new WeakMap<WebContents, Invocation>();
  ipcMain.handle(
    OnlineAsrIpc.Transcribe,
    async (event, value: unknown): Promise<OnlineAsrTranscribeResult> => {
      const owner = requireOwner(event);
      const request = value as Record<string, unknown> | null;
      if (
        !request ||
        typeof request !== 'object' ||
        Array.isArray(request) ||
        Object.keys(request).some(key => !['requestId', 'audioWav', 'language'].includes(key)) ||
        !validRequestId(request.requestId) ||
        !(request.audioWav instanceof Uint8Array) ||
        request.audioWav.length < 44 ||
        request.audioWav.length > MAX_RECORDED_ASR_AUDIO_BYTES ||
        !['auto', 'zh', 'en', 'ja', 'ko', 'yue'].includes(String(request.language))
      )
        throw new Error('Invalid recorded transcription request.');
      const previous = active.get(owner);
      if (previous?.requestId === request.requestId)
        throw new Error('This transcription request is already active.');
      previous?.revoke();
      const controller = new AbortController();
      const frame = event.senderFrame;
      const configurationKey = getRecordedOnlineAsrSettingsKey(getSettings(), getModelCategory());
      const configurationRevision = getSpeechConfigurationRevision('input');
      const profile = resolveRecordedOnlineAsrProfile(getSettings(), getModelCategory());
      if (!profile) throw new Error('A recorded transcription interface is not configured.');
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
      const invocation: Invocation = {
        requestId: request.requestId,
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
          owner.mainFrame !== frame ||
          getSpeechConfigurationRevision('input') !== configurationRevision ||
          getRecordedOnlineAsrSettingsKey(getSettings(), getModelCategory()) !== configurationKey
        )
          throw new Error('Recorded transcription was cancelled or its configuration changed.');
      };
      const timeout = setTimeout(revoke, 120_000);
      active.set(owner, invocation);
      owner.once('destroyed', revoke);
      owner.once('did-navigate', revoke);
      owner.once('render-process-gone', revoke);
      const unsubscribeConfiguration = onSpeechConfigurationChanged('input', revoke);
      try {
        if (previous) await previous.settled;
        assertCurrent();
        const text = await transcribeRecordedOnlineAudio(
          profile,
          request.audioWav,
          request.language as LocalAsrLanguage,
          controller.signal,
          assertCurrent,
        );
        assertCurrent();
        return { requestId: request.requestId, text };
      } finally {
        clearTimeout(timeout);
        detach();
        unsubscribeConfiguration();
        if (active.get(owner) === invocation) active.delete(owner);
        markSettled();
      }
    },
  );
  ipcMain.handle(OnlineAsrIpc.CancelTranscription, (event, requestId: unknown): void => {
    const owner = requireOwner(event);
    if (!validRequestId(requestId)) throw new Error('Invalid transcription cancellation.');
    const invocation = active.get(owner);
    if (invocation?.requestId === requestId) invocation.revoke();
  });
}
