import { ArrowPathIcon } from '@heroicons/react/24/outline';
import type { McpAppDiscovery, McpAppLaunchInput } from '@shared/plugins/mcpApps';
import { createElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useEngineReadiness } from '@/app/shell/startup/routing/useEngineReadiness';
import { resolveMcpAppIcons } from '@/libs/openclaw-chat/components/mcp-app/icons';
import type { McpAppViewContext } from '@/libs/openclaw-chat/components/mcp-app/view';
import { McpWorkspaceSession } from '@/libs/openclaw-chat/gateway/mcp-app/mcp-workspace-session';
import { decodeMcpAppLaunch } from '@/libs/openclaw-chat/pipeline/native-mcp-app';
import { i18nService } from '@/services/i18n';

import { HOME_DISPLAY_SESSION_KEY } from '../display/tabs/useSessionDisplayState';
import { openManagedFilePreview, openResourceFilePreview } from '../preview/filePreviewNavigation';
import { decodeFileAppLaunch, findFileApp, openManagedFileApp, type OpenMcpAppFile } from './fileApps';
import { withManualAppReopen } from './manualAppReopen';
import { McpAppIcon } from './McpAppIcon';
import type { McpAppComposerMenu } from './McpAppsControls';
import { openWorkspaceAppFile, openWorkspaceAppLaunch } from './workspaceApps';

interface Options {
  currentSessionId?: string | null;
  currentSessionCwd?: string;
  sessionIds?: readonly string[];
  sessionInteractive?: boolean;
  enabled: boolean;
  cwd: string;
  agentId: string;
  permissionMode: string;
  addDraft: (text: string) => Promise<boolean>;
}

/** Preload the real home App catalog without launching an App or sending chat. */
export function useHomeFileApps(options: Options): {
  openFile: OpenMcpAppFile;
  discover: () => Promise<void>;
  menu: McpAppComposerMenu;
  beginStart: (temporarySessionId: string, context: McpAppViewContext) => string | undefined;
  promote: (from: string, to: string) => void;
  rollback: (temporarySessionId: string) => void;
} {
  const engine = useEngineReadiness();
  const runtimeReady = engine.ready;
  const key = JSON.stringify([options.cwd, options.agentId, options.permissionMode]);
  const latest = useRef({ ...options, key, nativeAvailable: !engine.pending && !engine.failed });
  latest.current = { ...options, key, nativeAvailable: !engine.pending && !engine.failed };
  const active = useRef(true);
  type Owner = {
    key: string;
    requestId: string;
    session: McpWorkspaceSession;
    targetSessionId?: string;
    valid: boolean;
    hasAuthenticatedConnection: boolean;
  };
  const owned = useRef<Owner>();
  const retained = useRef(new Set<Owner>());
  const hasPendingStart = useCallback(
    () =>
      [...retained.current].some(
        scope => scope.key === latest.current.key && scope.targetSessionId?.startsWith('temp-'),
      ),
    [],
  );
  const [catalog, setCatalog] = useState<{
    owner: NonNullable<typeof owned.current>;
    value: McpAppDiscovery;
    isCurrent: () => boolean;
  }>();
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const [requestState, setRequestState] = useState<{ key: string; failed: boolean }>();
  const pending = useRef<{ revision: number; task: Promise<void>; abort: AbortController }>();
  const discovery = useRef({ revision: 0 }).current;
  const navigation = useRef(0);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      discovery.revision++;
      pending.current?.abort.abort();
      pending.current = undefined;
      catalogRef.current = undefined;
      if (owned.current) {
        owned.current.valid = false;
        owned.current.session.dispose();
      }
      owned.current = undefined;
    };
  }, [key, discovery]);
  useLayoutEffect(() => {
    navigation.current++;
    if (!options.enabled) {
      owned.current?.session.apps.invalidate(true);
    }
    for (const scope of retained.current)
      if (
        scope.targetSessionId !== options.currentSessionId ||
        options.sessionInteractive === false
      )
        scope.session.apps.invalidate(true);
  }, [options.enabled, options.currentSessionId, options.sessionInteractive, discovery]);
  useEffect(
    () => () => {
      for (const scope of retained.current) {
        scope.valid = false;
        scope.session.dispose();
      }
      retained.current.clear();
    },
    [],
  );
  const sessionIdsKey = options.sessionIds?.join('\0');
  useEffect(() => {
    if (sessionIdsKey === undefined) return;
    const existing = new Set(sessionIdsKey.split('\0'));
    for (const scope of retained.current) {
      const id = scope.targetSessionId;
      if (
        !id ||
        id.startsWith('temp-') ||
        id === latest.current.currentSessionId ||
        existing.has(id)
      )
        continue;
      scope.valid = false;
      scope.session.dispose();
      retained.current.delete(scope);
    }
  }, [sessionIdsKey]);
  const owner = useCallback(() => {
    if (!active.current) throw new Error('App workspace changed');
    let owner = owned.current;
    if (!owner) {
      const scope = latest.current;
      const requestId = crypto.randomUUID();
      let created!: Owner;
      const interactive = () =>
        created.valid &&
        (created.targetSessionId
          ? latest.current.currentSessionId === created.targetSessionId &&
            latest.current.sessionInteractive !== false
          : latest.current.enabled && latest.current.key === scope.key);
      const session = new McpWorkspaceSession(
        { requestId, cwd: scope.cwd, agentId: scope.agentId },
        {
          isCurrent: () =>
            created.valid &&
            (Boolean(created.targetSessionId) ||
              (active.current && latest.current.key === scope.key)),
          canInteract: interactive,
          getWorkingDirectory: () =>
            created.targetSessionId
              ? latest.current.currentSessionId === created.targetSessionId
                ? latest.current.currentSessionCwd
                : undefined
              : scope.cwd,
          addDraft: text =>
            interactive() ? latest.current.addDraft(text) : Promise.resolve(false),
          openFile: async file => {
            if (!interactive()) return false;
            if (file.managed) return openManagedFilePreview({
              filePath: file.path,
              managed: file.managed,
              signal: file.signal,
              sessionId: created.targetSessionId ?? null,
              isCurrent: () => interactive() && file.isCurrent(),
            });
            if (file.preview) return openResourceFilePreview({
              preview: file.preview,
              sessionId: created.targetSessionId ?? null,
              isCurrent: () => interactive() && file.isCurrent(),
            });
            window.dispatchEvent(
              new CustomEvent('cowork:preview-file', {
                detail: {
                  filePath: file.path,
                  workingDirectory: scope.cwd,
                  isCurrent: interactive,
                },
              }),
            );
            return true;
          },
        },
      );
      created = { key: scope.key, requestId, session, valid: true, hasAuthenticatedConnection: false };
      owner = created;
      owned.current = owner;
    }
    return owner;
  }, []);
  const discover = useCallback((): Promise<void> => {
    if (!active.current || !latest.current.nativeAvailable ||
      !latest.current.cwd || !latest.current.agentId) return Promise.resolve();
    const cached = catalogRef.current;
    if (
      cached &&
      cached.owner === owned.current &&
      cached.owner.key === latest.current.key &&
      cached.owner.session.connected &&
      cached.isCurrent()
    )
      return Promise.resolve();
    if (pending.current?.revision === discovery.revision) return pending.current.task;
    const revision = ++discovery.revision;
    const key = latest.current.key;
    const abort = new AbortController();
    setRequestState({ key, failed: false });
    const task = (async () => {
      try {
        const scope = owner();
        const result = await scope.session.discover(abort.signal);
        const current = () =>
          active.current &&
          revision === discovery.revision &&
          latest.current.key === scope.key &&
          owned.current === scope &&
          result.isCurrent();
        if (current()) {
          const next = { owner: scope, ...result };
          catalogRef.current = next;
          setCatalog(next);
          setRequestState(undefined);
        }
      } catch {
        if (active.current && revision === discovery.revision) {
          catalogRef.current = undefined;
          setCatalog(undefined);
          setRequestState({ key, failed: true });
        }
      } finally {
        if (pending.current?.revision === revision) pending.current = undefined;
      }
    })();
    pending.current = { revision, task, abort };
    return task;
  }, [owner, discovery]);
  useEffect(() => {
    if (!runtimeReady || !options.cwd || !options.agentId) return;
    const scope = owner();
    let active = true;
    if (scope.session.connected) scope.hasAuthenticatedConnection = true;
    let disconnected = false;
    const stop = scope.session.subscribeConnection(() => {
      if (!active || latest.current.key !== scope.key || owned.current !== scope) return;
      if (!scope.session.connected) {
        // A failed socket before the first hello is still owned by the same
        // bounded connection wait. Keep that real preparation visible until
        // it succeeds or rejects, instead of cancelling it as a read failure.
        if (!scope.hasAuthenticatedConnection &&
            pending.current?.revision === discovery.revision) return;
        disconnected = true;
        discovery.revision++;
        pending.current?.abort.abort();
        catalogRef.current = undefined;
        setCatalog(undefined);
        setRequestState({ key: scope.key, failed: true });
        return;
      }
      // Initial preparation is already waiting for the first hello. After a
      // reconnect, let that old attempt settle before preparing the new owner.
      const wasAuthenticated = scope.hasAuthenticatedConnection;
      scope.hasAuthenticatedConnection = true;
      if (!wasAuthenticated && !disconnected) {
        return;
      }
      disconnected = false;
      setRequestState({ key: scope.key, failed: false });
      void (pending.current?.task ?? Promise.resolve()).then(() => {
        if (active && owned.current === scope && scope.session.connected) void discover();
      });
    });
    const refresh = () => {
      if (!active || latest.current.key !== scope.key || owned.current !== scope) return;
      discovery.revision++;
      pending.current?.abort.abort();
      catalogRef.current = undefined;
      setCatalog(undefined);
      setRequestState({ key: scope.key, failed: false });
      void (pending.current?.task ?? Promise.resolve()).then(() => {
        if (active && owned.current === scope) void discover();
      });
    };
    const stopConfig = window.electron.mcp?.onConfigSyncDone?.(refresh);
    const stopExtensions = window.electron.extensions?.onChanged?.(refresh);
    void discover();
    return () => {
      active = false;
      stop();
      stopConfig?.();
      stopExtensions?.();
    };
  }, [
    options.cwd,
    options.agentId,
    options.enabled,
    runtimeReady,
    key,
    owner,
    discover,
    discovery,
  ]);
  const launch = (input: McpAppLaunchInput, label: string) => {
    if (!latest.current.nativeAvailable || !latest.current.enabled || !active.current || hasPendingStart()) return;
    const scope = owner();
    const epoch = navigation.current;
    openWorkspaceAppLaunch({
      id: `mcp-app-entry:${HOME_DISPLAY_SESSION_KEY}:${scope.requestId}:${input.serverName}:${input.toolName}`,
      sessionId: HOME_DISPLAY_SESSION_KEY,
      label,
      icons: resolveMcpAppIcons(catalogRef.current?.value, input),
      retryable: false,
      load: async signal => {
        const current = () =>
          active.current &&
          latest.current.enabled &&
          navigation.current === epoch &&
          owned.current === scope &&
          !signal.aborted;
        if (!current()) throw new Error('App workspace changed');
        const context = await scope.session.prepare();
        if (!current() || !context.isCurrent()) throw new Error('App workspace changed');
        const preview = decodeMcpAppLaunch(await scope.session.apps.launch(input, signal));
        if (!preview || !current() || !context.isCurrent())
          throw new Error('App launch superseded');
        return {
          preview,
          context: withManualAppReopen({
            context,
            preview,
            input,
            catalog: catalogRef.current?.owner === scope ? catalogRef.current.value : undefined,
            captureOwner: () => {
              const target = scope.targetSessionId;
              const revision = navigation.current;
              return () =>
                scope.valid &&
                latest.current.nativeAvailable &&
                scope.targetSessionId === target &&
                navigation.current === revision &&
                (target
                  ? !target.startsWith('temp-') &&
                    retained.current.has(scope) &&
                    latest.current.currentSessionId === target &&
                    latest.current.sessionInteractive !== false
                  : active.current && latest.current.enabled && owned.current === scope);
            },
          }),
        };
      },
    });
  };
  const openFile = useCallback<OpenMcpAppFile>(
    async request => {
      if (!latest.current.nativeAvailable || !latest.current.enabled || !request.isCurrent() || hasPendingStart()) return false;
      const { filePath, handlerId: requestedHandlerId } = request;
      const scope = owner();
      const epoch = navigation.current;
      const { session } = scope;
      const current = () =>
        active.current &&
        latest.current.enabled &&
        navigation.current === epoch &&
        owned.current === scope;
      let context: McpAppViewContext;
      let catalog;
      try {
        context = await session.prepare();
        catalog = await session.apps.discover();
      } catch {
        // A missing/disabled runtime must not break the existing ordinary preview.
        return false;
      }
      if (!current() || !request.isCurrent() || !context.isCurrent()) return false;
      const handler = findFileApp(catalog, filePath, requestedHandlerId);
      if (!handler) return false;
      const { id: handlerId, icons, pluginId } = handler;
      if (request.focusExisting?.(handlerId)) return true;
      if (request.managed) {
        const revision = session.apps.discoveryRevision;
        return openManagedFileApp(
          { ...request, managed: request.managed },
          handler,
          HOME_DISPLAY_SESSION_KEY,
          context,
          () => current() && session.apps.discoveryRevision === revision,
        );
      }
      const fileName = filePath.split(/[\\/]/).pop() || filePath;
      const load = async (
        currentLoad: () => boolean,
        signal?: AbortSignal,
        original?: ReturnType<typeof session.apps.bind>,
      ) => {
        if (!currentLoad() || signal?.aborted) throw new Error('App workspace changed');
        const fresh = await session.prepare();
        if (!currentLoad() || !fresh.isCurrent() || signal?.aborted)
          throw new Error('App workspace changed');
        const binding = session.apps.bind();
        if (
          original &&
          (binding.sessionKey !== original.sessionKey ||
            binding.sessionId !== original.sessionId ||
            binding.agentId !== original.agentId)
        )
          throw new Error('File App native session changed');
        const discovery = await session.apps.discover(signal);
        const selected = findFileApp(discovery, filePath, handlerId);
        if (
          !currentLoad() ||
          !fresh.isCurrent() ||
          signal?.aborted ||
          !selected ||
          selected.pluginId !== pluginId
        )
          throw new Error('File App is no longer available');
        const preview = decodeFileAppLaunch(
          await session.apps.launch(selected.input, signal),
          selected,
          fresh.sessionKey,
        );
        if (!preview || !currentLoad() || !fresh.isCurrent() || signal?.aborted)
          throw new Error('File App open was superseded');
        const reopen = (signal?: AbortSignal) => {
          const target = scope.targetSessionId;
          const reopenEpoch = navigation.current;
          const currentReopen = () => {
            if (
              !active.current || !scope.valid || navigation.current !== reopenEpoch ||
              scope.targetSessionId !== target
            )
              return false;
            if (!target) return latest.current.enabled && owned.current === scope;
            return (
              !target.startsWith('temp-') &&
              retained.current.has(scope) &&
              latest.current.currentSessionId === target &&
              latest.current.sessionInteractive !== false
            );
          };
          return load(currentReopen, signal, binding);
        };
        const fileContext = (base: McpAppViewContext): McpAppViewContext => ({
          ...base,
          resume: () => {
            const resumed = base.resume?.();
            return resumed ? fileContext(resumed) : undefined;
          },
          reopen,
        });
        return { preview, context: fileContext(fresh) };
      };
      openWorkspaceAppFile({
        id: `mcp-app-file:${JSON.stringify([HOME_DISPLAY_SESSION_KEY, scope.requestId, filePath, handlerId])}`,
        sessionId: HOME_DISPLAY_SESSION_KEY,
        filePath,
        fileHandlerId: handlerId,
        label: requestedHandlerId ? `${fileName} · ${handler.label}` : fileName,
        icons,
        load: signal => load(current, signal),
      });
      return true;
    },
    [owner, hasPendingStart],
  );
  const menuEpoch = navigation.current;
  const currentCatalog =
    catalog?.owner === owned.current &&
    catalog?.owner.key === key &&
    catalog.owner.session.connected &&
    catalog.isCurrent() &&
    options.enabled
      ? catalog
      : undefined;
  const state = requestState?.key === key ? requestState : undefined;
  return {
    beginStart: (temporarySessionId, context) => {
      const scope = owned.current;
      if (
        !scope ||
        !scope.valid ||
        !scope.session.connected ||
        scope.session.apps !== context.apps ||
        !context.isCurrent() ||
        scope.key !== latest.current.key ||
        hasPendingStart()
      )
        return;
      scope.targetSessionId = temporarySessionId;
      retained.current.add(scope);
      owned.current = undefined;
      return scope.requestId;
    },
    promote: (from, to) => {
      const scope = [...retained.current].find(scope => scope.targetSessionId === from);
      if (!scope) return;
      scope.session.adopt(to);
      scope.targetSessionId = to;
    },
    rollback: temporarySessionId => {
      const scope = [...retained.current].find(
        scope => scope.targetSessionId === temporarySessionId,
      );
      if (!scope) return;
      if (scope.key !== latest.current.key) {
        scope.valid = false;
        scope.session.dispose();
        retained.current.delete(scope);
        return;
      }
      // New launches are paused until this source is adopted or restored. Any
      // replacement owner is only catalog prewarming, so it is safe to release.
      if (owned.current) {
        owned.current.valid = false;
        owned.current.session.dispose();
      }
      scope.targetSessionId = undefined;
      retained.current.delete(scope);
      owned.current = scope;
      discovery.revision++;
      pending.current?.abort.abort();
      pending.current = undefined;
      catalogRef.current = undefined;
      setCatalog(undefined);
      if (latest.current.enabled) void discover();
    },
    openFile,
    discover,
    menu: {
      sessionId: HOME_DISPLAY_SESSION_KEY,
      fileCatalog: currentCatalog?.value,
      items: currentCatalog
        ? currentCatalog.value.servers.flatMap(server => {
            const entries = server.entrypoints.filter(entry => entry.entrypoint.type === 'global');
            return entries.map(entry => ({
              id: `mcp-app:${server.serverName}:${entry.toolName}`,
              label: entries.length === 1 ? server.label : entry.title || server.label,
              section: i18nService.t('mcpAppsTitle'),
              disabled: hasPendingStart(),
              icon: createElement(McpAppIcon, {
                icons: entry.icons ?? server.icons,
                label: server.label,
              }),
              onSelect: () => {
                if (
                  latest.current.key !== key ||
                  navigation.current !== menuEpoch ||
                  !latest.current.enabled ||
                  owned.current !== currentCatalog.owner ||
                  catalogRef.current !== currentCatalog ||
                  !currentCatalog.isCurrent()
                )
                  return;
                launch(
                  {
                    serverName: server.serverName,
                    toolName: entry.toolName,
                    entrypointType: 'global',
                  },
                  server.label,
                );
              },
            }));
          })
        : options.enabled && options.cwd && options.agentId
          ? [
              {
                id: 'mcp-app-discovery',
                label: i18nService.t(
                  state?.failed
                    ? 'mcpAppsRetryDiscovery'
                    : state || runtimeReady
                      ? 'mcpAppsDiscovering'
                      : 'mcpAppsUnavailable',
                ),
                description: state?.failed ? i18nService.t('mcpAppsDiscoveryFailed') : undefined,
                loading: !state?.failed && (Boolean(state) || runtimeReady),
                error: state?.failed === true,
                section: i18nService.t('mcpAppsTitle'),
                icon: createElement(ArrowPathIcon, {
                  className: 'h-4 w-4',
                }),
                disabled: !state?.failed,
                onSelect: () => void discover(),
              },
            ]
          : [],
    },
  };
}
