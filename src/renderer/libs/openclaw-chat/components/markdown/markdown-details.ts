import MarkdownIt from 'markdown-it';
import htmlBlock from 'markdown-it/lib/rules_block/html_block.mjs';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';
import type Token from 'markdown-it/lib/token.mjs';

const MAX_DETAILS_DEPTH = 32;
const DETAILS_STACK = Symbol('markdownDetailsStack');
const SOURCE_OWNERSHIP = Symbol('markdownDetailsSourceOwnership');
const DISCLOSURE_LINE_RE = /^[ \t]*<\/?(?:details|summary)(?=[\s>])/i;
// Consume complete HTML tags, including quoted attribute values, before deciding
// whether a tag belongs to the deliberately small disclosure grammar.
const HTML_TAG_RE = /<(?:[^<>"']|"[^"]*"|'[^']*')*>/g;
const DETAILS_OPEN_RE = /^<details( open)?>$/i;
const DETAILS_CLOSE_RE = /^<\/details>$/i;
const SUMMARY_OPEN_RE = /^<summary>$/i;
const SUMMARY_CLOSE_RE = /^<\/summary>$/i;
const INLINE_RAW_HTML_OPEN_RE =
  /<!--|<\?|<!\[CDATA\[|<(pre|script|style|textarea)(?=[\s>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
const STREAMING_CONTAINER_TYPES = new Set([
  'blockquote_open',
  'bullet_list_open',
  'ordered_list_open',
  'list_item_open',
]);

type DetailsToken = Token;
type DetailsFrame = { hasSummary: boolean; accepted?: boolean; opening?: DetailsToken };
type DetailsBlockState = StateBlock & { [DETAILS_STACK]?: DetailsFrame[] };
type DetailsTokenSink = {
  push(type: string, tag: string, nesting: -1 | 0 | 1): DetailsToken;
};
type DisclosureTag = { start: number; end: number; raw: string };
type RawHtmlState = { context: string | null };
type SourceOwnership = {
  codeSpans: Array<[number, number]>;
  htmlTags: Array<[number, number]>;
  rawHtmlSpans: Array<[number, number]>;
  lineOffsets: number[];
};

// Disable HTML for this ownership pass so tag-shaped code examples cannot
// interrupt a paragraph before the inline parser sees both backtick delimiters.
const codeOwnershipParser = new MarkdownIt({ html: false });

function findSourceOwnership(source: string): SourceOwnership {
  const lineOffsets = [0];
  for (const match of source.matchAll(/\n/g)) lineOffsets.push(match.index + 1);
  const tokens: DetailsToken[] = [];
  codeOwnershipParser.block.parse(source, codeOwnershipParser, {}, tokens);
  const literalBlocks: Array<[number, number]> = [];
  const paragraphs: Array<[number, number]> = [];
  const containers: Array<[number, number]> = [];
  for (const token of tokens) {
    if (!token.map) continue;
    const start = lineOffsets[token.map[0]] ?? 0;
    const end = lineOffsets[token.map[1]] ?? source.length;
    if (STREAMING_CONTAINER_TYPES.has(token.type)) containers.push([start, end]);
    if (token.type === 'fence' || token.type === 'code_block') {
      literalBlocks.push([start, end]);
    }
    if (token.type === 'inline') paragraphs.push([start, end]);
  }
  const codeSpans: Array<[number, number]> = [];
  const htmlTags: Array<[number, number]> = [];
  const rawHtmlSpans: Array<[number, number]> = [];
  const lowerSource = source.toLowerCase();
  const rawScanner = new RegExp(INLINE_RAW_HTML_OPEN_RE.source, 'iy');
  const tagScanner = new RegExp(HTML_TAG_RE.source, 'y');
  // Resolve ownership in source order: code suppresses tag-shaped samples,
  // while raw script/pre text suppresses backticks before later prose is read.
  // This avoids pairing a raw-text backtick with a code delimiter in the answer.
  let index = 0;
  while (index < source.length) {
    const literal = literalBlocks.find(
      ([from, to]) =>
        from <= index &&
        index < to &&
        !rawHtmlSpans.some(([rawFrom, rawTo]) => rawFrom <= from && from < rawTo),
    );
    if (literal) {
      codeSpans.push(literal);
      index = literal[1];
      continue;
    }
    if (source[index] === '`' && !isEscaped(source, index)) {
      let runEnd = index + 1;
      while (source[runEnd] === '`') runEnd += 1;
      const paragraph = paragraphs.find(([from, to]) => from <= index && index < to);
      const blank = /\n[ \t]*\n/g;
      blank.lastIndex = index;
      const paragraphEnd = paragraph?.[1] ?? blank.exec(source)?.index ?? source.length;
      const length = runEnd - index;
      const closer = [...source.slice(runEnd, paragraphEnd).matchAll(/`+/g)].find(
        match => match[0].length === length,
      );
      if (closer) {
        const end = runEnd + closer.index + length;
        codeSpans.push([index, end]);
        index = end;
        continue;
      }
      index = runEnd;
      continue;
    }
    if (source[index] !== '<' || isEscaped(source, index)) {
      index += 1;
      continue;
    }
    rawScanner.lastIndex = index;
    const raw = rawScanner.exec(source);
    if (raw?.index === index) {
      const closer = raw[1]
        ? `</${raw[1].toLowerCase()}>`
        : raw[0] === '<!--'
          ? '-->'
          : raw[0] === '<?'
            ? '?>'
            : ']]>';
      const closing = lowerSource.indexOf(closer.toLowerCase(), index + raw[0].length);
      const containerEnd = containers.reduce(
        (end, [from, to]) => (from <= index && index < to ? Math.min(end, to) : end),
        source.length,
      );
      const end = Math.min(closing < 0 ? source.length : closing + closer.length, containerEnd);
      rawHtmlSpans.push([index, end]);
      index = end;
      continue;
    }
    tagScanner.lastIndex = index;
    const tag = tagScanner.exec(source);
    if (tag?.index === index) {
      htmlTags.push([index, index + tag[0].length]);
      index += tag[0].length;
    } else index += 1;
  }
  return { codeSpans, htmlTags, rawHtmlSpans, lineOffsets };
}

function isOwnedCode(index: number, ownership?: SourceOwnership): boolean {
  return ownership?.codeSpans.some(([from, to]) => from <= index && index < to) ?? false;
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/** Match inline delimiters within a parser-owned paragraph, including across lines. */
function findInlineCodeSpans(line: string): Array<[number, number]> {
  const runs = [...line.matchAll(/`+/g)];
  const nextRun = new Map<number, number>();
  const closers = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const length = runs[index][0].length;
    const next = nextRun.get(length);
    if (next !== undefined) closers.set(index, next);
    nextRun.set(length, index);
  }
  const spans: Array<[number, number]> = [];
  for (let index = 0; index < runs.length; index += 1) {
    const opener = runs[index];
    if (isEscaped(line, opener.index)) continue;
    const closeIndex = closers.get(index);
    if (closeIndex === undefined) continue;
    const closer = runs[closeIndex];
    spans.push([opener.index, closer.index + closer[0].length]);
    index = closeIndex;
  }
  return spans;
}

function scanDisclosureLine(
  line: string,
  ownership?: SourceOwnership,
  offset = 0,
): DisclosureTag[] | null {
  if (!DISCLOSURE_LINE_RE.test(line)) return null;
  const spans = ownership ? [] : findInlineCodeSpans(line);
  const tags: DisclosureTag[] = [];
  for (const match of line.matchAll(HTML_TAG_RE)) {
    const start = match.index;
    if (
      !/^<\/?(?:details|summary)(?=[\s>])/i.test(match[0]) ||
      isEscaped(line, start) ||
      isOwnedCode(offset + start, ownership) ||
      ownership?.rawHtmlSpans.some(([from, to]) => from <= offset + start && offset + start < to) ||
      ownership?.htmlTags.some(([from, to]) => from < offset + start && offset + start < to) ||
      spans.some(([from, to]) => from <= start && start < to)
    )
      continue;
    tags.push({ start, end: start + match[0].length, raw: match[0] });
  }
  return tags.length > 0 ? tags : null;
}

function walkDisclosureTags(
  tags: readonly DisclosureTag[],
  stack: DetailsFrame[],
  callbacks: {
    allowPendingSummary?: boolean;
    onOpen?: (tag: DisclosureTag, expanded: boolean) => DetailsToken;
    onClose?: (tag: DisclosureTag) => void;
    onSummary?: (open: DisclosureTag, close: DisclosureTag) => void;
  } = {},
): boolean {
  const nextSummaryCloses: number[] = [];
  let nearestClose = -1;
  for (let index = tags.length - 1; index >= 0; index -= 1) {
    nextSummaryCloses[index] = nearestClose;
    if (SUMMARY_CLOSE_RE.test(tags[index].raw)) nearestClose = index;
  }
  for (let index = 0; index < tags.length; index += 1) {
    const tag = tags[index];
    const opening = DETAILS_OPEN_RE.exec(tag.raw);
    if (opening) {
      const accepted = stack.length < MAX_DETAILS_DEPTH;
      stack.push({
        accepted,
        hasSummary: false,
        opening: accepted ? callbacks.onOpen?.(tag, Boolean(opening[1])) : undefined,
      });
    } else if (DETAILS_CLOSE_RE.test(tag.raw) && stack.length > 0) {
      const frame = stack.pop();
      if (frame?.accepted !== false) callbacks.onClose?.(tag);
    } else if (SUMMARY_OPEN_RE.test(tag.raw)) {
      const frame = stack[stack.length - 1];
      if (!frame || frame.accepted === false || frame.hasSummary) continue;
      const closeIndex = nextSummaryCloses[index];
      if (closeIndex >= 0) {
        callbacks.onSummary?.(tag, tags[closeIndex]);
        frame.hasSummary = true;
        if (frame.opening) frame.opening.meta = { ...frame.opening.meta, hasSummary: true };
        index = closeIndex;
      } else if (callbacks.allowPendingSummary) {
        return true;
      }
    }
  }
  return false;
}

function pushInlineBlock(
  sink: DetailsTokenSink,
  content: string,
  line: number,
  kind: 'paragraph' | 'summary' = 'paragraph',
): void {
  if (kind === 'paragraph' && !content.trim()) return;
  const open = sink.push(`${kind}_open`, kind === 'paragraph' ? 'p' : 'summary', 1);
  open.map = [line, line + 1];
  if (kind === 'summary') open.meta = { emptySummary: !content.trim() };
  const inline = sink.push('inline', '', 0);
  inline.map = [line, line + 1];
  inline.content = content;
  inline.children = [];
  sink.push(`${kind}_close`, kind === 'paragraph' ? 'p' : 'summary', -1);
}

function pushDisclosureLine(
  sink: DetailsTokenSink,
  line: string,
  lineNumber: number,
  stack: DetailsFrame[],
  originalTags: readonly DisclosureTag[],
  repairPendingSummary: boolean,
): void {
  let tags = originalTags;
  if (
    repairPendingSummary &&
    walkDisclosureTags(
      tags,
      stack.map(frame => ({ ...frame, opening: undefined })),
      {
        allowPendingSummary: true,
      },
    )
  ) {
    // This virtual closer belongs only to display tokens; source and copying stay exact.
    tags = [...tags, { start: line.length, end: line.length, raw: '</summary>' }];
  }
  let cursor = 0;
  const flushText = (tag: DisclosureTag, end = tag.end) => {
    pushInlineBlock(sink, line.slice(cursor, tag.start), lineNumber);
    cursor = end;
  };
  walkDisclosureTags(tags, stack, {
    onOpen(tag, expanded) {
      flushText(tag);
      const token = sink.push('details_open', 'details', 1);
      token.map = [lineNumber, lineNumber + 1];
      token.meta = { hasSummary: false };
      if (expanded) token.attrSet('open', '');
      return token;
    },
    onClose(tag) {
      flushText(tag);
      sink.push('details_close', 'details', -1).map = [lineNumber, lineNumber + 1];
    },
    onSummary(open, close) {
      flushText(open, close.end);
      pushInlineBlock(sink, line.slice(open.end, close.start), lineNumber, 'summary');
    },
  });
  pushInlineBlock(sink, line.slice(cursor), lineNumber);
}

function isStreamingFinalLine(source: string, line: number, env: Record<string, unknown>): boolean {
  return (
    env.streamingDetails === true &&
    !source.endsWith('\n') &&
    line === source.split('\n').length - 1
  );
}

function detailsBlockRule(
  state: DetailsBlockState,
  startLine: number,
  _endLine: number,
  silent: boolean,
): boolean {
  if (state.env?.allowDetails !== true || state.sCount[startLine] - state.blkIndent >= 4) {
    return false;
  }
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const line = state.src.slice(start, state.eMarks[startLine]);
  const tags = scanDisclosureLine(line, state.env[SOURCE_OWNERSHIP], start);
  if (!tags) return false;
  if (silent) return true;
  pushDisclosureLine(
    state,
    line,
    startLine,
    (state[DETAILS_STACK] ??= []),
    tags,
    isStreamingFinalLine(state.src, startLine, state.env),
  );
  state.line = startLine + 1;
  return true;
}

function consumeRawHtmlLine(line: string, state: RawHtmlState): boolean {
  const trimmed = line.trimStart();
  let context = state.context;
  if (!context) {
    if (trimmed.startsWith('<!--')) context = '-->';
    else if (trimmed.startsWith('<?')) context = '?>';
    else if (trimmed.startsWith('<![CDATA[')) context = ']]>';
    else if (/^<![A-Za-z]/.test(trimmed)) context = '>';
    else {
      const element = /^<(pre|script|style|textarea)(?=[\s>]|$)/i.exec(trimmed)?.[1];
      if (element) context = `</${element.toLowerCase()}>`;
    }
  }
  if (!context) return false;
  state.context = (context.startsWith('</') ? line.toLowerCase() : line).includes(context)
    ? null
    : context;
  return true;
}

export function installMarkdownDetails(
  parser: MarkdownIt,
  options: { fallbackLabel: () => string },
): void {
  parser.core.ruler.before('block', 'details_source_ownership', state => {
    if (state.env?.allowDetails === true)
      state.env[SOURCE_OWNERSHIP] = findSourceOwnership(state.src);
  });
  parser.block.ruler.at(
    'html_block',
    (state, startLine, endLine, silent) => {
      const start = state.bMarks[startLine] + state.tShift[startLine];
      if (state.env?.allowDetails === true && isOwnedCode(start, state.env[SOURCE_OWNERSHIP]))
        return false;
      return htmlBlock(state, startLine, endLine, silent);
    },
    { alt: ['paragraph', 'reference', 'blockquote'] },
  );
  parser.block.ruler.before('html_block', 'details_block', detailsBlockRule, {
    alt: ['paragraph', 'reference', 'blockquote'],
  });
  parser.core.ruler.after('block', 'details_balance', state => {
    if (state.env?.allowDetails !== true) return;
    const output: DetailsToken[] = [];
    const stack: DetailsFrame[] = [];
    for (const token of state.tokens) {
      if (token.type === 'details_open') stack.push({ hasSummary: false, opening: token });
      else if (token.type === 'summary_open') {
        const frame = stack[stack.length - 1];
        if (frame) {
          frame.hasSummary = true;
          if (frame.opening) frame.opening.meta = { ...frame.opening.meta, hasSummary: true };
        }
      } else if (token.type === 'details_close') stack.pop();
      if (token.type !== 'html_block' || stack.length === 0) {
        output.push(token);
        continue;
      }
      // Type-6/7 HTML blocks may absorb the real closer. Types 1-5 retain their
      // complete literal ownership, bounded by the native HTML token/container.
      const sink: DetailsTokenSink = {
        push(type, tag, nesting) {
          const next = new state.Token(type, tag, nesting);
          next.block = true;
          output.push(next);
          return next;
        },
      };
      const lines = token.content.split('\n');
      const ownership: SourceOwnership = state.env[SOURCE_OWNERSHIP];
      const rawHtml: RawHtmlState = { context: null };
      let pendingHtml = '';
      const flushHtml = () => {
        if (!pendingHtml) return;
        const raw = sink.push('html_block', '', 0);
        raw.content = pendingHtml;
        raw.map = token.map;
        pendingHtml = '';
      };
      for (const [offset, line] of lines.entries()) {
        const lineNumber = (token.map?.[0] ?? 0) + offset;
        const lineStart = ownership.lineOffsets[lineNumber] ?? state.src.length;
        const sourceLine = state.src.slice(
          lineStart,
          ownership.lineOffsets[lineNumber + 1] ?? state.src.length,
        );
        const lineOffset = lineStart + Math.max(0, sourceLine.indexOf(line));
        const tags = consumeRawHtmlLine(line, rawHtml)
          ? null
          : scanDisclosureLine(line, ownership, lineOffset);
        if (!tags) {
          pendingHtml += line + (offset < lines.length - 1 ? '\n' : '');
          continue;
        }
        flushHtml();
        pushDisclosureLine(
          sink,
          line,
          lineNumber,
          stack,
          tags,
          isStreamingFinalLine(state.src, lineNumber, state.env),
        );
      }
      flushHtml();
    }
    while (stack.length > 0) {
      const frame = stack.pop();
      if (frame?.accepted === false) continue;
      const token = new state.Token('details_close', 'details', -1);
      token.block = true;
      token.meta = { synthetic: true };
      output.push(token);
    }
    let level = 0;
    for (const token of output) {
      if (token.nesting < 0) level -= 1;
      token.level = level;
      if (token.nesting > 0) level += 1;
    }
    state.tokens = output;
  });
  parser.renderer.rules.details_open = (tokens, index) => {
    const token = tokens[index];
    const opening = `<details class="markdown-disclosure"${token.attrGet('open') === null ? '' : ' open'}>`;
    return token.meta?.hasSummary
      ? opening
      : `${opening}<summary>${parser.utils.escapeHtml(options.fallbackLabel())}</summary>`;
  };
  parser.renderer.rules.details_close = () => '</details>\n';
  parser.renderer.rules.summary_open = (tokens, index) =>
    tokens[index].meta?.emptySummary
      ? `<summary>${parser.utils.escapeHtml(options.fallbackLabel())}`
      : '<summary>';
  parser.renderer.rules.summary_close = () => '</summary>';
}

/** Use the rendered parser's ownership decisions instead of guessing inside code or raw HTML. */
export function constrainDetailsStreamingBoundary(
  source: string,
  parser: MarkdownIt,
  initialBoundary: number,
): { boundary: number; detailsTail: boolean } {
  const tokens = parser.parse(source, { allowDetails: true, streamingDetails: true });
  const offsets = [0];
  for (const match of source.matchAll(/\n/g)) offsets.push(match.index + 1);
  const containers: DetailsToken[] = [];
  const details: Array<{ start: number; containers: DetailsToken[] }> = [];
  const ranges: Array<[number, number]> = [];
  for (const token of tokens) {
    if (STREAMING_CONTAINER_TYPES.has(token.type)) containers.push(token);
    else if (
      token.nesting < 0 &&
      STREAMING_CONTAINER_TYPES.has(token.type.replace(/_close$/, '_open'))
    ) {
      containers.pop();
    }
    if (token.type === 'details_open') {
      details.push({ start: offsets[token.map?.[0] ?? 0] ?? 0, containers: [...containers] });
    } else if (token.type === 'details_close') {
      const opening = details.pop();
      if (!opening) continue;
      ranges.push([
        opening.start,
        token.meta?.synthetic
          ? source.length + 1
          : (offsets[token.map?.[1] ?? offsets.length] ?? source.length),
      ]);
      for (const container of opening.containers) {
        if (container.map)
          ranges.push([
            offsets[container.map[0]] ?? 0,
            offsets[container.map[1]] ?? source.length + 1,
          ]);
      }
    }
  }
  let boundary = initialBoundary;
  for (const [start, end] of ranges.sort((left, right) => right[0] - left[0])) {
    if (start < boundary && boundary < end) boundary = start;
  }
  return {
    boundary,
    detailsTail: ranges.some(([start, end]) => start >= boundary && end > boundary),
  };
}
