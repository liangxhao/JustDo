import { realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';

import { HTML_PAGE_RESOURCE } from '../../../../plugins/extensions/smart-canvas/document/contracts';
import type { WidgetNetworkBinding, WidgetNetworkCreate } from '../../../shared/widgets/network';
import { widgetViewerMount } from '../../../shared/widgets/viewer';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
const RESOURCE_TYPES = new Set(['script', 'stylesheet', 'font', 'image', 'media']);
const DEVELOPMENT_VIEWER_MODULES = [
  'viewer',
  'host',
  'draft',
  'links',
  'messaging',
  'sizing',
  'viewport-fit',
].map(name => `/libs/openclaw-chat/components/native-widget/${name}.ts`);

/** Only the fixed viewer's Vite graph. Never admit a general filesystem/source prefix. */
function developmentModulePaths(applicationOrigin: string): ReadonlySet<string> {
  const modules = new Set([
    ...DEVELOPMENT_VIEWER_MODULES,
    '/@vite/client',
    '/@vite/env',
    '/@react-refresh',
  ]);
  // Vite serves @vite/env through this exact dependency path. A development
  // node_modules junction can produce either its lexical or resolved spelling.
  const environment = path.resolve('node_modules/vite/dist/client/env.mjs');
  const candidates = [environment];
  try {
    candidates.push(realpathSync(environment));
  } catch {
    /* Missing development dependencies fail closed. */
  }
  for (const filename of candidates) {
    const moduleUrl = new URL(applicationOrigin);
    moduleUrl.pathname = path.posix.join('/@fs/', filename.split(path.sep).join('/'));
    modules.add(moduleUrl.pathname);
  }
  return modules;
}

function viteModuleQuery(search: string): boolean {
  if (!search) return true;
  if (!/^\?(?:t=\d{10,17}|v=[a-f0-9]{8,64})(?:&(?:t=\d{10,17}|v=[a-f0-9]{8,64}))?$/iu.test(search))
    return false;
  const keys = [...new URLSearchParams(search).keys()];
  return new Set(keys).size === keys.length;
}
const fail = (): never => {
  throw new Error('Widget network policy unavailable');
};
export const validNetworkMount = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);

export function normalizedNetworkBinding(value: unknown): WidgetNetworkBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const data = value as Record<string, unknown>;
  const fields = [
    'agentId',
    'sessionKey',
    'sessionId',
    'lifecycleRevision',
    'name',
    'instanceId',
    'viewGeneration',
  ] as const;
  for (const field of fields)
    if (
      typeof data[field] !== 'string' ||
      !data[field] ||
      (data[field] as string).length > 1024 ||
      /[\u0000-\u001f\u007f]/u.test(data[field] as string)
    )
      return fail();
  if (
    !Number.isSafeInteger(data.connectionGeneration) ||
    (data.connectionGeneration as number) < 0 ||
    !Number.isSafeInteger(data.revision) ||
    (data.revision as number) < 1 ||
    data.grantState !== 'granted' ||
    !Array.isArray(data.netOrigins) ||
    data.netOrigins.length < 1 ||
    data.netOrigins.length > 32
  )
    return fail();
  const netOrigins = data.netOrigins.map(value => {
    if (typeof value !== 'string') return fail();
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.origin !== value ||
      url.username ||
      url.password ||
      !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])$/iu.test(url.hostname) ||
      privateNetworkHost(url.hostname)
    )
      return fail();
    return url.origin;
  });
  if (new Set(netOrigins).size !== netOrigins.length) return fail();
  return Object.fromEntries([
    ...fields.map(field => [field, data[field]]),
    ['connectionGeneration', data.connectionGeneration],
    ['revision', data.revision],
    ['grantState', 'granted'],
    ['netOrigins', netOrigins.sort()],
  ]) as WidgetNetworkBinding;
}

/** Literal-address defense; DNS/proxy destination policy remains a deployment boundary. */
export function privateNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    (!host.includes('.') && !host.includes(':'))
  )
    return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(host) === 6) {
    if (host.startsWith('::ffff:')) return true;
    return (
      host === '::' ||
      host === '::1' ||
      /^f[cd]/u.test(host) ||
      /^fe[89ab]/u.test(host) ||
      host.startsWith('ff')
    );
  }
  return host.endsWith('.') || host.includes('%');
}

export type WidgetNetworkPolicy = {
  viewerUrl: string;
  applicationOrigin: string;
  gatewayOrigin: string;
  sandboxUrl: string;
  resourceUrls: ReadonlySet<string>;
  origins: ReadonlySet<string>;
  development: boolean;
  developmentModules: ReadonlySet<string>;
};

export function createNetworkPolicy(
  input: WidgetNetworkCreate,
  ownerUrl: string,
  development: boolean,
): WidgetNetworkPolicy {
  if (!validNetworkMount(input.mountId)) return fail();
  const applicationOrigin = new URL(ownerUrl).origin;
  const viewer = new URL('/widget-viewer.html', applicationOrigin);
  viewer.searchParams.set('mount', input.mountId);
  if (!widgetViewerMount(viewer.href, ownerUrl)) return fail();
  const gateway = new URL(input.gatewayOrigin);
  const sandbox = new URL(input.sandboxUrl);
  if (
    !['http:', 'https:'].includes(gateway.protocol) ||
    gateway.origin !== input.gatewayOrigin ||
    gateway.username ||
    gateway.password ||
    sandbox.hostname !== gateway.hostname ||
    sandbox.protocol !== gateway.protocol ||
    sandbox.origin === gateway.origin ||
    sandbox.origin === applicationOrigin ||
    sandbox.pathname !== '/mcp-app-sandbox' ||
    sandbox.username ||
    sandbox.password ||
    sandbox.hash
  )
    return fail();
  const keys = [...sandbox.searchParams.keys()];
  if (
    keys.some(key => key !== 'csp' && key !== 'v') ||
    new Set(keys).size !== keys.length ||
    !/^[a-f0-9]{64}$/u.test(sandbox.searchParams.get('v') ?? '') ||
    !/^[A-Za-z0-9_-]{1,6832}$/u.test(sandbox.searchParams.get('csp') ?? '')
  )
    return fail();
  if (!Array.isArray(input.resourceUrls) || input.resourceUrls.length > 1) return fail();
  const resources = input.resourceUrls.map(raw => {
    const url = new URL(raw);
    if (
      url.origin !== gateway.origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/__openclaw__\/cap\/[A-Za-z0-9_-]{24}\//u.test(url.pathname) ||
      url.pathname.slice('/__openclaw__/cap/'.length + 24) !== HTML_PAGE_RESOURCE ||
      url.href !== raw
    )
      return fail();
    return raw;
  });
  const binding = normalizedNetworkBinding(input.binding);
  if (
    binding.netOrigins.some(origin =>
      [applicationOrigin, gateway.origin, sandbox.origin].includes(origin),
    )
  )
    return fail();
  return {
    viewerUrl: viewer.href,
    applicationOrigin,
    gatewayOrigin: gateway.origin,
    sandboxUrl: sandbox.href,
    resourceUrls: new Set(resources),
    origins: new Set(binding.netOrigins),
    development,
    developmentModules: development ? developmentModulePaths(applicationOrigin) : new Set(),
  };
}

export type RequestRole = 'viewer' | 'sandbox' | 'widget' | 'unknown';
export type NetworkRequest = {
  url: string;
  method: string;
  resourceType: string;
  uploadData?: readonly unknown[];
};
export type NetworkRequestKind = 'transport' | 'resource' | 'business' | 'preflight' | 'denied';
export function classifyNetworkRequest(
  policy: WidgetNetworkPolicy,
  details: NetworkRequest,
  role: RequestRole,
): NetworkRequestKind {
  if (details.uploadData?.length) return 'denied';
  let url: URL;
  try {
    url = new URL(details.url);
  } catch {
    return 'denied';
  }
  if (url.username || url.password || url.hash) return 'denied';
  const read = details.method === 'GET' || details.method === 'HEAD';
  if (
    read &&
    role === 'widget' &&
    ((url.protocol === 'data:' && ['image', 'media', 'font'].includes(details.resourceType)) ||
      (url.protocol === 'blob:' && details.resourceType === 'media'))
  )
    return 'transport';
  if (
    read &&
    details.url === policy.viewerUrl &&
    details.resourceType === 'mainFrame' &&
    role === 'viewer'
  )
    return 'transport';
  if (
    read &&
    details.url === policy.sandboxUrl &&
    details.resourceType === 'subFrame' &&
    role === 'sandbox'
  )
    return 'transport';
  if (
    read &&
    policy.resourceUrls.has(details.url) &&
    details.resourceType === 'script' &&
    role === 'widget'
  )
    return 'transport';
  if (
    read &&
    url.origin === policy.applicationOrigin &&
    role === 'viewer' &&
    !url.hash &&
    ['script', 'stylesheet', 'font', 'image'].includes(details.resourceType)
  ) {
    // Packaged /assets is already served from the immutable manifest. The
    // development entry uses Vite's renderer root, not a /src/renderer prefix.
    if (
      (!url.search && /^\/assets\/[A-Za-z0-9_./-]+$/u.test(url.pathname)) ||
      (policy.development &&
        details.resourceType === 'script' &&
        policy.developmentModules.has(url.pathname) &&
        viteModuleQuery(url.search))
    )
      return 'transport';
  }
  if (
    role !== 'widget' ||
    url.protocol !== 'https:' ||
    privateNetworkHost(url.hostname) ||
    [policy.applicationOrigin, policy.gatewayOrigin, new URL(policy.sandboxUrl).origin].includes(
      url.origin,
    )
  )
    return 'denied';
  // The authenticated native document and sandbox already own resource CSP.
  // netOrigins grants connect-src; it is not another script/style/font grant.
  if (RESOURCE_TYPES.has(details.resourceType)) return read ? 'resource' : 'denied';
  if (!policy.origins.has(url.origin)) return 'denied';
  if (details.method === 'OPTIONS' && ['other', 'xhr'].includes(details.resourceType))
    return 'preflight';
  return read && details.resourceType === 'xhr' ? 'business' : 'denied';
}

export function strictProxyRoute(route: string): boolean {
  const entries = route.split(';').map(entry => entry.trim());
  return (
    entries.length > 0 &&
    entries.every(entry => /^(?:PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+[^\s;]+:\d+$/iu.test(entry))
  );
}

export function sanitizedWidgetRequestHeaders(
  headers: Record<string, string>,
  preflight: boolean,
): Record<string, string> | undefined {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  if (
    normalized['transfer-encoding'] ||
    (normalized['content-length'] && normalized['content-length'] !== '0')
  )
    return;
  if (
    preflight &&
    (!['GET', 'HEAD'].includes(normalized['access-control-request-method']) ||
      normalized.origin !== 'null' ||
      normalized['access-control-request-headers']
        ?.split(',')
        .some(header => !['accept', 'range', 'content-type'].includes(header.trim().toLowerCase())))
  )
    return;
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([key]) =>
        !['authorization', 'cookie', 'cookie2', 'proxy-authorization'].includes(key.toLowerCase()),
    ),
  );
}
