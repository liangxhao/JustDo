import type { OpenClawEngineManager, OpenClawEngineStatus } from './openclawEngineManager';

type ExecutionReadinessDependencies = {
  manager: Pick<OpenClawEngineManager, 'getStatus' | 'startGateway' | 'setExternalError'>;
  verifyPermissionPolicy: () => Promise<{
    success: boolean;
    status?: OpenClawEngineStatus;
    error?: string;
  }>;
};

// Configuration is published by startup/settings mutations. Sending only joins
// process readiness and verifies the already active execution boundary.
export async function ensureExecutionReady({
  manager,
  verifyPermissionPolicy,
}: ExecutionReadinessDependencies): Promise<OpenClawEngineStatus> {
  const current = manager.getStatus();
  const status = current.phase === 'running' ? current : await manager.startGateway();
  if (status.phase !== 'running') return status;

  const verification = await verifyPermissionPolicy();
  if (verification.success) return manager.getStatus();
  return verification.status ?? manager.setExternalError(
    verification.error || 'The active Gateway permission policy is unavailable.',
  );
}
