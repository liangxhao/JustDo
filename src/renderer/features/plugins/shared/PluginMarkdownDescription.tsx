import React, { useMemo } from 'react';

import { toSanitizedMarkdownHtml } from '@/libs/openclaw-chat/components/markdown';

interface PluginMarkdownDescriptionProps {
  content: string;
  className?: string;
}

const PluginMarkdownDescription: React.FC<PluginMarkdownDescriptionProps> = ({
  content,
  className = '',
}) => {
  const html = useMemo(() => toSanitizedMarkdownHtml(content), [content]);
  if (!html) return null;

  return (
    <div
      className={`prose prose-sm min-w-0 max-w-none text-[13px] leading-relaxed text-secondary [overflow-wrap:anywhere] dark:prose-invert prose-headings:mb-2 prose-headings:mt-4 prose-headings:text-sm prose-headings:font-semibold prose-headings:text-foreground prose-a:text-primary prose-code:break-words prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-1 prose-pre:overflow-auto prose-pre:rounded-xl prose-pre:bg-background prose-pre:text-xs [&>_:first-child]:mt-0 [&>_:last-child]:mb-0 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};

export default PluginMarkdownDescription;
