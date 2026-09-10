import os from 'os';

type SetProcessPriority = (pid: number, priority: number) => void;

const setGatewayProcessPriority = (
  pid: number | null | undefined,
  priority: number,
  platform: NodeJS.Platform,
  setPriority: SetProcessPriority = (processId, priority) =>
    os.setPriority(processId, priority),
): boolean => {
  if (platform !== 'win32' || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    setPriority(pid, priority);
    return true;
  } catch {
    // Priority changes are best-effort and may be denied by the operating system.
    return false;
  }
};

export const ensureGatewayStartupPriority = (
  pid: number | null | undefined,
  platform: NodeJS.Platform = process.platform,
  setPriority?: SetProcessPriority,
): boolean =>
  setGatewayProcessPriority(
    pid,
    // Gateway startup is dominated by ESM loading, compile-cache I/O, and
    // short-lived Windows helper processes. BELOW_NORMAL can starve all three
    // behind foreground work and turn an otherwise bounded cold start into a
    // minute-long one. Keep the child at normal priority from the outset.
    os.constants.priority.PRIORITY_NORMAL,
    platform,
    setPriority,
  );
