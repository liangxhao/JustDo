const APP_SERVER_SHUTDOWN_WAIT_MS = 5_000;

/** Bound application teardown, without cancelling or settling the owned drain. */
export async function waitForAppServerShutdown(
  stopping: Promise<void> | undefined,
  timeoutMs = APP_SERVER_SHUTDOWN_WAIT_MS,
): Promise<boolean> {
  if (!stopping) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      stopping.then(() => true, () => false),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
