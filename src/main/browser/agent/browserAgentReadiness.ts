/** Finish the guest's initial document before starting a competing navigation. */
export async function waitForBrowserGuestReady(
  guest: Electron.WebContents,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (guest.isDestroyed()) throw new Error('The browser page is no longer available.');
  if (guest.getURL() && !guest.isLoadingMainFrame()) return;

  // A newly attached webview is still loading its bootstrap about:blank.
  // Electron loadURL can resolve on that older document's did-finish-load.
  // Keep early ownership registration, but await the initial did-stop-loading.
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      guest.removeListener('did-stop-loading', onReady);
      guest.removeListener('destroyed', onDestroyed);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onReady = () => {
      if (guest.isDestroyed() || !guest.getURL()) onDestroyed();
      else finish();
    };
    const onDestroyed = () => finish(new Error('The browser page is no longer available.'));
    const onAbort = () => finish(new Error('Browser request was cancelled.'));
    guest.once('did-stop-loading', onReady);
    guest.once('destroyed', onDestroyed);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
