import './DisplayPanelLauncher.css';

import {
  ArrowRightIcon,
  ChatBubbleLeftEllipsisIcon,
  CommandLineIcon,
  FolderIcon,
  GlobeAltIcon,
  MagnifyingGlassIcon,
  Square2StackIcon,
} from '@heroicons/react/24/outline';
import { isBrowserFaviconDataUrl, resolveBrowserAddressInput } from '@shared/browser/browser';
import { useEffect, useState } from 'react';

import { defaultConfig } from '@/app/config';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';

import { type RecentBrowserVisit, selectRecentBrowserVisits } from './displayPanelRecentVisits';

interface DisplayPanelLauncherProps {
  browserDisabled?: boolean;
  filesDisabled?: boolean;
  onCreateBrowser: (url?: string) => void;
  onCreateSideChat?: () => void;
  onCreateTerminal: () => void;
  onOpenFiles?: () => void;
  onOpenReview?: () => void;
  onNavigateBrowser?: (url: string) => void;
  showAddressInput?: boolean;
  sideChatDisabled?: boolean;
  terminalDisabled?: boolean;
  visible?: boolean;
}

function ToolButton({
  label,
  icon: Icon,
  onClick,
  disabled = false,
  shortcut,
}: {
  label: string;
  icon: typeof GlobeAltIcon;
  onClick: () => void;
  disabled?: boolean;
  shortcut?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      className="display-launcher__tool flex h-10 min-w-0 items-center gap-2.5 rounded-lg bg-surface-raised px-3 text-left text-sm font-medium text-foreground transition-colors hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Icon className="h-4 w-4 shrink-0 text-secondary" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut && (
        <kbd
          className="shrink-0 whitespace-nowrap rounded-full bg-foreground/10 px-1.5 py-0.5 font-sans text-[11px] font-normal leading-none text-secondary"
          aria-hidden
        >
          {shortcut}
        </kbd>
      )}
    </button>
  );
}

function RecentVisitIcon({ visit, visible }: { visit: RecentBrowserVisit; visible: boolean }) {
  const [iconUrl, setIconUrl] = useState<string>();
  const [loadedUrl, setLoadedUrl] = useState<string>();
  const [retry, setRetry] = useState(false);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void window.electron.browser
      .loadHistoryFavicon(visit.url, retry)
      .then(result => {
        if (!cancelled && result.success && isBrowserFaviconDataUrl(result.dataUrl))
          setIconUrl(result.dataUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [retry, visit.url, visible]);
  return (
    <span
      className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-surface-raised text-secondary"
      aria-hidden
    >
      {(!iconUrl || loadedUrl !== iconUrl) && <GlobeAltIcon className="h-7 w-7" />}
      {iconUrl && (
        <img
          key={iconUrl}
          src={iconUrl}
          alt=""
          className={`absolute h-8 w-8 object-contain ${loadedUrl === iconUrl ? '' : 'opacity-0'}`}
          referrerPolicy="no-referrer"
          onLoad={() => setLoadedUrl(iconUrl)}
          onError={() => {
            setIconUrl(undefined);
            setLoadedUrl(undefined);
            if (!retry) setRetry(true);
          }}
        />
      )}
    </span>
  );
}

const DisplayPanelLauncher = ({
  browserDisabled = false,
  filesDisabled = false,
  onCreateBrowser,
  onCreateSideChat,
  onCreateTerminal,
  onOpenFiles,
  onOpenReview,
  onNavigateBrowser,
  showAddressInput = true,
  sideChatDisabled = false,
  terminalDisabled = false,
  visible = true,
}: DisplayPanelLauncherProps) => {
  const [config, setConfig] = useState(() => configService.getConfig());
  const [address, setAddress] = useState('');
  const [visits, setVisits] = useState<RecentBrowserVisit[] | null>(null);
  const [historyFailed, setHistoryFailed] = useState(false);
  const shortcuts = { ...defaultConfig.shortcuts, ...config.shortcuts };
  const navigationDisabled = browserDisabled && !onNavigateBrowser;
  const openAddress = onNavigateBrowser ?? onCreateBrowser;

  useEffect(() => {
    const changed = () => setConfig(configService.getConfig());
    window.addEventListener('config-updated', changed);
    return () => window.removeEventListener('config-updated', changed);
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setVisits(null);
    setHistoryFailed(false);
    void window.electron.browser.listHistory().then(
      result => {
        if (cancelled) return;
        setVisits(selectRecentBrowserVisits(result.entries ?? []));
        setHistoryFailed(!result.success);
      },
      () => {
        if (cancelled) return;
        setVisits([]);
        setHistoryFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [visible]);

  return (
    <div className="display-launcher h-full overflow-y-auto bg-background text-foreground">
      {showAddressInput && (
        <form
          className="display-launcher__address border-b border-border px-5 py-3"
          role="search"
          onSubmit={event => {
            event.preventDefault();
            if (navigationDisabled) return;
            const url = resolveBrowserAddressInput(address, config.browserSearchEngine);
            if (url) openAddress(url);
          }}
        >
          <div className="flex h-9 items-center gap-2 rounded-full border border-border bg-surface-raised pl-3 pr-1 focus-within:border-primary/50">
            <MagnifyingGlassIcon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
            <input
              value={address}
              onChange={event => setAddress(event.target.value)}
              disabled={navigationDisabled}
              aria-label={i18nService.t('browserPanelAddress')}
              placeholder={i18nService.t('browserPanelAddressPlaceholder')}
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted disabled:opacity-40"
            />
            <button
              type="submit"
              disabled={navigationDisabled || !address.trim()}
              aria-label={i18nService.t('coworkLauncherOpenAddress')}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-secondary hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-30"
            >
              <ArrowRightIcon className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </form>
      )}
      <div className="display-launcher__content mx-auto max-w-3xl space-y-9 px-6 py-7">
        <section aria-label={i18nService.t('coworkLauncherTools')}>
          <h2 className="mb-3 text-xs font-semibold">{i18nService.t('coworkLauncherTools')}</h2>
          <div className="display-launcher__tools">
            {onOpenReview && (
              <ToolButton
                label={i18nService.t('reviewTitle')}
                icon={Square2StackIcon}
                onClick={onOpenReview}
                shortcut={shortcuts.review}
              />
            )}
            <ToolButton
              label={i18nService.t('coworkNewTerminalTab')}
              icon={CommandLineIcon}
              onClick={onCreateTerminal}
              disabled={terminalDisabled}
              shortcut={shortcuts.terminal}
            />
            {onOpenFiles && (
              <ToolButton
                label={i18nService.t('coworkWorkspaceFiles')}
                icon={FolderIcon}
                onClick={onOpenFiles}
                disabled={filesDisabled}
                shortcut={shortcuts.files}
              />
            )}
            {onCreateSideChat && (
              <ToolButton
                label={i18nService.t('sideChatTitle')}
                icon={ChatBubbleLeftEllipsisIcon}
                onClick={onCreateSideChat}
                disabled={sideChatDisabled}
                shortcut={shortcuts.sideChat}
              />
            )}
          </div>
        </section>
        <section aria-label={i18nService.t('coworkLauncherRecentVisits')}>
          <h2 className="mb-4 text-xs font-semibold">
            {i18nService.t('coworkLauncherRecentVisits')}
          </h2>
          {visits && visits.length > 0 && !historyFailed ? (
            <div className="display-launcher__visits">
              {visits.map(visit => (
                <button
                  key={visit.url}
                  type="button"
                  disabled={navigationDisabled}
                  onClick={() => openAddress(visit.url)}
                  title={`${visit.title}\n${visit.url}`}
                  className="flex min-w-0 flex-col items-center gap-3 rounded-xl px-2 py-3 text-center transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <RecentVisitIcon key={visit.faviconUrl} visit={visit} visible={visible} />
                  <span className="w-full truncate text-xs font-medium">{visit.title}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs leading-5 text-muted" role="status">
              {i18nService.t(
                historyFailed
                  ? 'browserHistoryLoadFailed'
                  : visits === null
                    ? 'loading'
                    : 'coworkLauncherRecentVisitsEmpty',
              )}
            </p>
          )}
        </section>
      </div>
    </div>
  );
};

export default DisplayPanelLauncher;
