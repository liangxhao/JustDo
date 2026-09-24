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
      className={`prose prose-sm max-w-none break-words text-secondary dark:prose-invert prose-a:text-primary prose-code:break-words prose-p:my-2 prose-pre:overflow-auto prose-pre:rounded-xl prose-pre:bg-background prose-pre:text-xs ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};

export default PluginMarkdownDescription;
