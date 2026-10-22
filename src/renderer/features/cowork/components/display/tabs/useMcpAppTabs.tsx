import { ArrowPathIcon } from '@heroicons/react/24/outline';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import { McpAppView } from '@/libs/openclaw-chat/components/mcp-app/view';
import { isNativeMcpAppPreview } from '@/libs/openclaw-chat/pipeline/native-mcp-app';
import { i18nService } from '@/services/i18n';

import { APP_BUTTON } from '../../mcpApps/mcpAppStyles';
import {
  isWorkspaceAppEntry,
  MCP_APP_WORKSPACE_CONTROLS_CLOSE_EVENT,
  MCP_APP_WORKSPACE_EVENT,
  type McpAppWorkspaceControlsEntry,
  type McpAppWorkspaceEntry,
  type McpAppWorkspaceLoadEntry,
} from '../../mcpApps/workspaceApps';
import type { CoworkDisplayTab } from '../CoworkDisplayPanel';
import { McpAppTabIcon } from './McpAppTabIcon';

type FileTab = McpAppWorkspaceLoadEntry & { failed?: boolean };
type AppTab = McpAppWorkspaceEntry | FileTab | McpAppWorkspaceControlsEntry;

function ControlsPanel({
  entry,
  active,
}: {
  entry: McpAppWorkspaceControlsEntry;
  active: boolean;
}) {
  const mount = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    entry.attach(mount.current);
    return () => entry.attach(null);
  }, [entry]);
  return (
    <div
      ref={mount}
      hidden={!active}
      className="absolute inset-0 z-20 overflow-y-auto bg-background"
    />
  );
}

function AppPanel({
  entry,
  active,
  register,
  reveal,
}: {
  entry: McpAppWorkspaceEntry;
  active: boolean;
  register: (view: McpAppView | null) => void;
  reveal: () => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const currentView = useRef<McpAppView>();
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  useLayoutEffect(() => {
    const host = mount.current;
    if (!host) return;
    // Adopt the empty custom element before creating any iframe. It keeps this
    // document for its entire lifetime, including workspace detachment.
    const view = new McpAppView();
    view.preview = entry.preview;
    view.context = entry.context;
    view.fillContainer = true;
    view.revealCanvas = () => revealRef.current();
    host.append(view);
    currentView.current = view;
    register(view);
    return () => {
      currentView.current = undefined;
      register(null);
      view.remove();
    };
  }, [entry.preview, entry.context, register]);
  useLayoutEffect(() => {
    if (!active) return;
    let listening = true;
    const resume = () =>
      queueMicrotask(() => {
        if (listening) currentView.current?.resume();
      });
    resume();
    const stop = entry.context.apps.subscribe(resume);
    return () => {
      listening = false;
      stop();
    };
  }, [active, entry]);
  return <div ref={mount} hidden={!active} className="absolute inset-0 z-20 bg-background" />;
}

export function useMcpAppTabs(sessionId: string, select: (id: string) => void, open: () => void) {
  const [entries, setEntries] = useState<AppTab[]>([]);
  const entriesRef = useRef(entries);
  const update = useCallback((change: (current: AppTab[]) => AppTab[]) => {
    entriesRef.current = change(entriesRef.current);
    setEntries(entriesRef.current);
  }, []);
  const latest = useRef({ sessionId, select, open });
  latest.current = { sessionId, select, open };
  const views = useRef(new Map<string, McpAppView>());
  const registrations = useRef(new Map<string, (view: McpAppView | null) => void>());
  const operations = useRef(new Map<string, AbortController>());
  const loadFile = useCallback(
    (entry: McpAppWorkspaceLoadEntry) => {
      if (entry.sessionId !== latest.current.sessionId) return;
      operations.current.get(entry.id)?.abort();
      const abort = new AbortController();
      operations.current.set(entry.id, abort);
      const pending: FileTab = { ...entry, failed: false };
      update(current =>
        current.some(item => item.id === entry.id)
          ? current.map(item => (item.id === entry.id ? pending : item))
          : [...current, pending],
      );
      const current = () =>
        !abort.signal.aborted &&
        latest.current.sessionId === pending.sessionId &&
        entriesRef.current.includes(pending);
      void (async () => {
        try {
          if (!current()) return;
          const result = await pending.load(abort.signal);
          if (!current()) return;
          if (!isNativeMcpAppPreview(result.preview) || !result.context.isCurrent())
            throw new Error('File App view is no longer current');
          const ready: McpAppWorkspaceEntry = {
            id: pending.id,
            sessionId: pending.sessionId,
            filePath: pending.filePath,
            label: pending.label,
            ...result,
          };
          // Fill the reserved tab without selecting it again after navigation.
          update(items => items.map(item => (item === pending ? ready : item)));
        } catch {
          if (current())
            update(items =>
              items.map(item => (item === pending ? { ...pending, failed: true } : item)),
            );
        } finally {
          if (operations.current.get(entry.id) === abort) operations.current.delete(entry.id);
        }
      })();
    },
    [update],
  );
  useLayoutEffect(() => {
    const listener = (event: Event) => {
      const entry: unknown = (event as CustomEvent).detail;
      if (!isWorkspaceAppEntry(entry) || entry.sessionId !== latest.current.sessionId) return;
      if ('attach' in entry) {
        if (event.type === MCP_APP_WORKSPACE_CONTROLS_CLOSE_EVENT) {
          if (!entriesRef.current.includes(entry)) return;
          entry.onClose();
          update(current => current.filter(item => item !== entry));
          return;
        }
        if (!entry.isCurrent()) return;
        const previous = entriesRef.current.find(item => item.id === entry.id);
        if (previous && previous !== entry && 'attach' in previous) previous.onClose();
        update(current => [...current.filter(item => item.id !== entry.id), entry]);
      } else if ('load' in entry) {
        const existing = entriesRef.current.find(item => item.id === entry.id);
        const view = views.current.get(entry.id);
        if (
          !existing ||
          'attach' in existing ||
          ('load' in existing
            ? existing.failed && existing.retryable !== false
            : entry.retryable !== false &&
              (!(view?.context ?? existing.context).isCurrent() || view?.error || view?.closed))
        )
          loadFile(entry);
      } else {
        if (!entry.context.isCurrent()) return;
        operations.current.get(entry.id)?.abort();
        update(current => {
          const existing = current.find(item => item.id === entry.id);
          if (
            existing &&
            'preview' in existing &&
            existing.context.isCurrent() &&
            existing.preview.viewId === entry.preview.viewId
          )
            return current;
          return [...current.filter(item => item.id !== entry.id), entry];
        });
      }
      latest.current.select(entry.id);
      latest.current.open();
    };
    window.addEventListener(MCP_APP_WORKSPACE_EVENT, listener);
    window.addEventListener(MCP_APP_WORKSPACE_CONTROLS_CLOSE_EVENT, listener);
    const pending = operations.current;
    return () => {
      window.removeEventListener(MCP_APP_WORKSPACE_EVENT, listener);
      window.removeEventListener(MCP_APP_WORKSPACE_CONTROLS_CLOSE_EVENT, listener);
      for (const abort of pending.values()) abort.abort();
      pending.clear();
      for (const entry of entriesRef.current) if ('attach' in entry) entry.onClose();
    };
  }, [loadFile, update]);
  useLayoutEffect(() => {
    update(current =>
      current.filter(entry => {
        if ('preview' in entry || entry.sessionId === sessionId) return true;
        if ('attach' in entry) entry.onClose();
        operations.current.get(entry.id)?.abort();
        operations.current.delete(entry.id);
        registrations.current.delete(entry.id);
        return false;
      }),
    );
  }, [sessionId, update]);
  const tabs: CoworkDisplayTab[] = entries
    .filter(entry => entry.sessionId === sessionId)
    .map(entry => ({
      id: entry.id,
      label: entry.label ?? ('preview' in entry ? entry.preview.title : ''),
      icon: (
        <McpAppTabIcon
          preview={'preview' in entry ? entry.preview : undefined}
          context={'context' in entry ? entry.context : undefined}
          icons={'icons' in entry ? entry.icons : undefined}
          label={entry.label ?? ('preview' in entry ? entry.preview.title : '')}
        />
      ),
      onSelect: () => select(entry.id),
      onClose: async () => {
        const closingEntry = entriesRef.current.find(item => item.id === entry.id);
        if (!closingEntry) return;
        if ('attach' in closingEntry) {
          closingEntry.onClose();
          update(current => current.filter(item => item !== closingEntry));
          return;
        }
        operations.current.get(entry.id)?.abort();
        operations.current.delete(entry.id);
        if ('load' in closingEntry) {
          update(current => current.filter(item => item !== closingEntry));
          registrations.current.delete(entry.id);
          return;
        }
        const view = views.current.get(entry.id);
        await view?.closeApp();
        if (view?.contextCleanupUnconfirmed)
          window.dispatchEvent(
            new CustomEvent('app:showToast', { detail: i18nService.t('mcpAppsCloseUnknown') }),
          );
        update(current => current.filter(item => item !== closingEntry));
        if (!entriesRef.current.some(item => item.id === entry.id))
          registrations.current.delete(entry.id);
      },
    }));
  return {
    async prepareContext(): Promise<boolean> {
      const source = latest.current.sessionId;
      const current = entriesRef.current.filter(
        entry => entry.sessionId === source && !('attach' in entry),
      );
      if (!current.length) return false;
      for (const entry of current) {
        const view = views.current.get(entry.id);
        if ('load' in entry || !view) throw new Error('App is still loading');
        await view.prepareContext();
        if (latest.current.sessionId !== source || !entriesRef.current.includes(entry))
          throw new Error('App workspace changed during preparation');
      }
      return true;
    },
    promote: (from: string, to: string) => {
      update(current =>
        current.map(entry =>
          entry.sessionId === from && 'preview' in entry ? { ...entry, sessionId: to } : entry,
        ),
      );
    },
    tabs,
    hasRetainedPanels: entries.some(entry => 'preview' in entry),
    focusFile: (filePath: string) => {
      const entry = entriesRef.current.find(
        item =>
          item.sessionId === sessionId &&
          'filePath' in item &&
          item.filePath === filePath &&
          ('load' in item ||
            ((views.current.get(item.id)?.context ?? item.context).isCurrent() &&
              !views.current.get(item.id)?.error &&
              !views.current.get(item.id)?.closed)),
      );
      if (!entry) return false;
      if ('load' in entry && entry.failed) loadFile(entry);
      select(entry.id);
      open();
      return true;
    },
    panels: (activeId: string | null) =>
      entries.map(entry => {
        if ('attach' in entry)
          return (
            <ControlsPanel
              key={entry.id}
              entry={entry}
              active={entry.sessionId === sessionId && entry.id === activeId}
            />
          );
        if ('load' in entry)
          return (
            <div
              key={entry.id}
              hidden={entry.sessionId !== sessionId || entry.id !== activeId}
              className="absolute inset-0 z-20 bg-background"
            >
              <div
                className="flex h-full items-center justify-center gap-3 p-4 text-xs text-secondary"
                aria-busy={!entry.failed}
              >
                {entry.failed ? (
                  <>
                    <span role="alert">
                      {i18nService.t(
                        entry.retryable === false
                          ? 'mcpAppsOperationUnknown'
                          : 'mcpAppsUnavailable',
                      )}
                    </span>
                    {entry.retryable !== false && (
                      <button type="button" className={APP_BUTTON} onClick={() => loadFile(entry)}>
                        {i18nService.t('mcpAppsRetry')}
                      </button>
                    )}
                  </>
                ) : (
                  <span role="status" aria-label={i18nService.t('mcpAppsLoading')}>
                    <ArrowPathIcon
                      className="h-4 w-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  </span>
                )}
              </div>
            </div>
          );
        let register = registrations.current.get(entry.id);
        if (!register) {
          register = view => {
            if (view) views.current.set(entry.id, view);
            else views.current.delete(entry.id);
          };
          registrations.current.set(entry.id, register);
        }
        return (
          <AppPanel
            key={entry.id}
            entry={entry}
            active={entry.sessionId === sessionId && entry.id === activeId}
            register={register}
            reveal={() => {
              select(entry.id);
              open();
            }}
          />
        );
      }),
  };
}
