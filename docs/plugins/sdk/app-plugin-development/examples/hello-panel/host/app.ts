import type { AppMainHost, AppMainRegistration } from '@app-plugin/sdk/main';

export function register(host: AppMainHost): AppMainRegistration {
  return {
    commands: [
      {
        id: 'info.read',
        invoke: () => {
          host.assertActive();
          return { id: host.manifest.id, version: host.manifest.version };
        },
      },
    ],
  };
}
