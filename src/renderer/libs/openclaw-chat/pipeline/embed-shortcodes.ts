import MarkdownIt from 'markdown-it';

const MAX_SHORTCODE_CHARS = 32_768;
const markdown = new MarkdownIt('commonmark');
type Range = { start: number; end: number };

export type EmbedShortcodeSegment =
  | { type: 'text'; text: string; start: number; end: number }
  | {
      type: 'embed';
      attributes: Readonly<Record<string, string>>;
      rawText: string;
      fallbackText?: string;
      start: number;
      end: number;
    };

function escaped(source: string, offset: number): boolean {
  let slashes = 0;
  while (offset > 0 && source[--offset] === '\\') slashes++;
  return slashes % 2 === 1;
}

/** Markdown owns literal examples, including indented and unfinished fenced code. */
function codeRanges(source: string): Range[] {
  const lines = [0];
  for (const match of source.matchAll(/\r\n|\r|\n/g)) lines.push(match.index + match[0].length);
  const ranges: Range[] = [];
  const inlineRanges: Range[] = [];
  for (const token of markdown.parse(source, {})) {
    if (token.type === 'inline' && token.map)
      inlineRanges.push({
        start: lines[token.map[0]] ?? source.length,
        end: lines[token.map[1]] ?? source.length,
      });
    if (
      !token.map ||
      (token.type !== 'fence' &&
        token.type !== 'code_block' &&
        !(
          token.type === 'html_block' &&
          /^\s*<(?:pre|script|style|textarea)(?:\s|>)/i.test(token.content)
        ))
    )
      continue;
    ranges.push({
      start: lines[token.map[0]] ?? source.length,
      end: lines[token.map[1]] ?? source.length,
    });
  }
  for (const inline of inlineRanges) {
    const runs = Array.from(source.slice(inline.start, inline.end).matchAll(/`+/g), match => ({
      start: inline.start + match.index,
      end: inline.start + match.index + match[0].length,
      length: match[0].length,
      next: -1,
    }));
    const nextByLength = new Map<number, number>();
    for (let index = runs.length - 1; index >= 0; index--) {
      runs[index].next = nextByLength.get(runs[index].length) ?? -1;
      nextByLength.set(runs[index].length, index);
    }
    for (let index = 0; index < runs.length; index++) {
      const run = runs[index];
      if (escaped(source, run.start)) continue;
      if (run.next < 0) {
        // A cumulative stream may still close this inline example. Retain its
        // paragraph literally instead of starting a page that later becomes code.
        ranges.push({ start: run.start, end: inline.end });
        break;
      }
      ranges.push({ start: run.start, end: runs[run.next].end });
      index = run.next;
    }
  }
  const merged: Range[] = [];
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    const previous = merged[merged.length - 1];
    if (previous && previous.end >= range.start) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function overlapsCode(regions: readonly Range[], start: number, end: number): boolean {
  let low = 0;
  let high = regions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (regions[middle].end <= start) low = middle + 1;
    else high = middle;
  }
  return low < regions.length && regions[low].start < end;
}

function attributesFrom(raw: string): Record<string, string> | undefined {
  const attributes: Record<string, string> = Object.create(null);
  const expression = /\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy;
  let cursor = 0;
  while (cursor < raw.length) {
    if (!raw.slice(cursor).trim()) break;
    expression.lastIndex = cursor;
    const match = expression.exec(raw);
    if (!match) return;
    const key = match[1].toLowerCase();
    if (Object.prototype.hasOwnProperty.call(attributes, key)) return;
    attributes[key] = match[2] ?? match[3];
    cursor = expression.lastIndex;
    // Attributes must be separated; a quote cannot silently start another name.
    if (cursor < raw.length && !/\s/.test(raw[cursor])) return;
  }
  if (attributes.target !== undefined && attributes.target !== 'assistant_message') return;
  if (attributes.ref !== undefined && attributes.viewid !== undefined) return;
  const identity = ['url', 'ref', 'viewid'].filter(key =>
    Object.prototype.hasOwnProperty.call(attributes, key),
  );
  if (!identity.length || identity.some(key => !attributes[key].trim())) return;
  return attributes;
}

/** Complete, bounded shortcodes only; all rejected bytes remain visible text. */
export function scanEmbedShortcodes(source: string): EmbedShortcodeSegment[] {
  if (!/\[embed\s/i.test(source))
    return source ? [{ type: 'text', text: source, start: 0, end: source.length }] : [];
  const regions = codeRanges(source);
  const segments: EmbedShortcodeSegment[] = [];
  const expression = /\[embed\s+/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(source))) {
    const start = match.index;
    if (start < cursor || escaped(source, start) || overlapsCode(regions, start, start + 1))
      continue;
    const limit = Math.min(source.length, start + MAX_SHORTCODE_CHARS);
    let quote = '';
    let openEnd = expression.lastIndex;
    for (; openEnd < limit; openEnd++) {
      const char = source[openEnd];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === ']') break;
      else if (char === '[') break;
    }
    if (source[openEnd] !== ']' || openEnd >= limit) continue;
    const rawAttributes = source.slice(expression.lastIndex, openEnd);
    const selfClosing = /\/\s*$/.test(rawAttributes);
    const attributes = attributesFrom(
      selfClosing ? rawAttributes.replace(/\/\s*$/, '') : rawAttributes,
    );
    if (!attributes) continue;
    let end = openEnd + 1;
    let fallbackText: string | undefined;
    if (!selfClosing) {
      const closing = /\[\/embed\s*\]/gi;
      closing.lastIndex = end;
      const close = closing.exec(source);
      if (!close || close.index + close[0].length > limit || escaped(source, close.index)) continue;
      fallbackText = source.slice(end, close.index);
      // Nested candidates and code boundaries must not consume literal examples.
      end = close.index + close[0].length;
      if (/\[\/?embed(?:\s|\])/i.test(fallbackText)) {
        expression.lastIndex = end;
        continue;
      }
    }
    if (overlapsCode(regions, start, end)) continue;
    if (start > cursor)
      segments.push({ type: 'text', text: source.slice(cursor, start), start: cursor, end: start });
    segments.push({
      type: 'embed',
      attributes,
      rawText: source.slice(start, end),
      start,
      end,
      ...(fallbackText !== undefined ? { fallbackText } : {}),
    });
    cursor = end;
    expression.lastIndex = end;
  }
  if (cursor < source.length)
    segments.push({ type: 'text', text: source.slice(cursor), start: cursor, end: source.length });
  return segments;
}

/** Use the same literal/code rules when suppressing an exact native fallback. */
export function stripEmbedShortcodes(
  text: string,
  shouldStrip: (attributes: Readonly<Record<string, string>>) => boolean,
): string {
  return scanEmbedShortcodes(text)
    .map(segment =>
      segment.type === 'embed' && shouldStrip(segment.attributes)
        ? ''
        : segment.type === 'text'
          ? segment.text
          : segment.rawText,
    )
    .join('');
}

/** Keep native block boundaries while sharing code ownership across adjacent text. */
export function stripEmbedShortcodesFromTextParts(
  parts: readonly string[],
  shouldStrip: (attributes: Readonly<Record<string, string>>) => boolean,
): string[] {
  const source = parts.join('\n');
  const removed = scanEmbedShortcodes(source).filter(
    segment => segment.type === 'embed' && shouldStrip(segment.attributes),
  );
  let offset = 0;
  let removedIndex = 0;
  return parts.map(part => {
    const start = offset;
    const end = start + part.length;
    offset = end + 1;
    let cursor = start;
    let text = '';
    while (removedIndex < removed.length && removed[removedIndex].end <= start) removedIndex++;
    for (let index = removedIndex; index < removed.length && removed[index].start < end; index++) {
      const range = removed[index];
      text += source.slice(cursor, Math.max(cursor, range.start));
      cursor = Math.min(end, range.end);
    }
    return text + source.slice(cursor, end);
  });
}
