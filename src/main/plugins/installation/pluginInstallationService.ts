import path from 'node:path';

import type { PluginKind } from '../../../shared/plugins/marketplace';
import { sanitizeInstallationFailureReason } from './installationFailureReason';
import {
  type PluginInstaller,
  PluginInstallOrigin,
  type PluginInstallRequest,
  type PluginInstallResult,
} from './types';

export class PluginInstallationService {
  private readonly installers = new Map<PluginKind, PluginInstaller>();

  registerInstaller(installer: PluginInstaller): void {
    if (this.installers.has(installer.kind)) {
      throw new Error(`Plugin installer already registered for ${installer.kind}`);
    }
    this.installers.set(installer.kind, installer);
  }

  async install(request: PluginInstallRequest): Promise<PluginInstallResult> {
    const installer = this.installers.get(request.payload.kind);
    if (!installer) {
      return {
        success: false,
        error: `No plugin installer registered for ${request.payload.kind}`,
      };
    }
    const result = await installer.install(request);
    if (result.success || request.origin !== PluginInstallOrigin.MARKETPLACE) return result;
    const sourcePath = 'sourcePath' in request.payload ? request.payload.sourcePath : undefined;
    return {
      ...result,
      publicReason: sanitizeInstallationFailureReason(result.error, [
        typeof sourcePath === 'string' && sourcePath ? path.resolve(sourcePath) : undefined,
        typeof result.installPath === 'string' && result.installPath
          ? path.resolve(result.installPath)
          : undefined,
      ]),
    };
  }
}
