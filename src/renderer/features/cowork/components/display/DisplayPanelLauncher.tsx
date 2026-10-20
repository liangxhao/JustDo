import './DisplayPanelLauncher.css';

import {
  ArrowRightIcon,
  ChatBubbleLeftEllipsisIcon,
  CommandLineIcon,
  FolderIcon,
  GlobeAltIcon,
  MagnifyingGlassIcon,
  Square2StackIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { isBrowserFaviconDataUrl, resolveBrowserAddressInput } from '@shared/browser/browser';
import { useCallback, useEffect, useRef, useState } from 'react';

import { defaultConfig } from '@/app/config';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';

import type { ComposerFeatureItem } from '../composer/ComposerFeatureMenu';
import { type RecentBrowserVisit, selectRecentBrowserVisits } from './displayPanelRecentVisits';

interface DisplayPanelLauncherProps {
  appItems?: readonly ComposerFeatureItem[];
  appsDisabled?: boolean;
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
  appItems = [],
  appsDisabled = false,
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
  const [deleteFailed, setDeleteFailed] = useState(false);
  const [deletingUrl, setDeletingUrl] = useState<string | null>(null);
  const pendingDeletion = useRef<string | null>(null);
  const historyEpoch = useRef(0);
  const historyVisible = useRef(false);
  const shortcuts = { ...defaultConfig.shortcuts, ...config.shortcuts };
  const navigationDisabled = browserDisabled && !onNavigateBrowser;
  const openAddress = onNavigateBrowser ?? onCreateBrowser;

  useEffect(() => {
    const changed = () => setConfig(configService.getConfig());
    window.addEventListener('config-updated', changed);
    return () => window.removeEventListener('config-updated', changed);
  }, []);

  const loadHistory = useCallback(async () => {
    const epoch = ++historyEpoch.current;
    try {
      const result = await window.electron.browser.listHistory();
      if (epoch !== historyEpoch.current) return;
      setVisits(selectRecentBrowserVisits(result.entries ?? []));
      setHistoryFailed(!result.success);
    } catch {
      if (epoch !== historyEpoch.current) return;
      setVisits([]);
      setHistoryFailed(true);
    }
  }, []);

  useEffect(() => {
    historyVisible.current = visible;
    if (!visible) return;
    setVisits(null);
    setHistoryFailed(false);
    setDeleteFailed(false);
    void loadHistory();
    return () => {
      historyVisible.current = false;
      historyEpoch.current += 1;
    };
  }, [loadHistory, visible]);

  const deleteVisit = async (url: string) => {
    if (pendingDeletion.current) return;
    pendingDeletion.current = url;
    setDeletingUrl(url);
    setDeleteFailed(false);
    try {
      const result = await window.electron.browser.deleteHistory([url]);
      if (!historyVisible.current) return;
      if (!result.success) {
        setDeleteFailed(true);
        return;
      }
      setVisits(current => current?.filter(visit => visit.url !== url) ?? null);
      await loadHistory();
    } catch {
      if (historyVisible.current) setDeleteFailed(true);
    } finally {
      pendingDeletion.current = null;
      setDeletingUrl(null);
    }
  };

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
        {appItems.length > 0 && (
          <section aria-label={i18nService.t('mcpAppsTitle')}>
            <h2 className="mb-3 text-xs font-semibold">{i18nService.t('mcpAppsTitle')}</h2>
            <div className="display-launcher__apps">
              {appItems.map(item => (
                <button
                  key={item.id}
                  type="button"
                  disabled={appsDisabled || item.disabled}
                  onClick={item.onSelect}
                  aria-label={item.label}
                  title={item.description ? `${item.label}\n${item.description}` : item.label}
                  className="flex min-w-0 flex-col items-center gap-3 rounded-xl px-2 py-3 text-center transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span
                    className="flex h-10 w-10 shrink-0 items-center justify-center text-secondary"
                    aria-hidden="true"
                  >
                    {item.icon}
                  </span>
                  <span className="w-full truncate text-xs font-medium">{item.label}</span>
                  {item.description && (
                    <span className="w-full text-xs text-muted">{item.description}</span>
                  )}
                </button>
              ))}
            </div>
          </section>
        )}
        <section aria-label={i18nService.t('coworkLauncherRecentVisits')}>
          <h2 className="mb-4 text-xs font-semibold">
            {i18nService.t('coworkLauncherRecentVisits')}
          </h2>
          {deleteFailed && (
            <p className="mb-3 text-xs leading-5 text-red-500" role="alert">
              {i18nService.t('browserHistoryDeleteFailed')}
            </p>
          )}
          {visits && visits.length > 0 && !historyFailed ? (
            <div className="display-launcher__visits">
              {visits.map(visit => (
                <div key={visit.url} className="group relative min-w-0">
                  <button
                    type="button"
                    disabled={navigationDisabled || deletingUrl === visit.url}
                    onClick={() => openAddress(visit.url)}
                    title={`${visit.title}\n${visit.url}`}
                    className="flex w-full min-w-0 flex-col items-center gap-3 rounded-xl px-2 py-3 text-center transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <RecentVisitIcon key={visit.faviconUrl} visit={visit} visible={visible} />
                    <span className="w-full truncate text-xs font-medium">{visit.title}</span>
                  </button>
                  <button
                    type="button"
                    disabled={deletingUrl !== null}
                    onClick={() => void deleteVisit(visit.url)}
                    aria-label={i18nService
                      .t('coworkLauncherDeleteRecentVisit')
                      .replace('{title}', visit.title)}
                    title={i18nService.t('browserHistoryDeleteOne')}
                    className="display-launcher__delete-visit absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-md bg-surface text-secondary opacity-0 transition-opacity hover:bg-surface-overlay hover:text-red-500 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed"
                  >
                    <XMarkIcon className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
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
