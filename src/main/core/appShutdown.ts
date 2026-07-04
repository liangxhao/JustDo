import { app } from 'electron';

type AppShutdownOptions = {
  cleanup: () => Promise<void>;
};

export type AppShutdownController = {
  isQuitting: () => boolean;
};

export const registerAppShutdown = ({
  cleanup,
}: AppShutdownOptions): AppShutdownController => {
  let cleanupFinished = false;
  let cleanupInProgress = false;
  let quitting = false;

  const beginCleanup = (context: string): void => {
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
        app.exit(0);
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
  };
};
