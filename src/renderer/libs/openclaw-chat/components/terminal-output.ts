import { html } from 'lit';

// ANSI colors coordinated with the dark Monokai-style terminal card.
const COLORS = [
  '#75715e',
  '#f92672',
  '#a6e22e',
  '#e6db74',
  '#66d9ef',
  '#ae81ff',
  '#a1efe4',
  '#f8f8f2',
  '#a6a69c',
  '#ff6188',
  '#b7ea46',
  '#fff27a',
  '#8be9fd',
  '#c9a7ff',
  '#b5fff3',
  '#ffffff',
];

type TerminalSegment = { text: string; color: string; bold: boolean };

/** Conservative highlighting for plain command output; original spacing stays intact. */
function highlightPlainTerminal(source: string): TerminalSegment[] {
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const result: TerminalSegment[] = [];
  const add = (text: string, kind = '', bold = false) => {
    if (text) result.push({ text, color: kind ? `var(--terminal-${kind})` : '', bold });
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const separator = (value: string) => /^\s*-{2,}(?:\s+-{2,})*\s*$/.test(value);
    if (separator(line)) {
      add(line, 'muted');
      continue;
    }
    if (line.trim() && lines[index + 1] && separator(lines[index + 1])) {
      add(line, 'header', true);
      continue;
    }
    // PowerShell file rows: keep filename (including spaces) as one token.
    const row = /^(\s*[dlarhs-]{4,}\s+)(.*?)(\s+\d+\s+)(.+?)(\n?)$/i.exec(line);
    const body = row ? row[1] + row[2] + row[3] : line;
    const tokens =
      /[A-Za-z]:\\[^\r\n]*|\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
    let cursor = 0;
    for (const match of body.matchAll(tokens)) {
      add(body.slice(cursor, match.index));
      add(match[0], /^[A-Za-z]:/.test(match[0]) ? 'path' : 'number');
      cursor = match.index! + match[0].length;
    }
    add(body.slice(cursor));
    if (row) {
      add(row[4], 'file');
      add(row[5]);
    }
  }
  return result;
}

/** Text-only ANSI projection: never interprets terminal content as HTML or links. */
export function terminalSegments(
  source: string,
): Array<{ text: string; color: string; bold: boolean }> {
  const segments: Array<{ text: string; color: string; bold: boolean }> = [];
  let color = '';
  let bold = false;
  let cursor = 0;
  const push = (text: string) => {
    if (text) segments.push({ text: text.replace(/\r\n/g, '\n'), color, bold });
  };
  // Consume OSC (including hyperlink/title payloads) and CSI sequences.
  const controls = /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g;
  for (const match of source.matchAll(controls)) {
    push(source.slice(cursor, match.index));
    cursor = match.index! + match[0].length;
    if (!match[0].startsWith('\x1b[') || !match[0].endsWith('m')) continue;
    const codes = match[0]
      .slice(2, -1)
      .split(';')
      .map(value => Number(value || 0));
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) {
        color = '';
        bold = false;
      } else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) color = '';
      else if (code >= 30 && code <= 37) color = COLORS[code - 30];
      else if (code >= 90 && code <= 97) color = COLORS[code - 90 + 8];
      else if (code === 38 || code === 48) {
        // Skip extended color payloads instead of interpreting them as SGR flags.
        i += codes[i + 1] === 2 ? 4 : codes[i + 1] === 5 ? 2 : 0;
      }
    }
  }
  push(source.slice(cursor));
  // Explicit ANSI styling takes precedence; plain captured output gets semantic colors.
  return segments.some(segment => segment.color || segment.bold)
    ? segments
    : highlightPlainTerminal(segments.map(segment => segment.text).join(''));
}

export function renderTerminalPage(
  segments: ReturnType<typeof terminalSegments>,
  start: number,
  end: number,
) {
  let offset = 0;
  const visible = [];
  for (const segment of segments) {
    const from = Math.max(0, start - offset);
    const to = Math.min(segment.text.length, end - offset);
    if (to > from)
      visible.push(
        html`<span
          style=${`color: ${segment.color || 'inherit'}; font-weight: ${segment.bold ? '600' : 'inherit'}`}
          >${segment.text.slice(from, to)}</span
        >`,
      );
    offset += segment.text.length;
    if (offset >= end) break;
  }
  return visible;
}
