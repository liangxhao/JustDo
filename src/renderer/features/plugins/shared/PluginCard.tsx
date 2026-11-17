import type { ReactNode } from 'react';

import Tooltip from '@/shared/components/ui/Tooltip';

import PluginVersion from './PluginVersion';

interface PluginCardProps {
  icon: ReactNode;
  artworkTone: string;
  iconBadge?: ReactNode;
  title: string;
  version?: string;
  titleBadge?: ReactNode;
  description?: string;
  actions?: ReactNode;
  footer?: ReactNode;
  onOpen?: () => void;
  openLabel: string;
}

export const PluginCardGrid = ({ children }: { children: ReactNode }) => (
  <div className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-x-4 gap-y-1">
    {children}
  </div>
);

const PluginCard = ({
  icon,
  artworkTone,
  iconBadge,
  title,
  version,
  titleBadge,
  description,
  actions,
  footer,
  onOpen,
  openLabel,
}: PluginCardProps) => (
  <article
    className={`group relative min-h-14 min-w-0 rounded-xl px-3 py-2 transition-colors hover:bg-surface-raised focus-within:bg-surface-raised${onOpen ? ' cursor-pointer' : ''}`}
    onClick={onOpen}
  >
    <button
      type="button"
      disabled={!onOpen}
      className="absolute inset-0 z-0 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary"
      aria-label={openLabel}
      onClick={event => {
        event.stopPropagation();
        onOpen?.();
      }}
    />
    <div className="relative grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] items-start gap-x-2">
      <div className="relative">
        <div
          className={`flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br text-sm ${artworkTone}`}
        >
          {icon}
        </div>
        {iconBadge && <div className="absolute -bottom-1 -right-1 z-10 flex">{iconBadge}</div>}
      </div>
      <div className="min-w-0">
        <div className="flex min-h-8 min-w-0 items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{title}</span>
            <PluginVersion version={version} />
            {titleBadge}
          </div>
          {actions && (
            <div
              className="flex shrink-0 items-center gap-1.5"
              onClick={event => event.stopPropagation()}
            >
              {actions}
            </div>
          )}
        </div>
        {description && (
          <Tooltip
            content={description}
            position="bottom"
            maxWidth="360px"
            className="block w-full text-xs leading-4 text-secondary"
            renderInPortal
          >
            <p className="line-clamp-2 break-words">{description}</p>
          </Tooltip>
        )}
        {footer && <div className="mt-1.5 text-[10px] text-secondary">{footer}</div>}
      </div>
    </div>
  </article>
);

export default PluginCard;
