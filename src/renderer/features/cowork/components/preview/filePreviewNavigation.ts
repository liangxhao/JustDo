import type { McpAppStagedResourcePreview } from '@shared/plugins/mcpAppResourcePreview';

import type { ManagedMcpAppOpen } from '@/libs/openclaw-chat/components/mcp-app/view';

export const FILE_PREVIEW_EVENT = 'cowork:preview-file';
const resourcePreviewEvent = 'cowork:preview-resource';

export interface ResourceFilePreviewRequest {
  preview: McpAppStagedResourcePreview;
  sessionId: string | null;
  isCurrent: () => boolean;
}

export function openResourceFilePreview(request: ResourceFilePreviewRequest): Promise<boolean> {
  return dispatchPreview(resourcePreviewEvent, request);
}

export function openManagedFilePreview(request: {
  filePath: string;
  managed: ManagedMcpAppOpen;
  sessionId: string | null;
  isCurrent: () => boolean;
  signal?: AbortSignal;
}): Promise<boolean> {
  return dispatchPreview(FILE_PREVIEW_EVENT, request);
}

function dispatchPreview(eventName: string, request: object): Promise<boolean> {
  let result: Promise<boolean> | undefined;
  window.dispatchEvent(new CustomEvent(eventName, {
    detail: { ...request, respond: (response: Promise<boolean>) => { result = response; } },
    cancelable: true,
  }));
  return result ?? Promise.resolve(false);
}

export function listenForResourceFilePreviews(
  open: (request: ResourceFilePreviewRequest) => Promise<boolean> | undefined,
): () => void {
  const listener = (event: Event) => {
    const { detail } = event as CustomEvent<ResourceFilePreviewRequest & {
      respond: (response: Promise<boolean>) => void;
    }>;
    if (event.defaultPrevented || !detail?.preview?.resourcePreview || typeof detail.respond !== 'function') return;
    const response = open(detail);
    if (!response) return;
    event.preventDefault();
    detail.respond(response);
  };
  window.addEventListener(resourcePreviewEvent, listener);
  return () => window.removeEventListener(resourcePreviewEvent, listener);
}

export interface FilePreviewNavigationOptions {
  preserveTabs?: boolean;
  canCommit?(): boolean;
}

export function isFilePreviewWithinPath(filePath: string, sourcePath: string): boolean {
  const normalize = (value: string) => {
    const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
    return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
      ? normalized.toLowerCase()
      : normalized;
  };
  const file = normalize(filePath);
  const source = normalize(sourcePath);
  return file === source || file.startsWith(`${source}/`);
}

export async function runGuardedFilePreviewNavigation(
  requestTransition: (options?: FilePreviewNavigationOptions) => Promise<boolean>,
  navigate: () => unknown | Promise<unknown>,
  options?: FilePreviewNavigationOptions,
  prepare?: () => Promise<boolean>,
): Promise<boolean> {
  if (!(await requestTransition(options))) return false;
  if (prepare && !(await prepare())) return false;
  await navigate();
  return true;
}

export function isCurrentFilePreviewRequest(
  requestId: number,
  latestRequestId: number,
  sourceSessionId: string | null,
  currentSessionId: string | null,
): boolean {
  return requestId === latestRequestId && sourceSessionId === currentSessionId;
}
