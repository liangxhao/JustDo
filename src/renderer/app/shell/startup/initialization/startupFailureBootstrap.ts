import {
  captureStartupFailure,
  type StartupFailure,
  StartupFailureSource,
  startupFailureText,
} from '../../../../../shared/app/startupFailure';

declare global {
  interface Window {
    startupDiagnostics?: { failure?: StartupFailure; fail: (error: unknown) => void };
  }
}

/** Bundled into the trusted HTML, independent of React, application chunks and preload. */
export function install(copy: Record<string, string>): void {
  const startup = document.getElementById('startup-document');
  if (!startup) return;
  const detail = document.getElementById('startup-failure-detail');
  const copyButton = document.getElementById('startup-copy-diagnostics');
  const capture = {
    failure: undefined as StartupFailure | undefined,
    fail(error: unknown) {
      if (!startup.isConnected || capture.failure) return;
      capture.failure = captureStartupFailure(StartupFailureSource.Renderer, error, {
        activity: startup.dataset.activity || 'document',
      });
      startup.dataset.failed = 'true';
      document.getElementById('startup-document-error')!.hidden = false;
      (startup.querySelector('[data-bootstrap-progress]') as HTMLElement).hidden = true;
      if (detail) detail.textContent = startupFailureText(capture.failure);
    },
  };
  window.startupDiagnostics = capture;
  const onError = (event: Event) => {
    if (!(event.target instanceof Element)) {
      const error = event as ErrorEvent;
      capture.fail(error.error ?? error.message ?? 'Unknown error');
    } else if (
      event.target instanceof HTMLScriptElement ||
      event.target instanceof HTMLLinkElement
    ) {
      const target = event.target;
      capture.fail({
        message: 'Failed to load application resource',
        stack: target instanceof HTMLScriptElement ? target.src : target.href,
      });
    }
  };
  const onRejection = (event: PromiseRejectionEvent) => capture.fail(event.reason);
  const onCopy = async () => {
    if (!capture.failure) return;
    try {
      await navigator.clipboard.writeText(startupFailureText(capture.failure));
      if (copyButton) copyButton.textContent = copy.startupDiagnosticsCopied;
    } catch {
      if (copyButton) copyButton.textContent = copy.startupDiagnosticsCopyFailed;
    }
  };
  copyButton?.addEventListener('click', onCopy);
  window.addEventListener('error', onError, true);
  window.addEventListener('unhandledrejection', onRejection);
  const observer = new MutationObserver(() => {
    if (startup.isConnected) return;
    window.removeEventListener('error', onError, true);
    window.removeEventListener('unhandledrejection', onRejection);
    copyButton?.removeEventListener('click', onCopy);
    observer.disconnect();
  });
  observer.observe(document.getElementById('root')!, { childList: true });
}
