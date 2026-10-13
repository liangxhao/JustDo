import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt('commonmark', { html: false });

/** Code and quoted material are message content, not recipient requests. */
export function hasUnboundDiscussionMention(text: string): boolean {
  let quoteDepth = 0;
  for (const token of markdown.parse(text, {})) {
    if (token.type === 'blockquote_open') quoteDepth += 1;
    if (token.type === 'blockquote_close') quoteDepth -= 1;
    if (quoteDepth || token.type !== 'inline') continue;
    if (
      token.children?.some(
        child =>
          child.type === 'text' && /(^|[^A-Za-z0-9_.+-])@[\p{L}\p{N}_-]+/u.test(child.content),
      )
    )
      return true;
  }
  return false;
}
