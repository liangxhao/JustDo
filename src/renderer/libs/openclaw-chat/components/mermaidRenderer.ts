import mermaid from 'mermaid';

export const renderMermaidSvg = async (
  id: string,
  source: string,
  container?: HTMLElement,
): Promise<string> => {
  const definition = source.trim();
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
