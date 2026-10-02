import { app } from 'electron';

type AppShutdownOptions = {
  cleanup: () => Promise<void>;
  cleanupTimeoutMs?: number;
  onCleanupTimeout?: () => Promise<void>;
};

export type AppShutdownController = {
  isQuitting: () => boolean;
  quitAndInstall: (installUpdate: () => void) => void;
};

export const registerAppShutdown = ({
  cleanup,
  cleanupTimeoutMs,
  onCleanupTimeout,
}: AppShutdownOptions): AppShutdownController => {
  let cleanupFinished = false;
  let cleanupInProgress = false;
  let quitting = false;

  const beginCleanup = (context: string, afterCleanup?: () => void): void => {
    if (cleanupFinished || cleanupInProgress) return;

    cleanupInProgress = true;
    quitting = true;
    console.log(`[Main] ${context}, running cleanup before exit...`);
    let timedOut = false;

    const timeout =
      cleanupTimeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            console.error('[Main] Development cleanup timed out; stopping runtime before exit.');
            // Gateway shutdown has its own 16s deadline. Still bound the fallback
            // in case another cleanup implementation fails to settle.
            const forceExit = setTimeout(() => app.exit(1), 17_000);
            forceExit.unref();
            void Promise.resolve()
              .then(onCleanupTimeout)
              .catch(error => console.error('[Main] Emergency runtime cleanup failed:', error))
              .finally(() => {
                clearTimeout(forceExit);
                app.exit(1);
              });
          }, cleanupTimeoutMs);
    timeout?.unref();

    void Promise.resolve()
      .then(cleanup)
      .catch(error => {
        console.error(`[Main] Cleanup error (${context}):`, error);
      })
      .finally(() => {
        clearTimeout(timeout);
        if (timedOut) return;
        cleanupFinished = true;
        cleanupInProgress = false;
        if (!afterCleanup) {
          app.exit(0);
          return;
        }
        try {
          afterCleanup();
        } catch (error) {
          console.error('[Main] Failed to launch downloaded update:', error);
          app.exit(1);
        }
      });
  };

  app.on('before-quit', event => {
    if (cleanupFinished) return;
    event.preventDefault();
    beginCleanup('App is quitting');
  });

  process.once('SIGINT', () => beginCleanup('Received SIGINT'));
  process.once('SIGTERM', () => beginCleanup('Received SIGTERM'));

  return {
    isQuitting: () => quitting,
    quitAndInstall: installUpdate => beginCleanup('Installing downloaded update', installUpdate),
  };
};
