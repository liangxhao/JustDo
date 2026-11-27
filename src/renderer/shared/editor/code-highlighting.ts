import type { HLJSApi } from 'highlight.js';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const autoHighlightLanguages = [
  'bash',
  'c',
  'cpp',
  'csharp',
  'css',
  'diff',
  'dockerfile',
  'go',
  'java',
  'javascript',
  'json',
  'kotlin',
  'markdown',
  'mermaid',
  'php',
  'powershell',
  'python',
  'ruby',
  'rust',
  'sql',
  'swift',
  'typescript',
  'xml',
  'yaml',
];

const HIGHLIGHT_ALIASES: Record<string, string> = {
  'c#': 'csharp',
  'c++': 'cpp',
  cs: 'csharp',
  cxx: 'cpp',
  docker: 'dockerfile',
  js: 'javascript',
  jsx: 'javascript',
  kt: 'kotlin',
  kts: 'kotlin',
  md: 'markdown',
  ps1: 'powershell',
  pwsh: 'powershell',
  rb: 'ruby',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  tsx: 'typescript',
};

let codeHighlightingReady = false;

/** Allow callers with their own grammars to use registered highlighting without chat setup. */
export function initializeCodeHighlighting(): void {
  if (codeHighlightingReady) return;
  for (const [language, definition, aliases] of [
    ['bash', bash, ['sh', 'shell']],
    ['c', c, []],
    ['cpp', cpp, ['c++', 'cxx']],
    ['csharp', csharp, ['cs', 'c#']],
    ['css', css, []],
    ['diff', diff, ['patch']],
    ['dockerfile', dockerfile, ['docker']],
    ['go', go, ['golang']],
    ['java', java, []],
    ['javascript', javascript, ['js', 'jsx']],
    ['json', json, []],
    ['kotlin', kotlin, ['kt', 'kts']],
    ['markdown', markdown, ['md']],
    ['php', php, []],
    ['powershell', powershell, ['ps1', 'pwsh']],
    ['python', python, ['py']],
    ['ruby', ruby, ['rb']],
    ['rust', rust, ['rs']],
    ['sql', sql, []],
    ['swift', swift, []],
    ['typescript', typescript, ['ts', 'tsx']],
    ['xml', xml, ['html', 'svg']],
    ['yaml', yaml, ['yml']],
  ] as const) {
    hljs.registerLanguage(language, definition);
    if (aliases.length > 0) {
      hljs.registerAliases([...aliases], { languageName: language });
    }
  }

  hljs.registerLanguage('mermaid', () => ({
    name: 'Mermaid',
    case_insensitive: true,
    keywords: {
      keyword:
        'graph flowchart sequenceDiagram classDiagram stateDiagram stateDiagram-v2 erDiagram ' +
        'journey gantt pie gitGraph mindmap timeline quadrantChart requirementDiagram C4Context ' +
        'subgraph end participant actor as activate deactivate note over loop alt else opt par and ' +
        'rect critical break direction click linkStyle classDef class style state title section dateFormat ' +
        'axisFormat excludes includes todayMarker accTitle accDescr',
      literal: 'true false null',
      built_in: 'TB TD BT RL LR',
    },
    contains: [
      hljs.COMMENT('%%', '$'),
      hljs.QUOTE_STRING_MODE,
      hljs.APOS_STRING_MODE,
      hljs.C_NUMBER_MODE,
      {
        className: 'symbol',
        begin: /-->|---|-.->|==>|~~~|--|->|<--|<->/,
      },
      {
        className: 'meta',
        begin: /%%\{/,
        end: /\}%%/,
      },
    ],
  }));
  codeHighlightingReady = true;
}

export function normalizeCodeHighlightLanguage(lang: string): string {
  const language = lang.trim().toLowerCase();
  return HIGHLIGHT_ALIASES[language] ?? language;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function highlightRegisteredCode(
  highlighter: Pick<HLJSApi, 'highlight'>,
  text: string,
  language: string,
): string {
  return highlighter.highlight(text, { language, ignoreIllegals: true }).value;
}

export function highlightCode(text: string, lang: string): string {
  initializeCodeHighlighting();
  const language = normalizeCodeHighlightLanguage(lang);
  try {
    if (language && hljs.getLanguage(language)) {
      return highlightRegisteredCode(hljs, text, language);
    }
    if (!language && text.trim()) {
      const result = hljs.highlightAuto(text, autoHighlightLanguages);
      if (result.relevance >= 2) return result.value;
    }
  } catch {
    // Fall back to escaped plaintext.
  }
  return escapeHtml(text);
}
