import MarkdownIt from 'markdown-it';
const markdown = new MarkdownIt({ html: false });
export const toSanitizedMarkdownHtml = (text: string) => markdown.render(text);
