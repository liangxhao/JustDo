import { OPEN_SPEECH_SETTINGS_EVENT } from '@shared/speech/speechSettingsNavigation';

export function requestSpeechSettings(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SPEECH_SETTINGS_EVENT));
}
