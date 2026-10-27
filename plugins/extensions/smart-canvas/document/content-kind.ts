import { HTML_PAGE_KIND, HTML_PAGE_RESOURCE, HTML_PAGE_SURFACE } from './contracts';
import { applyDocumentAttributes, prepareHtmlSource } from './html-source';
import { installSmartCanvasImageLoading } from './image-loading';
import { escapeHtml, scriptJson } from './serialization';

const IMAGE_SCRIPT_ID = 'smart-canvas-image-loading';

/** Request native network admission for HTTPS pages even when optional arguments were omitted. */
export function prepareHtmlPageToolCall({
  toolName,
  params,
}: {
  toolName: string;
  params: Record<string, unknown>;
}): { params: Record<string, unknown> } | undefined {
  if (
    toolName !== 'show_widget' ||
    params.kind !== HTML_PAGE_KIND ||
    (params.pin !== undefined && params.pin !== true) ||
    typeof params.widget_code !== 'string'
  )
    return;
  const capabilities = params.capabilities === undefined ? {} : params.capabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return;
  const declared = capabilities as Record<string, unknown>;
  let netOrigins = declared.netOrigins;
  if (netOrigins === undefined) {
    const origins = new Set<string>();
    for (const [literal] of params.widget_code.matchAll(/https:\/\/[^\s"'`<>\\]+/gi)) {
      try {
        const url = new URL(literal);
        if (
          /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])$/u.test(url.hostname) &&
          !url.hostname.endsWith('.')
        )
          origins.add(url.origin);
      } catch {
        // Dynamic hosts still need an explicit native origin declaration.
      }
    }
    netOrigins = [...origins];
  }
  if (!Array.isArray(netOrigins) || !netOrigins.length) return;
  return { params: { ...params, pin: true, capabilities: { ...declared, netOrigins } } };
}

/** Native resource errors need a message before the ordinary bridge can report them. */
function installImageResourceBootstrap(scriptId: string): void {
  let failed = false;
  const isResource = (event: Event): boolean => event.target === document.getElementById(scriptId);
  const fail = (): void => {
    if (failed) return;
    failed = true;
    throw new Error('Widget image loading initialization failed');
  };
  window.addEventListener(
    'error',
    event => {
      if (isResource(event)) fail();
    },
    true,
  );
  document.addEventListener(
    'load',
    event => {
      if (
        isResource(event) &&
        !Object.prototype.hasOwnProperty.call(
          HTMLImageElement.prototype,
          Symbol.for('smart-canvas.image-loading'),
        )
      )
        fail();
    },
    true,
  );
}

export const htmlPageContentKind = {
  kind: HTML_PAGE_KIND,
  label: 'HTML page',
  resources: {
    surface: HTML_PAGE_SURFACE,
    paths: [HTML_PAGE_RESOURCE],
    async readPublicResource(path: string) {
      if (path !== HTML_PAGE_RESOURCE) return undefined;
      return {
        body: new TextEncoder().encode(`(${installSmartCanvasImageLoading.toString()})();`),
        contentType: 'text/javascript; charset=utf-8',
      };
    },
  },
  validateSource(source: string): void {
    if (typeof source !== 'string' || !source.trim())
      throw new Error('Expected non-empty HTML source');
  },
  composeDocument({
    source,
    resourceUrls,
  }: {
    source: string;
    title: string;
    resourceUrls: Readonly<Record<string, string>>;
    promptGranted: boolean;
  }): string {
    htmlPageContentKind.validateSource(source);
    const url = resourceUrls[HTML_PAGE_RESOURCE];
    if (!url) throw new Error('Widget image loading resource unavailable');
    const authored = prepareHtmlSource(source);
    return (
      `<script>(${installImageResourceBootstrap.toString()})(${scriptJson(IMAGE_SCRIPT_ID)});</script>` +
      `<script id="${IMAGE_SCRIPT_ID}" src="${escapeHtml(url)}"></script>` +
      (authored.documentAttributes.length
        ? `<script>(${applyDocumentAttributes.toString()})(${scriptJson(authored.documentAttributes)});</script>`
        : '') +
      authored.html
    );
  },
};
