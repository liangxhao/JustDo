import MarkdownIt from 'markdown-it';

type ReasoningTag = { start: number; end: number; closing: boolean; pending: boolean; empty: boolean };
type TagEnvironment = {
  source: string;
  inlineSource: string;
  offset: number;
  tags: ReasoningTag[];
  restart?: number;
};

const names = ['think', 'thinking', 'thought', 'antthinking', 'antml:think', 'antml:thinking', 'mm:think', 'mm:thinking'];
const tagStart = /<\s*(\/?)\s*([a-z:]+)/iy;
const markdown = new MarkdownIt('commonmark');

function readTag(source: string, start: number): ReasoningTag | null {
  tagStart.lastIndex = start;
  const match = tagStart.exec(source);
  if (!match) return null;
  const name = match[2].toLowerCase();
  let end = tagStart.lastIndex;
  const known = names.includes(name);
  if (!known && !(end === source.length && names.some(value => value.startsWith(name)))) return null;
  if (end < source.length && !/[\s/>]/.test(source[end])) return null;
  let quote = '';
  for (; end < source.length; end++) {
    const char = source[end];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '<') return null;
    else if (char === '>') return {
      start, end: end + 1, closing: match[1] === '/', pending: false,
      empty: /\/\s*$/.test(source.slice(tagStart.lastIndex, end)),
    };
  }
  return { start, end, closing: match[1] === '/', pending: true, empty: false };
}

// Markdown decides whether an opening tag is literal. Inside a confirmed thought,
// delimiters are protocol text: unmatched Markdown must not swallow its closing tag.
markdown.inline.ruler.before('autolink', 'reasoning_tag', (state, silent) => {
  if (state.src[state.pos] !== '<') return false;
  const env = state.env as TagEnvironment;
  if (env.restart !== undefined) return false;
  if (state.src !== env.inlineSource) return false; // Image alt is parsed recursively.
  const tag = readTag(env.source, env.offset + state.pos);
  if (!tag || tag.closing) return false;
  if (silent) {
    state.pos += tag.end - tag.start;
    return true;
  }
  env.tags.push(tag);
  let end = tag.end;
  let depth = tag.empty ? 0 : 1;
  while (depth > 0 && end < env.source.length) {
    const start = env.source.indexOf('<', end);
    if (start < 0) { end = env.source.length; break; }
    const next = readTag(env.source, start);
    if (!next) { end = start + 1; continue; }
    env.tags.push(next);
    end = next.end;
    if (next.closing) depth--;
    else if (!next.empty) depth++;
  }
  if (end > env.offset + state.posMax) env.restart = end;
  state.pos = Math.min(end - env.offset, state.posMax);
  return true;
});

/** Partition cumulative legacy text for display; native message bytes stay authoritative. */
export function partitionTaggedReasoning(source: string): { text: string; thinking: string } {
  if (!/<\s*\/?\s*[a-z:]*t/i.test(source)) return { text: source, thinking: '' };
  const tags: ReasoningTag[] = [];
  const references = {};
  let offset = 0;
  while (offset < source.length) {
    const fragment = source.slice(offset);
    const lines = [0];
    for (const match of fragment.matchAll(/\r\n|\r|\n/g)) lines.push(match.index + match[0].length);
    const blocks: ReturnType<typeof markdown.parse> = [];
    markdown.block.parse(fragment, markdown, references, blocks);
    let restart: number | undefined;
    let parsedEnd = offset;
    for (const block of blocks) {
      // Reference definitions and code blocks have no inline token. Preserve their
      // original bytes and retain the reference environment for images and links.
      if ((block.type !== 'inline' && block.type !== 'html_block') || !block.map) continue;
      const start = Math.max(parsedEnd, offset + (lines[block.map[0]] ?? fragment.length));
      const end = offset + (lines[block.map[1]] ?? fragment.length);
      if (start >= end) continue;
      const inlineSource = source.slice(start, end);
      if (block.type === 'html_block' && /^\s*<(?:pre|script|style|textarea)(?:\s|>)/i.test(block.content)) continue;
      const env: TagEnvironment = { ...references, source, inlineSource, offset: start, tags };
      markdown.inline.parse(inlineSource, markdown, env, []);
      parsedEnd = end;
      if (env.restart !== undefined) { restart = env.restart; break; }
    }
    if (restart === undefined) break;
    // A hidden thought can contain unfinished fences or span Markdown blocks.
    // Resume external Markdown at the real closing delimiter, not inside that fence.
    offset = restart;
  }
  if (!tags.length) return { text: source, thinking: '' };
  let depth = 0;
  let text = '';
  let thinking = '';
  let cursor = 0;
  for (const tag of tags) {
    if (depth > 0) thinking += source.slice(cursor, tag.start);
    else text += source.slice(cursor, tag.start);
    cursor = tag.end;
    if (tag.pending) {
      cursor = source.length;
      break;
    }
    if (tag.closing) depth--;
    else if (!tag.empty) {
      if (depth === 0 && thinking && !thinking.endsWith('\n')) thinking += '\n';
      depth++;
    }
  }
  if (depth > 0) thinking += source.slice(cursor);
  else text += source.slice(cursor);
  return { text, thinking: thinking.trim() };
}
