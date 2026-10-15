import type { ReactNode } from 'react';

interface PluginCardProps {
  icon: ReactNode;
  iconBadge?: ReactNode;
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  feedback?: ReactNode;
  onOpen?: () => void;
  openLabel?: string;
}

const PluginCard = ({
  icon,
  iconBadge,
  title,
  description,
  actions,
  footer,
  feedback,
  onOpen,
  openLabel,
}: PluginCardProps) => (
  <article
    className={`group relative flex h-full min-w-0 flex-col rounded-xl p-4 transition-colors hover:bg-surface-raised focus-within:bg-surface-raised${onOpen ? ' cursor-pointer' : ''}`}
    onClick={onOpen}
  >
    {onOpen && (
      <button
        type="button"
        className="absolute inset-0 z-0 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary"
        aria-label={openLabel}
        onClick={event => {
          event.stopPropagation();
          onOpen();
        }}
      />
    )}
    <div className="relative flex min-w-0 items-center gap-2">
      <div className="relative shrink-0">
        {icon}
        {iconBadge && <div className="absolute -bottom-1 -right-1 z-10 flex">{iconBadge}</div>}
      </div>
      <div className="min-w-0 flex-1">{title}</div>
      {actions && (
        <div
          className="flex shrink-0 items-center gap-1.5"
          onClick={event => event.stopPropagation()}
        >
          {actions}
        </div>
      )}
    </div>
    <div className="relative mt-2 h-8 min-w-0 text-xs text-secondary">{description}</div>
    {footer && (
      <div className="relative mt-auto flex min-h-10 items-center justify-between gap-3 pt-3 text-[10px] text-secondary">
        {footer}
      </div>
    )}
    {feedback && (
      <div className="relative" onClick={event => event.stopPropagation()}>
        {feedback}
      </div>
    )}
  </article>
);

export default PluginCard;
