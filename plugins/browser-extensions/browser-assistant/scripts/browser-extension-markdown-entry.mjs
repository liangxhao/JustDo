import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: false,
});

// Admit disclosure structure without enabling arbitrary message HTML.
const disclosureTag = /^<(\/?)(details|summary)(?:\s[^<>]*?)?>/i;
function readDisclosureTag(source) {
  const match = disclosureTag.exec(source);
  if (!match) return null;
  const name = match[2].toLowerCase();
  const open = !match[1] && name === 'details' && /\sopen(?:\s|=|>)/i.test(match[0]);
  return { length: match[0].length, html: `<${match[1]}${name}${open ? ' open' : ''}>` };
}
markdown.inline.ruler.before('text', 'disclosure', (state, silent) => {
  const tag = readDisclosureTag(state.src.slice(state.pos));
  if (!tag) return false;
  if (!silent) state.push('disclosure', '', 0).content = tag.html;
  state.pos += tag.length;
  return true;
});
markdown.renderer.rules.disclosure = (tokens, index) => tokens[index].content;
markdown.block.ruler.before('paragraph', 'disclosure', (state, startLine, endLine, silent) => {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const line = state.src.slice(start, state.eMarks[startLine]).trim();
  const tag = readDisclosureTag(line);
  if (!tag) return false;
  // Complete structural lines must interrupt paragraphs so block Markdown inside
  // a disclosure remains a list, table, code fence, etc.
  if (tag.length !== line.length && !/^<summary\b.*<\/summary>$/i.test(line)) return false;
  if (silent) return true;
  const token = state.push('inline', '', 0);
  token.content = line;
  token.children = [];
  state.line = startLine + 1;
  return true;
}, { alt: ['paragraph', 'reference', 'blockquote'] });

const validateLink = markdown.validateLink.bind(markdown);
markdown.validateLink = url => /^(?:file|localfile):/i.test(url) || validateLink(url);
const defaultImage = markdown.renderer.rules.image;
markdown.renderer.rules.image = (tokens, index, options, env, self) => {
  const token = tokens[index];
  token.attrSet('data-image-source', token.attrGet('src') || '');
  token.attrs = (token.attrs || []).filter(([name]) => name !== 'src');
  return defaultImage(tokens, index, options, env, self);
};

const defaultLinkOpen = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index];
  if (/^(?:file|localfile):/i.test(token.attrGet('href') || ''))
    token.attrs = (token.attrs || []).filter(([name]) => name !== 'href');
  token.attrSet('target', '_blank');
  token.attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen
    ? defaultLinkOpen(tokens, index, options, env, self)
    : self.renderToken(tokens, index, options);
};

export function renderMarkdownHtml(value) {
  return markdown.render(typeof value === 'string' ? value : String(value ?? ''));
}
