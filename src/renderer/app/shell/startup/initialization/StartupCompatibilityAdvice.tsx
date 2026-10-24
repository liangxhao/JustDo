import { StartupCompatibilityErrorCode } from '@shared/app/startup/versionPolicy';

import { i18nService } from '@/services/i18n';

const messageKeys: Record<string, string> = {
  [StartupCompatibilityErrorCode.VersionUnconfirmed]: 'startupCompatibilityUnknown',
  [StartupCompatibilityErrorCode.NativeSchemaUnsupported]: 'startupCompatibilitySchema',
};

export function hasStartupCompatibilityAdvice(code?: string): boolean {
  return code !== undefined && Object.prototype.hasOwnProperty.call(messageKeys, code);
}

/** Main owns admission; this explanation cannot override the blocked startup. */
export default function StartupCompatibilityAdvice({ code }: { code?: string }) {
  if (!hasStartupCompatibilityAdvice(code)) return null;
  const key = messageKeys[code!];
  return (
    <div
      role="alert"
      className="rounded-xl border border-border bg-surface-raised p-4 text-sm text-foreground"
    >
      <h3 className="mb-2 font-semibold">{i18nService.t(key)}</h3>
      <p className="text-secondary">{i18nService.t(`${key}Description`)}</p>
    </div>
  );
}
