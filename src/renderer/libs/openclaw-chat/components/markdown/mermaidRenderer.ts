import mermaid from 'mermaid';

import { i18nService } from '@/services/i18n';

export const renderMermaidSvg = async (
  id: string,
  source: string,
  container?: HTMLElement,
): Promise<string> => {
  const definition = source.trim();
  if (
    definition.length > 20_000 ||
    definition.split('\n').length > 400 ||
    /(?:\bclick\s|https?:|data:|\bimg\s*:|\bimage\s*:|<\s*(?:script|iframe|img)|%%\{)/i.test(
      definition,
    )
  )
    throw new Error(i18nService.t('messageDiagramLimited'));
  await mermaid.parse(definition);

  try {
    const { svg } = await mermaid.render(id, definition, container);
    return svg;
  } catch (error) {
    if (typeof document !== 'undefined') {
      document.getElementById(`d${id}`)?.remove();
      document.getElementById(`i${id}`)?.remove();
      document.getElementById(id)?.remove();
    }
    throw error;
  }
};

/** Render a message diagram only while its owner and theme are still current. */
export async function renderMessageDiagram(block: HTMLElement): Promise<void> {
  if (block.dataset.mermaidRendered) return;
  block.dataset.mermaidRendered = 'true';
  const preview = block.querySelector<HTMLElement>('.mermaid-preview');
  const code = block.querySelector<HTMLElement>('.mermaid-source code')?.textContent;
  if (!preview || !code) return;
  const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'default';
  const isCurrent = () => block.isConnected &&
    theme === (document.documentElement.classList.contains('dark') ? 'dark' : 'default');
  try {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, maxEdges: 500, maxTextSize: 20_000 });
    const svg = await renderMermaidSvg(`justdo-mermaid-${crypto.randomUUID()}`, code);
    if (!isCurrent()) return;
    preview.classList.remove('mermaid-error');
    preview.innerHTML = svg;
  } catch (error) {
    if (!isCurrent()) return;
    preview.classList.add('mermaid-error');
    preview.textContent = error instanceof Error ? error.message : i18nService.t('mermaidRenderFailed');
  }
}
