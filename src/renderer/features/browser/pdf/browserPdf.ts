export const isLikelyPdfUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (/\.pdf$/iu.test(url.pathname)) return true;
    if (
      (url.hostname === 'arxiv.org' || url.hostname === 'export.arxiv.org') &&
      url.pathname.startsWith('/pdf/')
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
};
