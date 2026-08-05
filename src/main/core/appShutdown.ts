import { app } from 'electron';

type AppShutdownOptions = {
  cleanup: () => Promise<void>;
};

export type AppShutdownController = {
  isQuitting: () => boolean;
  quitAndInstall: (installUpdate: () => void) => void;
};

export const registerAppShutdown = ({ cleanup }: AppShutdownOptions): AppShutdownController => {
  let cleanupFinished = false;
  let cleanupInProgress = false;
  let quitting = false;

  const beginCleanup = (context: string, afterCleanup?: () => void): void => {
    if (cleanupFinished || cleanupInProgress) return;

    cleanupInProgress = true;
    quitting = true;
    console.log(`[Main] ${context}, running cleanup before exit...`);

    void cleanup()
      .catch(error => {
        console.error(`[Main] Cleanup error (${context}):`, error);
      })
      .finally(() => {
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
