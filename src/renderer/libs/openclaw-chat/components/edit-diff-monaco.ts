import type * as Monaco from 'monaco-editor';

export type EditDiffMonacoData = {
  key: string;
  language: string;
  mode: 'unified' | 'split';
  modified: string;
  original: string;
};

type EditDiffMonacoHost = HTMLElement & {
  editDiffData?: EditDiffMonacoData;
};

type MonacoInstance = {
  container: HTMLElement;
  data: EditDiffMonacoData;
  editor: Monaco.editor.IStandaloneDiffEditor;
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
  instance.editor.dispose();
  instance.originalModel.dispose();
  instance.modifiedModel.dispose();
  instance.container.remove();
  host.classList.remove('is-ready');
  host.querySelector<HTMLElement>('.edit-diff__monaco-fallback')?.removeAttribute('aria-hidden');
}

export function resolveEditDiffLanguage(path: string | null): string {
  const fileName = path?.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1) : '';
  return LANGUAGE_BY_EXTENSION[extension] ?? 'plaintext';
}

export class EditDiffMonacoController {
  private readonly instances = new Map<EditDiffMonacoHost, MonacoInstance>();
  private syncRevision = 0;

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
      if (!data || !host.isConnected) continue;
      const current = this.instances.get(host);
      if (current && sameData(current.data, data)) continue;
      if (current) {
        disposeInstance(host, current);
        this.instances.delete(host);
      }
      try {
        this.instances.set(host, this.createInstance(monaco, host, data));
      } catch {
        host.classList.remove('is-ready');
      }
    }
  }

  dispose(): void {
    this.syncRevision += 1;
    for (const [host, instance] of this.instances) disposeInstance(host, instance);
    this.instances.clear();
  }

  private createInstance(
    monaco: MonacoApi,
    host: EditDiffMonacoHost,
    data: EditDiffMonacoData,
  ): MonacoInstance {
    const container = document.createElement('div');
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
      automaticLayout: true,
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
    host.classList.add('is-ready');
    host.closest('.edit-diff')?.classList.add('edit-diff--monaco-ready');
    host
      .querySelector<HTMLElement>('.edit-diff__monaco-fallback')
      ?.setAttribute('aria-hidden', 'true');

    return { container, data, editor, modifiedModel, originalModel };
  }
}
