import crypto from 'crypto';

import { PREDEFINED_OUTBOUND_HEADER_POLICY_CONFIG } from '../../../config/outboundHeaders';
import type { InstalledOpenClawExtension } from '../../../shared/openclaw/extensions';
import {
  type ExtensionNetworkPolicyInspection,
  inspectExtensionNetworkPolicyManifest,
} from '../../plugins/extensions/extensionNetworkPolicyManifest';
import {
  activateOutboundHeaderPolicyConfig,
  type OutboundHeaderPolicyConfig,
  readOutboundHeaderPolicyConfig,
  resolveOutboundHeaderPolicyConfigPath,
} from './outboundHeaderPolicyConfig';

export type EffectiveOutboundHeaderPolicySnapshot = OutboundHeaderPolicyConfig & {
  digest: string;
};

const digestPolicy = (policy: Pick<OutboundHeaderPolicyConfig, 'enabled' | 'groups'>): string =>
  crypto.createHash('sha256').update(JSON.stringify(policy)).digest('hex');

export class OutboundHeaderPolicyService {
  private snapshot: EffectiveOutboundHeaderPolicySnapshot | null = null;

  constructor(
    private readonly deps: {
      listInstalledExtensions: () => InstalledOpenClawExtension[];
      configPath?: string;
      userInfoPath?: string;
    },
  ) {}

  inspectExtension(extensionRoot: string): ExtensionNetworkPolicyInspection | null {
    return inspectExtensionNetworkPolicyManifest(extensionRoot);
  }

  reconcile(): EffectiveOutboundHeaderPolicySnapshot {
    const manual = readOutboundHeaderPolicyConfig(
      this.deps.configPath ?? resolveOutboundHeaderPolicyConfigPath(),
    );
    const defaultGroups = PREDEFINED_OUTBOUND_HEADER_POLICY_CONFIG.groups;
    // Existing installations may have the former generated default in config.json.
    const manualGroups = manual.groups.filter(group =>
      !defaultGroups.some(builtIn => JSON.stringify(builtIn) === JSON.stringify(group)),
    );
    const groups = manual.enabled
      ? [...defaultGroups, ...manualGroups].map(group => ({
          baseUrlWhitelist: [...group.baseUrlWhitelist],
          headerNames: [...group.headerNames],
        }))
      : [];

    let installedExtensions: InstalledOpenClawExtension[] = [];
    try {
      installedExtensions = this.deps
        .listInstalledExtensions()
        .filter(candidate => candidate.installPath)
        .sort((left, right) => left.id.localeCompare(right.id));
    } catch (error) {
      console.warn(
        '[OutboundHeaderPolicyService] Failed to read Extension inventory; excluding all Extension contributions:',
        error instanceof Error ? error.message : String(error),
      );
    }

    for (const extension of installedExtensions) {
      let inspection: ExtensionNetworkPolicyInspection | null;
      try {
        inspection = this.inspectExtension(extension.installPath!);
      } catch (error) {
        console.warn(
          `[OutboundHeaderPolicyService] Ignored invalid network policy for extension=${extension.id}:`,
          error instanceof Error ? error.message : String(error),
        );
        continue;
      }
      if (!inspection) continue;
      if (!manual.enabled || !extension.enabled) {
        continue;
      }
      for (const group of inspection.manifest.groups) {
        groups.push({
          baseUrlWhitelist: [...group.baseUrlWhitelist],
          headerNames: [...group.headerNames],
        });
      }
    }

    const normalized = {
      enabled: groups.length > 0,
      groups,
    } satisfies OutboundHeaderPolicyConfig;
    const digest = digestPolicy(normalized);
    const snapshot: EffectiveOutboundHeaderPolicySnapshot = Object.freeze({
      enabled: normalized.enabled,
      groups: Object.freeze(
        normalized.groups.map(group =>
          Object.freeze({
            baseUrlWhitelist: Object.freeze([...group.baseUrlWhitelist]),
            headerNames: Object.freeze([...group.headerNames]),
          }),
        ),
      ),
      digest,
    });
    activateOutboundHeaderPolicyConfig(snapshot, this.deps.userInfoPath);
    this.snapshot = snapshot;
    console.log(`[OutboundHeaderPolicyService] Activated groups=${snapshot.groups.length}`);
    return snapshot;
  }

  getSnapshot(): EffectiveOutboundHeaderPolicySnapshot {
    return this.snapshot ?? this.reconcile();
  }
}
