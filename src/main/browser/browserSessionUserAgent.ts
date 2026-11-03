/** Keep Chromium's native platform/version while removing desktop shell tokens. */
export const getBrowserUserAgent = (userAgent: string): string => {
  if (!/\sElectron\/\S+/u.test(userAgent)) return userAgent;
  return userAgent
    .replace(/(\(KHTML, like Gecko\)) \S+\/\S+(?= Chrome\/)/u, '$1')
    .replace(/\sElectron\/\S+/gu, '');
};
