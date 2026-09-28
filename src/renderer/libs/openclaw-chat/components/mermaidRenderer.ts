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
