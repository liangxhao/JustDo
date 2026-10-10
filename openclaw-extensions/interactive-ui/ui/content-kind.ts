import { widgetResourceBootstrap } from '../document/resource-bootstrap';
import { escapeHtml, scriptJson } from '../document/serialization';
import { uiLabels } from './labels';
import { uiRuntime } from './runtime';
import { parseUiDocument, UI_KIND, UI_RESOURCE } from './schema';
import { uiStyles } from './styles';

/** Fixed resource: all interactive helpers live inside uiRuntime. */
export function uiRendererSource(): string {
  return `(${uiRuntime.toString()})(globalThis.__interactiveAnswerBoot);`;
}

export const uiContentKind = {
  kind: UI_KIND,
  label: 'Interactive answer',
  resources: {
    surface: 'interactive-ui',
    paths: [UI_RESOURCE],
    async readPublicResource(path: string) {
      if (path !== UI_RESOURCE) return undefined;
      return {
        body: new TextEncoder().encode(uiRendererSource()),
        contentType: 'text/javascript; charset=utf-8',
      };
    },
  },
  validateSource(source: string): void {
    parseUiDocument(source);
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
    const document = parseUiDocument(source);
    const labels = uiLabels[document.language];
    const url = resourceUrls[UI_RESOURCE];
    if (!url) throw new Error('Interactive answer renderer resource unavailable');
    return (
      `<style>${uiStyles}</style><main id="interactive-answer-root" lang="${document.language}"><p role="status">${escapeHtml(labels.rendererLoading)}</p></main>` +
      `<script>globalThis.__interactiveAnswerBoot=${scriptJson({ document, labels })};\n(${widgetResourceBootstrap.toString()})(${scriptJson({ rootId: 'interactive-answer-root', rendererId: 'interactive-answer-renderer', unavailable: labels.rendererUnavailable })});</script>` +
      `<script id="interactive-answer-renderer" src="${escapeHtml(url)}"></script>`
    );
  },
};
