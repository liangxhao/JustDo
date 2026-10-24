export const StartupCompatibilityErrorCode = {
  DowngradeBlocked: 'STARTUP_DOWNGRADE_BLOCKED',
  VersionUnconfirmed: 'STARTUP_VERSION_UNCONFIRMED',
  NativeSchemaUnsupported: 'STARTUP_NATIVE_SCHEMA_UNSUPPORTED',
} as const;
export type StartupCompatibilityErrorCode =
  (typeof StartupCompatibilityErrorCode)[keyof typeof StartupCompatibilityErrorCode];

export type StartupDeliveryIdentity = {
  appVersion: string;
  runtimeVersion: string;
  runtimeBuildId: string;
};
export type DeclaredDowngradeCompatibility = {
  evidenceId: string;
  source: StartupDeliveryIdentity;
  target: StartupDeliveryIdentity;
};

// A future exception needs an exact delivery pair, documented data compatibility,
// independent review and real target-native inspection. No exception is active today.
export const DECLARED_DOWNGRADE_COMPATIBILITY: readonly DeclaredDowngradeCompatibility[] = [];

type Direction = 'adoption' | 'same' | 'upgrade' | 'build-change' | 'declared-downgrade';
export type StartupDeliveryAssessment =
  | { allowed: true; direction: Direction }
  | { allowed: false; blockReason: StartupCompatibilityErrorCode; requiresNativeInspection?: true };

function parseStableVersion(value: string): readonly number[] | null {
  if (typeof value !== 'string' || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
    return null;
  const parts = value.replace(/^v/, '').split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function comparableIdentity(value: StartupDeliveryIdentity): boolean {
  return !!value && !!parseStableVersion(value.appVersion) && !!parseStableVersion(value.runtimeVersion) &&
    typeof value.runtimeBuildId === 'string' && /^[a-f0-9]{64}$/.test(value.runtimeBuildId);
}

function compare(source: string, target: string): number {
  const left = parseStableVersion(source)!;
  const right = parseStableVersion(target)!;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return right[index] > left[index] ? 1 : -1;
  }
  return 0;
}

function exactIdentity(left: StartupDeliveryIdentity, right: StartupDeliveryIdentity): boolean {
  return left.appVersion === right.appVersion && left.runtimeVersion === right.runtimeVersion &&
    left.runtimeBuildId === right.runtimeBuildId;
}

/** Delivery ordering never grants native schema authority; its version contract and inspection do. */
export function assessStartupDelivery(options: {
  source?: StartupDeliveryIdentity;
  target: StartupDeliveryIdentity;
  declaredDowngrades?: readonly DeclaredDowngradeCompatibility[];
  nativeCompatibilityConfirmed?: boolean;
}): StartupDeliveryAssessment {
  const { source, target } = options;
  if (!comparableIdentity(target) || (source !== undefined && !comparableIdentity(source)))
    return { allowed: false, blockReason: StartupCompatibilityErrorCode.VersionUnconfirmed };
  if (!source) return { allowed: true, direction: 'adoption' };
  const app = compare(source.appVersion, target.appVersion);
  const runtime = compare(source.runtimeVersion, target.runtimeVersion);
  if (app < 0 || runtime < 0) {
    const declaration = (options.declaredDowngrades ?? DECLARED_DOWNGRADE_COMPATIBILITY)
      .find(item => typeof item.evidenceId === 'string' && !!item.evidenceId.trim() &&
        comparableIdentity(item.source) && comparableIdentity(item.target) &&
        exactIdentity(item.source, source) && exactIdentity(item.target, target));
    if (!declaration)
      return { allowed: false, blockReason: StartupCompatibilityErrorCode.DowngradeBlocked };
    if (options.nativeCompatibilityConfirmed === undefined)
      return { allowed: false, blockReason: StartupCompatibilityErrorCode.VersionUnconfirmed,
        requiresNativeInspection: true };
    if (!options.nativeCompatibilityConfirmed)
      return { allowed: false, blockReason: StartupCompatibilityErrorCode.NativeSchemaUnsupported };
    return { allowed: true, direction: 'declared-downgrade' };
  }
  if (app > 0 || runtime > 0) return { allowed: true, direction: 'upgrade' };
  return { allowed: true, direction: source.runtimeBuildId === target.runtimeBuildId ? 'same' : 'build-change' };
}
