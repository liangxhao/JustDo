/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { EditDiffMonacoController, type EditDiffMonacoData, resolveEditDiffLanguage } from './edit-diff-monaco';

const editors = vi.hoisted(() => ({
  original: { setSelection: vi.fn(), revealRangeInCenter: vi.fn() },
  modified: { setSelection: vi.fn(), revealRangeInCenter: vi.fn() },
}));

vi.mock('@/shared/dom/observeEditorLayout', () => ({ observeEditorLayout: () => () => {} }));
vi.mock('@/app/monacoConfig', () => ({
  monaco: {
    Uri: { parse: (value: string) => value },
    editor: {
      defineTheme() {},
      createModel: () => ({ dispose() {} }),
      createDiffEditor: () => ({
        setModel() {}, dispose() {},
        getOriginalEditor: () => editors.original,
        getModifiedEditor: () => editors.modified,
      }),
    },
  },
}));

const controllers: EditDiffMonacoController[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  document.body.replaceChildren();
});

function preparedDiff(mode: 'unified' | 'split') {
  const host = document.createElement('div');
  host.setAttribute('data-edit-diff-monaco', '');
  host.innerHTML = '<div class="edit-diff__monaco-fallback">HTML code</div>';
  host.getClientRects = () => ({ length: 1 } as DOMRectList);
  const data: EditDiffMonacoData = {
    key: 'edit-search', language: 'plaintext', mode,
    original: 'context\nold needle', modified: 'context\nnew needle',
    lines: [{ kind: 'context', text: 'context' },
      { kind: 'removed', text: 'old needle' }, { kind: 'added', text: 'new needle' }],
  };
  Object.assign(host, { editDiffData: data });
  document.body.append(host);
  const controller = new EditDiffMonacoController();
  controllers.push(controller);
  return { host, controller, data, sync: controller.sync(document.body) };
}

async function mountedDiff(mode: 'unified' | 'split') {
  const fixture = preparedDiff(mode);
  await fixture.sync;
  return fixture;
}

describe('edit Diff Monaco integration', () => {
  test.each([
    ['C:\\workspace\\src\\app.ts', 'typescript'],
    ['/workspace/main.py', 'python'],
    ['/workspace/README.md', 'markdown'],
    ['/workspace/Dockerfile', 'plaintext'],
    [null, 'plaintext'],
  ])('resolves the Monaco language for %s', (path, expected) => {
    expect(resolveEditDiffLanguage(path)).toBe(expected);
  });

  test.each(['unified', 'split'] as const)('reveals added code in the actual %s modified editor', async mode => {
    const { controller, host } = await mountedDiff(mode);
    expect(controller.revealSearch(host, 2, 4, 6)?.native).toBe(true);
    const range = { startLineNumber: 2, endLineNumber: 2, startColumn: 5, endColumn: 11 };
    expect(editors.modified.setSelection).toHaveBeenCalledWith(range);
    expect(editors.modified.revealRangeInCenter).toHaveBeenCalledWith(range);
    expect(editors.original.setSelection).not.toHaveBeenCalled();
  });

  test('reveals removed split code in the original editor', async () => {
    const { controller, host } = await mountedDiff('split');
    expect(controller.revealSearch(host, 1, 4, 6)?.native).toBe(true);
    expect(editors.original.setSelection).toHaveBeenCalledWith({
      startLineNumber: 2, endLineNumber: 2, startColumn: 5, endColumn: 11,
    });
    expect(editors.modified.setSelection).not.toHaveBeenCalled();
  });

  test('temporarily exposes bounded HTML for removed inline code without replacing Monaco', async () => {
    const { controller, host } = await mountedDiff('unified');
    const editor = host.querySelector('.edit-diff__monaco-editor')!;
    const fallback = host.querySelector('.edit-diff__monaco-fallback')!;
    expect(controller.revealSearch(host, 1, 4, 6)).toEqual({ container: fallback, native: false });
    expect(host.classList.contains('is-search-fallback')).toBe(true);
    expect(editor.getAttribute('aria-hidden')).toBe('true');
    expect(fallback.hasAttribute('aria-hidden')).toBe(false);
    expect(editors.original.setSelection).not.toHaveBeenCalled();
    controller.clearSearch();
    expect(host.classList.contains('is-search-fallback')).toBe(false);
    expect(editor.hasAttribute('aria-hidden')).toBe(false);
    expect(fallback.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('.edit-diff__monaco-editor')).toBe(editor);
  });

  test('does not select stale Monaco contents or a disconnected host', async () => {
    const { controller, host, data } = await mountedDiff('split');
    Object.assign(host, { editDiffData: { ...data, modified: 'changed native code' } });
    expect(controller.revealSearch(host, 2, 4, 6)?.native).toBe(false);
    expect(editors.modified.setSelection).not.toHaveBeenCalled();
    host.remove();
    expect(controller.revealSearch(host, 2, 4, 6)).toBeNull();
  });

  test.each([1, 2])('keeps the cold search on source line %i when Monaco finishes loading', async line => {
    const { controller, host, sync } = preparedDiff('unified');
    expect(controller.revealSearch(host, line, 4, 6)).toBeNull();
    host.querySelector('.edit-diff__monaco-fallback')!.innerHTML = '<span class="chat-search-mark">needle</span>';
    await sync;
    if (line === 1) {
      expect(host.classList.contains('is-search-fallback')).toBe(true);
      expect(host.querySelector('.edit-diff__monaco-fallback')!.hasAttribute('aria-hidden')).toBe(false);
      expect(editors.modified.setSelection).not.toHaveBeenCalled();
    } else {
      expect(host.classList.contains('is-search-fallback')).toBe(false);
      expect(editors.modified.setSelection).toHaveBeenCalledWith({
        startLineNumber: 2, endLineNumber: 2, startColumn: 5, endColumn: 11,
      });
    }
  });

  test.each(['clear', 'replace', 'disconnect'] as const)('discards a cold search after %s', async reason => {
    const { controller, host, data, sync } = preparedDiff('split');
    controller.revealSearch(host, 2, 4, 6);
    if (reason === 'clear') controller.clearSearch();
    if (reason === 'replace') Object.assign(host, { editDiffData: { ...data, modified: 'new contents' } });
    if (reason === 'disconnect') host.remove();
    await sync;
    expect(editors.modified.setSelection).not.toHaveBeenCalled();
  });
});
