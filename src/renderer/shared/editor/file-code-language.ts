const FILE_CODE_LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
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

const WRITE_CODE_LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  astro: 'xml',
  c: 'c',
  cc: 'cpp',
  cfg: 'ini',
  cjs: 'javascript',
  cmd: 'bat',
  cnf: 'ini',
  config: 'xml',
  cts: 'typescript',
  cxx: 'cpp',
  desktop: 'ini',
  dockerfile: 'dockerfile',
  gql: 'plaintext',
  graphql: 'plaintext',
  hh: 'cpp',
  hpp: 'cpp',
  htm: 'html',
  hxx: 'cpp',
  jsonc: 'json',
  jsonl: 'json',
  kt: 'kotlin',
  kts: 'kotlin',
  lua: 'plaintext',
  mjs: 'javascript',
  mk: 'plaintext',
  mts: 'typescript',
  ndjson: 'json',
  php: 'php',
  psm1: 'powershell',
  proto: 'plaintext',
  r: 'plaintext',
  rb: 'ruby',
  sass: 'scss',
  scala: 'plaintext',
  service: 'ini',
  styl: 'plaintext',
  svelte: 'xml',
  swift: 'swift',
  vue: 'xml',
  xhtml: 'html',
  zsh: 'shell',
};

const WRITE_CODE_LANGUAGE_BY_NAME: Readonly<Record<string, string>> = {
  '.bashrc': 'shell',
  '.env': 'ini',
  '.env.example': 'ini',
  '.env.local': 'ini',
  '.gitconfig': 'ini',
  '.zshrc': 'shell',
  'cmakelists.txt': 'plaintext',
  containerfile: 'dockerfile',
  dockerfile: 'dockerfile',
  gnumakefile: 'plaintext',
  makefile: 'plaintext',
};

// These are code/configuration files with no grammar in the curated chat highlighter.
const UNREGISTERED_WRITE_CODE_LANGUAGES = new Set(['bat', 'ini', 'less', 'scss']);

function fileNameOf(path: string | null): string {
  return path?.split(/[\\/]/).pop()?.toLowerCase() ?? '';
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot + 1);
}

function lookupLanguage(map: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** Monaco language IDs used by the existing file and diff readers. */
export function resolveFileCodeLanguage(path: string | null): string {
  return lookupLanguage(FILE_CODE_LANGUAGE_BY_EXTENSION, extensionOf(fileNameOf(path))) ?? 'plaintext';
}

/** Code previews use explicit grammars; prose and unknown formats keep the text bubble. */
export function resolveWriteCodeLanguage(path: string | null): string | undefined {
  const fileName = fileNameOf(path);
  const extension = extensionOf(fileName);
  const language =
    lookupLanguage(WRITE_CODE_LANGUAGE_BY_NAME, fileName) ??
    lookupLanguage(WRITE_CODE_LANGUAGE_BY_EXTENSION, extension) ??
    lookupLanguage(FILE_CODE_LANGUAGE_BY_EXTENSION, extension);
  if (!language || language === 'markdown') return undefined;
  return UNREGISTERED_WRITE_CODE_LANGUAGES.has(language) ? 'plaintext' : language;
}
