import { APP_UPDATE_CONFIG } from '../../../config/appUpdate';

export function resolveAppUpdateResourceUrl(
  relativePath: string,
  feedUrl: string = APP_UPDATE_CONFIG.feedUrl,
): string | undefined {
  const configured = feedUrl.trim();
  if (!configured) return undefined;
  const baseUrl = new URL(configured);
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, '')}/`;
  return new URL(relativePath, baseUrl).toString();
}
