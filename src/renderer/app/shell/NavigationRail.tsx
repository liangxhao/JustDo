import {
  BookOpenIcon,
  Cog6ToothIcon,
  EllipsisHorizontalIcon,
  HomeIcon,
  Squares2X2Icon,
} from '@heroicons/react/24/outline';
import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import AuthEntry from '@/features/auth/AuthEntry';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';
import ArrowUpRightIcon from '@/shared/components/icons/ArrowUpRightIcon';
import ClockIcon from '@/shared/components/icons/ClockIcon';
import PuzzleIcon from '@/shared/components/icons/PuzzleIcon';

import { normalizeSidebarPins, type SidebarFeatureId, SidebarView } from './sidebarNavigation';

interface NavigationRailProps {
  activeView: SidebarView;
  homePanelId: string;
  isHomePanelExpanded: boolean;
  showWorkboard: boolean;
  unreadScheduledTaskResults: number;
  onShowHome: () => void;
  onShowScheduledTasks: () => void;
  onShowPlugins: () => void;
  onShowMemory: () => void;
  onShowWorkboard: () => void;
  onShowSettings: () => void;
  onOpenChatWeb?: () => void;
}

const railButtonClass = (active: boolean) =>
  `non-draggable relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
    active
      ? 'bg-surface text-foreground shadow-sm'
      : 'text-secondary hover:bg-surface hover:text-foreground'
  }`;

const PinIcon: React.FC<{ pinned: boolean }> = ({ pinned }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-4 w-4"
    aria-hidden="true"
  >
    <path d="m16 3 5 5-4 2-3 5-5-5 5-3 2-4Z" fill={pinned ? 'currentColor' : 'none'} />
    <path d="m9 15-6 6" />
  </svg>
);

const NavigationRail: React.FC<NavigationRailProps> = ({
  activeView,
  homePanelId,
  isHomePanelExpanded,
  showWorkboard,
  unreadScheduledTaskResults,
  onShowHome,
  onShowScheduledTasks,
  onShowPlugins,
  onShowMemory,
  onShowWorkboard,
  onShowSettings,
  onOpenChatWeb,
}) => {
  const [pinnedItems, setPinnedItems] = useState(() =>
    normalizeSidebarPins(configService.getConfig().sidebarPinnedItems),
  );
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const [isSavingPins, setIsSavingPins] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const savingPinsRef = useRef(false);
  const menuId = useId();
  const isMac = window.electron.platform === 'darwin';
  const showChatWeb = Boolean(onOpenChatWeb);

  useEffect(() => {
    const syncPins = () => {
      setPinnedItems(normalizeSidebarPins(configService.getConfig().sidebarPinnedItems));
    };
    window.addEventListener('config-updated', syncPins);
    return () => window.removeEventListener('config-updated', syncPins);
  }, []);

  useEffect(() => {
    if (!isMoreOpen) return;
    const updatePosition = () => {
      const button = moreButtonRef.current?.getBoundingClientRect();
      if (!button) return;
      const menuHeight = menuRef.current?.offsetHeight ?? 128;
      setMenuPosition({
        left: Math.max(8, Math.min(button.right + 10, window.innerWidth - 248)),
        top: Math.max(8, Math.min(button.top, window.innerHeight - menuHeight - 8)),
      });
    };
    const dismissOnOutsideClick = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target) &&
        !moreButtonRef.current?.contains(event.target)
      ) {
        setIsMoreOpen(false);
      }
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setIsMoreOpen(false);
      moreButtonRef.current?.focus();
    };
    updatePosition();
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    window.addEventListener('resize', updatePosition);
    document.addEventListener('scroll', updatePosition, true);
    document.addEventListener('pointerdown', dismissOnOutsideClick);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      window.removeEventListener('resize', updatePosition);
      document.removeEventListener('scroll', updatePosition, true);
      document.removeEventListener('pointerdown', dismissOnOutsideClick);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [isMoreOpen, showWorkboard, showChatWeb]);

  const features: {
    id: SidebarFeatureId;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    onSelect: () => void;
  }[] = [
    {
      id: SidebarView.Memory,
      label: i18nService.t('memoryTitle'),
      icon: BookOpenIcon,
      onSelect: onShowMemory,
    },
    ...(showWorkboard
      ? [
          {
            id: SidebarView.Workboard,
            label: i18nService.t('workboard'),
            icon: Squares2X2Icon,
            onSelect: onShowWorkboard,
          },
        ]
      : []),
  ];
  const pinnedFeatures = pinnedItems.flatMap(id => features.filter(feature => feature.id === id));
  const isMoreActive = features.some(
    feature => feature.id === activeView && !pinnedItems.includes(feature.id),
  );
  const scheduledTasksLabel = `${i18nService.t('scheduledTasks')}${
    unreadScheduledTaskResults > 0
      ? `, ${unreadScheduledTaskResults} ${i18nService.t('scheduledTasksResultsUnreadLabel')}`
      : ''
  }`;

  const navigate = (onSelect: () => void) => {
    setIsMoreOpen(false);
    onSelect();
  };

  const togglePin = async (id: SidebarFeatureId) => {
    if (savingPinsRef.current) return;
    savingPinsRef.current = true;
    setIsSavingPins(true);
    const nextPins = pinnedItems.includes(id)
      ? pinnedItems.filter(item => item !== id)
      : [...pinnedItems, id];
    try {
      await configService.updateConfig({ sidebarPinnedItems: nextPins });
      setPinnedItems(normalizeSidebarPins(configService.getConfig().sidebarPinnedItems));
    } catch {
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: i18nService.t('sidebarPinSaveFailed'),
        }),
      );
    } finally {
      savingPinsRef.current = false;
      setIsSavingPins(false);
    }
  };

  return (
    <nav
      aria-label={i18nService.t('sidebarNavigation')}
      className={`col-start-1 row-start-1 row-span-2 flex w-11 min-h-0 shrink-0 flex-col items-center border-r border-border-subtle bg-surface-raised pb-3 ${isMac ? 'pt-12' : 'pt-5'}`}
    >
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto pb-3">
        <button
          type="button"
          className={railButtonClass(activeView === SidebarView.Home)}
          onClick={() => navigate(onShowHome)}
          aria-label={i18nService.t('sidebarHome')}
          title={i18nService.t('sidebarHome')}
          aria-controls={homePanelId}
          aria-expanded={isHomePanelExpanded}
          aria-current={activeView === SidebarView.Home ? 'page' : undefined}
        >
          <HomeIcon className="h-5 w-5" />
        </button>
        <button
          type="button"
          className={railButtonClass(activeView === SidebarView.ScheduledTasks)}
          onClick={() => navigate(onShowScheduledTasks)}
          aria-label={scheduledTasksLabel}
          title={scheduledTasksLabel}
          aria-current={activeView === SidebarView.ScheduledTasks ? 'page' : undefined}
        >
          <ClockIcon className="h-5 w-5" />
          {unreadScheduledTaskResults > 0 && (
            <span
              className="absolute right-0.5 top-0.5 min-w-3.5 rounded-full bg-primary px-1 text-[9px] font-semibold leading-[14px] text-white"
              aria-hidden="true"
            >
              {unreadScheduledTaskResults > 99 ? '99+' : unreadScheduledTaskResults}
            </span>
          )}
        </button>
        <button
          type="button"
          className={railButtonClass(activeView === SidebarView.Plugins)}
          onClick={() => navigate(onShowPlugins)}
          aria-label={i18nService.t('plugins')}
          title={i18nService.t('plugins')}
          aria-current={activeView === SidebarView.Plugins ? 'page' : undefined}
        >
          <PuzzleIcon className="h-5 w-5" />
        </button>
        <button
          ref={moreButtonRef}
          type="button"
          className={railButtonClass(isMoreOpen || isMoreActive)}
          onClick={() => setIsMoreOpen(open => !open)}
          aria-label={i18nService.t('sidebarMore')}
          title={i18nService.t('sidebarMore')}
          aria-expanded={isMoreOpen}
          aria-haspopup="dialog"
          aria-controls={isMoreOpen ? menuId : undefined}
        >
          <EllipsisHorizontalIcon className="h-5 w-5" />
        </button>
        {pinnedFeatures.map(feature => (
          <button
            key={feature.id}
            type="button"
            className={railButtonClass(activeView === feature.id)}
            onClick={() => navigate(feature.onSelect)}
            aria-label={feature.label}
            title={feature.label}
            aria-current={activeView === feature.id ? 'page' : undefined}
          >
            <feature.icon className="h-5 w-5" />
          </button>
        ))}
      </div>
      <div className="flex shrink-0 flex-col items-center gap-2">
        <AuthEntry compact />
        <button
          type="button"
          className={railButtonClass(false)}
          onClick={() => navigate(onShowSettings)}
          aria-label={i18nService.t('settings')}
          title={i18nService.t('settings')}
        >
          <Cog6ToothIcon className="h-5 w-5" />
        </button>
      </div>
      {isMoreOpen &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="dialog"
            aria-label={i18nService.t('sidebarMore')}
            className="non-draggable fixed z-[60] w-60 rounded-xl border border-border bg-surface p-1.5 shadow-xl"
            style={menuPosition}
            onBlur={event => {
              if (
                event.relatedTarget instanceof Node &&
                !event.currentTarget.contains(event.relatedTarget) &&
                event.relatedTarget !== moreButtonRef.current
              ) {
                setIsMoreOpen(false);
              }
            }}
          >
            <div className="px-2.5 py-1.5 text-xs font-medium text-secondary">
              {i18nService.t('sidebarMore')}
            </div>
            {features.map(feature => {
              const pinned = pinnedItems.includes(feature.id);
              const pinLabel = i18nService
                .t(pinned ? 'sidebarUnpinFeature' : 'sidebarPinFeature')
                .replace('{name}', feature.label);
              return (
                <div
                  key={feature.id}
                  className="flex items-center gap-1 rounded-lg hover:bg-surface-raised"
                >
                  <button
                    type="button"
                    className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${activeView === feature.id ? 'text-primary' : 'text-foreground'}`}
                    aria-current={activeView === feature.id ? 'page' : undefined}
                    onClick={() => navigate(feature.onSelect)}
                  >
                    <feature.icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{feature.label}</span>
                  </button>
                  <button
                    type="button"
                    className={`mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 ${pinned ? 'text-primary' : 'text-secondary'}`}
                    onClick={() => void togglePin(feature.id)}
                    disabled={isSavingPins}
                    aria-label={pinLabel}
                    aria-pressed={pinned}
                    title={i18nService.t(pinned ? 'sidebarUnpin' : 'sidebarPin')}
                  >
                    <PinIcon pinned={pinned} />
                  </button>
                </div>
              );
            })}
            {onOpenChatWeb && (
              <div className="mt-1 border-t border-border-subtle pt-1">
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-foreground hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  onClick={() => navigate(onOpenChatWeb)}
                >
                  <ArrowUpRightIcon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{i18nService.t('openChatWeb')}</span>
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}
    </nav>
  );
};

export default NavigationRail;
