import type { McpAppDiscovery, McpAppLaunchInput, McpAppPreview } from '@shared/plugins/mcpApps';

import type { McpAppViewContext } from '@/libs/openclaw-chat/components/mcp-app/view';
import { findMcpAppViewAdapter } from '@/libs/openclaw-chat/pipeline/mcp-app-adapters';
import {
  decodeMcpAppLaunch,
  readNativeMcpAppIdentity,
} from '@/libs/openclaw-chat/pipeline/native-mcp-app';

export function withManualAppReopen({
  context,
  preview,
  input,
  catalog,
  captureOwner,
}: {
  context: McpAppViewContext;
  preview: McpAppPreview;
  input: McpAppLaunchInput;
  catalog?: McpAppDiscovery;
  /** The homepage owner can transfer to a conversation without changing the native view. */
  captureOwner?: () => () => boolean;
}): McpAppViewContext {
  const source = readNativeMcpAppIdentity(preview);
  const blank = source && findMcpAppViewAdapter(source)?.blankLaunch;
  if (
    !source ||
    !blank ||
    input.entrypointType !== 'global' ||
    input.quickAction ||
    source.toolName !== blank.toolName ||
    input.serverName !== source.serverName ||
    input.toolName !== source.toolName ||
    source.originSessionKey !== context.sessionKey ||
    !context.apps.ready
  )
    return context;
  const matchesEntry = (value: McpAppDiscovery | undefined) =>
    value?.servers.some(
      server =>
        server.pluginId === blank.pluginId &&
        server.serverName === source.serverName &&
        server.entrypoints.some(
          entry =>
            entry.toolName === source.toolName &&
            entry.resourceUri === source.uiResourceUri &&
            entry.entrypoint.type === 'global' &&
            !entry.entrypoint.quickAction,
        ),
    );
  if (!matchesEntry(catalog)) return context;
  const original = context.apps.bind();
  if (!original.sessionId || !original.agentId) return context;
  const launch = Object.freeze({
    serverName: source.serverName,
    toolName: source.toolName,
    entrypointType: 'global' as const,
  });

  const resourceUri = source.uiResourceUri;

  function forView(base: McpAppViewContext, viewId: string): McpAppViewContext {
    let pending = false;
    let issued = false;
    function wrap(base: McpAppViewContext): McpAppViewContext {
      return {
        ...base,
        ...(base.refresh ? { refresh: async () => wrap(await base.refresh!()) } : {}),
        ...(base.resume
          ? {
              resume: () => {
                const resumed = base.resume!();
                return resumed && wrap(resumed);
              },
            }
          : {}),
        reopenBlank: {
          viewId,
          status: () => pending ? 'opening' : issued ? 'unknown' : 'ready',
          async open(signal) {
            if (issued || pending) throw new Error('Blank App launch is unavailable');
            pending = true;
            try {
              const stillOwnsView = captureOwner?.();
              const fresh = base.isCurrent() ? base : base.resume?.();
              if (
                !fresh?.isCurrent() ||
                fresh.apps !== context.apps ||
                fresh.sessionKey !== context.sessionKey ||
                fresh.presentationScope !== context.presentationScope
              )
                throw new Error('App source changed');
              const binding = fresh.apps.bind();
              const current = () =>
                !signal.aborted &&
                (stillOwnsView?.() ?? true) &&
                fresh.isCurrent() &&
                fresh.canDraft() &&
                binding.isCurrent() &&
                binding.sessionId === original.sessionId &&
                binding.agentId === original.agentId;
              if (!current()) throw new Error('App source changed');
              const ready = await fresh.apps.discover(signal);
              if (!current() || !matchesEntry(ready))
                throw new Error('App entry is no longer available');

              issued = true;
              let result: unknown;
              try {
                result = await fresh.apps.launch(launch, signal);
              } catch (error) {
                if ((error as { requestSent?: boolean } | undefined)?.requestSent !== false)
                  return { status: 'unknown' };
                issued = false;
                throw error;
              }
              const next = decodeMcpAppLaunch(result);
              const identity = readNativeMcpAppIdentity(next);
              if (
                !current() ||
                !next ||
                !identity ||
                identity.viewId === viewId ||
                identity.originSessionKey !== fresh.sessionKey ||
                identity.serverName !== launch.serverName ||
                identity.toolName !== launch.toolName ||
                identity.uiResourceUri !== resourceUri
              )
                return { status: 'unknown' };
              return { status: 'opened', preview: next, context: forView(fresh, next.viewId) };
            } finally {
              pending = false;
            }
          },
        },
      };
    }
    return wrap(base);
  }

  return forView(context, preview.viewId);
}
