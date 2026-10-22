import type { McpAppIcon as AppIcon } from '@shared/plugins/mcpApps';
import { type ReactNode, useState } from 'react';

import { selectMcpAppIcon } from '@/libs/openclaw-chat/components/mcp-app/icons';

export function McpAppIcon({
  icons,
  label,
  size = 'launcher',
  fallback: suppliedFallback,
}: {
  icons?: readonly AppIcon[];
  label: string;
  size?: 'launcher' | 'file';
  fallback?: ReactNode;
}) {
  const [failed, setFailed] = useState<readonly string[]>([]);
  const fallback =
    suppliedFallback ?? Array.from(label.trim()).slice(0, 2).join('').toLocaleUpperCase();
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center ${
        size === 'file'
          ? 'h-4 w-4'
          : 'h-8 w-8 rounded-lg bg-primary/10 text-xs font-semibold text-primary'
      }`}
      aria-hidden="true"
    >
      {(['light', 'dark'] as const).map(theme => {
        const icon = selectMcpAppIcon(icons, theme, failed);
        return (
          <span
            key={theme}
            className={`h-full w-full items-center justify-center ${theme === 'dark' ? 'hidden dark:inline-flex' : 'inline-flex dark:hidden'}`}
          >
            {icon ? (
              <img
                src={icon.src}
                alt=""
                className={`h-full w-full object-contain ${size === 'file' ? '' : 'rounded-lg'}`}
                referrerPolicy="no-referrer"
                onError={() => setFailed(current => [...current, icon.src])}
              />
            ) : (
              fallback
            )}
          </span>
        );
      })}
    </span>
  );
}
