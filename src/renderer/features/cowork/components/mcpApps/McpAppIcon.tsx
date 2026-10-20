import type { McpAppIcon as AppIcon } from '@shared/plugins/mcpApps';
import { useState } from 'react';

// Plugin icons must travel with the catalog; rendering a launcher must not
// contact public image hosts or expose local file URLs.
const isInlineIcon = (icon: AppIcon) =>
  typeof icon.src === 'string' &&
  icon.src.length <= 2048 &&
  /^data:image\/(?:png|jpeg|gif|webp|svg\+xml)(?:;charset=utf-8)?(?:;base64)?,/i.test(icon.src);

export function McpAppIcon({ icons, label }: { icons?: readonly AppIcon[]; label: string }) {
  const [failed, setFailed] = useState<readonly string[]>([]);
  const candidates = icons?.filter(icon => isInlineIcon(icon) && !failed.includes(icon.src)) ?? [];
  const fallback = Array.from(label.trim()).slice(0, 2).join('').toLocaleUpperCase();
  return (
    <span
      className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-xs font-semibold text-primary"
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
                className="h-full w-full rounded-lg object-contain"
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
