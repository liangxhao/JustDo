import { OpenClawExtensionId } from '../../../../shared/plugins/nativeIds';
import { LOCAL_TTS_PROVIDER_ID } from '../../../../shared/speech/localTts';

/** Refresh runtime parameters without choosing whether a speech extension is enabled. */
export function buildManagedLocalSpeechPluginEntries(
  sttConfig: Record<string, unknown> | null,
  isAvailable: (id: string) => boolean,
): Record<string, Record<string, unknown>> {
  return {
    ...(isAvailable(OpenClawExtensionId.STT_LOCAL_CLI)
      ? { [OpenClawExtensionId.STT_LOCAL_CLI]: { config: sttConfig ?? {} } }
      : {}),
    // Native defaults apply only within the existing allow/deny policy.
    ...(isAvailable(LOCAL_TTS_PROVIDER_ID) ? { [LOCAL_TTS_PROVIDER_ID]: {} } : {}),
  };
}
