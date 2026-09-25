import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: false,
});

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
