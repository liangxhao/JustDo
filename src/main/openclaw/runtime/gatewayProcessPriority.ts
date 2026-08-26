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

export const lowerGatewayProcessPriority = (
  pid: number | null | undefined,
  platform: NodeJS.Platform = process.platform,
  setPriority?: SetProcessPriority,
): boolean =>
  setGatewayProcessPriority(
    pid,
    os.constants.priority.PRIORITY_BELOW_NORMAL,
    platform,
    setPriority,
  );

export const restoreGatewayProcessPriority = (
  pid: number | null | undefined,
  platform: NodeJS.Platform = process.platform,
  setPriority?: SetProcessPriority,
): boolean =>
  setGatewayProcessPriority(pid, os.constants.priority.PRIORITY_NORMAL, platform, setPriority);
