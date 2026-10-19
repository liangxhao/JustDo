export type AppUpdateConfig = Readonly<{
  feedUrl: string;
  speechModels: Readonly<{
    path: string;
  }>;
  releaseHistory: Readonly<{
    maxBytes: number;
    maxEntries: number;
    maxReleaseDateLength: number;
    maxReleaseNotesLength: number;
  }>;
}>;

/** 部署方编辑此处，然后重启 Electron 开发进程或重新打包。 */
export const APP_UPDATE_CONFIG: AppUpdateConfig = Object.freeze({
  feedUrl: '',
  speechModels: Object.freeze({
    path: 'speech-models/v1',
  }),
  releaseHistory: Object.freeze({
    maxBytes: 1048576,
    maxEntries: 200,
    maxReleaseDateLength: 64,
    maxReleaseNotesLength: 100000,
  }),
});

/** Empty and example deployment addresses never enable installed-app networking. */
export function resolveAppUpdateFeedUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const placeholders = ['xxx.com', 'example.com', 'example.net', 'example.org'];
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      placeholders.some(host => hostname === host || hostname.endsWith(`.${host}`)) ||
      hostname.endsWith('.invalid') ||
      hostname.endsWith('.example')
    )
      return undefined;
    return url.href.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

export function resolveAppUpdateResourceUrl(
  relativePath: string,
  feedUrl: unknown = APP_UPDATE_CONFIG.feedUrl,
): string | undefined {
  const configured = resolveAppUpdateFeedUrl(feedUrl);
  return configured ? new URL(relativePath, `${configured}/`).toString() : undefined;
}
