import type { PluginKind } from '../../../shared/plugins/marketplace';
import type { PluginInstaller, PluginInstallRequest, PluginInstallResult } from './types';

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
    return installer.install(request);
  }
}
