export const BrowserLinkTarget = {
  Embedded: 'embedded',
  Chrome: 'chrome',
} as const;

export type BrowserLinkTarget = (typeof BrowserLinkTarget)[keyof typeof BrowserLinkTarget];

export const normalizeBrowserLinkTarget = (
  value: unknown,
  fallback: BrowserLinkTarget,
): BrowserLinkTarget =>
  value === BrowserLinkTarget.Embedded || value === BrowserLinkTarget.Chrome ? value : fallback;

export const isWebBrowserLink = (value: unknown): value is string => {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

export interface LocalHtmlLink {
  filePath: string;
  navigationSuffix: string;
}

/** Validates an already decoded native path without interpreting percent signs again. */
export const isLocalHtmlFilePath = (value: string): boolean => {
  if (/[\u0000-\u001f\u007f]/u.test(value)) return false;
  if (/^file:/iu.test(value)) {
    try {
      const url = new URL(value);
      const pathname = decodeURIComponent(url.pathname);
      return (
        !url.hostname &&
        !url.search &&
        !url.hash &&
        !/[\u0000-\u001f\u007f]/u.test(pathname) &&
        /\.(?:html?|xhtml)$/iu.test(pathname)
      );
    } catch {
      return false;
    }
  }
  if (/^[a-z][a-z\d+.-]*:/iu.test(value) && !/^[a-z]:[\\/]/iu.test(value)) return false;
  return /\.(?:html?|xhtml)$/iu.test(value);
};

/** Separates URL navigation from the file lookup and decodes the path exactly once. */
export const parseLocalHtmlLink = (value: string): LocalHtmlLink | null => {
  if (/[\u0000-\u001f\u007f]/u.test(value)) return null;
  if (/^file:/iu.test(value)) {
    try {
      const url = new URL(value);
      const navigationSuffix = url.search + url.hash;
      url.search = '';
      url.hash = '';
      return isLocalHtmlFilePath(url.href) ? { filePath: url.href, navigationSuffix } : null;
    } catch {
      return null;
    }
  }
  try {
    const match = value.match(/^(.*?\.(?:html?|xhtml))([?#].*)?$/iu);
    if (!match) return null;
    const filePath = decodeURIComponent(match[1]);
    return isLocalHtmlFilePath(filePath) ? { filePath, navigationSuffix: match[2] ?? '' } : null;
  } catch {
    return null;
  }
};
