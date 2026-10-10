import { NativeWidgetToolIdentity } from '@shared/plugins/nativeIds';

/** Native descriptors are admitted only from an identified show_widget result. */
export type NativeCanvasPreview = {
  kind: 'canvas';
  surface: 'assistant_message';
  render: 'native';
  docId: string;
  viewId: string;
  toolCallId: string;
  title?: string;
  preferredHeight?: number;
};

const nativePreviews = new WeakSet<object>();
const DOCUMENT_ID = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,256}$/;
const MAX_DESCRIPTOR_CHARS = 32_768;
const FAILED_STATUSES = new Set([
  'error',
  'failed',
  'failure',
  'timeout',
  'timed_out',
  'blocked',
  'denied',
  'forbidden',
  'approval-unavailable',
  'disabled',
  'aborted',
  'cancelled',
  'canceled',
  'interrupted',
  'killed',
  'invalid',
  'unavailable',
]);

export function isNativeCanvasPreview(value: unknown): value is NativeCanvasPreview {
  return Boolean(value && typeof value === 'object' && nativePreviews.has(value));
}

export function isNativeWidgetFallbackPreview(
  value: unknown,
  docIds: ReadonlySet<string>,
): boolean {
  const preview = record(value);
  const docId = preview?.viewId;
  return Boolean(
    preview?.kind === 'canvas' &&
    preview.render === 'url' &&
    typeof docId === 'string' &&
    docIds.has(docId) &&
    preview.url === `/__openclaw__/canvas/documents/${docId}/index.html`,
  );
}

/** Suppress only a fallback for a document already admitted by a real tool. */
export function stripNativeWidgetFallbacks(text: string, docIds: ReadonlySet<string>): string {
  if (!docIds.size || !text.toLowerCase().includes('[embed')) return text;
  const codeRanges = Array.from(
    text.matchAll(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g),
    match => [match.index, match.index + match[0].length],
  );
  return text.replace(
    /\[embed\s+([^\]]*?[^\]/]|)\][\s\S]*?\[\/embed\]|\[embed\s+([^\]]*?)\/\]/gi,
    (
      match: string,
      blockAttrs: string | undefined,
      selfAttrs: string | undefined,
      offset: number,
    ) => {
      if (codeRanges.some(([start, end]) => offset >= start && offset < end)) return match;
      const attrs = new Map(
        Array.from(
          (blockAttrs ?? selfAttrs ?? '').matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g),
          value => [value[1].toLowerCase(), value[2] ?? value[3]],
        ),
      );
      const ref = attrs.get('ref') ?? attrs.get('viewid');
      if (ref && docIds.has(ref)) return '';
      const url = attrs.get('url');
      const document = url?.match(
        /^\/__openclaw__\/canvas\/documents\/([A-Za-z0-9._-]+)\/index\.html$/,
      );
      return document && docIds.has(document[1]) ? '' : match;
    },
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function failed(value: Record<string, unknown> | undefined): boolean {
  return Boolean(
    value &&
    (value.isError === true ||
      value.ok === false ||
      value.success === false ||
      value.timedOut === true ||
      value.error ||
      (typeof value.status === 'string' &&
        FAILED_STATUSES.has(value.status.trim().toLowerCase())) ||
      (value.exitCode !== undefined && value.exitCode !== 0)),
  );
}

/** Callers must be the canonical Tool timeline or a tool-role history record. */
export function decodeNativeCanvasResult(
  output: string | undefined,
  toolName: string | undefined,
  toolCallId: string | undefined,
): NativeCanvasPreview | undefined {
  if (
    (toolName !== NativeWidgetToolIdentity.directName &&
      toolName !== NativeWidgetToolIdentity.dispatcherName) ||
    !toolCallId?.trim() ||
    toolCallId.length > 256 ||
    !output ||
    output.length > MAX_DESCRIPTOR_CHARS
  )
    return;
  let payload: Record<string, unknown> | undefined;
  try {
    payload = record(JSON.parse(output));
  } catch {
    return;
  }
  if (toolName === NativeWidgetToolIdentity.dispatcherName) {
    // The native dispatcher publishes the resolved catalog identity and the
    // actual AgentToolResult. Only this exact core tool grants Canvas authority;
    // unrelated nested JSON and content strings are never searched recursively.
    const tool = record(payload?.tool);
    const result = record(payload?.result);
    const details = record(result?.details);
    if (
      tool?.id !== NativeWidgetToolIdentity.catalogId ||
      tool.name !== NativeWidgetToolIdentity.directName ||
      tool.source !== NativeWidgetToolIdentity.catalogSource ||
      !Array.isArray(result?.content) ||
      failed(result) ||
      failed(details)
    )
      return;
    payload = details;
  }
  if (failed(payload)) return;
  const presentation = record(payload?.presentation);
  const view = record(payload?.view);
  if (
    payload?.kind !== 'canvas' ||
    presentation?.target !== 'assistant_message' ||
    presentation.sandbox !== 'scripts' ||
    typeof view?.id !== 'string' ||
    !DOCUMENT_ID.test(view.id)
  )
    return;
  // A URL is informational. Never navigate to it or derive document authority from it.
  const preview: NativeCanvasPreview = {
    kind: 'canvas',
    surface: 'assistant_message',
    render: 'native',
    docId: view.id,
    viewId: view.id,
    toolCallId,
    ...(typeof presentation.title === 'string' ? { title: presentation.title.slice(0, 200) } : {}),
  };
  nativePreviews.add(preview);
  return preview;
}
