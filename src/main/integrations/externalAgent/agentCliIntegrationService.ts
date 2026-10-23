import fs from 'node:fs';

import type { AgentCliIntegrationStatus } from '../../../shared/integrations/agentCliIntegration';

interface Options {
  getBridgeState: () => { running: boolean; activeTaskCount: number };
  getGatewayPhase: () => string;
  prepareLauncher: () => { command: string; path: string };
}

/** Availability is derived from the installed launcher and the desktop lifecycle. */
export class AgentCliIntegrationService {
  private launcher: { command: string; path: string } | undefined;
  constructor(private readonly options: Options) {}

  prepare(): void {
    this.launcher = undefined;
    this.launcher = this.options.prepareLauncher();
  }

  getStatus(): AgentCliIntegrationStatus {
    const bridge = this.options.getBridgeState();
    return {
      supported: ['win32', 'darwin', 'linux'].includes(process.platform),
      command: this.launcher?.command ?? '',
      launcherReady: Boolean(
        this.launcher?.path && fs.statSync(this.launcher.path, { throwIfNoEntry: false })?.isFile(),
      ),
      bridgeRunning: bridge.running,
      activeTaskCount: bridge.activeTaskCount,
      gatewayPhase: this.options.getGatewayPhase(),
    };
  }
}
