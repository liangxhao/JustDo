export interface WorkflowGatewayClient {
  request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T>;
}

/** Live capabilities supplied by the application; no controller or SDK implementation imports. */
export interface WorkflowHostRuntime {
  getGatewayClient(): WorkflowGatewayClient | null;
  getSessionKeysForSession(sessionId: string): string[];
  getPlanMode(sessionId: string): Promise<{ enabled: boolean }>;
}
export interface SwarmWorkflowDependencies {
  getRuntime: () => WorkflowHostRuntime | null;
  hasSession: (sessionId: string) => boolean;
}
