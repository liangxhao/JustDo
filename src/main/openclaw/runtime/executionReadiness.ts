import { t } from '../../core/i18n';
import type { OpenClawEngineManager, OpenClawEngineStatus } from './openclawEngineManager';

type ExecutionReadinessDependencies = {
  manager: Pick<OpenClawEngineManager, 'getStatus' | 'setExternalError'>;
  startWithPermissionPolicy: () => Promise<OpenClawEngineStatus>;
  verifyPermissionPolicy: () => Promise<{
    success: boolean;
    status?: OpenClawEngineStatus;
    error?: string;
  }>;
};

// Configuration is published by startup/settings mutations. Sending only joins
// process readiness (including the cold-start approval floor) and verifies the
// already active execution boundary on a running process.
export async function ensureExecutionReady({
  manager,
  startWithPermissionPolicy,
  verifyPermissionPolicy,
}: ExecutionReadinessDependencies): Promise<OpenClawEngineStatus> {
  const current = manager.getStatus();
  if (current.phase !== 'running') return startWithPermissionPolicy();

  const verification = await verifyPermissionPolicy();
  if (verification.success) return manager.getStatus();
  if ((verification.status ?? manager.getStatus()).phase === 'running')
    throw new Error(verification.error || t('enginePreparationFailed'));
  return verification.status ?? manager.setExternalError(
    verification.error || 'The active Gateway permission policy is unavailable.',
  );
}
