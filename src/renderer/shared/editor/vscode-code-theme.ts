import type { editor } from 'monaco-editor';

export const VS_CODE_MONOKAI_COLORS = {
  background: '#272822',
  backgroundDeep: '#1E1F1C',
  backgroundMuted: '#34352F',
  border: '#414339',
  foreground: '#F8F8F2',
  lineHighlight: '#3E3D32',
  selection: '#878B9180',
  cursor: '#F8F8F0',
  lineNumber: '#90908A',
  lineNumberActive: '#C2C2BF',
  whitespace: '#464741',
  comment: '#88846F',
  string: '#E6DB74',
  number: '#AE81FF',
  keyword: '#F92672',
  type: '#66D9EF',
  function: '#A6E22E',
  parameter: '#FD971F',
  addedBackground: '#4B661680',
  removedBackground: '#90274A70',
  scrollbarThumb: '#75715E',
} as const;

export const VS_CODE_MONOKAI_FONT_FAMILY = "Consolas, 'Courier New', monospace";
export const VS_CODE_MONOKAI_FONT_SIZE = 12;
export const VS_CODE_MONOKAI_LINE_HEIGHT = 18;
export const VS_CODE_MONOKAI_THEME_ID = 'justdo-vscode-monokai';

const palette = VS_CODE_MONOKAI_COLORS;
const tokenColor = (color: string): string => color.slice(1);

export const VS_CODE_MONOKAI_CSS_VARIABLES = {
  '--monokai-background': palette.background,
  '--monokai-background-muted': palette.backgroundMuted,
  '--monokai-border': palette.border,
  '--monokai-foreground': palette.foreground,
  '--monokai-line-highlight': palette.lineHighlight,
  '--monokai-line-number': palette.lineNumber,
  '--monokai-line-number-active': palette.lineNumberActive,
  '--monokai-comment': palette.comment,
  '--monokai-string': palette.string,
  '--monokai-number': palette.number,
  '--monokai-keyword': palette.keyword,
  '--monokai-type': palette.type,
  '--monokai-function': palette.function,
  '--monokai-parameter': palette.parameter,
  '--monokai-added-background': palette.addedBackground,
  '--monokai-removed-background': palette.removedBackground,
  '--monokai-scrollbar-thumb': palette.scrollbarThumb,
} as const;

export const VS_CODE_MONOKAI_THEME: editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: tokenColor(palette.foreground), background: tokenColor(palette.background) },
    { token: 'comment', foreground: tokenColor(palette.comment) },
    { token: 'string', foreground: tokenColor(palette.string) },
    { token: 'number', foreground: tokenColor(palette.number) },
    { token: 'keyword', foreground: tokenColor(palette.keyword) },
    { token: 'operator', foreground: tokenColor(palette.keyword) },
    { token: 'type', foreground: tokenColor(palette.type), fontStyle: 'italic' },
    { token: 'type.identifier', foreground: tokenColor(palette.type), fontStyle: 'italic' },
    { token: 'function', foreground: tokenColor(palette.function) },
    { token: 'variable.parameter', foreground: tokenColor(palette.parameter), fontStyle: 'italic' },
    { token: 'tag', foreground: tokenColor(palette.keyword) },
    { token: 'attribute.name', foreground: tokenColor(palette.function) },
  ],
  colors: {
    'editor.background': palette.background,
    'editor.foreground': palette.foreground,
    'editor.lineHighlightBackground': palette.lineHighlight,
    'editor.selectionBackground': palette.selection,
    'editorCursor.foreground': palette.cursor,
    'editorGutter.background': palette.background,
    'editorLineNumber.activeForeground': palette.lineNumberActive,
    'editorLineNumber.foreground': palette.lineNumber,
    'editorWhitespace.foreground': palette.whitespace,
    'diffEditor.insertedTextBackground': palette.addedBackground,
    'diffEditor.removedTextBackground': palette.removedBackground,
    'diffEditor.diagonalFill': palette.border,
    'diffEditor.border': palette.backgroundMuted,
    'scrollbar.shadow': '#00000098',
    'scrollbarSlider.background': `${palette.scrollbarThumb}66`,
    'scrollbarSlider.hoverBackground': `${palette.scrollbarThumb}99`,
    'scrollbarSlider.activeBackground': '#99947CAA',
  },
};
