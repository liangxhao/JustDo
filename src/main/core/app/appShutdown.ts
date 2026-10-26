import { app } from 'electron';

import { SHUTDOWN_BUDGET_MS } from '../../../shared/app/shutdownPolicy';

type AppShutdownOptions = {
  cleanup: () => Promise<void>;
  cleanupTimeoutMs?: number;
  onCleanupTimeout?: () => Promise<void>;
  onBeginCleanup?: () => void;
};

export type AppShutdownController = {
  isQuitting: () => boolean;
  quitAndInstall: (installUpdate: () => void) => void;
};

export const registerAppShutdown = ({
  cleanup,
  cleanupTimeoutMs,
  onCleanupTimeout,
  onBeginCleanup,
}: AppShutdownOptions): AppShutdownController => {
  let cleanupFinished = false;
  let cleanupInProgress = false;
  let quitting = false;

  const beginCleanup = (context: string, afterCleanup?: () => void): void => {
    if (cleanupFinished || cleanupInProgress) return;

    cleanupInProgress = true;
    quitting = true;
    try { onBeginCleanup?.(); }
    catch (error) { console.error('[Main] Failed to retire shutdown presentation:', error); }
    console.log(`[Main] ${context}, running cleanup before exit...`);
    let timedOut = false;
    let cleanupFailed = false;
    let exitRequested = false;
    const exit = (code: number): void => {
      if (exitRequested) return;
      exitRequested = true;
      app.exit(code);
    };

    const timeout =
      cleanupTimeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            console.error('[Main] Application cleanup timed out; resource retirement remains unconfirmed.');
            const forceExit = setTimeout(() => exit(1), SHUTDOWN_BUDGET_MS.forceExitObservation);
            forceExit.unref();
            void Promise.resolve()
              .then(onCleanupTimeout)
              .catch(error => console.error('[Main] Emergency runtime cleanup failed:', error))
              .finally(() => {
                clearTimeout(forceExit);
                exit(1);
              });
          }, cleanupTimeoutMs);
    timeout?.unref();

    void Promise.resolve()
      .then(cleanup)
      .catch(error => {
        cleanupFailed = true;
        console.error(`[Main] Cleanup error (${context}):`, error);
      })
      .finally(() => {
        clearTimeout(timeout);
        if (timedOut) return;
        if (cleanupFailed) {
          exit(1);
          return;
        }
        cleanupFinished = true;
        cleanupInProgress = false;
        if (!afterCleanup) {
          exit(0);
          return;
        }
        try {
          afterCleanup();
        } catch (error) {
          console.error('[Main] Failed to launch downloaded update:', error);
          exit(1);
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
