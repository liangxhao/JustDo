import type * as Monaco from 'monaco-editor';

import { observeEditorLayout } from '@/shared/dom/observeEditorLayout';

import type { EditDiffLine } from '../../model/tools/edit-tool-diff';

export type EditDiffMonacoData = {
  key: string;
  language: string;
  mode: 'unified' | 'split';
  modified: string;
  original: string;
  lines?: readonly EditDiffLine[];
};

type EditDiffMonacoHost = HTMLElement & {
  editDiffData?: EditDiffMonacoData;
};

type MonacoInstance = {
  container: HTMLElement;
  data: EditDiffMonacoData;
  editor: Monaco.editor.IStandaloneDiffEditor;
  disposeLayout: () => void;
  modifiedModel: Monaco.editor.ITextModel;
  originalModel: Monaco.editor.ITextModel;
};

type MonacoApi = typeof Monaco;

const EDIT_DIFF_THEME = 'justdo-vscode-monokai';

const MONOKAI_THEME: Monaco.editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'F8F8F2', background: '272822' },
    { token: 'comment', foreground: '88846F' },
    { token: 'string', foreground: 'E6DB74' },
    { token: 'number', foreground: 'AE81FF' },
    { token: 'keyword', foreground: 'F92672' },
    { token: 'operator', foreground: 'F92672' },
    { token: 'type', foreground: '66D9EF', fontStyle: 'italic' },
    { token: 'type.identifier', foreground: '66D9EF', fontStyle: 'italic' },
    { token: 'function', foreground: 'A6E22E' },
    { token: 'variable.parameter', foreground: 'FD971F', fontStyle: 'italic' },
    { token: 'tag', foreground: 'F92672' },
    { token: 'attribute.name', foreground: 'A6E22E' },
  ],
  colors: {
    'editor.background': '#272822',
    'editor.foreground': '#F8F8F2',
    'editor.lineHighlightBackground': '#3E3D32',
    'editor.selectionBackground': '#878B9180',
    'editorCursor.foreground': '#F8F8F0',
    'editorGutter.background': '#272822',
    'editorLineNumber.activeForeground': '#C2C2BF',
    'editorLineNumber.foreground': '#90908A',
    'editorWhitespace.foreground': '#464741',
    'diffEditor.insertedTextBackground': '#4B661680',
    'diffEditor.removedTextBackground': '#90274A70',
    'diffEditor.diagonalFill': '#414339',
    'diffEditor.border': '#34352F',
    'scrollbar.shadow': '#00000098',
    'scrollbarSlider.background': '#75715E66',
    'scrollbarSlider.hoverBackground': '#75715E99',
    'scrollbarSlider.activeBackground': '#99947CAA',
  },
};

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  bash: 'shell',
  bat: 'bat',
  c: 'cpp',
  conf: 'ini',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  go: 'go',
  h: 'cpp',
  html: 'html',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'javascript',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  properties: 'ini',
  ps1: 'powershell',
  py: 'python',
  rs: 'rust',
  scss: 'scss',
  sh: 'shell',
  sql: 'sql',
  toml: 'ini',
  ts: 'typescript',
  tsx: 'typescript',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
};

let monacoPromise: Promise<MonacoApi> | null = null;
let monacoThemeDefined = false;
let modelSequence = 0;

function loadMonaco(): Promise<MonacoApi> {
  monacoPromise ??= import('@/app/monacoConfig').then(({ monaco }) => monaco);
  return monacoPromise;
}

function sameData(left: EditDiffMonacoData, right: EditDiffMonacoData): boolean {
  return (
    left.key === right.key &&
    left.language === right.language &&
    left.mode === right.mode &&
    left.original === right.original &&
    left.modified === right.modified
  );
}

function disposeInstance(host: EditDiffMonacoHost, instance: MonacoInstance): void {
  instance.disposeLayout();
  instance.editor.dispose();
  instance.originalModel.dispose();
  instance.modifiedModel.dispose();
  instance.container.remove();
  host.classList.remove('is-ready');
  host.classList.remove('is-search-fallback');
  host.querySelector<HTMLElement>('.edit-diff__monaco-fallback')?.removeAttribute('aria-hidden');
}

export function resolveEditDiffLanguage(path: string | null): string {
  const fileName = path?.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1) : '';
  return LANGUAGE_BY_EXTENSION[extension] ?? 'plaintext';
}

export class EditDiffMonacoController {
  private readonly instances = new Map<EditDiffMonacoHost, MonacoInstance>();
  private readonly pendingSearches = new Map<EditDiffMonacoHost, {
    data: EditDiffMonacoData;
    lineIndex: number;
    column: number;
    length: number;
  }>();
  private syncRevision = 0;

  revealSearch(host: HTMLElement, lineIndex: number, column: number, length: number): {
    container: HTMLElement;
    native: boolean;
  } | null {
    const instance = this.instances.get(host);
    const data = (host as EditDiffMonacoHost).editDiffData;
    const line = data?.lines?.[lineIndex];
    if (!host.isConnected || !data || !line || line.kind === 'omitted') return null;
    if (!instance) {
      this.pendingSearches.set(host, { data, lineIndex, column, length });
      return null;
    }
    // Inline Monaco renders deleted text in a view zone, not the original editor.
    // Keep its instance and mode while showing this existing bounded HTML hunk.
    if (!sameData(instance.data, data)) {
      this.pendingSearches.set(host, { data, lineIndex, column, length });
      return { container: this.showSearchFallback(host, instance.container), native: false };
    }
    if (data.mode === 'unified' && line.kind === 'removed') {
      return { container: this.showSearchFallback(host, instance.container), native: false };
    }
    const original = line.kind === 'removed';
    const lineNumber = data.lines!.slice(0, lineIndex + 1)
      .filter(source => source.kind !== (original ? 'added' : 'removed')).length;
    const range = { startLineNumber: lineNumber, endLineNumber: lineNumber,
      startColumn: column + 1, endColumn: column + length + 1 };
    const editor = original ? instance.editor.getOriginalEditor() : instance.editor.getModifiedEditor();
    this.clearSearchHost(host, instance);
    editor.setSelection(range);
    editor.revealRangeInCenter(range);
    return { container: instance.container, native: true };
  }

  clearSearch(): void {
    this.pendingSearches.clear();
    for (const [host, instance] of this.instances) this.clearSearchHost(host, instance);
  }

  private clearSearchHost(host: HTMLElement, instance: MonacoInstance): void {
    host.classList.remove('is-search-fallback');
    instance.container.removeAttribute('aria-hidden');
    host.querySelector('.edit-diff__monaco-fallback')?.setAttribute('aria-hidden', 'true');
  }

  private showSearchFallback(host: HTMLElement, editor: HTMLElement): HTMLElement {
    host.classList.add('is-search-fallback');
    editor.setAttribute('aria-hidden', 'true');
    const fallback = host.querySelector<HTMLElement>('.edit-diff__monaco-fallback');
    fallback?.removeAttribute('aria-hidden');
    return fallback ?? host;
  }

  async sync(root: ParentNode): Promise<void> {
    const revision = ++this.syncRevision;
    const hosts = new Set(
      [...root.querySelectorAll<EditDiffMonacoHost>('[data-edit-diff-monaco]')].filter(
        host => host.isConnected && host.getClientRects().length > 0 && host.editDiffData,
      ),
    );

    for (const [host, instance] of this.instances) {
      if (hosts.has(host)) continue;
      disposeInstance(host, instance);
      this.instances.delete(host);
    }
    for (const host of this.pendingSearches.keys()) if (!hosts.has(host)) this.pendingSearches.delete(host);
    if (hosts.size === 0) return;

    let monaco: MonacoApi;
    try {
      monaco = await loadMonaco();
    } catch {
      return;
    }
    if (revision !== this.syncRevision) return;

    if (!monacoThemeDefined) {
      monaco.editor.defineTheme(EDIT_DIFF_THEME, MONOKAI_THEME);
      monacoThemeDefined = true;
    }

    for (const host of hosts) {
      const data = host.editDiffData;
      if (!data || !host.isConnected) {
        this.pendingSearches.delete(host);
        continue;
      }
      const current = this.instances.get(host);
      if (current && sameData(current.data, data)) continue;
      if (current) {
        disposeInstance(host, current);
        this.instances.delete(host);
      }
      try {
        this.instances.set(host, this.createInstance(monaco, host, data));
        const pending = this.pendingSearches.get(host);
        this.pendingSearches.delete(host);
        if (pending && sameData(pending.data, data))
          this.revealSearch(host, pending.lineIndex, pending.column, pending.length);
      } catch {
        host.classList.remove('is-ready');
      }
    }
  }

  dispose(): void {
    this.syncRevision += 1;
    this.pendingSearches.clear();
    for (const [host, instance] of this.instances) disposeInstance(host, instance);
    this.instances.clear();
  }

  private createInstance(
    monaco: MonacoApi,
    host: EditDiffMonacoHost,
    data: EditDiffMonacoData,
  ): MonacoInstance {
    const container = host.ownerDocument.createElement('div');
    container.className = 'edit-diff__monaco-editor';
    host.append(container);

    const modelId = `${encodeURIComponent(data.key)}/${modelSequence++}`;
    const originalModel = monaco.editor.createModel(
      data.original,
      data.language,
      monaco.Uri.parse(`inmemory://justdo-edit-diff/${modelId}/original`),
    );
    const modifiedModel = monaco.editor.createModel(
      data.modified,
      data.language,
      monaco.Uri.parse(`inmemory://justdo-edit-diff/${modelId}/modified`),
    );
    const editor = monaco.editor.createDiffEditor(container, {
      automaticLayout: false,
      autoDetectHighContrast: false,
      compactMode: false,
      contextmenu: false,
      diffAlgorithm: 'advanced',
      diffCodeLens: false,
      enableSplitViewResizing: true,
      fixedOverflowWidgets: true,
      folding: false,
      fontFamily: "Consolas, 'Courier New', monospace",
      fontLigatures: false,
      fontSize: 14,
      fontWeight: 'normal',
      glyphMargin: false,
      lineHeight: 20,
      lineNumbers: 'on',
      lineNumbersMinChars: 3,
      minimap: { enabled: false },
      originalEditable: false,
      overviewRulerLanes: 0,
      padding: { top: 4, bottom: 4 },
      readOnly: true,
      renderGutterMenu: false,
      renderIndicators: true,
      renderLineHighlight: 'none',
      renderMarginRevertIcon: false,
      renderOverviewRuler: false,
      renderSideBySide: data.mode === 'split',
      scrollBeyondLastLine: false,
      scrollbar: {
        alwaysConsumeMouseWheel: false,
        horizontalScrollbarSize: 8,
        verticalScrollbarSize: 8,
      },
      stickyScroll: { enabled: false },
      theme: EDIT_DIFF_THEME,
      useInlineViewWhenSpaceIsLimited: false,
      useShadowDOM: true,
      wordWrap: 'off',
    });
    editor.setModel({ original: originalModel, modified: modifiedModel });
    const disposeLayout = observeEditorLayout(editor);
    host.classList.add('is-ready');
    host.closest('.edit-diff')?.classList.add('edit-diff--monaco-ready');
    host
      .querySelector<HTMLElement>('.edit-diff__monaco-fallback')
      ?.setAttribute('aria-hidden', 'true');
    if (host.querySelector('.chat-search-mark')) this.showSearchFallback(host, container);

    return { container, data, editor, disposeLayout, modifiedModel, originalModel };
  }
}
