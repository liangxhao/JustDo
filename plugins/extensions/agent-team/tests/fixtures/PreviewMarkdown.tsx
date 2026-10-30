export default function PreviewMarkdown({ html }: { html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
