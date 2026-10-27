import { parseLocalHtmlLink } from '@shared/browser/browserLinkOpening';
import type { MessageFileLinkTarget } from '@shared/preview/messageFileLink';
import type MarkdownIt from 'markdown-it';
import backticks from 'markdown-it/lib/rules_inline/backticks.mjs';
import link from 'markdown-it/lib/rules_inline/link.mjs';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import type Token from 'markdown-it/lib/token.mjs';

import {
  findBareMessageFilePaths,
  type MessageFilePathMatch,
  parseMessageFileCode,
  parseMessageFileDestination,
} from './markdownPathLinks';

const FILE_REFERENCE = Symbol('messageFileReference');
const INLINE_MATCHES = new WeakMap<StateInline, MessageFilePathMatch[]>();
const TOKEN_ATTRIBUTE = 'data-message-file-token';

export type MessageFileLinkRegistry = Map<string, MessageFileLinkTarget>;

const getReference = (token: Token): MessageFileLinkTarget | undefined =>
  token.meta?.[FILE_REFERENCE];

const markReference = (token: Token, reference: MessageFileLinkTarget): void => {
  token.meta = { ...token.meta, [FILE_REFERENCE]: reference };
};

const isInLink = (state: StateInline): boolean =>
  'linkLevel' in state && typeof state.linkLevel === 'number' && state.linkLevel > 0;

function rawLinkDestination(state: StateInline): string | null {
  const labelEnd = state.md.helpers.parseLinkLabel(state, state.pos, true);
  if (labelEnd < 0 || state.src[labelEnd + 1] !== '(') return null;
  let position = labelEnd + 2;
  while (/\s/u.test(state.src[position] ?? '') && position < state.posMax) position += 1;
  const destination = state.md.helpers.parseLinkDestination(state.src, position, state.posMax);
  return destination.ok ? state.src.slice(position, destination.pos) : null;
}

function trustedLinkOpening(reference: MessageFileLinkTarget, env: Record<string, unknown>): string {
  const registry = env.messageFileLinkRegistry as MessageFileLinkRegistry;
  const nonce = globalThis.crypto.randomUUID();
  registry.set(nonce, reference);
  return `<a href="#" ${TOKEN_ATTRIBUTE}="${nonce}">`;
}

/** Called by DOMPurify only while sanitizing this render's generated HTML. */
export function sanitizeMessageFileLinkNode(
  node: Element,
  registry: MessageFileLinkRegistry | undefined,
): boolean {
  const nonce = node.getAttribute(TOKEN_ATTRIBUTE);
  const reference = nonce ? registry?.get(nonce) : undefined;
  for (const attribute of [...node.attributes]) {
    if (attribute.name.startsWith('data-message-file-')) node.removeAttribute(attribute.name);
  }
  if (!reference || node.tagName.toLowerCase() !== 'a') return false;
  // A nonce can admit exactly one generated anchor, never another raw node.
  registry?.delete(nonce!);
  node.setAttribute('href', '#');
  node.setAttribute('data-message-file-target', reference.target);
  node.setAttribute('data-message-file-kind', reference.sourceKind);
  if (reference.navigationSuffix)
    node.setAttribute('data-message-file-suffix', reference.navigationSuffix);
  return true;
}

/** Install only after the legacy HTML rules, whose compatibility stays intact. */
export function installMessageFileLinks(md: MarkdownIt): void {
  md.core.ruler.at('inline', state => {
    const sourceLineCount = state.src.split('\n').length;
    for (const token of state.tokens) {
      if (token.type !== 'inline' || !token.children) continue;
      const env = state.env.fileLinks
        ? {
            ...state.env,
            messageFileSourceComplete: !state.env.fileLinksStreaming ||
              Boolean(token.map && token.map[1] < sourceLineCount),
          }
        : state.env;
      state.md.inline.parse(token.content, state.md, env, token.children);
    }
  });

  md.inline.ruler.before('local_html_path', 'message_file_path', (state, silent) => {
    if (!state.env.fileLinks || isInLink(state)) return false;
    let matches = INLINE_MATCHES.get(state);
    if (!matches) {
      matches = findBareMessageFilePaths(state.src, {
        sourceComplete: state.env.messageFileSourceComplete !== false,
      });
      INLINE_MATCHES.set(state, matches);
    }
    const match = matches.find(candidate => candidate.start >= state.pos && candidate.end <= state.posMax);
    if (!match) return false;
    const prefix = state.src.slice(state.pos, match.start);
    // Let existing syntax process delimiters before looking ahead again.
    if (/[\n\\`*_{}\[\]<>&!$]/u.test(prefix)) return false;
    if (!silent) {
      if (prefix) state.push('text', '', 0).content = prefix;
      const opening = state.push('link_open', 'a', 1);
      opening.attrSet('href', '#');
      markReference(opening, match.reference);
      state.push('text', '', 0).content = state.src.slice(match.start, match.end);
      state.push('link_close', 'a', -1);
    }
    state.pos = match.end;
    return true;
  });

  md.inline.ruler.before('backticks', 'message_file_code', (state, silent) => {
    if (!state.env.fileLinks || state.src[state.pos] !== '`' || isInLink(state)) return false;
    const start = state.pos;
    const firstToken = state.tokens.length;
    if (!backticks(state, silent)) return false;
    if (!silent) {
      const token = state.tokens.slice(firstToken).find(item => item.type === 'code_inline');
      if (token) {
        const raw = state.src.slice(start + token.markup.length, state.pos - token.markup.length);
        const reference = !/\s/u.test(raw) ? parseMessageFileCode(raw) : null;
        if (reference) markReference(token, reference);
      }
    }
    return true;
  });

  md.inline.ruler.before('link', 'message_file_destination', (state, silent) => {
    if (!state.env.fileLinks || state.src[state.pos] !== '[') return false;
    const raw = rawLinkDestination(state);
    const firstToken = state.tokens.length;
    if (!link(state, silent)) return false;
    if (!silent && raw !== null) {
      const opening = state.tokens.slice(firstToken).find(token => token.type === 'link_open');
      const href = opening?.attrGet('href');
      // Existing HTML decoding/navigation remains the old explicit contract.
      if (opening && href && !parseLocalHtmlLink(href)) {
        const reference = parseMessageFileDestination(href, raw);
        if (reference) markReference(opening, reference);
      }
    }
    return true;
  });

  md.core.ruler.after('local_html_link', 'message_file_link_targets', state => {
    if (!state.env.messageFileLinksMode) return;
    for (const block of state.tokens) {
      if (block.type !== 'inline' || !block.children) continue;
      const suppressed: boolean[] = [];
      for (const token of block.children) {
        if (token.type === 'link_open') {
          const href = token.attrGet('href') ?? '';
          const reject = !getReference(token) && !parseLocalHtmlLink(href) &&
            !/^(?:https?:|mailto:|#)/iu.test(href);
          suppressed.push(reject);
          if (reject) { token.tag = 'span'; token.attrs = null; }
        } else if (token.type === 'link_close' && suppressed.pop()) {
          token.tag = 'span';
        }
      }
    }
  });

  const originalLinkOpening = md.renderer.rules.link_open;
  md.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    const reference = getReference(tokens[index]);
    if (reference && env?.messageFileLinkRegistry) return trustedLinkOpening(reference, env);
    return originalLinkOpening
      ? originalLinkOpening(tokens, index, options, env, renderer)
      : renderer.renderToken(tokens, index, options);
  };
  const originalCodeInline = md.renderer.rules.code_inline;
  md.renderer.rules.code_inline = (tokens, index, options, env, renderer) => {
    const rendered = originalCodeInline
      ? originalCodeInline(tokens, index, options, env, renderer)
      : `<code>${md.utils.escapeHtml(tokens[index].content)}</code>`;
    const reference = getReference(tokens[index]);
    return reference && env?.messageFileLinkRegistry
      ? `${trustedLinkOpening(reference, env)}${rendered}</a>`
      : rendered;
  };
}
