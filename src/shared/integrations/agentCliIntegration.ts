export const AgentCliIntegrationIpc = {
  GetStatus: 'agent-cli:status',
} as const;

export interface AgentCliIntegrationStatus {
  supported: boolean;
  command: string;
  launcherReady: boolean;
  bridgeRunning: boolean;
  activeTaskCount: number;
  gatewayPhase: string;
}
