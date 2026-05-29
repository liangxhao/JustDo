/**
 * MonacoDiffView Component
 * VS Code-style diff visualization using Monaco Editor
 * Works offline with locally bundled workers
 */

import { loader, Monaco } from '@monaco-editor/react';
import { editor, Uri } from 'monaco-editor';
import React, { useEffect, useRef, useState } from 'react';

// Import types and helper from DiffView
import { type DiffData,extractDiffFromToolInput } from './DiffView';

// Re-export for compatibility
export { type DiffData,extractDiffFromToolInput };

// Monokai-inspired theme for diff view
const MONOKAI_THEME = {
  base: 'vs-dark' as const,
  inherit: true,
  rules: [
    { token: 'comment', foreground: '75715E', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'F92672' },
    { token: 'string', foreground: 'E6DB74' },
    { token: 'number', foreground: 'AE81FF' },
    { token: 'regexp', foreground: 'E6DB74' },
    { token: 'type', foreground: '66D9EF' },
    { token: 'function', foreground: 'A6E22E' },
    { token: 'variable', foreground: 'F8F8F2' },
    { token: 'constant', foreground: 'AE81FF' },
    { token: 'delimiter', foreground: 'F8F8F2' },
    { token: 'delimiter.bracket', foreground: 'F8F8F2' },
    { token: 'delimiter.parenthesis', foreground: 'F8F8F2' },
    { token: 'delimiter.square', foreground: 'F8F8F2' },
    { token: 'text', foreground: 'F8F8F2' },
  ],
  colors: {
    'editor.background': '#272822',
    'editor.foreground': '#F8F8F2',
    'editor.lineHighlightBackground': '#3E3D32',
    'editorLineNumber.foreground': '#75715E',
    'editorLineNumber.activeForeground': '#F8F8F2',
    'editor.selectionBackground': '#49483E',
    'editorCursor.foreground': '#F8F8F0',
    'editorWhitespace.foreground': '#464741',
    'editorIndentGuide.background': '#464741',
    'editorIndentGuide.activeBackground': '#75715E',
    // Diff colors - Monokai style with subtle diff indicators
    'diffEditor.insertedTextBackground': '#A6E22E20',
    'diffEditor.insertedLineBackground': '#A6E22E15',
    'diffEditor.removedTextBackground': '#F9267220',
    'diffEditor.removedLineBackground': '#F9267215',
    'diffEditor.insertedCodeLineBackground': '#A6E22E10',
    'diffEditor.removedCodeLineBackground': '#F9267210',
    'diffEditor.diagonalFill': '#464741',
    'editorOverviewRail.added.background': '#A6E22E50',
    'editorOverviewRail.removed.background': '#F9267250',
  },
};

// Light Monokai variant
const LIGHT_MONOKAI_THEME = {
  base: 'vs' as const,
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6A737D', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'D73A49' },
    { token: 'string', foreground: '032F62' },
    { token: 'number', foreground: '005CC5' },
    { token: 'type', foreground: '6F42C1' },
    { token: 'function', foreground: '22863A' },
    { token: 'text', foreground: '24292E' },
  ],
  colors: {
    'editor.background': '#F6F8FA',
    'editor.foreground': '#24292E',
    'editor.lineHighlightBackground': '#EDF2F7',
    'editorLineNumber.foreground': '#959DA5',
    'editorLineNumber.activeForeground': '#24292E',
    'editor.selectionBackground': '#C8E1FF',
    'editorCursor.foreground': '#24292E',
    // Light diff colors
    'diffEditor.insertedTextBackground': '#28A74520',
    'diffEditor.insertedLineBackground': '#28A74512',
    'diffEditor.removedTextBackground': '#CB243120',
    'diffEditor.removedLineBackground': '#CB243112',
    'diffEditor.insertedCodeLineBackground': '#28A74508',
    'diffEditor.removedCodeLineBackground': '#CB243108',
    'diffEditor.diagonalFill': '#E1E4E8',
    'editorOverviewRail.added.background': '#28A74540',
    'editorOverviewRail.removed.background': '#CB243140',
  },
};

interface MonacoDiffViewProps {
  diffDataList: DiffData[];
}

// Generate unique URI for each model
const modelUriCounter = { value: 0 };
const generateUri = (type: 'original' | 'modified') =>
  Uri.parse(`inmemory://diff-${modelUriCounter.value++}-${type}`);

const MonacoDiffView: React.FC<MonacoDiffViewProps> = ({ diffDataList }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const diffEditorRef = useRef<editor.IDiffEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const currentModelsRef = useRef<{ original: editor.ITextModel | null; modified: editor.ITextModel | null }>({
    original: null,
    modified: null,
  });
  const [isReady, setIsReady] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(() =>
    document.documentElement.classList.contains('dark'),
  );
  const [currentEditIndex, setCurrentEditIndex] = useState(0);

  // Listen for theme changes
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDarkMode(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // Initialize Monaco and define custom themes
  useEffect(() => {
    loader.init().then(monaco => {
      monacoRef.current = monaco;
      // Define custom Monokai-inspired themes
      monaco.editor.defineTheme('monokai-diff', MONOKAI_THEME);
      monaco.editor.defineTheme('light-monokai-diff', LIGHT_MONOKAI_THEME);
      setIsReady(true);
    });
  }, []);

  // Initialize editor (only once when ready)
  useEffect(() => {
    if (!isReady || !containerRef.current || !monacoRef.current || diffEditorRef.current) return;

    const diffEditor = monacoRef.current.editor.createDiffEditor(containerRef.current, {
      theme: isDarkMode ? 'monokai-diff' : 'light-monokai-diff',
      readOnly: true,
      renderSideBySide: true,
      minimap: { enabled: false },
      folding: false,
      lineNumbers: 'on',
      scrollBeyondLastLine: false,
      automaticLayout: true,
      renderIndicators: true,
      glyphMargin: false,
      ignoreUnchangedLines: true,
      lineNumbersMinChars: 2,
      fontSize: 11,
      fontFamily: 'JetBrains Mono, Fira Code, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontLigatures: false,
      renderLineHighlight: 'line',
      scrollbar: {
        vertical: 'hidden',
        horizontal: 'hidden',
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
        useShadows: false,
      },
      overviewRulerLanes: 1,
      overviewRulerBorder: false,
      hideUnchangedRegions: {
        enabled: true,
        revealLineCount: 2,
        contextLineCount: 1,
      },
      diffStyle: 'diff',
      renderMarginRevisionsIcon: false,
      wordWrap: 'off',
      wrappingIndent: 'indent',
    });

    diffEditorRef.current = diffEditor;

    // Cleanup: dispose editor (models are handled separately)
    return () => {
      if (diffEditorRef.current) {
        // First reset models to null before disposing editor
        diffEditorRef.current.setModel(null);
        diffEditorRef.current.dispose();
        diffEditorRef.current = null;
      }
    };
  }, [isReady]);

  // Update theme
  useEffect(() => {
    if (monacoRef.current && isReady && diffEditorRef.current) {
      monacoRef.current.editor.setTheme(isDarkMode ? 'monokai-diff' : 'light-monokai-diff');
    }
  }, [isDarkMode, isReady]);

  // Manage models - proper cleanup sequence is critical
  useEffect(() => {
    if (!diffEditorRef.current || !monacoRef.current || diffDataList.length === 0) return;

    const monaco = monacoRef.current;
    const currentDiff = diffDataList[currentEditIndex];
    if (!currentDiff) return;

    // Step 1: Reset editor models to null FIRST (unbind from editor)
    diffEditorRef.current.setModel(null);

    // Step 2: Dispose previous models AFTER unbinding
    if (currentModelsRef.current.original) {
      currentModelsRef.current.original.dispose();
    }
    if (currentModelsRef.current.modified) {
      currentModelsRef.current.modified.dispose();
    }

    // Step 3: Create new models
    const originalModel = monaco.editor.createModel(currentDiff.oldStr, 'plaintext', generateUri('original'));
    const modifiedModel = monaco.editor.createModel(currentDiff.newStr, 'plaintext', generateUri('modified'));

    // Step 4: Store refs for future cleanup
    currentModelsRef.current = { original: originalModel, modified: modifiedModel };

    // Step 5: Set new models to editor
    diffEditorRef.current.setModel({ original: originalModel, modified: modifiedModel });

    // Cleanup for this effect: properly dispose when switching or unmounting
    return () => {
      if (diffEditorRef.current) {
        // MUST reset models before disposing them
        diffEditorRef.current.setModel(null);
      }
      // Now safe to dispose
      if (currentModelsRef.current.original) {
        currentModelsRef.current.original.dispose();
        currentModelsRef.current.original = null;
      }
      if (currentModelsRef.current.modified) {
        currentModelsRef.current.modified.dispose();
        currentModelsRef.current.modified = null;
      }
    };
  }, [diffDataList, currentEditIndex, isReady]);

  if (diffDataList.length === 0) return null;

  const currentDiff = diffDataList[currentEditIndex];
  const filePath = currentDiff?.filePath;

  // Stats calculation
  const computeStats = (oldStr: string, newStr: string) => {
    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');
    let added = 0;
    let removed = 0;
    const maxLen = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
      if (i >= oldLines.length) added++;
      else if (i >= newLines.length) removed++;
      else if (oldLines[i] !== newLines[i]) {
        added++;
        removed++;
      }
    }
    return { added, removed };
  };

  const stats = currentDiff ? computeStats(currentDiff.oldStr, currentDiff.newStr) : { added: 0, removed: 0 };

  return (
    <div className="rounded-md overflow-hidden border dark:border-[#3E3D32] border-gray-200 shadow-sm">
      {/* Header - Monokai style */}
      <div className="flex items-center justify-between px-2.5 py-1.5 dark:bg-[#1E1F1C] bg-[#EDF2F7] border-b dark:border-[#3E3D32] border-gray-200">
        <div className="flex items-center gap-2 min-w-0">
          {/* File icon */}
          <div className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
            <svg
              className="w-3.5 h-3.5 dark:text-[#75715E] text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
          </div>
          {filePath && (
            <span className="text-[11px] font-medium font-mono dark:text-[#F8F8F2] text-gray-700 truncate">
              {filePath}
            </span>
          )}
          {diffDataList.length > 1 && (
            <span className="text-[10px] dark:text-[#75715E] text-gray-400 flex-shrink-0 font-medium">
              ({currentEditIndex + 1}/{diffDataList.length})
            </span>
          )}
        </div>
        {/* Stats badges - Monokai accent colors */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {stats.added > 0 && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold dark:bg-[#A6E22E]/20 dark:text-[#A6E22E] bg-green-100 text-green-700">
              +{stats.added}
            </span>
          )}
          {stats.removed > 0 && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold dark:bg-[#F92672]/20 dark:text-[#F92672] bg-red-100 text-red-700">
              -{stats.removed}
            </span>
          )}
        </div>
      </div>

      {/* Navigation - pill style */}
      {diffDataList.length > 1 && (
        <div className="flex items-center gap-1 px-2.5 py-1 dark:bg-[#272822] bg-[#F6F8FA] border-b dark:border-[#3E3D32]/50 border-gray-200/50">
          <span className="text-[10px] dark:text-[#75715E] text-gray-400 mr-0.5">Edits:</span>
          {diffDataList.map((_, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => setCurrentEditIndex(idx)}
              className={`px-2 py-0.5 text-[10px] font-medium rounded transition-all ${
                idx === currentEditIndex
                  ? 'dark:bg-[#A6E22E]/30 dark:text-[#A6E22E] bg-green-200 text-green-700'
                  : 'dark:bg-[#464741]/50 bg-gray-100 dark:text-[#75715E] text-gray-400 hover:dark:bg-[#464741] hover:bg-gray-200'
              }`}
            >
              {idx + 1}
            </button>
          ))}
        </div>
      )}

      {/* Editor container with theme-matched background */}
      <div className="relative dark:bg-[#272822] bg-[#F6F8FA]">
        <div ref={containerRef} className="w-full h-[260px]" />
      </div>
    </div>
  );
};

export default MonacoDiffView;