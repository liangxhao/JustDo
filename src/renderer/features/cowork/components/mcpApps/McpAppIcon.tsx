import type { McpAppIcon as AppIcon } from '@shared/plugins/mcpApps';
import { type ReactNode, useState } from 'react';

// Plugin icons must travel with the catalog; rendering a launcher must not
// contact public image hosts or expose local file URLs.
const isInlineIcon = (icon: AppIcon) =>
  typeof icon.src === 'string' &&
  icon.src.length <= 2048 &&
  /^data:image\/(?:png|jpeg|gif|webp|svg\+xml)(?:;charset=utf-8)?(?:;base64)?,/i.test(icon.src);

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
  const candidates = icons?.filter(icon => isInlineIcon(icon) && !failed.includes(icon.src)) ?? [];
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
        const icon =
          candidates.find(item => item.theme === theme) ?? candidates.find(item => !item.theme);
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
