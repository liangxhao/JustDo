export const OPEN_SPEECH_SETTINGS_EVENT = 'speech-settings:open';
export const SPEECH_SURFACE_HIDDEN_EVENT = 'speech-surface:hidden';

export function requestSpeechSettings(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SPEECH_SETTINGS_EVENT));
}
