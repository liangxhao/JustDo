import {
  ArrowPathIcon,
  ArrowUpRightIcon,
  BoltIcon,
  CheckIcon,
  ChevronLeftIcon,
  Cog6ToothIcon,
  DocumentIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  Squares2X2Icon,
} from '@heroicons/react/24/outline';
import {
  type McpAppDiscoveredServer,
  type McpAppDiscovery,
  type McpAppLaunchInput,
  McpAppMethod,
  mcpAppRecord,
  type McpAppResourceLink,
} from '@shared/plugins/mcpApps';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { resolveMcpAppIcons } from '@/libs/openclaw-chat/components/mcp-app/icons';
import type { McpAppViewContext } from '@/libs/openclaw-chat/components/mcp-app/view';
import type { McpAppSession } from '@/libs/openclaw-chat/gateway/mcp-app/mcp-app-session';
import { decodeMcpAppLaunch } from '@/libs/openclaw-chat/pipeline/native-mcp-app';
import { i18nService } from '@/services/i18n';

import type { ComposerFeatureItem } from '../composer/ComposerFeatureMenu';
import { findFileApp, type OpenMcpAppFile } from './fileApps';
import { McpAppIcon } from './McpAppIcon';
import { type AppSettings, appSettingsSchema, McpAppSettings } from './McpAppSettings';
import { APP_BUTTON, APP_ICON_BUTTON, APP_INPUT } from './mcpAppStyles';
import { NativeAppQuestions } from './NativeAppQuestions';
import {
  closeWorkspaceAppControls,
  type McpAppWorkspaceControlsEntry,
  openWorkspaceApp,
  openWorkspaceAppControls,
  openWorkspaceAppFile,
  openWorkspaceAppLaunch,
} from './workspaceApps';

const t = (key: string) => i18nService.t(key);
const menuEntries = (server: McpAppDiscoveredServer, filePath?: string) =>
  server.entrypoints.filter(
    entry =>
      entry.entrypoint.type !== 'file' ||
      (filePath &&
        entry.entrypoint.extensions.some(extension =>
          filePath.toLowerCase().endsWith(extension.toLowerCase()),
        )),
  );
export interface McpAppComposerMenu {
  sessionId: string;
  items: readonly ComposerFeatureItem[];
  fileCatalog?: McpAppDiscovery;
  openFile?: OpenMcpAppFile;
}

export function McpAppsControls({
  apps,
  prepare,
  sessionId,
  canDraft,
  addDraft,
  filePath,
  onOnboard,
  onMenuChange,
}: {
  apps: McpAppSession;
  prepare: () => Promise<McpAppViewContext>;
  sessionId: string;
  canDraft: () => boolean;
  addDraft: (text: string) => Promise<boolean>;
  filePath?: string;
  onOnboard: (pluginId: string, signal: AbortSignal) => Promise<void>;
  onMenuChange?: (menu: McpAppComposerMenu) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [panelTarget, setPanelTarget] = useState<HTMLElement | null>(null);
  const ownedControls = useRef<McpAppWorkspaceControlsEntry>();
  const [panelServer, setPanelServer] = useState<string>();
  const [catalog, setCatalog] = useState<McpAppDiscovery>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState<{ server: string; label: string; value: AppSettings }>();
  const [searchServer, setSearchServer] = useState<string>();
  const [query, setQuery] = useState('');
  const queryRef = useRef(query);
  queryRef.current = query;
  const [resources, setResources] = useState<{ server: string; items: McpAppResourceLink[] }>();
  const [addedResource, setAddedResource] = useState<string>();
  const lifecycle = useRef({
    version: 0,
    fileEpoch: 0,
    catalogRevision: 0,
    operations: new Set<AbortController>(),
  }).current;
  const root = useRef<HTMLDivElement>(null);
  const region = useRef<HTMLDivElement>(null);
  const regionId = useId();
  useEffect(() => {
    if (expanded)
      region.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [expanded, panelTarget]);
  useEffect(() => {
    setCatalog(undefined);
    setSettings(undefined);
    setResources(undefined);
    setSearchServer(undefined);
    setError('');
    setBusy(false);
    const abort = new AbortController();
    let bindingRevision = apps.discoveryRevision;
    const refresh = () => {
      const own = ++lifecycle.catalogRevision;
      setCatalog(undefined);
      // Discover only an already-bound native conversation. The mere presence
      // of these controls must not create a session or prepare a model send.
      void apps
        .discover(abort.signal)
        .then(value => {
          if (abort.signal.aborted || own !== lifecycle.catalogRevision) return;
          setCatalog(value);
          if (!value.servers.length && !value.onboarding?.length && ownedControls.current)
            closeWorkspaceAppControls(ownedControls.current);
        })
        .catch(() => undefined);
    };
    refresh();
    const stop = apps.subscribe(() => {
      if (bindingRevision !== apps.discoveryRevision) {
        if (ownedControls.current) closeWorkspaceAppControls(ownedControls.current);
        bindingRevision = apps.discoveryRevision;
        refresh();
      }
    });
    const stopConfig = window.electron.mcp?.onConfigSyncDone?.(refresh);
    const stopExtensions = window.electron.extensions?.onChanged?.(refresh);
    return () => {
      if (ownedControls.current) closeWorkspaceAppControls(ownedControls.current);
      abort.abort();
      lifecycle.version++;
      lifecycle.fileEpoch++;
      lifecycle.catalogRevision++;
      for (const operation of lifecycle.operations) operation.abort();
      lifecycle.operations.clear();
      stop();
      stopConfig?.();
      stopExtensions?.();
    };
  }, [apps, sessionId, lifecycle]);
  const run = async (
    operation: (signal: AbortSignal, context: McpAppViewContext) => Promise<void>,
    mutation = false,
  ) => {
    if (busy || lifecycle.operations.size || !canDraft()) return;
    const own = ++lifecycle.version;
    const abort = new AbortController();
    lifecycle.operations.add(abort);
    let context: McpAppViewContext | undefined;
    const current = () =>
      !abort.signal.aborted &&
      own === lifecycle.version &&
      canDraft() &&
      (!context || context.isCurrent());
    setBusy(true);
    setError('');
    try {
      context = await prepare();
      if (!current()) throw new Error('Native session changed');
      await operation(abort.signal, context);
    } catch {
      if (current()) setError(t(mutation ? 'mcpAppsOperationUnknown' : 'mcpAppsDiscoveryFailed'));
    } finally {
      lifecycle.operations.delete(abort);
      if (own === lifecycle.version) setBusy(false);
    }
  };
  const discover = () =>
    run(async signal => {
      // Manual and event-driven reads share freshness so neither can restore an older catalog.
      const own = ++lifecycle.catalogRevision;
      try {
        const value = await apps.discover(signal);
        if (!signal.aborted && own === lifecycle.catalogRevision) setCatalog(value);
      } catch (error) {
        if (!signal.aborted && own === lifecycle.catalogRevision) throw error;
      }
    });
  const show = (value: unknown, context: McpAppViewContext, signal: AbortSignal) => {
    const preview = decodeMcpAppLaunch(value);
    if (preview && context.isCurrent() && !signal.aborted) {
      openWorkspaceApp({ id: `mcp-app:${preview.viewId}`, sessionId, preview, context });
      if (ownedControls.current) closeWorkspaceAppControls(ownedControls.current);
    }
  };
  const launch = (input: McpAppLaunchInput) => {
    if (!canDraft() || lifecycle.operations.size) return;
    const epoch = lifecycle.fileEpoch;
    openWorkspaceAppLaunch({
      id: `mcp-app-entry:${sessionId}:${input.serverName}:${input.toolName}:${input.entrypointType}:${input.quickAction === true}`,
      sessionId,
      label:
        catalog?.servers.find(server => server.serverName === input.serverName)?.label ??
        input.serverName,
      icons: resolveMcpAppIcons(catalog, input),
      retryable: false,
      load: async signal => {
        const revision = apps.discoveryRevision;
        const current = () =>
          epoch === lifecycle.fileEpoch &&
          revision === apps.discoveryRevision &&
          fileActions.current.canDraft() &&
          !signal.aborted;
        if (!current()) throw new Error('App entry is no longer available');
        const context = await fileActions.current.prepare();
        if (!current() || !context.isCurrent()) throw new Error('App session changed');
        const preview = decodeMcpAppLaunch(await apps.launch(input, signal));
        if (!preview || !current() || !context.isCurrent())
          throw new Error('App launch was superseded');
        return { preview, context };
      },
    });
    if (ownedControls.current) closeWorkspaceAppControls(ownedControls.current);
  };
  const menuActions = useRef({ launch, open: (_server?: string) => setExpanded(true) });
  const fileActions = useRef({ catalog, prepare, canDraft });
  fileActions.current = { catalog, prepare, canDraft };
  menuActions.current = {
    launch,
    open: server => {
      setPanelServer(server);
      setSettings(undefined);
      setSearchServer(undefined);
      setResources(undefined);
      setAddedResource(undefined);
      setQuery('');
      setError('');
      setExpanded(true);
      const revision = apps.discoveryRevision;
      const entry: McpAppWorkspaceControlsEntry = {
        id: `mcp-app-controls:${sessionId}`,
        sessionId,
        label:
          catalog?.servers.find(item => item.serverName === server)?.label ?? t('mcpAppsTitle'),
        icons: server ? resolveMcpAppIcons(catalog, { serverName: server }) : undefined,
        isCurrent: () =>
          ownedControls.current === entry && revision === apps.discoveryRevision && canDraft(),
        attach: target => {
          if (ownedControls.current === entry) setPanelTarget(target);
        },
        onClose: () => {
          if (ownedControls.current !== entry) return;
          ownedControls.current = undefined;
          lifecycle.version++;
          for (const operation of lifecycle.operations) operation.abort();
          lifecycle.operations.clear();
          if (root.current) {
            setPanelTarget(null);
            setExpanded(false);
            setBusy(false);
            setError('');
          }
        },
      };
      ownedControls.current = entry;
      openWorkspaceAppControls(entry);
    },
  };
  useEffect(() => {
    if (!onMenuChange) return;
    let active = true;
    const revision = apps.discoveryRevision;
    const available = () => active && revision === apps.discoveryRevision && canDraft();
    onMenuChange({
      sessionId,
      fileCatalog: canDraft() ? catalog : undefined,
      openFile: async request => {
        if (!available() || !request.isCurrent()) return false;
        const input = findFileApp(fileActions.current.catalog, request.filePath);
        if (!input) return false;
        const epoch = lifecycle.fileEpoch;
        const sameHandler = () => {
          const handler = findFileApp(fileActions.current.catalog, request.filePath);
          return handler?.serverName === input.serverName && handler.toolName === input.toolName;
        };
        const load = async (signal?: AbortSignal) => {
          // Each explicit retry may use a reconnected binding; an in-flight
          // attempt must still reject a binding change during preparation.
          const bindingRevision = apps.discoveryRevision;
          const current = () =>
            epoch === lifecycle.fileEpoch &&
            bindingRevision === apps.discoveryRevision &&
            fileActions.current.canDraft();
          if (!current() || !sameHandler() || signal?.aborted)
            throw new Error('File App is no longer available');
          const context = await fileActions.current.prepare();
          if (!current() || !sameHandler() || signal?.aborted || !context.isCurrent())
            throw new Error('File App session changed');
          const preview = decodeMcpAppLaunch(await apps.launch(input, signal));
          if (!preview || !current() || !sameHandler() || signal?.aborted || !context.isCurrent())
            throw new Error('File App open was superseded');
          const fileContext = (base: McpAppViewContext): McpAppViewContext => ({
            ...base,
            resume: () => {
              const resumed = base.resume?.();
              return resumed ? fileContext(resumed) : undefined;
            },
            reopen: async () => {
              const currentInput = findFileApp(fileActions.current.catalog, request.filePath);
              if (
                !fileActions.current.canDraft() ||
                currentInput?.serverName !== input.serverName ||
                currentInput.toolName !== input.toolName
              )
                throw new Error('File App is no longer available');
              const fresh = base.refresh
                ? await base.refresh()
                : await fileActions.current.prepare();
              if (!fresh.isCurrent() || fresh.sessionKey !== context.sessionKey)
                throw new Error('File App session changed');
              const next = decodeMcpAppLaunch(await apps.launch(input));
              if (!next || !fresh.isCurrent()) throw new Error('File App reopen was superseded');
              return { preview: next, context: fileContext(fresh) };
            },
          });
          return { preview, context: fileContext(context) };
        };
        openWorkspaceAppFile({
          id: `mcp-app-file:${sessionId}:${request.filePath}`,
          sessionId,
          filePath: request.filePath,
          label: request.filePath.split(/[\\/]/).pop() || request.filePath,
          icons: resolveMcpAppIcons(fileActions.current.catalog, input),
          load,
        });
        return true;
      },
      items: [
        ...(catalog?.servers
          .filter(
            server => menuEntries(server, filePath).length || server.settings || server.mentionTool,
          )
          .map(server => {
            const visibleEntries = menuEntries(server, filePath);
            const entry = visibleEntries[0];
            const direct =
              visibleEntries.length === 1 &&
              !server.settings &&
              !server.mentionTool &&
              !(entry.entrypoint.type === 'global' && entry.entrypoint.quickAction);
            const fileUnavailable =
              direct &&
              entry.entrypoint.type === 'file' &&
              (!filePath ||
                !entry.entrypoint.extensions.some(extension =>
                  filePath.toLowerCase().endsWith(extension.toLowerCase()),
                ));
            return {
              id: `mcp-app:${server.serverName}`,
              label: server.label,
              section: t('mcpAppsTitle'),
              icon: <McpAppIcon icons={entry?.icons ?? server.icons} label={server.label} />,
              disabled: busy || !canDraft() || fileUnavailable,
              onSelect: () => {
                if (!available()) return;
                if (direct)
                  void menuActions.current.launch({
                    serverName: server.serverName,
                    toolName: entry.toolName,
                    entrypointType: entry.entrypoint.type,
                    ...(entry.entrypoint.type === 'file' ? { filePath } : {}),
                  });
                else menuActions.current.open(server.serverName);
              },
            };
          }) ?? []),
        ...(catalog?.onboarding?.map(plugin => ({
          id: `mcp-app-setup:${plugin.pluginId}`,
          label: plugin.title,
          section: t('mcpAppsTitle'),
          icon: <PlusIcon className="h-4 w-4" />,
          disabled: busy || !canDraft(),
          onSelect: () => {
            if (available()) menuActions.current.open();
          },
        })) ?? []),
      ],
    });
    return () => {
      active = false;
      onMenuChange({ sessionId, items: [] });
    };
  }, [apps, catalog, busy, canDraft, filePath, sessionId, onMenuChange, lifecycle]);
  const dismiss = () => {
    // The launcher may already be unmounted, and controls can live in the
    // detached workspace document. Restore focus within that same workspace
    // after its remaining tabs/homepage have rendered.
    const workspace = panelTarget?.closest<HTMLElement>('#cowork-display-panel');
    const ownerWindow = panelTarget?.ownerDocument.defaultView;
    if (ownedControls.current) closeWorkspaceAppControls(ownedControls.current);
    ownerWindow?.requestAnimationFrame(() => {
      if (!workspace?.isConnected || workspace.closest('[inert], [aria-hidden="true"]')) return;
      const target =
        workspace.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]') ??
        workspace.querySelector<HTMLButtonElement>('.display-launcher__apps button:not(:disabled)');
      target?.focus({ preventScroll: true });
    });
  };
  const panelServers = catalog?.servers.filter(
    server => !panelServer || server.serverName === panelServer,
  );
  const onboarding = panelServer ? [] : catalog?.onboarding;
  return (
    <div
      ref={root}
      className="contents"
      onKeyDown={event => {
        if (event.key === 'Escape' && expanded) {
          event.stopPropagation();
          dismiss();
        }
      }}
    >
      {panelTarget &&
        createPortal(
          <>
            {expanded && (
              <div
                ref={region}
                id={regionId}
                className="flex h-full min-h-0 flex-col text-xs"
                aria-busy={busy}
              >
                {(settings || !panelServer) && (
                  <div className="flex items-center gap-1 border-b border-border px-2 py-1">
                    {settings && (
                      <button
                        type="button"
                        className={APP_ICON_BUTTON}
                        disabled={busy}
                        title={t('back')}
                        aria-label={t('back')}
                        onClick={() => setSettings(undefined)}
                      >
                        <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
                      </button>
                    )}
                    <span className="min-w-0 flex-1 truncate px-1 text-xs font-medium text-secondary">
                      {settings ? `${settings.label} · ${t('mcpAppsSettings')}` : null}
                    </span>
                    {!settings && (
                      <button
                        type="button"
                        disabled={busy || !canDraft()}
                        className={APP_ICON_BUTTON}
                        title={t('mcpAppsRefresh')}
                        aria-label={t('mcpAppsRefresh')}
                        onClick={() => void discover()}
                      >
                        <ArrowPathIcon className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                )}
                {error && (
                  <p role="alert" className="px-3 py-2 text-xs text-destructive">
                    {error}
                  </p>
                )}
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {settings ? (
                    <div className="p-2">
                      <McpAppSettings
                        key={JSON.stringify(settings)}
                        settings={settings.value}
                        busy={busy}
                        cancel={() => setSettings(undefined)}
                        save={changed =>
                          void run(async signal => {
                            const result = await apps.bind().request(
                              McpAppMethod.Settings,
                              {
                                serverName: settings.server,
                                action: 'update',
                                arguments: { set: changed },
                              },
                              signal,
                            );
                            if (
                              mcpAppRecord(result)?.isError === true ||
                              mcpAppRecord(result)?.ok === false
                            )
                              throw new Error('App settings update failed');
                            setSettings(undefined);
                          }, true)
                        }
                        tool={name =>
                          void run(
                            async (signal, context) =>
                              show(
                                await apps
                                  .bind()
                                  .request(
                                    McpAppMethod.Settings,
                                    { serverName: settings.server, action: 'tool', toolName: name },
                                    signal,
                                  ),
                                context,
                                signal,
                              ),
                            true,
                          )
                        }
                      />
                    </div>
                  ) : (
                    <>
                      {!catalog && busy && (
                        <div className="flex min-h-24 items-center justify-center gap-2 text-secondary">
                          <ArrowPathIcon className="h-4 w-4 animate-spin" aria-hidden="true" />
                          <span>{t('mcpAppsLoading')}</span>
                        </div>
                      )}
                      {catalog && !catalog.servers.length && !catalog.onboarding?.length && (
                        <p className="px-3 py-6 text-center text-secondary">{t('mcpAppsNone')}</p>
                      )}
                      {panelServers?.map(server => (
                        <section
                          key={server.serverName}
                          className="rounded-lg p-1 [&+section]:mt-2"
                        >
                          <div className="flex items-center gap-1 px-2 py-1">
                            <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
                              {server.label}
                            </span>
                            {panelServer && (
                              <button
                                type="button"
                                disabled={busy || !canDraft()}
                                className={APP_ICON_BUTTON}
                                title={t('mcpAppsRefresh')}
                                aria-label={t('mcpAppsRefresh')}
                                onClick={() => void discover()}
                              >
                                <ArrowPathIcon className="h-3.5 w-3.5" aria-hidden="true" />
                              </button>
                            )}
                            {server.mentionTool && (
                              <button
                                type="button"
                                className={APP_ICON_BUTTON}
                                disabled={busy || !canDraft()}
                                title={t('mcpAppsSearch')}
                                aria-label={`${t('mcpAppsSearch')}: ${server.label}`}
                                aria-expanded={searchServer === server.serverName}
                                onClick={() => {
                                  setSearchServer(
                                    searchServer === server.serverName
                                      ? undefined
                                      : server.serverName,
                                  );
                                  setQuery('');
                                  setResources(undefined);
                                  setAddedResource(undefined);
                                }}
                              >
                                <MagnifyingGlassIcon className="h-4 w-4" aria-hidden="true" />
                              </button>
                            )}
                            {server.settings && (
                              <button
                                type="button"
                                className={APP_ICON_BUTTON}
                                disabled={busy || !canDraft()}
                                title={t('mcpAppsSettings')}
                                aria-label={`${t('mcpAppsSettings')}: ${server.label}`}
                                onClick={() =>
                                  void run(async signal => {
                                    const value = await apps
                                      .bind()
                                      .request(
                                        McpAppMethod.Settings,
                                        { serverName: server.serverName, action: 'read' },
                                        signal,
                                      );
                                    setSettings({
                                      server: server.serverName,
                                      label: server.label,
                                      value: appSettingsSchema.parse(value),
                                    });
                                  })
                                }
                              >
                                <Cog6ToothIcon className="h-4 w-4" aria-hidden="true" />
                              </button>
                            )}
                          </div>
                          {menuEntries(server, filePath).map((entry, index) => {
                            const unavailable =
                              entry.entrypoint.type === 'file' &&
                              (!filePath ||
                                !entry.entrypoint.extensions.some(extension =>
                                  filePath.toLowerCase().endsWith(extension.toLowerCase()),
                                ));
                            return (
                              <div key={index} className="flex items-center gap-1">
                                <button
                                  type="button"
                                  className="group flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-40"
                                  disabled={busy || !canDraft() || unavailable}
                                  title={unavailable ? t('mcpAppsFileRequired') : entry.title}
                                  onClick={() =>
                                    void launch({
                                      serverName: server.serverName,
                                      toolName: entry.toolName,
                                      entrypointType: entry.entrypoint.type,
                                      ...(entry.entrypoint.type === 'file' ? { filePath } : {}),
                                    })
                                  }
                                >
                                  {entry.entrypoint.type === 'file' ? (
                                    <DocumentIcon
                                      className="h-4 w-4 shrink-0 text-secondary"
                                      aria-hidden="true"
                                    />
                                  ) : (
                                    <Squares2X2Icon
                                      className="h-4 w-4 shrink-0 text-secondary"
                                      aria-hidden="true"
                                    />
                                  )}
                                  <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                                  <ArrowUpRightIcon
                                    className="h-3.5 w-3.5 shrink-0 text-muted group-hover:text-foreground"
                                    aria-hidden="true"
                                  />
                                </button>
                                {entry.entrypoint.type === 'global' &&
                                  entry.entrypoint.quickAction && (
                                    <button
                                      type="button"
                                      className={APP_BUTTON}
                                      disabled={busy || !canDraft()}
                                      onClick={() =>
                                        void launch({
                                          serverName: server.serverName,
                                          toolName: entry.toolName,
                                          entrypointType: 'global',
                                          quickAction: true,
                                        })
                                      }
                                    >
                                      <BoltIcon className="h-3.5 w-3.5" aria-hidden="true" />
                                      {entry.entrypoint.quickAction.title}
                                    </button>
                                  )}
                              </div>
                            );
                          })}
                          {searchServer === server.serverName && (
                            <div className="space-y-1 px-2 pb-1 pt-2">
                              <form
                                className="flex items-center gap-1.5"
                                onSubmit={event => {
                                  event.preventDefault();
                                  void run(async signal => {
                                    const value = await apps
                                      .bind()
                                      .request<{ resources: McpAppResourceLink[] }>(
                                        McpAppMethod.Mention,
                                        { serverName: server.serverName, query },
                                        signal,
                                      );
                                    if (queryRef.current === query)
                                      setResources({
                                        server: server.serverName,
                                        items: value.resources,
                                      });
                                  });
                                }}
                              >
                                <input
                                  autoFocus
                                  type="search"
                                  aria-label={`${t('mcpAppsSearch')}: ${server.label}`}
                                  placeholder={t('mcpAppsSearch')}
                                  value={query}
                                  onChange={event => {
                                    setQuery(event.target.value);
                                    setResources(undefined);
                                    setAddedResource(undefined);
                                  }}
                                  maxLength={2048}
                                  className={APP_INPUT}
                                />
                                <button
                                  type="submit"
                                  disabled={busy || !canDraft()}
                                  className={APP_ICON_BUTTON}
                                  title={t('mcpAppsSearch')}
                                  aria-label={t('mcpAppsSearch')}
                                >
                                  <MagnifyingGlassIcon className="h-4 w-4" aria-hidden="true" />
                                </button>
                              </form>
                              {resources?.server === server.serverName &&
                                !resources.items.length && (
                                  <p className="px-1 py-2 text-secondary" role="status">
                                    {t('mcpAppsNoResources')}
                                  </p>
                                )}
                              {resources?.server === server.serverName &&
                                resources.items.map(resource => (
                                  <button
                                    key={resource.uri}
                                    type="button"
                                    disabled={busy || !canDraft()}
                                    className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40"
                                    title={resource.description || resource.title || resource.name}
                                    onClick={() =>
                                      void run(async () => {
                                        const added = await addDraft(
                                          JSON.stringify(
                                            { serverName: server.serverName, resource },
                                            null,
                                            2,
                                          ),
                                        );
                                        if (added) setAddedResource(resource.uri);
                                        else setError(t('mcpAppsDraftFailed'));
                                      })
                                    }
                                  >
                                    <DocumentIcon
                                      className="h-4 w-4 shrink-0 text-secondary"
                                      aria-hidden="true"
                                    />
                                    <span className="min-w-0 flex-1 truncate">
                                      {resource.title || resource.name}
                                    </span>
                                    {addedResource === resource.uri ? (
                                      <CheckIcon
                                        className="h-4 w-4 shrink-0 text-primary"
                                        aria-label={t('mcpAppsDraftAdded')}
                                      />
                                    ) : (
                                      <PlusIcon
                                        className="h-3.5 w-3.5 shrink-0 text-secondary"
                                        aria-label={t('mcpAppsAddDraft')}
                                      />
                                    )}
                                  </button>
                                ))}
                            </div>
                          )}
                        </section>
                      ))}
                      {onboarding?.map(plugin => (
                        <button
                          type="button"
                          disabled={busy || !canDraft()}
                          className={`${APP_BUTTON} m-1`}
                          key={plugin.pluginId}
                          onClick={() => {
                            if (
                              !(region.current?.ownerDocument.defaultView ?? window).confirm(
                                t('mcpAppsSetupConfirm'),
                              )
                            )
                              return;
                            void run(async signal => {
                              await onOnboard(plugin.pluginId, signal);
                            }, true);
                          }}
                        >
                          <PlusIcon className="h-3.5 w-3.5" aria-hidden="true" />
                          {plugin.title}
                          <ArrowUpRightIcon className="h-3 w-3" aria-hidden="true" />
                        </button>
                      ))}
                    </>
                  )}
                </div>
              </div>
            )}
            {addedResource && (
              <span className="sr-only" role="status">
                {t('mcpAppsDraftAdded')}
              </span>
            )}
          </>,
          panelTarget,
        )}
      <NativeAppQuestions key={sessionId} sessionId={sessionId} prepare={prepare} />
    </div>
  );
}
