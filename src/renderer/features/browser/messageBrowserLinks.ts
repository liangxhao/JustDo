import {
  BrowserLinkTarget,
  isWebBrowserLink,
  normalizeBrowserLinkTarget,
} from '@shared/browser/browserLinkOpening';

import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';

export const MessageBrowserEvent = {
  OpenWebUrl: 'cowork:open-web-url',
  OpenLocalHtml: 'cowork:open-local-html',
} as const;

export async function openMessageWebLink(url: string): Promise<void> {
  if (!isWebBrowserLink(url)) return;
  const target = normalizeBrowserLinkTarget(
    configService.getConfig().browserWebLinkTarget,
    BrowserLinkTarget.Chrome,
  );
  if (target === BrowserLinkTarget.Embedded) {
    window.dispatchEvent(new CustomEvent(MessageBrowserEvent.OpenWebUrl, { detail: { url } }));
    return;
  }
  try {
    const result = await window.electron.browser.openInChrome(url);
    if (result.success) return;
  } catch {
    // Report the same user-facing failure for a rejected IPC or a failed launch.
  }
  window.dispatchEvent(
    new CustomEvent('app:showToast', { detail: i18nService.t('browserLinkOpenFailed') }),
  );
}

export function openMessageHtmlLink(
  filePath: string,
  workingDirectory?: string,
  navigationSuffix?: string,
): void {
  window.dispatchEvent(
    new CustomEvent(MessageBrowserEvent.OpenLocalHtml, {
      detail: { filePath, workingDirectory, ...(navigationSuffix ? { navigationSuffix } : {}) },
    }),
  );
}
