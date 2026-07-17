import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mermaidMocks = vi.hoisted(() => ({
  parse: vi.fn(),
  render: vi.fn(),
}));

vi.mock('mermaid', () => ({
  default: mermaidMocks,
}));

import { renderMermaidSvg } from '@/libs/openclaw-chat/components/mermaidRenderer';

describe('renderMermaidSvg', () => {
  beforeEach(() => {
    mermaidMocks.parse.mockReset();
    mermaidMocks.render.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('preserves the syntax error without rendering Mermaid error artwork', async () => {
    const container = {} as HTMLElement;
    const syntaxError = new Error('Parse error on line 2');
    mermaidMocks.parse.mockRejectedValue(syntaxError);

    await expect(renderMermaidSvg('diagram-id', ' invalid diagram ', container)).rejects.toBe(
      syntaxError,
    );

    expect(mermaidMocks.parse).toHaveBeenCalledWith('invalid diagram');
    expect(mermaidMocks.render).not.toHaveBeenCalled();
  });

  test('renders valid diagrams inside the preview container', async () => {
    const container = {} as HTMLElement;
    mermaidMocks.parse.mockResolvedValue(true);
    mermaidMocks.render.mockResolvedValue({ svg: '<svg />' });

    await expect(renderMermaidSvg('diagram-id', ' graph TD\nA --> B ', container)).resolves.toBe(
      '<svg />',
    );

    expect(mermaidMocks.render).toHaveBeenCalledWith(
      'diagram-id',
      'graph TD\nA --> B',
      container,
    );
  });

  test('supports document-level rendering for previews inside a shadow root', async () => {
    mermaidMocks.parse.mockResolvedValue(true);
    mermaidMocks.render.mockResolvedValue({ svg: '<svg />' });

    await expect(renderMermaidSvg('diagram-id', 'graph TD\nA --> B')).resolves.toBe('<svg />');

    expect(mermaidMocks.render).toHaveBeenCalledWith(
      'diagram-id',
      'graph TD\nA --> B',
      undefined,
    );
  });

  test('removes Mermaid temporary nodes when rendering fails', async () => {
    const renderError = new Error('Draw failed');
    const remove = vi.fn();
    const getElementById = vi.fn((_id: string) => ({ remove }));
    vi.stubGlobal('document', { getElementById });
    mermaidMocks.parse.mockResolvedValue(true);
    mermaidMocks.render.mockRejectedValue(renderError);

    await expect(renderMermaidSvg('diagram-id', 'graph TD\nA --> B')).rejects.toBe(renderError);

    expect(getElementById.mock.calls.map(([id]) => id)).toEqual([
      'ddiagram-id',
      'idiagram-id',
      'diagram-id',
    ]);
    expect(remove).toHaveBeenCalledTimes(3);
  });
});
