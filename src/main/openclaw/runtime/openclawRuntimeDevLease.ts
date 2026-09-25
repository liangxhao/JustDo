import path from 'node:path';

type RuntimeDevLeaseModule = {
  acquireRuntimeDevLease: (runtimeBaseDir: string) => () => void;
  resolveRuntimeDevLeaseDir: (repoRoot: string) => string;
};

type AcquireOpenClawRuntimeDevLeaseOptions = {
  appPath: string;
  isPackaged: boolean;
  loadLeaseModule?: (modulePath: string) => RuntimeDevLeaseModule;
};

export const acquireOpenClawRuntimeDevLease = ({
  appPath,
  isPackaged,
  loadLeaseModule = modulePath => require(modulePath) as RuntimeDevLeaseModule,
}: AcquireOpenClawRuntimeDevLeaseOptions): (() => void) => {
  if (isPackaged) return () => {};

  const repoRoot = path.resolve(appPath);
  const modulePath = path.join(repoRoot, 'scripts', 'openclaw', 'openclaw-runtime-dev-lease.cjs');
  const leaseModule = loadLeaseModule(modulePath);
  return leaseModule.acquireRuntimeDevLease(leaseModule.resolveRuntimeDevLeaseDir(repoRoot));
};
