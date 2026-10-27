import { isLocalHtmlFilePath } from '@shared/browser/browserLinkOpening';
import {
  MessageFileLinkSourceKind,
  type MessageFileLinkTarget,
} from '@shared/preview/messageFileLink';

export const matchAutoLinkPathPrefix = (value: string): string | null => {
  const match =
    value.match(/^file:\/\/[^\s<>"'`|[\]{}]+/i) ??
    value.match(/^[A-Za-z]:[\\/][^\s<>"'`|[\]{}]+/) ??
    // A POSIX path starts with exactly one slash. Two slashes may be the
    // authority marker in an URL (for example https://example.com/path).
    value.match(/^\/(?!\/)(?:[^\s<>"'`|[\]{}]+\/)+[^\s<>"'`|[\]{}]+/);

  return match?.[0] ?? null;
};

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const ENCODED_SEPARATOR = /%(?:2f|5c)/iu;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/u;
const ORDINARY_FILE_NAME = /^[\p{L}\p{M}\p{N}_-][\p{L}\p{M}\p{N}_.-]*\.[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const SIMPLE_DIRECTORY_NAME = /^[\p{L}\p{M}\p{N}_.-]+$/u;
const SENTENCE_SEPARATOR = /[,;!，。；！？、]/u;
const QUOTE_PAIRS: Readonly<Record<string, string>> = {
  '"': '"', "'": "'", '“': '”', '‘': '’', '「': '」', '『': '』',
};

export interface MessageFilePathMatch {
  start: number;
  end: number;
  reference: MessageFileLinkTarget;
}

/** Native names have no URI conversion, including percent decoding. */
export const parseSimpleMessageFilePath = (value: string): MessageFileLinkTarget | null => {
  if (!WINDOWS_ABSOLUTE.test(value) || CONTROL_CHARACTERS.test(value)) return null;
  const parts = value.slice(3).split(/[\\/]/u);
  const name = parts.pop();
  if (!name || !ORDINARY_FILE_NAME.test(name)) return null;
  if (parts.some(part => !SIMPLE_DIRECTORY_NAME.test(part) || part === '.' || part === '..'))
    return null;
  return { sourceKind: MessageFileLinkSourceKind.NativePath, target: value };
};

/** Validate URL syntax here; only Main converts the encoded URL to a native path. */
export const parseMessageFileUrl = (value: string): MessageFileLinkTarget | null => {
  if (!/^file:\/\/\//iu.test(value) || /[\s\\<>"'`|]/u.test(value) || ENCODED_SEPARATOR.test(value))
    return null;
  try {
    const url = new URL(value);
    const path = decodeURIComponent(url.pathname);
    if (
      url.hostname || !path.startsWith('/') || path.startsWith('//') ||
      CONTROL_CHARACTERS.test(path) || /[\\]/u.test(path) ||
      /^\/(?:[?.](?:\/|$)|[A-Za-z]:\/[/\\])/u.test(path)
    ) return null;
    const navigationSuffix = url.search + url.hash;
    if (navigationSuffix && !isLocalHtmlFilePath(path)) return null;
    // Preserve the original encoding. A literal %25 must not become a second escape.
    return {
      sourceKind: MessageFileLinkSourceKind.FileUrl,
      target: navigationSuffix ? value.slice(0, value.search(/[?#]/u)) : value,
      ...(navigationSuffix ? { navigationSuffix } : {}),
    };
  } catch {
    return null;
  }
};

export const parseMessageFileCode = (value: string): MessageFileLinkTarget | null =>
  parseSimpleMessageFilePath(value) ?? parseMessageFileUrl(value);

/** The raw destination is checked before Markdown can unescape native backslashes. */
export const parseMessageFileDestination = (
  value: string,
  rawDestination: string,
): MessageFileLinkTarget | null => {
  if (
    /[\\\r\n]/u.test(rawDestination) || /%(?![a-f\d]{2})/iu.test(rawDestination) ||
    CONTROL_CHARACTERS.test(value) || ENCODED_SEPARATOR.test(value)
  ) return null;
  if (/^file:/iu.test(value)) return parseMessageFileUrl(value);
  if (!/^(?:[A-Za-z]:\/|\.\.?\/)/u.test(value) || /[\\]/u.test(value)) return null;
  try {
    const suffixIndex = value.search(/[?#]/u);
    const encodedPath = suffixIndex < 0 ? value : value.slice(0, suffixIndex);
    const path = decodeURIComponent(encodedPath);
    const name = path.split('/').pop() ?? '';
    if (
      CONTROL_CHARACTERS.test(path) || /[\\]/u.test(path) ||
      !/^(?:[A-Za-z]:\/|\.\.?\/)/u.test(path) ||
      !/^[^.].*\.[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(name)
    ) return null;
    const navigationSuffix = suffixIndex < 0 ? '' : value.slice(suffixIndex);
    if (navigationSuffix && !isLocalHtmlFilePath(path)) return null;
    return {
      sourceKind: MessageFileLinkSourceKind.MarkdownUri,
      target: encodedPath,
      ...(navigationSuffix ? { navigationSuffix } : {}),
    };
  } catch {
    return null;
  }
};

const hasPathStartBoundary = (source: string, position: number): boolean => {
  if (position === 0 || /[\s(（：]/u.test(source[position - 1])) return true;
  // An ASCII scheme colon is not a new local-path boundary (data:C:/...).
  if (source[position - 1] === ':' && (position === 1 || /\s/u.test(source[position - 2])))
    return true;
  return /(?:^|[\s(（：])(?:\*{1,3}|_{1,3})$/u.test(source.slice(0, position));
};

const skipCodeSpan = (source: string, start: number): number => {
  let markerEnd = start + 1;
  while (source[markerEnd] === '`') markerEnd += 1;
  const markerLength = markerEnd - start;
  let position = markerEnd;
  while ((position = source.indexOf('`', position)) >= 0) {
    let end = position + 1;
    while (source[end] === '`') end += 1;
    if (end - position === markerLength) return end;
    position = end;
  }
  return source.length;
};

const skipBracketSpan = (source: string, start: number): number => {
  let depth = 1;
  let position = start + 1;
  for (; position < source.length; position += 1) {
    if (source[position] === '\\') { position += 1; continue; }
    if (source[position] === '`') { position = skipCodeSpan(source, position) - 1; continue; }
    if (source[position] === '[') depth += 1;
    if (source[position] === ']' && --depth === 0) break;
  }
  if (position >= source.length) return source.length;
  position += 1;
  if (source[position] !== '(') return position;
  depth = 1;
  for (position += 1; position < source.length; position += 1) {
    if (source[position] === '\\') { position += 1; continue; }
    if (source[position] === '(') depth += 1;
    if (source[position] === ')' && --depth === 0) return position + 1;
  }
  return source.length;
};

/**
 * Bounded source scanner. Rejected clauses and explicit Markdown contexts are
 * consumed as a whole, so a valid-looking prefix is never salvaged from them.
 */
export const findBareMessageFilePaths = (
  source: string,
  options: { sourceComplete?: boolean } = {},
): MessageFilePathMatch[] => {
  const matches: MessageFilePathMatch[] = [];
  const outerClosers: string[] = [];
  for (let position = 0; position < source.length;) {
    const character = source[position];
    if (character === '`') { position = skipCodeSpan(source, position); continue; }
    if (character === '[') { position = skipBracketSpan(source, position); continue; }
    const closingQuote = QUOTE_PAIRS[character];
    if (closingQuote && (position === 0 || !/[\p{L}\p{M}\p{N}]/u.test(source[position - 1]))) {
      const close = source.indexOf(closingQuote, position + 1);
      position = close < 0 ? source.length : close + 1;
      continue;
    }
    if (character === '<') {
      const tag = source.slice(position).match(/^<([A-Za-z][\w:-]*)\b[^>]*>/u);
      const closing = tag ? new RegExp(`</${tag[1]}\\s*>`, 'iu').exec(source.slice(position + tag[0].length)) : null;
      const end = source.indexOf('>', position + 1);
      position = tag
        ? closing ? position + tag[0].length + closing.index + closing[0].length : source.length
        : end < 0 ? source.length : end + 1;
      continue;
    }
    if (character === '$' || (character === '\\' && /[([]/u.test(source[position + 1] ?? ''))) {
      const marker = character === '$' ? '$' : source.slice(position, position + 2);
      const closeMarker = marker === '\\(' ? '\\)' : marker === '\\[' ? '\\]' : marker;
      const close = source.indexOf(closeMarker, position + marker.length);
      position = close < 0 ? source.length : close + closeMarker.length;
      continue;
    }
    if (character === '(' || character === '（') outerClosers.push(character === '(' ? ')' : '）');
    if (outerClosers[outerClosers.length - 1] === character) outerClosers.pop();
    const startsPath = /^[A-Za-z]:[\\/]/u.test(source.slice(position, position + 3)) ||
      /^file:\/\/\//iu.test(source.slice(position, position + 8));
    if (!startsPath || !hasPathStartBoundary(source, position)) { position += 1; continue; }

    const start = position;
    const fileUrl = /^file:/iu.test(source.slice(start, start + 5));
    const emphasis = source.slice(0, start).match(/(?:^|[\s(（：])(\*{1,3}|_{1,3})$/u)?.[1];
    const isBoundary = (index: number): boolean =>
      (!fileUrl && SENTENCE_SEPARATOR.test(source[index] ?? '')) ||
      outerClosers[outerClosers.length - 1] === source[index] ||
      Boolean(emphasis && source.startsWith(emphasis, index));
    while (position < source.length && !/\s/u.test(source[position]) && !isBoundary(position))
      position += 1;
    const end = position;
    let boundary = position;
    while (boundary < source.length && /[ \t]/u.test(source[boundary])) boundary += 1;
    const hasRightBoundary = boundary < source.length
      ? source[boundary] === '\n' || isBoundary(boundary)
      : options.sourceComplete !== false;
    const reference = hasRightBoundary ? parseMessageFileCode(source.slice(start, end)) : null;
    if (reference) matches.push({ start, end, reference });
    if (!hasRightBoundary) {
      // The suffix may be a spaced filename. Exclude the complete clause.
      while (position < source.length && source[position] !== '\n' && !isBoundary(position))
        position += 1;
    }
    if (position === start) position += 1;
  }
  return matches;
};
