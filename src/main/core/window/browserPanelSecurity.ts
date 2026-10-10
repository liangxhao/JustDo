const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.azure.internal',
  'instance-data.ec2.internal',
]);

const LOW_RISK_BROWSER_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);
const PROMPTABLE_BROWSER_PERMISSIONS = new Set(['geolocation', 'media', 'notifications']);

const EXTERNAL_BROWSER_PROTOCOLS = new Set(['mailto:', 'magnet:', 'sms:', 'tel:', 'webcal:']);

const CHROMIUM_PDF_VIEWER_URL = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html';

// Chromium's PDF viewer embeds its PDF stream in a child frame. This is not a
// website navigation: only the built-in viewer may initiate this exact stream URL.
export const isBrowserPdfStreamNavigation = (
  url: string,
  isMainFrame: boolean,
  parentUrl: string | undefined,
): boolean =>
  !isMainFrame &&
  parentUrl === CHROMIUM_PDF_VIEWER_URL &&
  /^chrome-extension:\/\/mhjfbmdgcfjbbpaeojofohoefgiehjai\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
    url,
  );

export const browserPermissionKeys = (
  origin: string,
  permission: string,
  mediaTypes: readonly string[] = [],
): string[] => {
  if (permission !== 'media') return [`${origin}\0${permission}`];
  if (!mediaTypes.length || mediaTypes.some(type => type !== 'audio' && type !== 'video'))
    return [];
  return [...new Set(mediaTypes)].map(type => `${origin}\0media:${type}`);
};

export const shouldAllowBrowserPanelPermission = (
  permission: string,
  isFocused: boolean,
): boolean => isFocused && LOW_RISK_BROWSER_PERMISSIONS.has(permission);

export const shouldPromptBrowserPanelPermission = (
  permission: string,
  isFocused: boolean,
): boolean => isFocused && PROMPTABLE_BROWSER_PERMISSIONS.has(permission);

export const isAllowedExternalBrowserUrl = (value: string): boolean => {
  try {
    return EXTERNAL_BROWSER_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
};

export const isBlockedBrowserMetadataHost = (hostname: string): boolean => {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/u, '');
  if (METADATA_HOSTNAMES.has(normalized)) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(normalized);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some(value => value > 255)) return false;
    return (
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 100 && octets[1] === 100 && octets[2] === 100 && octets[3] === 200)
    );
  }
  const firstHextet = Number.parseInt(normalized.split(':', 1)[0] || '0', 16);
  return (
    (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) ||
    normalized === 'fd00:ec2::254' ||
    normalized.startsWith('::ffff:a9fe:') ||
    normalized.startsWith('::ffff:169.254.')
  );
};

export const isAllowedBrowserPanelUrl = (value: string): boolean => {
  if (!value || value === 'about:blank') return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !isBlockedBrowserMetadataHost(url.hostname)
    );
  } catch {
    return false;
  }
};

type MainWindowNavigationOptions = {
  appRoot?: string;
  devServerUrl: string;
  isDev: boolean;
  applicationUrl?: string;
};

export const isApplicationRendererOrigin = (
  value: string,
  options: MainWindowNavigationOptions,
): boolean => {
  try {
    const url = new URL(value);
    const applicationUrl = options.isDev ? options.devServerUrl : options.applicationUrl;
    if (
      !applicationUrl ||
      url.username ||
      url.password ||
      !['http:', 'https:'].includes(url.protocol)
    )
      return false;
    return url.origin === new URL(applicationUrl).origin;
  } catch {
    return false;
  }
};

export const isAllowedMainWindowNavigation = (
  value: string,
  options: MainWindowNavigationOptions,
): boolean => {
  if (!isApplicationRendererOrigin(value, options)) return false;
  const url = new URL(value);
  return options.isDev || (['/', '/index.html'].includes(url.pathname) && !url.search);
};

export const shouldOpenMainWindowLinkExternally = (
  value: string,
  options: MainWindowNavigationOptions,
): boolean =>
  value !== 'about:blank' &&
  !isApplicationRendererOrigin(value, options) &&
  isAllowedBrowserPanelUrl(value);
