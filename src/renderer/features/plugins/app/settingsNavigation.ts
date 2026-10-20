import type { AppSettingsNavigationRequest } from '../../../../../packages/app-plugin-sdk/application';

export type { AppSettingsNavigationRequest } from '../../../../../packages/app-plugin-sdk/application';

export const APP_PLUGIN_SHOW_SETTINGS_EVENT = 'app-plugin:show-settings';

/** App keeps ownership of settings; plugins request only the declared destination. */
export function requestAppSettings(options: AppSettingsNavigationRequest): void {
  if (options?.initialTab !== 'runtime') return;
  window.dispatchEvent(
    new CustomEvent<AppSettingsNavigationRequest>(APP_PLUGIN_SHOW_SETTINGS_EVENT, {
      detail: { initialTab: options.initialTab },
    }),
  );
}
