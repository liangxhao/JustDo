export const getBrowserLocalFilePath = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:' || /%(?:00|2f|5c)/iu.test(url.pathname)) return null;
    const pathname = decodeURIComponent(url.pathname);
    if (/[\u0000-\u001f\u007f]/u.test(pathname)) return null;
    if (url.hostname) return `\\\\${url.hostname}${pathname.replace(/\//gu, '\\')}`;
    return /^\/[a-z]:\//iu.test(pathname) ? pathname.slice(1).replace(/\//gu, '\\') : pathname;
  } catch {
    return null;
  }
};

// Former preview URLs contain a random 24-byte token, not a recoverable file path.
// Match only that retired shape; ordinary localhost development sites stay visible.
export const isTemporaryBrowserPreviewUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      Boolean(url.port) &&
      /^\/[A-Za-z0-9_-]{32}\/.+\.(?:html?|xhtml)$/iu.test(url.pathname)
    );
  } catch {
    return false;
  }
};
