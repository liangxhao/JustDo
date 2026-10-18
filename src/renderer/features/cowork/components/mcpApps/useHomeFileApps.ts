import { useCallback, useLayoutEffect, useRef } from 'react';

import type { McpAppViewContext } from '@/libs/openclaw-chat/components/mcp-app/view';
import { McpWorkspaceSession } from '@/libs/openclaw-chat/gateway/mcp-workspace-session';
import { decodeMcpAppLaunch } from '@/libs/openclaw-chat/pipeline/native-mcp-app';

import { HOME_DISPLAY_SESSION_KEY } from '../display/useSessionDisplayState';
import { findFileApp, type OpenMcpAppFile } from './fileApps';
import { openWorkspaceAppFile } from './workspaceApps';

interface Options {
  enabled: boolean;
  cwd: string;
  agentId: string;
  permissionMode: string;
  addDraft: (text: string) => Promise<boolean>;
}

/** Homepage has no chat controller; prepare a native workspace only on an explicit file click. */
export function useHomeFileApps(options: Options): OpenMcpAppFile {
  const key = JSON.stringify([
    options.enabled,
    options.cwd,
    options.agentId,
    options.permissionMode,
  ]);
  const latest = useRef({ ...options, key });
  latest.current = { ...options, key };
  const active = useRef(true);
  const owned = useRef<{ key: string; session: McpWorkspaceSession }>();
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      owned.current?.session.dispose();
      owned.current = undefined;
    };
  }, [key]);
  return useCallback(async request => {
    if (!latest.current.enabled || !request.isCurrent()) return false;
    let owner = owned.current;
    if (!owner) {
      const scope = latest.current;
      const session = new McpWorkspaceSession(
        { requestId: crypto.randomUUID(), cwd: scope.cwd, agentId: scope.agentId },
        {
          isCurrent: () => active.current && latest.current.key === scope.key,
          addDraft: text => latest.current.addDraft(text),
          openFile: async file => {
            if (!active.current || latest.current.key !== scope.key) return false;
            window.dispatchEvent(
              new CustomEvent('cowork:preview-file', {
                detail: {
                  filePath: file.path,
                  workingDirectory: scope.cwd,
                  isCurrent: () => active.current && latest.current.key === scope.key,
                },
              }),
            );
            return true;
          },
        },
      );
      owner = { key: scope.key, session };
      owned.current = owner;
    }
    const { session } = owner;
    const current = () => active.current && owned.current === owner;
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
    const input = findFileApp(catalog, request.filePath);
    if (!input) return false;
    const load = async (signal?: AbortSignal) => {
      if (!current() || signal?.aborted) throw new Error('App workspace changed');
      const fresh = await session.prepare();
      const discovery = await session.apps.discover(signal);
      const handler = findFileApp(discovery, request.filePath);
      if (
        !current() ||
        !fresh.isCurrent() ||
        signal?.aborted ||
        handler?.serverName !== input.serverName ||
        handler.toolName !== input.toolName
      )
        throw new Error('File App is no longer available');
      const preview = decodeMcpAppLaunch(await session.apps.launch(input, signal));
      if (!preview || !current() || !fresh.isCurrent() || signal?.aborted)
        throw new Error('File App open was superseded');
      const fileContext: McpAppViewContext = { ...fresh, reopen: () => load() };
      return { preview, context: fileContext };
    };
    openWorkspaceAppFile({
      id: `mcp-app-file:${HOME_DISPLAY_SESSION_KEY}:${request.filePath}`,
      sessionId: HOME_DISPLAY_SESSION_KEY,
      filePath: request.filePath,
      label: request.filePath.split(/[\\/]/).pop() || request.filePath,
      load,
    });
    return true;
  }, []);
}
