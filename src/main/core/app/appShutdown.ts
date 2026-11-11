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
  quitForMaintenance: (afterCleanup: () => void, afterTimeout: () => void) => void;
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

  const beginCleanup = (context: string, afterCleanup?: () => void, afterTimeout?: () => void): void => {
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

    const timeoutMs = afterTimeout ? SHUTDOWN_BUDGET_MS.storageRelocationGrace : cleanupTimeoutMs;
    const timeout =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            if (afterTimeout) {
              console.warn('[Main] Storage relocation shutdown timed out; stopping the old process tree.');
              try { afterTimeout(); }
              catch (error) { console.error('[Main] Storage relocation forced handoff failed: ' +
                JSON.stringify(error instanceof Error ? error.message.slice(0, 400) : 'Unknown error')); }
              exit(1);
              return;
            }
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
          }, timeoutMs);
    timeout?.unref();

    void Promise.resolve()
      .then(cleanup)
      .catch(error => {
        cleanupFailed = true;
        console.error(`[Main] Cleanup error (${context}):`, error);
      })
      .finally(() => {
        if (timedOut || (cleanupFailed && afterTimeout)) return;
        clearTimeout(timeout);
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
    quitForMaintenance: (afterCleanup, afterTimeout) =>
      beginCleanup('Preparing offline storage maintenance', () => {
        afterCleanup();
        app.exit(0);
      }, afterTimeout),
  };
};
