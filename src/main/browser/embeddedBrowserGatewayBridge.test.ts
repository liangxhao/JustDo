import type { AppExecutionSessionQuery, AppResolvedExecutionSession } from '@app-plugin/sdk/main';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EMBEDDED_BROWSER_CANCELLED_EVENT,
  EMBEDDED_BROWSER_RELEASED_EVENT,
  EMBEDDED_BROWSER_REQUESTED_EVENT,
  EMBEDDED_BROWSER_REVOKED_EVENT,
  EMBEDDED_BROWSER_STOPPED_EVENT,
} from '../../../plugins/extensions/embedded-browser/browserExecutionContract';
import embeddedBrowserPlugin from '../../../plugins/extensions/embedded-browser/index';
import type { ScheduledTask } from '../../shared/scheduledTask/types';
import { EmbeddedBrowserGatewayBridge } from './embeddedBrowserGatewayBridge';

const nativeSdk = vi.hoisted(() => ({ getSessionEntry: vi.fn() }));
vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({
  getSessionEntry: nativeSdk.getSessionEntry,
}));
vi.mock('openclaw/plugin-sdk/media-store', () => ({ saveMediaBuffer: vi.fn() }));

const workspaceDir = path.resolve('test-workspace');
const userRun = {
  sessionKey: 'agent:main:justdo:conversation',
  sessionId: 'native-1',
  lifecycleRevision: 'one',
  runId: 'run-1',
  trigger: 'user',
  workspaceDir,
};
const cronRun = {
  ...userRun,
  sessionKey: 'agent:main:cron:job-1:run:iteration',
  trigger: 'cron',
  jobId: 'job-1',
};
const request = (
  run = userRun,
  requestId = 'request-1',
  command: Record<string, unknown> = { action: 'open', url: 'https://example.com' },
  admissionRevision = 1,
) => ({
  event: EMBEDDED_BROWSER_REQUESTED_EVENT,
  payload: {
    requestId,
    run,
    sessionKey: run.sessionKey,
    toolCallId: `call-${requestId}`,
    admissionRevision,
    command,
    policy: { allowLocalFiles: true },
  },
});

const setup = () => {
  const options = {
    isEnabled: vi.fn(() => true),
    getDesktopSession: vi.fn(
      (
        _key: string,
      ): { id: string; cwd: string; historyBinding?: { nativeSessionId: string } } | null => ({
        id: 'conversation',
        cwd: workspaceDir,
      }),
    ),
    getScheduledTask: vi.fn(
      async () =>
        ({
          id: 'job-1',
          management: 'editable',
          sessionTarget: 'isolated',
          agentId: 'main',
          payload: { kind: 'agentTurn' },
        }) as ScheduledTask,
    ),
    resolveExecutionSession: vi.fn<
      (query: AppExecutionSessionQuery) => Promise<AppResolvedExecutionSession | null>
    >(async () => null),
    isExecutionSourceCurrent: vi.fn(() => true),
    isNativeOnlyExecutionSource: vi.fn(() => false),
    execute: vi.fn(
      async (_key: string, _command: unknown, _signal: AbortSignal, _scope: unknown) => ({
        ok: true,
      }),
    ),
    releaseScope: vi.fn(),
    revokeAll: vi.fn(),
    resolve: vi.fn(async (_id: string, _response: Record<string, unknown>) => undefined),
  };
  return { options, bridge: new EmbeddedBrowserGatewayBridge(options) };
};

describe('authenticated embedded browser Gateway boundary', () => {
  it('keeps a normally released sidebar page readable across metadata refresh without admitting another command from the old run', async () => {
    const { options, bridge } = setup();
    options.resolveExecutionSession.mockResolvedValue({
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'current',
      ownerSessionId: 'organizer-chat',
    });
    bridge.handleEvent(request(userRun, 'retained-sidebar-page'));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledOnce());
    const scope = options.execute.mock.calls[0][3] as { sessionId: string };
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: {
        run: userRun,
        reason: 'settled',
        discardPages: false,
      },
    });
    expect(options.releaseScope).toHaveBeenCalledExactlyOnceWith(scope.sessionId, false);
    options.releaseScope.mockClear();
    options.resolveExecutionSession.mockResolvedValue(null);
    await bridge.reconcileOwners(true);
    expect(options.releaseScope).not.toHaveBeenCalled();
    bridge.handleEvent(request(userRun, 'late-retained-command'));
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith('late-retained-command', {
        ok: false,
        error: expect.stringContaining('no longer available'),
      }),
    );
    expect(options.execute).toHaveBeenCalledOnce();
  });

  it('keeps the exact latest release when metadata lookup began before its normal Released receipt', async () => {
    const { options, bridge } = setup();
    const source = {
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'current',
      ownerSessionId: 'organizer-chat',
    };
    options.resolveExecutionSession.mockResolvedValue(source);
    bridge.handleEvent(request(userRun, 'release-during-metadata'));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledOnce());
    const scope = options.execute.mock.calls[0][3] as { sessionId: string };
    let finish!: (value: null) => void;
    options.resolveExecutionSession.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const reconciling = bridge.reconcileOwners(true);
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: {
        run: userRun,
        reason: 'settled',
        discardPages: false,
      },
    });
    expect(options.releaseScope).toHaveBeenCalledExactlyOnceWith(scope.sessionId, false);
    options.releaseScope.mockClear();
    finish(null);
    await reconciling;
    expect(options.releaseScope).not.toHaveBeenCalled();
    await bridge.reconcileOwners(true);
    expect(options.releaseScope).not.toHaveBeenCalled();
  });

  it('ignores an old metadata result after a new run replaces the retained source object', async () => {
    const { options, bridge } = setup();
    const source = {
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'current',
      ownerSessionId: 'organizer-chat',
    };
    options.resolveExecutionSession.mockResolvedValue(source);
    bridge.handleEvent(request(userRun, 'before-source-replacement'));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledOnce());
    let finish!: (value: null) => void;
    options.resolveExecutionSession.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const reconciling = bridge.reconcileOwners(true);
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: {
        run: userRun,
        reason: 'settled',
        discardPages: false,
      },
    });
    options.releaseScope.mockClear();
    bridge.handleEvent(
      request({ ...userRun, runId: 'replacement-run' }, 'replacement-during-metadata'),
    );
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledTimes(2));
    finish(null);
    await reconciling;
    expect(options.execute.mock.calls[1][2].aborted).toBe(false);
    expect(options.releaseScope).not.toHaveBeenCalled();
  });

  it('does not let a late older Released receipt give the latest active run passive page retention', async () => {
    const { options, bridge } = setup();
    options.resolveExecutionSession.mockResolvedValue({
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'current',
      ownerSessionId: 'organizer-chat',
    });
    bridge.handleEvent(request(userRun, 'older-native-run'));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledOnce());
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: {
        run: userRun,
        reason: 'settled',
        discardPages: false,
      },
    });
    const latest = { ...userRun, runId: 'latest-native-run' };
    bridge.handleEvent(request(latest, 'latest-native-run'));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledTimes(2));
    const scope = options.execute.mock.calls[1][3] as { sessionId: string };
    options.releaseScope.mockClear();
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: {
        run: userRun,
        reason: 'settled',
        discardPages: false,
      },
    });
    expect(options.releaseScope).not.toHaveBeenCalled();
    expect(options.execute.mock.calls[1][2].aborted).toBe(false);
    options.resolveExecutionSession.mockResolvedValue(null);
    await bridge.reconcileOwners(true);
    expect(options.releaseScope).toHaveBeenCalledExactlyOnceWith(scope.sessionId, true);
    expect(options.execute.mock.calls[1][2].aborted).toBe(true);
  });

  it('still closes a normally retained page on lifecycle withdrawal and explicit owner deletion', async () => {
    const { options, bridge } = setup();
    options.resolveExecutionSession.mockResolvedValue({
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'current',
      ownerSessionId: 'organizer-chat',
    });
    bridge.handleEvent(request(userRun, 'before-lifecycle-withdrawal'));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledOnce());
    const scope = options.execute.mock.calls[0][3] as { sessionId: string };
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: {
        run: userRun,
        reason: 'settled',
        discardPages: false,
      },
    });
    options.releaseScope.mockClear();
    options.isExecutionSourceCurrent.mockReturnValue(false);
    await bridge.reconcileOwners(true);
    expect(options.releaseScope).toHaveBeenCalledExactlyOnceWith(scope.sessionId, true);
    options.isExecutionSourceCurrent.mockReturnValue(true);
    const nextRun = { ...userRun, runId: 'second-member-run' };
    bridge.handleEvent(request(nextRun, 'before-owner-deletion'));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledTimes(2));
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: {
        run: nextRun,
        reason: 'settled',
        discardPages: false,
      },
    });
    options.releaseScope.mockClear();
    bridge.deleteSession('organizer-chat');
    expect(options.releaseScope).toHaveBeenCalledWith(scope.sessionId, true);
  });

  it('closes the precise retained pages before another run reuses their Native resource under a different display owner', async () => {
    const { options, bridge } = setup();
    options.resolveExecutionSession.mockResolvedValue({
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'current',
      ownerSessionId: 'organizer-chat',
    });
    bridge.handleEvent(request(userRun, 'original-retained-owner'));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledOnce());
    const scope = options.execute.mock.calls[0][3] as { sessionId: string };
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: {
        run: userRun,
        reason: 'settled',
        discardPages: false,
      },
    });
    options.releaseScope.mockClear();
    options.resolveExecutionSession.mockResolvedValue({
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'current',
      ownerSessionId: 'conversation',
    });
    bridge.handleEvent(
      request({ ...userRun, runId: 'independent-member-run' }, 'new-display-owner'),
    );
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledTimes(2));
    expect(options.releaseScope).toHaveBeenCalledExactlyOnceWith(scope.sessionId, true);
    expect(options.releaseScope.mock.invocationCallOrder[0]).toBeLessThan(
      options.execute.mock.invocationCallOrder[1],
    );
    expect(options.execute.mock.calls[1][3]).toMatchObject({
      sessionId: scope.sessionId,
      ownerSessionId: 'conversation',
    });
    expect(options.execute.mock.calls[1][2].aborted).toBe(false);
  });

  it('retires a revoked previous owner before reusing its incarnation and leaves another member and late release untouched', async () => {
    const { options, bridge } = setup();
    const source = {
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'current',
      ownerSessionId: 'organizer-chat',
    };
    const sibling = {
      ...userRun,
      sessionKey: 'agent:sibling:justdo:conversation',
      sessionId: 'sibling-incarnation',
      runId: 'sibling-run',
    };
    options.resolveExecutionSession.mockResolvedValue(source);
    bridge.handleEvent(request(userRun, 'revoked-display-owner'));
    bridge.handleEvent(request(sibling, 'unaffected-sibling-owner'));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledTimes(2));
    const originalScope = options.execute.mock.calls[0][3] as { sessionId: string };
    const siblingSignal = options.execute.mock.calls[1][2];
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_REVOKED_EVENT,
      payload: { run: userRun, admissionRevision: 1 },
    });
    expect(options.releaseScope).toHaveBeenCalledExactlyOnceWith(originalScope.sessionId, false);
    options.releaseScope.mockClear();
    options.resolveExecutionSession.mockResolvedValue({
      ...source,
      ownerSessionId: 'independent-chat',
    });
    const latest = { ...userRun, runId: 'new-owner-run' };

    bridge.handleEvent(request(latest, 'owner-after-revocation'));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledTimes(3));

    expect(options.releaseScope).toHaveBeenCalledExactlyOnceWith(originalScope.sessionId, true);
    expect(options.releaseScope.mock.invocationCallOrder[0]).toBeLessThan(
      options.execute.mock.invocationCallOrder[2],
    );
    expect(options.execute.mock.calls[2][3]).toMatchObject({
      sessionId: originalScope.sessionId,
      ownerSessionId: 'independent-chat',
    });
    const latestSignal = options.execute.mock.calls[2][2];
    options.releaseScope.mockClear();
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: { run: userRun, reason: 'revoked', discardPages: true },
    });
    expect(options.releaseScope).not.toHaveBeenCalled();
    expect(latestSignal.aborted).toBe(false);
    expect(siblingSignal.aborted).toBe(false);
  });

  it('rechecks a new run before reusing retained pages and does not carry passive retention into active execution', async () => {
    const { options, bridge } = setup();
    options.resolveExecutionSession.mockResolvedValue({
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'current',
      ownerSessionId: 'organizer-chat',
    });
    bridge.handleEvent(request(userRun, 'retained-for-new-run'));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledOnce());
    const scope = options.execute.mock.calls[0][3] as { sessionId: string };
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: {
        run: userRun,
        reason: 'settled',
        discardPages: false,
      },
    });
    options.releaseScope.mockClear();
    options.resolveExecutionSession.mockClear();
    bridge.handleEvent(request({ ...userRun, runId: 'fresh-run' }, 'fresh-run-admission'));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledTimes(2));
    expect(options.resolveExecutionSession).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ runId: 'fresh-run' }),
    );
    expect(options.releaseScope).not.toHaveBeenCalled();
    options.resolveExecutionSession.mockResolvedValue(null);
    await bridge.reconcileOwners(true);
    expect(options.releaseScope).toHaveBeenCalledExactlyOnceWith(scope.sessionId, true);
    expect(options.execute.mock.calls[1][2].aborted).toBe(true);
  });

  it('does not retain pages for a revocation signal that has no normal Released receipt', async () => {
    const { options, bridge } = setup();
    options.resolveExecutionSession.mockResolvedValue({
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'current',
      ownerSessionId: 'organizer-chat',
    });
    bridge.handleEvent(request(userRun, 'not-settled-yet'));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledOnce());
    const scope = options.execute.mock.calls[0][3] as { sessionId: string };
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_REVOKED_EVENT,
      payload: { run: userRun, admissionRevision: 1 },
    });
    options.releaseScope.mockClear();
    options.resolveExecutionSession.mockResolvedValue(null);
    await bridge.reconcileOwners(true);
    expect(options.releaseScope).toHaveBeenCalledExactlyOnceWith(scope.sessionId, true);
  });

  it('retires an active source when only its exact native producer changes during reconciliation', async () => {
    const { options, bridge } = setup();
    const source = {
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'current',
      ownerSessionId: 'organizer-chat',
    };
    options.resolveExecutionSession.mockResolvedValue(source);
    bridge.handleEvent(request(userRun, 'before-native-producer-change'));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledOnce());
    const scope = options.execute.mock.calls[0][3] as { sessionId: string };
    const signal = options.execute.mock.calls[0][2];
    options.resolveExecutionSession.mockResolvedValue({
      ...source,
      nativePluginId: 'replacement-native-producer',
    });

    await bridge.reconcileOwners(true);

    expect(options.releaseScope).toHaveBeenCalledExactlyOnceWith(scope.sessionId, true);
    expect(signal.aborted).toBe(true);
  });

  it('rechecks only the awaiting source when unrelated metadata reconciliation occurs and preserves the sibling pages', async () => {
    const { options, bridge } = setup();
    const source = {
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'current',
      ownerSessionId: 'organizer-chat',
    };
    const sibling = {
      ...userRun,
      sessionKey: 'agent:sibling:justdo:other',
      sessionId: 'sibling-native',
      runId: 'sibling-run',
    };
    let complete!: (value: AppResolvedExecutionSession) => void;
    let firstRead = true;
    options.resolveExecutionSession.mockImplementation(async query => {
      if (query.sessionKey === userRun.sessionKey && firstRead) {
        firstRead = false;
        return new Promise(resolve => {
          complete = resolve;
        });
      }
      return source;
    });
    bridge.handleEvent(request(sibling, 'existing-sibling'));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledOnce());
    const siblingSignal = options.execute.mock.calls[0][2];
    bridge.handleEvent(request(userRun, 'awaiting-source'));
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    await bridge.reconcileOwners();
    complete(source);
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith('awaiting-source', {
        ok: true,
        result: { ok: true },
      }),
    );
    expect(options.execute).toHaveBeenCalledTimes(2);
    expect(
      options.resolveExecutionSession.mock.calls.filter(
        ([query]) => query.sessionKey === userRun.sessionKey,
      ),
    ).toHaveLength(2);
    expect(options.execute.mock.calls[1][3]).toMatchObject({
      ownerSessionId: 'organizer-chat',
      sourceEpoch: 'current',
    });
    expect(siblingSignal.aborted).toBe(false);
    expect(options.releaseScope).not.toHaveBeenCalled();
  });

  it('does not admit an old association when the exact pending source changes during reconciliation', async () => {
    const { options, bridge } = setup();
    const source = {
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'current',
      ownerSessionId: 'organizer-chat',
    };
    let complete!: (value: AppResolvedExecutionSession) => void;
    options.resolveExecutionSession.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          complete = resolve;
        }),
    );
    bridge.handleEvent(request(userRun, 'changed-source-await'));
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    options.resolveExecutionSession.mockResolvedValue({ ...source, pending: true });
    await bridge.reconcileOwners();
    complete(source);
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith('changed-source-await', {
        ok: false,
        error: expect.stringContaining('not yet confirmed'),
      }),
    );
    expect(options.execute).not.toHaveBeenCalled();
    expect(options.releaseScope).not.toHaveBeenCalled();
  });

  it('rejects uncertainty when the exact source changes again while the single read-only revalidation is awaiting', async () => {
    const { options, bridge } = setup();
    const source = {
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'current',
      ownerSessionId: 'original-organizer',
    };
    let initial!: (value: AppResolvedExecutionSession) => void;
    let revalidated!: (value: AppResolvedExecutionSession) => void;
    options.resolveExecutionSession
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            initial = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            revalidated = resolve;
          }),
      );
    bridge.handleEvent(request(userRun, 'changed-during-revalidation'));
    await vi.waitFor(() => expect(initial).toBeTypeOf('function'));
    await bridge.reconcileOwners();
    initial(source);
    await vi.waitFor(() => expect(revalidated).toBeTypeOf('function'));
    // A new receipt changes the source while the outstanding response still
    // carries the previous snapshot, without changing its plugin epoch.
    options.resolveExecutionSession.mockResolvedValue({
      ...source,
      ownerSessionId: 'replacement-organizer',
    });
    await bridge.reconcileOwners();
    revalidated(source);
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith('changed-during-revalidation', {
        ok: false,
        error: expect.stringContaining('ownership changed'),
      }),
    );
    expect(options.resolveExecutionSession).toHaveBeenCalledTimes(2);
    expect(options.execute).not.toHaveBeenCalled();
    expect(options.releaseScope).not.toHaveBeenCalled();
  });

  it('does not silently reparent an awaiting command when source revalidation returns another display owner', async () => {
    const { options, bridge } = setup();
    const source = {
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'current',
      ownerSessionId: 'original-organizer',
    };
    let complete!: (value: AppResolvedExecutionSession) => void;
    options.resolveExecutionSession.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          complete = resolve;
        }),
    );
    bridge.handleEvent(request(userRun, 'reparent-during-await'));
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    options.resolveExecutionSession.mockResolvedValue({
      ...source,
      ownerSessionId: 'different-organizer',
    });
    await bridge.reconcileOwners();
    complete(source);
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith('reparent-during-await', {
        ok: false,
        error: expect.stringContaining('ownership changed'),
      }),
    );
    expect(options.execute).not.toHaveBeenCalled();
    expect(options.releaseScope).not.toHaveBeenCalled();
  });

  it('prefers a proven collaboration source to the member ordinary product binding', async () => {
    const { options, bridge } = setup();
    options.resolveExecutionSession.mockResolvedValue({
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'current',
      ownerSessionId: 'organizer-chat',
      label: 'Member',
    });
    bridge.handleEvent(request(userRun, 'collaboration-member'));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledOnce());
    const scope = options.execute.mock.calls[0][3] as { sessionId: string; assertCurrent(): void };
    expect(scope).toMatchObject({
      sessionId: expect.stringMatching(/^browser-execution:/),
      ownerSessionId: 'organizer-chat',
      sourcePluginId: 'agent-team',
      sourceEpoch: 'current',
      workspaceDir: userRun.workspaceDir,
      headlessOnly: false,
    });
    expect(scope.sessionId).not.toBe('conversation');
    expect(options.resolveExecutionSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: userRun.sessionKey,
        nativeSessionId: userRun.sessionId,
        runId: userRun.runId,
      }),
    );
    options.isExecutionSourceCurrent.mockReturnValue(false);
    expect(scope.assertCurrent).toThrow('owning plugin');
  });

  it('rejects an unconfirmed collaboration source without creating or closing any resource, then admits a new command after its exact receipt arrives', async () => {
    const { options, bridge } = setup();
    options.resolveExecutionSession.mockResolvedValue({
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'current',
      pending: true,
    });
    bridge.handleEvent(request(userRun, 'before-delivery-ack'));
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith('before-delivery-ack', {
        ok: false,
        error: expect.stringContaining('not yet confirmed'),
      }),
    );
    expect(options.execute).not.toHaveBeenCalled();
    expect(options.releaseScope).not.toHaveBeenCalled();
    expect(options.revokeAll).not.toHaveBeenCalled();
    options.resolveExecutionSession.mockResolvedValue({
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'current',
      ownerSessionId: 'organizer-chat',
    });
    bridge.handleEvent(request(userRun, 'after-delivery-ack'));
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith('after-delivery-ack', {
        ok: true,
        result: { ok: true },
      }),
    );
    expect(options.execute).toHaveBeenCalledOnce();
    expect(options.execute.mock.calls[0][3]).toMatchObject({
      sessionId: expect.stringMatching(/^browser-execution:/),
      ownerSessionId: 'organizer-chat',
    });
    expect(options.releaseScope).not.toHaveBeenCalled();
  });

  it('retains an independent member conversation as its own display source rather than treating all membership as organizer work', async () => {
    const { options, bridge } = setup();
    options.resolveExecutionSession.mockResolvedValue({
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'current',
      ownerSessionId: 'conversation',
    });
    bridge.handleEvent(request(userRun, 'member-independent-chat'));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledOnce());
    expect(options.execute.mock.calls[0][3]).toMatchObject({
      sessionId: expect.stringMatching(/^browser-execution:/),
      ownerSessionId: 'conversation',
      sourcePluginId: 'agent-team',
      workspaceDir: userRun.workspaceDir,
    });
  });

  it('preserves a known nullable lifecycle revision for an App-associated product member', async () => {
    const { options, bridge } = setup();
    options.resolveExecutionSession.mockResolvedValue({
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'current',
      ownerSessionId: 'organizer-chat',
    });
    const run = { ...userRun, lifecycleRevision: null };
    const event = request(userRun, 'nullable-incarnation');
    bridge.handleEvent({ ...event, payload: { ...event.payload, run } });
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledOnce());
    expect(options.resolveExecutionSession).toHaveBeenCalledWith(
      expect.objectContaining({
        lifecycleRevision: null,
      }),
    );
    const admitted = options.execute.mock.calls[0][3] as { sessionId: string };
    const unknown = { ...run, runId: 'missing-revision-run', lifecycleRevision: undefined };
    const next = request(userRun, 'missing-incarnation');
    bridge.handleEvent({ ...next, payload: { ...next.payload, run: unknown } });
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith('missing-incarnation', {
        ok: false,
        error: expect.stringContaining('lifecycle'),
      }),
    );
    expect(options.execute).toHaveBeenCalledOnce();
    expect(admitted.sessionId).toMatch(/^browser-execution:/);
  });

  it('rejects a retired App source after its awaited resolution instead of falling back to the ordinary product chat', async () => {
    const { options, bridge } = setup();
    options.resolveExecutionSession.mockImplementation(async () => {
      options.isExecutionSourceCurrent.mockReturnValue(false);
      return {
        pluginId: 'agent-team',
        nativePluginId: 'agent-team',
        epoch: 'old',
        ownerSessionId: 'organizer-chat',
      };
    });
    bridge.handleEvent(request(userRun, 'retired-before-admission'));
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith('retired-before-admission', {
        ok: false,
        error: expect.stringContaining('owning plugin'),
      }),
    );
    expect(options.execute).not.toHaveBeenCalled();
    expect(options.releaseScope).not.toHaveBeenCalled();
  });

  it('does not let App resolvers hijack a positively classified Native-only execution', async () => {
    const { options, bridge } = setup();
    options.getDesktopSession.mockReturnValue(null);
    options.isNativeOnlyExecutionSource.mockReturnValue(true);
    options.resolveExecutionSession.mockResolvedValue({
      pluginId: 'unrelated-app',
      nativePluginId: 'unrelated-app',
      epoch: 'current',
      ownerSessionId: 'unrelated-conversation',
    });
    const event = request(userRun, 'native-owned', { action: 'open', headless: true });
    bridge.handleEvent({
      ...event,
      payload: {
        ...event.payload,
        executionSource: {
          version: 1,
          ownerPluginId: 'native-producer',
          sessionKey: userRun.sessionKey,
          nativeSessionId: userRun.sessionId,
          lifecycleRevision: userRun.lifecycleRevision,
        },
      },
    });
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledOnce());
    expect(options.resolveExecutionSession).not.toHaveBeenCalled();
    const scope = options.execute.mock.calls[0][3];
    expect(scope).toMatchObject({ headlessOnly: true });
    expect(scope).not.toHaveProperty('ownerSessionId');
    expect(scope).not.toHaveProperty('sourcePluginId');
  });

  it('withdraws an already admitted collaboration scope when its association becomes pending', async () => {
    const { options, bridge } = setup();
    const source = {
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'current',
      ownerSessionId: 'organizer-chat',
    };
    options.resolveExecutionSession.mockResolvedValue(source);
    bridge.handleEvent(request(userRun, 'confirmed-member'));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledOnce());
    const scope = options.execute.mock.calls[0][3] as { sessionId: string };
    const signal = options.execute.mock.calls[0][2];
    options.resolveExecutionSession.mockResolvedValue({ ...source, pending: true });
    await bridge.reconcileOwners();
    expect(signal.aborted).toBe(true);
    expect(options.releaseScope).toHaveBeenCalledExactlyOnceWith(scope.sessionId, true);
  });

  it('keeps sibling member resources independent when both product-bound runs display in the same organizer sidebar', async () => {
    const { options, bridge } = setup();
    options.resolveExecutionSession.mockResolvedValue({
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'current',
      ownerSessionId: 'organizer-chat',
    });
    const second = {
      ...userRun,
      sessionKey: 'agent:other:justdo:member-two',
      sessionId: 'native-two',
      runId: 'run-two',
    };
    bridge.handleEvent(request(userRun, 'sibling-one'));
    bridge.handleEvent(request(second, 'sibling-two'));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledTimes(2));
    const firstScope = options.execute.mock.calls[0][3] as { sessionId: string };
    const secondScope = options.execute.mock.calls[1][3] as { sessionId: string };
    expect(firstScope.sessionId).not.toBe(secondScope.sessionId);
    for (const scope of [firstScope, secondScope])
      expect(scope).toMatchObject({ ownerSessionId: 'organizer-chat' });
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: { run: userRun, reason: 'revoked', discardPages: true },
    });
    expect(options.execute.mock.calls[0][2].aborted).toBe(true);
    expect(options.execute.mock.calls[1][2].aborted).toBe(false);
    expect(options.releaseScope).toHaveBeenCalledExactlyOnceWith(firstScope.sessionId, true);
  });

  it('forgets closed child scope metadata while retaining successful foreground pages until source withdrawal', async () => {
    const { options, bridge } = setup();
    options.getDesktopSession.mockReturnValue(null);
    const state = bridge as unknown as {
      nativeScopes: Map<unknown, unknown>;
      incarnations: Map<unknown, unknown>;
      latestRuns: Map<unknown, unknown>;
      ownedScopes: Map<unknown, unknown>;
      runs: Map<unknown, unknown>;
    };
    for (let index = 0; index < 4; index++) {
      const run = {
        ...userRun,
        sessionKey: `agent:worker:subagent:closed-${index}`,
        sessionId: `native-${index}`,
        runId: `run-${index}`,
      };
      bridge.handleEvent(request(run, `closed-${index}`, { action: 'open', headless: true }));
      await vi.waitFor(() => expect(options.resolve).toHaveBeenCalledTimes(index + 1));
      bridge.handleEvent({
        event: EMBEDDED_BROWSER_RELEASED_EVENT,
        payload: { run, reason: 'settled', discardPages: false },
      });
    }
    for (const map of [
      state.nativeScopes,
      state.incarnations,
      state.latestRuns,
      state.ownedScopes,
      state.runs,
    ])
      expect(map.size).toBe(0);

    options.resolveExecutionSession.mockResolvedValue({
      pluginId: 'swarm-workflow',
      nativePluginId: 'swarm-workflow',
      epoch: 'active',
      ownerSessionId: 'conversation',
    });
    const retained = {
      ...userRun,
      sessionKey: 'agent:worker:subagent:retained',
      runId: 'retained',
    };
    bridge.handleEvent(request(retained, 'foreground', { action: 'open' }));
    await vi.waitFor(() => expect(options.resolve).toHaveBeenCalledTimes(5));
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: { run: retained, reason: 'settled', discardPages: false },
    });
    expect(options.releaseScope).toHaveBeenLastCalledWith(
      expect.stringMatching(/^browser-execution:/),
      false,
    );
    expect(state.runs.size).toBe(0);
    for (const map of [state.nativeScopes, state.incarnations, state.latestRuns, state.ownedScopes])
      expect(map.size).toBe(1);

    options.isExecutionSourceCurrent.mockReturnValue(false);
    const retiring = bridge.reconcileOwners();
    for (const map of [state.nativeScopes, state.incarnations, state.latestRuns, state.ownedScopes])
      expect(map.size).toBe(0);
    expect(options.releaseScope).toHaveBeenLastCalledWith(
      expect.stringMatching(/^browser-execution:/),
      true,
    );
    await retiring;
  });

  it('admits a confirmed Native-only producer only in its own background scope and revokes on inventory loss', async () => {
    const { options, bridge } = setup();
    options.getDesktopSession.mockReturnValue(null);
    options.isNativeOnlyExecutionSource.mockReturnValue(true);
    const run = { ...userRun, sessionKey: 'agent:worker:subagent:native-only' };
    const executionSource = {
      version: 1,
      ownerPluginId: 'native-producer',
      sessionKey: run.sessionKey,
      nativeSessionId: run.sessionId,
      lifecycleRevision: 'one',
    };
    const event = request(run, 'native-only', { action: 'open', headless: true });
    bridge.handleEvent({ ...event, payload: { ...event.payload, executionSource } });
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith('native-only', {
        ok: true,
        result: { ok: true },
      }),
    );
    const scope = options.execute.mock.calls[0][3] as { sessionId: string; assertCurrent(): void };
    expect(scope).toMatchObject({ headlessOnly: true, workspaceDir: run.workspaceDir });
    expect(scope).not.toHaveProperty('ownerSessionId');
    expect(scope).not.toHaveProperty('sourcePluginId');
    expect(scope.assertCurrent).not.toThrow();

    options.isNativeOnlyExecutionSource.mockReturnValue(false);
    expect(scope.assertCurrent).toThrow('inventory');
    const reconciling = bridge.reconcileOwners();
    expect(options.execute.mock.calls[0][2].aborted).toBe(true);
    expect(options.releaseScope).toHaveBeenCalledWith(scope.sessionId, true);
    await reconciling;
  });

  it('never reclassifies an already claimed App scope as an unclaimed Native-only producer', async () => {
    const { options, bridge } = setup();
    options.getDesktopSession.mockReturnValue(null);
    options.resolveExecutionSession.mockResolvedValue({
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'active',
      label: 'Standalone',
    });
    const run = { ...userRun, sessionKey: 'agent:worker:agent-team:group:standalone' };
    const executionSource = {
      version: 1,
      ownerPluginId: 'agent-team',
      sessionKey: run.sessionKey,
      nativeSessionId: run.sessionId,
      lifecycleRevision: 'one',
    };
    const first = request(run, 'app-first', { action: 'open', headless: true });
    bridge.handleEvent({ ...first, payload: { ...first.payload, executionSource } });
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledOnce());
    options.resolveExecutionSession.mockResolvedValue(null);
    // Even an optimistic caller cannot downgrade an existing explicit App claim.
    options.isNativeOnlyExecutionSource.mockReturnValue(true);
    const next = request({ ...run, runId: 'next-run' }, 'app-late', {
      action: 'open',
      headless: true,
    });
    bridge.handleEvent({ ...next, payload: { ...next.payload, executionSource } });
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith('app-late', {
        ok: false,
        error: expect.stringContaining('owning plugin'),
      }),
    );
    expect(options.execute).toHaveBeenCalledOnce();
  });

  it('keeps an explicitly adopted Native-only child in its own product sidebar with exact binding and live source guard', async () => {
    const { options, bridge } = setup();
    const run = { ...userRun, sessionKey: 'agent:worker:subagent:adopted-child' };
    const executionSource = {
      version: 1,
      ownerPluginId: 'native-producer',
      sessionKey: run.sessionKey,
      nativeSessionId: run.sessionId,
      lifecycleRevision: 'one',
    };
    options.getDesktopSession.mockReturnValue({
      id: 'adopted-product',
      cwd: run.workspaceDir,
      historyBinding: { nativeSessionId: run.sessionId },
    });
    options.isNativeOnlyExecutionSource.mockReturnValue(true);
    const event = request(run, 'adopted-front', { action: 'open', url: 'https://example.test/' });
    bridge.handleEvent({ ...event, payload: { ...event.payload, executionSource } });
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledOnce());
    const scope = options.execute.mock.calls[0][3] as { assertCurrent(): void };
    expect(scope).toMatchObject({
      sessionId: 'adopted-product',
      headlessOnly: false,
      workspaceDir: run.workspaceDir,
    });
    expect(options.resolveExecutionSession).not.toHaveBeenCalled();
    expect(scope.assertCurrent).not.toThrow();

    options.getDesktopSession.mockReturnValue({
      id: 'adopted-product',
      cwd: run.workspaceDir,
      historyBinding: { nativeSessionId: 'other-incarnation' },
    });
    const changed = request({ ...run, runId: 'new-run' }, 'bad-adoption');
    bridge.handleEvent({ ...changed, payload: { ...changed.payload, executionSource } });
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith('bad-adoption', {
        ok: false,
        error: expect.stringContaining('session binding'),
      }),
    );
    expect(options.execute).toHaveBeenCalledOnce();
    options.isNativeOnlyExecutionSource.mockReturnValue(false);
    expect(scope.assertCurrent).toThrow('inventory');
  });

  it('gives delegated runs separate resources and their own workspace in the real owner sidebar', async () => {
    const { options, bridge } = setup();
    options.getDesktopSession.mockReturnValue(null);
    options.resolveExecutionSession.mockResolvedValue({
      ownerSessionId: 'conversation',
      label: 'Worker',
      pluginId: 'swarm-workflow',
      nativePluginId: 'swarm-workflow',
      epoch: 'active',
    });
    const first = {
      ...userRun,
      sessionKey: 'agent:worker:subagent:first',
      sessionId: 'child-one',
      lifecycleRevision: 'life-one',
      workspaceDir: path.resolve('first-workspace'),
    };
    const second = {
      ...first,
      sessionKey: 'agent:worker:agent-team:group:room',
      sessionId: 'child-two',
      runId: 'run-two',
      lifecycleRevision: 'life-two',
      workspaceDir: path.resolve('second-workspace'),
    };
    bridge.handleEvent(request(first, 'first'));
    bridge.handleEvent(request(second, 'second'));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledTimes(2));
    const scopes = options.execute.mock.calls.map(call => call[3]) as Array<
      Record<string, unknown>
    >;
    expect(scopes.map(scope => scope.sessionId)).toEqual([
      expect.stringMatching(/^browser-execution:[a-f0-9]{64}$/),
      expect.stringMatching(/^browser-execution:[a-f0-9]{64}$/),
    ]);
    expect(scopes[0].sessionId).not.toBe(scopes[1].sessionId);
    expect(scopes).toEqual([
      expect.objectContaining({
        ownerSessionId: 'conversation',
        workspaceDir: first.workspaceDir,
        headlessOnly: false,
      }),
      expect.objectContaining({
        ownerSessionId: 'conversation',
        workspaceDir: second.workspaceDir,
        headlessOnly: false,
      }),
    ]);
    expect(options.resolveExecutionSession).toHaveBeenCalledWith({
      sessionKey: first.sessionKey,
      nativeSessionId: first.sessionId,
      lifecycleRevision: 'life-one',
      runId: first.runId,
    });
    const replacement = {
      ...first,
      lifecycleRevision: 'replacement-life',
      runId: 'replacement-run',
    };
    bridge.handleEvent(request(replacement, 'replacement'));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledTimes(3));
    expect(options.releaseScope).toHaveBeenCalledWith(scopes[0].sessionId, true);
    expect(options.releaseScope).not.toHaveBeenCalledWith(scopes[1].sessionId, true);
    expect((options.execute.mock.calls[2][3] as { sessionId: string }).sessionId).not.toBe(
      scopes[0].sessionId,
    );
  });

  it('requires explicit background mode for an admitted native run without a desktop owner', async () => {
    const { options, bridge } = setup();
    options.getDesktopSession.mockReturnValue(null);
    const run = {
      ...userRun,
      sessionKey: 'agent:worker:agent-team:group:standalone',
      lifecycleRevision: 'life',
    };
    bridge.handleEvent(request(run, 'foreground'));
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith('foreground', {
        ok: false,
        error: expect.stringContaining('headless=true'),
      }),
    );
    expect(options.execute).not.toHaveBeenCalled();
    bridge.handleEvent(request(run, 'background', { action: 'open', headless: true }));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledOnce());
    expect(options.execute.mock.calls[0][3]).toMatchObject({ headlessOnly: true, workspaceDir });
    expect(options.execute.mock.calls[0][3]).not.toHaveProperty('ownerSessionId');
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: { run, reason: 'settled', discardPages: false },
    });
    expect(options.releaseScope).toHaveBeenCalledWith(
      expect.stringMatching(/^browser-execution:/),
      true,
    );
  });

  it('withdraws retained child pages when the owning plugin relationship is retired', async () => {
    const { options, bridge } = setup();
    options.getDesktopSession.mockReturnValue(null);
    options.resolveExecutionSession.mockResolvedValue({
      ownerSessionId: 'conversation',
      pluginId: 'swarm-workflow',
      nativePluginId: 'swarm-workflow',
      epoch: 'active',
    });
    const run = { ...userRun, sessionKey: 'agent:worker:subagent:work', lifecycleRevision: 'life' };
    bridge.handleEvent(request(run));
    await vi.waitFor(() => expect(options.resolve).toHaveBeenCalled());
    const scopeId = (options.execute.mock.calls[0][3] as { sessionId: string }).sessionId;
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: { run, reason: 'settled', discardPages: false },
    });
    expect(options.releaseScope).toHaveBeenLastCalledWith(scopeId, false);
    options.resolveExecutionSession.mockResolvedValue(null);
    await bridge.reconcileOwners();
    expect(options.releaseScope).toHaveBeenLastCalledWith(scopeId, true);
  });

  it('withdraws synchronously at a source epoch fence without awaiting another metadata request', async () => {
    const { options, bridge } = setup();
    options.getDesktopSession.mockReturnValue(null);
    options.resolveExecutionSession.mockResolvedValue({
      ownerSessionId: 'conversation',
      pluginId: 'swarm-app',
      nativePluginId: 'swarm-workflow',
      epoch: 'active',
    });
    const run = { ...userRun, sessionKey: 'agent:worker:subagent:work', lifecycleRevision: 'life' };
    bridge.handleEvent(request(run));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalled());
    const scope = options.execute.mock.calls[0][3] as { sessionId: string; assertCurrent(): void };
    expect(() => scope.assertCurrent()).not.toThrow();
    expect(options.isExecutionSourceCurrent).toHaveBeenCalledWith('swarm-app', 'active');
    options.isExecutionSourceCurrent.mockReturnValue(false);
    options.resolveExecutionSession.mockClear();
    options.resolveExecutionSession.mockImplementation(() => new Promise(() => undefined));
    expect(() => scope.assertCurrent()).toThrow('owning plugin');
    const reconciling = bridge.reconcileOwners();
    expect(options.releaseScope).toHaveBeenCalledWith(scope.sessionId, true);
    expect(options.resolveExecutionSession).not.toHaveBeenCalled();
    await reconciling;
  });

  it('rechecks ownership on every call and never downgrades an old owned run to unowned background execution', async () => {
    const { options, bridge } = setup();
    options.getDesktopSession.mockReturnValue(null);
    options.resolveExecutionSession.mockResolvedValue({
      ownerSessionId: 'conversation',
      pluginId: 'swarm-workflow',
      nativePluginId: 'swarm-workflow',
      epoch: 'active',
    });
    const run = { ...userRun, sessionKey: 'agent:worker:subagent:work', lifecycleRevision: 'life' };
    bridge.handleEvent(request(run, 'before'));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledOnce());
    options.resolveExecutionSession.mockResolvedValue(null);
    bridge.handleEvent(request(run, 'after', { action: 'open', headless: true }));
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith('after', {
        ok: false,
        error: expect.stringContaining('owner'),
      }),
    );
    expect(options.execute).toHaveBeenCalledOnce();
    expect(options.releaseScope).toHaveBeenLastCalledWith(
      expect.stringMatching(/^browser-execution:/),
      true,
    );
  });

  it('keeps a claimed standalone source bound to its plugin epoch and never falls back after retirement', async () => {
    const { options, bridge } = setup();
    options.getDesktopSession.mockReturnValue(null);
    options.resolveExecutionSession.mockResolvedValue({
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'epoch-one',
      label: 'Standalone group',
    });
    const run = {
      ...userRun,
      sessionKey: 'agent:worker:agent-team:group:standalone',
      lifecycleRevision: 'one',
    };
    const source = {
      version: 1,
      ownerPluginId: 'agent-team',
      sessionKey: run.sessionKey,
      nativeSessionId: run.sessionId,
      lifecycleRevision: 'one',
    };
    const event = request(run, 'claimed', { action: 'open', headless: true });
    bridge.handleEvent({ ...event, payload: { ...event.payload, executionSource: source } });
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledOnce());
    expect(options.execute.mock.calls[0][3]).toMatchObject({
      sourcePluginId: 'agent-team',
      sourceEpoch: 'epoch-one',
      headlessOnly: true,
    });
    expect(options.resolveExecutionSession).toHaveBeenCalledWith(
      expect.objectContaining({ ownerPluginId: 'agent-team', nativeSessionId: run.sessionId }),
    );
    options.resolveExecutionSession.mockResolvedValue({
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'epoch-two',
      label: 'Standalone group',
    });
    await bridge.reconcileOwners();
    expect(options.releaseScope).toHaveBeenLastCalledWith(
      expect.stringMatching(/^browser-execution:/),
      true,
    );
    options.resolveExecutionSession.mockResolvedValue(null);
    const next = request({ ...run, runId: 'new-run' }, 'retired', {
      action: 'open',
      headless: true,
    });
    bridge.handleEvent({ ...next, payload: { ...next.payload, executionSource: source } });
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith('retired', {
        ok: false,
        error: expect.stringContaining('owning plugin'),
      }),
    );
    expect(options.execute).toHaveBeenCalledOnce();
  });
  it('keeps ordinary headless omission and the product workspace; model identity fields do not choose the scope', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent(
      request(userRun, 'r1', { action: 'open', sessionId: 'forged', workspaceDir: '/forged' }),
    );
    await vi.waitFor(() => expect(options.resolve).toHaveBeenCalled());
    expect(options.execute).toHaveBeenCalledWith(
      userRun.sessionKey,
      expect.objectContaining({ action: 'open' }),
      expect.any(AbortSignal),
      {
        sessionId: 'conversation',
        runId: 'run-1',
        workspaceDir,
        headlessOnly: false,
        allowLocalFiles: true,
      },
    );
  });

  it('prepares a scheduled run with its own page scope and the trusted workspace', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent(request(cronRun));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalled());
    expect(options.execute.mock.calls[0][3]).toMatchObject({
      sessionId: expect.stringMatching(/^browser-run:[a-f0-9]{64}$/),
      headlessOnly: true,
      workspaceDir,
    });
    expect(options.getDesktopSession).not.toHaveBeenCalled();
  });

  it('rejects cron false and advanced or managed task shapes', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent(request(cronRun, 'false', { action: 'open', headless: false }));
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith('false', expect.objectContaining({ ok: false })),
    );
    options.getScheduledTask.mockResolvedValue({
      id: 'job-1',
      management: 'managed',
    } as ScheduledTask);
    bridge.handleEvent(request({ ...cronRun, runId: 'run-2' }, 'managed'));
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith(
        'managed',
        expect.objectContaining({ ok: false }),
      ),
    );
    expect(options.execute).not.toHaveBeenCalled();
  });

  it('rejects missing transport identity, unavailable mapping and mismatched workspace', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_REQUESTED_EVENT,
      payload: { requestId: 'forged', sessionKey: userRun.sessionKey, command: { action: 'open' } },
    });
    expect(options.execute).not.toHaveBeenCalled();
    options.getDesktopSession.mockReturnValue({
      id: 'conversation',
      cwd: path.resolve('different'),
    });
    bridge.handleEvent(request());
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith(
        'request-1',
        expect.objectContaining({ ok: false }),
      ),
    );
    expect(options.execute).not.toHaveBeenCalled();
  });

  it('does not replay a duplicate requested event', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent(request());
    bridge.handleEvent(request());
    await vi.waitFor(() => expect(options.resolve).toHaveBeenCalled());
    bridge.handleEvent(request());
    expect(options.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects an imported binding to a different native incarnation', async () => {
    const { options, bridge } = setup();
    options.getDesktopSession.mockReturnValue({
      id: 'conversation',
      cwd: workspaceDir,
      historyBinding: { nativeSessionId: 'different-native-session' },
    } as ReturnType<typeof options.getDesktopSession>);
    bridge.handleEvent(request());
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith('request-1', {
        ok: false,
        error: 'The browser session binding is unavailable.',
      }),
    );
    expect(options.execute).not.toHaveBeenCalled();
  });

  it('matches cancellation to the complete run and tool call', async () => {
    const { options, bridge } = setup();
    options.execute.mockImplementation(
      async (_key, _command, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        }),
    );
    const event = request();
    bridge.handleEvent(event);
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalled());
    const signal = options.execute.mock.calls[0][2];
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_CANCELLED_EVENT,
      payload: { ...event.payload, run: { ...userRun, runId: 'other-run' } },
    });
    expect(signal.aborted).toBe(false);
    bridge.handleEvent({ event: EMBEDDED_BROWSER_CANCELLED_EVENT, payload: event.payload });
    expect(signal.aborted).toBe(true);
    expect(options.resolve).not.toHaveBeenCalled();
  });

  it('fences a request cancelled while task ownership is being checked', async () => {
    const { options, bridge } = setup();
    let finish!: (job: ScheduledTask) => void;
    options.getScheduledTask.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    bridge.handleEvent(request(cronRun));
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: { run: cronRun, reason: 'settled', discardPages: false },
    });
    finish({
      id: 'job-1',
      management: 'editable',
      sessionTarget: 'isolated',
      payload: { kind: 'agentTurn' },
    } as ScheduledTask);
    await new Promise(resolve => setImmediate(resolve));
    expect(options.execute).not.toHaveBeenCalled();
  });

  it('releases cron pages at the exact release, while ordinary settled pages remain available', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent(request(userRun, 'user'));
    bridge.handleEvent(request(cronRun, 'cron'));
    await vi.waitFor(() => expect(options.resolve).toHaveBeenCalledTimes(2));
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: { run: userRun, reason: 'settled', discardPages: false },
    });
    expect(options.releaseScope).toHaveBeenCalledWith('conversation', false);
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: { run: cronRun, reason: 'settled', discardPages: false },
    });
    expect(options.releaseScope).toHaveBeenCalledWith(expect.stringMatching(/^browser-run:/), true);
  });

  it('keeps a run revocation signal alive after the request result for armed callbacks', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent(request());
    await vi.waitFor(() => expect(options.resolve).toHaveBeenCalled());
    const signal = options.execute.mock.calls[0][2];
    expect(signal.aborted).toBe(false);
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: { run: userRun, reason: 'settled', discardPages: false },
    });
    expect(signal.aborted).toBe(true);
  });

  it.each([false, true])(
    'revokes effects on tool disposal and waits for the terminal to discard ordinary pages: %s',
    async discardPages => {
      const { options, bridge } = setup();
      bridge.handleEvent(request());
      await vi.waitFor(() => expect(options.resolve).toHaveBeenCalled());
      const signal = options.execute.mock.calls[0][2];

      bridge.handleEvent({
        event: EMBEDDED_BROWSER_REVOKED_EVENT,
        payload: { run: userRun, admissionRevision: 1 },
      });

      expect(signal.aborted).toBe(true);
      expect(options.releaseScope).toHaveBeenCalledExactlyOnceWith('conversation', false);
      bridge.handleEvent(request(userRun, 'after-disposal'));
      await vi.waitFor(() => expect(options.resolve).toHaveBeenCalledTimes(2));
      expect(options.execute).toHaveBeenCalledTimes(1);
      bridge.handleEvent({
        event: EMBEDDED_BROWSER_REVOKED_EVENT,
        payload: { run: userRun, admissionRevision: 1 },
      });
      expect(options.releaseScope).toHaveBeenCalledTimes(1);

      bridge.handleEvent({
        event: EMBEDDED_BROWSER_RELEASED_EVENT,
        payload: { run: userRun, reason: 'settled', discardPages },
      });

      expect(options.releaseScope).toHaveBeenLastCalledWith('conversation', discardPages);
      expect(options.releaseScope).toHaveBeenCalledTimes(2);
    },
  );

  it('fences source disposal while the first cron request awaits the native job', async () => {
    const { options, bridge } = setup();
    let finish!: (job: ScheduledTask) => void;
    options.getScheduledTask.mockImplementation(() => new Promise(resolve => (finish = resolve)));
    bridge.handleEvent(request(cronRun));

    bridge.handleEvent({
      event: EMBEDDED_BROWSER_REVOKED_EVENT,
      payload: { run: cronRun, admissionRevision: 1 },
    });
    finish({
      id: 'job-1',
      management: 'editable',
      sessionTarget: 'isolated',
      payload: { kind: 'agentTurn' },
    } as ScheduledTask);
    await new Promise(resolve => setImmediate(resolve));
    bridge.handleEvent(request(cronRun, 'late-call'));
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith(
        'late-call',
        expect.objectContaining({ ok: false }),
      ),
    );

    expect(options.execute).not.toHaveBeenCalled();
    expect(options.getScheduledTask).toHaveBeenCalledTimes(1);
  });

  it('requires a higher admission revision to resume the same native run after disposal', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent(request());
    await vi.waitFor(() => expect(options.resolve).toHaveBeenCalledTimes(1));
    const retiredSignal = options.execute.mock.calls[0][2];
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_REVOKED_EVENT,
      payload: { run: userRun, admissionRevision: 1 },
    });

    bridge.handleEvent(request(userRun, 'retired'));
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith(
        'retired',
        expect.objectContaining({ ok: false }),
      ),
    );
    expect(options.execute).toHaveBeenCalledTimes(1);

    bridge.handleEvent(request(userRun, 'renewed', { action: 'status' }, 2));
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith(
        'renewed',
        expect.objectContaining({ ok: true }),
      ),
    );
    expect(options.execute).toHaveBeenCalledTimes(2);
    expect(retiredSignal.aborted).toBe(true);
    expect(options.execute.mock.calls[1][2].aborted).toBe(false);
    expect(options.releaseScope).toHaveBeenCalledExactlyOnceWith('conversation', false);
  });

  it('renews a delegated admission without letting its late old source read retire the current page', async () => {
    const { options, bridge } = setup();
    const source = {
      pluginId: 'agent-team',
      nativePluginId: 'agent-team',
      epoch: 'current',
      ownerSessionId: 'organizer-chat',
    };
    options.resolveExecutionSession.mockResolvedValue(source);
    bridge.handleEvent(request(userRun, 'delegated-first'));
    await vi.waitFor(() => expect(options.resolve).toHaveBeenCalledTimes(1));
    const oldSignal = options.execute.mock.calls[0][2];
    const originalScope = options.execute.mock.calls[0][3];
    let finish!: (value: AppResolvedExecutionSession) => void;
    options.resolveExecutionSession.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    bridge.handleEvent(request(userRun, 'delayed-old-source'));
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_REVOKED_EVENT,
      payload: { run: userRun, admissionRevision: 1 },
    });
    bridge.handleEvent(request(userRun, 'delegated-renewed', { action: 'status' }, 2));
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith(
        'delegated-renewed',
        expect.objectContaining({ ok: true }),
      ),
    );
    const newSignal = options.execute.mock.calls[1][2];
    expect(oldSignal.aborted).toBe(true);
    expect(newSignal.aborted).toBe(false);
    expect(options.execute.mock.calls[1][3]).toMatchObject({
      ...(originalScope as Record<string, unknown>),
      assertCurrent: expect.any(Function),
    });
    finish({ ...source, ownerSessionId: 'late-foreign-owner' });
    await new Promise(resolve => setImmediate(resolve));
    expect(newSignal.aborted).toBe(false);
    expect(options.execute).toHaveBeenCalledTimes(2);
    expect(options.resolve).not.toHaveBeenCalledWith('delayed-old-source', expect.anything());
    expect(options.releaseScope).toHaveBeenCalledExactlyOnceWith(
      (originalScope as { sessionId: string }).sessionId,
      false,
    );
  });

  it('retires only the Native-only hidden page on admission disposal and permits fresh authorization', async () => {
    const { options, bridge } = setup();
    options.getDesktopSession.mockReturnValue(null);
    options.isNativeOnlyExecutionSource.mockReturnValue(true);
    const run = { ...userRun, sessionKey: 'agent:main:subagent:native-worker' };
    const event = request(run, 'native-hidden', { action: 'open', headless: true });
    const executionSource = {
      version: 1,
      ownerPluginId: 'native-producer',
      sessionKey: run.sessionKey,
      nativeSessionId: run.sessionId,
      lifecycleRevision: run.lifecycleRevision,
    };
    bridge.handleEvent({ ...event, payload: { ...event.payload, executionSource } });
    await vi.waitFor(() => expect(options.resolve).toHaveBeenCalledTimes(1));
    const scope = options.execute.mock.calls[0][3] as { sessionId: string };
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_REVOKED_EVENT,
      payload: { run, admissionRevision: 1 },
    });
    expect(options.execute.mock.calls[0][2].aborted).toBe(true);
    expect(options.releaseScope).toHaveBeenCalledExactlyOnceWith(scope.sessionId, true);
    const retry = request(run, 'native-hidden-renewed', { action: 'status', headless: true }, 2);
    bridge.handleEvent({ ...retry, payload: { ...retry.payload, executionSource } });
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith(
        'native-hidden-renewed',
        expect.objectContaining({ ok: true }),
      ),
    );
    expect(options.execute.mock.calls[1][2].aborted).toBe(false);
    expect(options.execute.mock.calls[1][3]).toMatchObject({
      sessionId: scope.sessionId,
      headlessOnly: true,
    });
  });

  it('retires an older live admission and ignores its delayed request, revocation and cancellation', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent(request());
    await vi.waitFor(() => expect(options.resolve).toHaveBeenCalledTimes(1));
    const retiredSignal = options.execute.mock.calls[0][2];
    let finish!: (result: { ok: boolean }) => void;
    options.execute.mockImplementationOnce(
      async () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const current = request(userRun, 'current', { action: 'status' }, 2);

    bridge.handleEvent(current);
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledTimes(2));
    const currentSignal = options.execute.mock.calls[1][2];
    expect(retiredSignal.aborted).toBe(true);
    expect(options.releaseScope).toHaveBeenCalledExactlyOnceWith('conversation', false);
    bridge.handleEvent(request(userRun, 'delayed-old-request'));
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_REVOKED_EVENT,
      payload: { run: userRun, admissionRevision: 1 },
    });
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_CANCELLED_EVENT,
      payload: { ...current.payload, admissionRevision: 1 },
    });
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith(
        'delayed-old-request',
        expect.objectContaining({ ok: false }),
      ),
    );
    expect(currentSignal.aborted).toBe(false);
    expect(options.execute).toHaveBeenCalledTimes(2);
    expect(options.releaseScope).toHaveBeenCalledTimes(1);

    finish({ ok: true });
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith(
        'current',
        expect.objectContaining({ ok: true }),
      ),
    );
  });

  it('fences an older cron admission that finishes ownership preparation after its replacement', async () => {
    const { options, bridge } = setup();
    const job = await options.getScheduledTask();
    options.getScheduledTask.mockClear();
    let finishRetired!: (value: ScheduledTask) => void;
    options.getScheduledTask.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishRetired = resolve;
        }),
    );
    bridge.handleEvent(request(cronRun, 'retired-preparation'));
    bridge.handleEvent(request(cronRun, 'current-preparation', { action: 'status' }, 2));
    await vi.waitFor(() =>
      expect(options.resolve).toHaveBeenCalledWith(
        'current-preparation',
        expect.objectContaining({ ok: true }),
      ),
    );
    const currentSignal = options.execute.mock.calls[0][2];

    finishRetired(job);
    await new Promise(resolve => setImmediate(resolve));
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_REVOKED_EVENT,
      payload: { run: cronRun, admissionRevision: 1 },
    });

    expect(options.execute).toHaveBeenCalledTimes(1);
    expect(options.resolve).not.toHaveBeenCalledWith('retired-preparation', expect.anything());
    expect(currentSignal.aborted).toBe(false);
    expect(options.releaseScope).not.toHaveBeenCalled();
  });

  it.each(['settled', 'service-stopped'] as const)(
    'does not reopen a closed native run with a higher admission revision after %s',
    async reason => {
      const { options, bridge } = setup();
      bridge.handleEvent(request());
      await vi.waitFor(() => expect(options.resolve).toHaveBeenCalledTimes(1));
      if (reason === 'service-stopped')
        bridge.handleEvent({ event: EMBEDDED_BROWSER_STOPPED_EVENT });
      else
        bridge.handleEvent({
          event: EMBEDDED_BROWSER_RELEASED_EVENT,
          payload: { run: userRun, reason: 'settled', discardPages: false },
        });

      bridge.handleEvent(request(userRun, 'after-close', { action: 'status' }, 2));
      await vi.waitFor(() =>
        expect(options.resolve).toHaveBeenCalledWith(
          'after-close',
          expect.objectContaining({ ok: false }),
        ),
      );
      expect(options.execute).toHaveBeenCalledTimes(1);
      expect(options.execute.mock.calls[0][2].aborted).toBe(true);
    },
  );

  it.each([EMBEDDED_BROWSER_REVOKED_EVENT, EMBEDDED_BROWSER_RELEASED_EVENT])(
    'ignores conflicting full identity during native job preparation: %s',
    async event => {
      const { options, bridge } = setup();
      let finish!: (job: ScheduledTask) => void;
      options.getScheduledTask.mockImplementation(() => new Promise(resolve => (finish = resolve)));
      bridge.handleEvent(request(cronRun));

      bridge.handleEvent({
        event,
        payload: {
          run: { ...cronRun, workspaceDir: path.resolve('foreign') },
          admissionRevision: 1,
          reason: 'revoked',
          discardPages: true,
        },
      });
      finish({
        id: 'job-1',
        management: 'editable',
        sessionTarget: 'isolated',
        payload: { kind: 'agentTurn' },
      } as ScheduledTask);
      await vi.waitFor(() => expect(options.resolve).toHaveBeenCalled());

      expect(options.execute).toHaveBeenCalledTimes(1);
      expect(options.execute.mock.calls[0][2].aborted).toBe(false);
    },
  );

  it('ignores a release with conflicting complete run identity', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent(request());
    await vi.waitFor(() => expect(options.resolve).toHaveBeenCalled());
    const signal = options.execute.mock.calls[0][2];

    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: {
        run: { ...userRun, workspaceDir: path.resolve('foreign') },
        reason: 'revoked',
        discardPages: true,
      },
    });

    expect(signal.aborted).toBe(false);
    expect(options.releaseScope).not.toHaveBeenCalled();
    bridge.handleEvent(request(userRun, 'still-current'));
    await vi.waitFor(() => expect(options.execute).toHaveBeenCalledTimes(2));
  });

  it.each(['settled', 'revoked', 'deleted', 'disconnected'] as const)(
    'shares one run lifetime across concurrently prepared requests on %s',
    async reason => {
      const { options, bridge } = setup();
      bridge.handleEvent(request(userRun, 'parallel-1'));
      bridge.handleEvent(request(userRun, 'parallel-2'));
      await vi.waitFor(() => expect(options.resolve).toHaveBeenCalledTimes(2));
      const signals = options.execute.mock.calls.map(call => call[2]);
      expect(signals).toHaveLength(2);
      expect(signals.every(signal => !signal.aborted)).toBe(true);
      if (reason === 'deleted') bridge.deleteSession('conversation');
      else if (reason === 'disconnected') bridge.revoke();
      else
        bridge.handleEvent({
          event: EMBEDDED_BROWSER_RELEASED_EVENT,
          payload: { run: userRun, reason, discardPages: reason === 'revoked' },
        });
      expect(signals.every(signal => signal.aborted)).toBe(true);
    },
  );

  it.each([
    ['display owner', { ownerSessionId: 'earlier-display-owner' }],
    ['native plugin', { nativePluginId: 'earlier-native-producer' }],
  ] as const)(
    'rejects a concurrently prepared request with a different %s without retiring the established request',
    async (_description, earlierSource) => {
      const { options, bridge } = setup();
      const source = {
        pluginId: 'agent-team',
        nativePluginId: 'agent-team',
        epoch: 'current',
        ownerSessionId: 'organizer-chat',
      };
      let complete!: (value: AppResolvedExecutionSession) => void;
      options.resolveExecutionSession
        .mockImplementationOnce(
          () =>
            new Promise(resolve => {
              complete = resolve;
            }),
        )
        .mockResolvedValue(source);
      options.execute.mockImplementation(() => new Promise(() => {}));
      bridge.handleEvent(request(userRun, 'awaiting-earlier-owner'));
      await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
      bridge.handleEvent(request(userRun, 'established-owner'));
      await vi.waitFor(() => expect(options.execute).toHaveBeenCalledOnce());
      const signal = options.execute.mock.calls[0][2];

      complete({ ...source, ...earlierSource });
      await vi.waitFor(() =>
        expect(options.resolve).toHaveBeenCalledWith('awaiting-earlier-owner', {
          ok: false,
          error: expect.stringContaining('ownership changed'),
        }),
      );

      expect(options.execute).toHaveBeenCalledOnce();
      expect(options.releaseScope).not.toHaveBeenCalled();
      expect(signal.aborted).toBe(false);
      bridge.handleEvent({
        event: EMBEDDED_BROWSER_RELEASED_EVENT,
        payload: { run: userRun, reason: 'settled', discardPages: false },
      });
      expect(signal.aborted).toBe(true);
    },
  );

  it('retires retained pages when a product session acquires a new native incarnation', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent(request());
    await vi.waitFor(() => expect(options.resolve).toHaveBeenCalledTimes(1));
    bridge.handleEvent({
      event: EMBEDDED_BROWSER_RELEASED_EVENT,
      payload: { run: userRun, reason: 'settled', discardPages: false },
    });
    options.releaseScope.mockClear();
    bridge.handleEvent(request({ ...userRun, sessionId: 'native-2', runId: 'run-2' }, 'new'));
    await vi.waitFor(() => expect(options.resolve).toHaveBeenCalledTimes(2));
    expect(options.releaseScope).toHaveBeenCalledWith('conversation', true);
  });

  it('revokes retained pages on service stop or disconnect and closes deleted conversations', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent(request());
    await vi.waitFor(() => expect(options.resolve).toHaveBeenCalled());
    bridge.deleteSession('conversation');
    expect(options.releaseScope).toHaveBeenCalledWith('conversation', true);
    bridge.handleEvent({ event: EMBEDDED_BROWSER_STOPPED_EVENT });
    expect(options.revokeAll).toHaveBeenCalledTimes(1);
    bridge.revoke();
    expect(options.revokeAll).toHaveBeenCalledTimes(2);
  });

  it('fences a first request deleted after its product record has already been removed', async () => {
    const { options, bridge } = setup();
    bridge.handleEvent(request());
    options.getDesktopSession.mockImplementation(() => null as never);
    bridge.deleteSession('conversation');
    await new Promise(resolve => setImmediate(resolve));
    expect(options.execute).not.toHaveBeenCalled();
    expect(options.releaseScope).toHaveBeenCalledWith('conversation', true);
  });
});

describe('plugin to Main cancellation after an armed browser result', () => {
  type HookHandler = (event: Record<string, unknown>, context: Record<string, unknown>) => unknown;
  type GatewayHandler = (context: {
    params: Record<string, unknown>;
    respond: (...args: unknown[]) => void;
  }) => void;
  type Service = {
    start(context: { gatewayEvents: { emit(name: string, payload: unknown): void } }): void;
    stop(): void;
  };
  type ToolFactory = {
    create(context: Record<string, unknown>): {
      execute(
        toolCallId: string,
        command: Record<string, unknown>,
        signal?: AbortSignal,
      ): Promise<{ isError?: boolean; details: Record<string, unknown> }>;
    };
  };
  let sequence = 0;
  const stops: Array<() => void> = [];
  afterEach(() => stops.splice(0).forEach(stop => stop()));

  const createBoundary = () => {
    const { options, bridge } = setup();
    const run = { ...userRun, runId: `boundary-run-${++sequence}` };
    nativeSdk.getSessionEntry.mockReturnValue({
      sessionId: run.sessionId,
      lifecycleRevision: 'one',
    });
    const hooks = new Map<string, HookHandler>();
    const methods = new Map<string, GatewayHandler>();
    let lifecycle!: (event: Record<string, unknown>) => void;
    let service!: Service;
    let factory!: ToolFactory;
    const emitted: Array<{ name: string; payload: unknown }> = [];
    const delayedEffect = vi.fn();
    const effects: Array<() => void> = [];
    options.execute.mockImplementation(async (_key, _command, signal) => {
      effects.push(() => {
        signal.throwIfAborted();
        delayedEffect();
      });
      return { ok: true, armed: true };
    });
    options.resolve.mockImplementation(async (requestId, response) => {
      methods.get('embeddedBrowser.resolve')!({
        params: { requestId, ...response },
        respond() {},
      });
    });
    embeddedBrowserPlugin.register({
      logger: { warn: vi.fn() },
      on(name: string, handler: HookHandler) {
        hooks.set(name, handler);
      },
      registerService(value: Service) {
        service = value;
      },
      registerTool(value: ToolFactory) {
        factory = value;
      },
      registerGatewayMethod(name: string, handler: GatewayHandler) {
        methods.set(name, handler);
      },
      runtime: {
        events: {
          onAgentEvent: (listener: typeof lifecycle) => {
            lifecycle = listener;
            return () => undefined;
          },
        },
      },
    } as unknown as Parameters<typeof embeddedBrowserPlugin.register>[0]);
    service.start({
      gatewayEvents: {
        emit(name: string, payload: unknown) {
          emitted.push({ name, payload });
          bridge.handleEvent({ event: `plugin.embedded-browser.${name}`, payload });
        },
      },
    });
    stops.push(() => service.stop());
    const prompt = () =>
      hooks.get('before_prompt_build')!(
        {},
        {
          ...run,
          toolAuthority: { allows: () => true, assertActive() {} },
        },
      );
    prompt();
    const tool = factory.create({ ...run, assertInvocationCurrent() {} });
    const prepare = (toolCallId: string, signal?: AbortSignal) =>
      hooks.get('before_tool_call')!(
        { toolName: 'browser', runId: run.runId, toolCallId },
        { ...run, toolName: 'browser', toolCallId, abortSignal: signal },
      );
    const releases = () => emitted.filter(event => event.name === 'released');
    const revocations = () => emitted.filter(event => event.name === 'revoked');
    const settle = (aborted = false) =>
      lifecycle({
        ...run,
        stream: 'lifecycle',
        data: { phase: 'end', executionSettled: true, aborted },
      });
    return {
      options,
      run,
      tool,
      prompt,
      prepare,
      releases,
      revocations,
      settle,
      effects,
      delayedEffect,
      service,
    };
  };

  it.each([
    ['dialog', 'hook'],
    ['dialog', 'execute'],
    ['upload', 'hook'],
    ['upload', 'execute'],
  ] as const)(
    'revokes a returned %s effect on native %s abort before any terminal',
    async (action, source) => {
      const f = createBoundary();
      const controller = new AbortController();
      f.prepare('armed', source === 'hook' ? controller.signal : undefined);
      const result = await f.tool.execute(
        'armed',
        {
          action,
          headless: true,
          ...(action === 'dialog' ? { accept: true } : { paths: ['fixture.txt'] }),
        },
        source === 'execute' ? controller.signal : undefined,
      );
      await new Promise(resolve => setImmediate(resolve));
      expect(result.isError).toBeUndefined();
      expect(result.details.armed).toBe(true);
      expect(f.releases()).toEqual([]);
      expect(f.options.execute.mock.calls[0][2].aborted).toBe(false);

      controller.abort();

      expect(f.revocations()).toEqual([
        { name: 'revoked', payload: { run: f.run, admissionRevision: 1 } },
      ]);
      expect(f.releases()).toEqual([]);
      expect(f.options.execute.mock.calls[0][2].aborted).toBe(true);
      expect(f.options.releaseScope).toHaveBeenCalledExactlyOnceWith('conversation', false);
      expect(() => f.effects[0]()).toThrow();
      expect(f.delayedEffect).not.toHaveBeenCalled();
      expect(f.prepare('subsequent')).toMatchObject({ block: true });
      f.service.stop();
      expect(f.releases()).toHaveLength(1);
    },
  );

  it('retains every concurrent call source after all responses return', async () => {
    const f = createBoundary();
    const first = new AbortController();
    const second = new AbortController();
    f.prepare('first', first.signal);
    f.prepare('second', second.signal);
    await Promise.all([
      f.tool.execute('first', { action: 'dialog', accept: true, headless: true }),
      f.tool.execute('second', { action: 'upload', paths: ['fixture.txt'], headless: true }),
    ]);
    await new Promise(resolve => setImmediate(resolve));
    expect(f.effects).toHaveLength(2);

    first.abort();

    expect(f.revocations()).toHaveLength(1);
    expect(f.releases()).toEqual([]);
    expect(
      f.effects.every(effect => {
        try {
          effect();
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
    expect(f.delayedEffect).not.toHaveBeenCalled();
    second.abort();
    expect(f.revocations()).toHaveLength(1);
  });

  it('renews the plugin and Main admission only after a fresh authorized prompt while old armed effects stay retired', async () => {
    const f = createBoundary();
    const retiredSource = new AbortController();
    f.prepare('before-retry', retiredSource.signal);
    await f.tool.execute('before-retry', { action: 'dialog', accept: true, headless: true });
    const retiredSignal = f.options.execute.mock.calls[0][2];

    retiredSource.abort();
    expect(f.prepare('without-fresh-authority')).toMatchObject({ block: true });
    expect(retiredSignal.aborted).toBe(true);
    expect(() => f.effects[0]()).toThrow();

    f.prompt();
    const currentSource = new AbortController();
    expect(f.prepare('after-retry', currentSource.signal)).toBeUndefined();
    const result = await f.tool.execute('after-retry', { action: 'status', headless: true });

    expect(result.isError).toBeUndefined();
    expect(f.options.execute).toHaveBeenCalledTimes(2);
    expect(f.options.execute.mock.calls[1][2].aborted).toBe(false);
    expect(() => f.effects[0]()).toThrow();
    expect(() => f.effects[1]()).not.toThrow();
    expect(f.releases()).toEqual([]);
    expect(f.revocations()).toEqual([
      { name: 'revoked', payload: { run: f.run, admissionRevision: 1 } },
    ]);

    currentSource.abort();
    expect(f.revocations()).toEqual([
      { name: 'revoked', payload: { run: f.run, admissionRevision: 1 } },
      { name: 'revoked', payload: { run: f.run, admissionRevision: 2 } },
    ]);
    expect(() => f.effects[1]()).toThrow();
  });

  it.each([false, true])(
    'uses the exact native terminal after generation disposal to discard pages: %s',
    async aborted => {
      const f = createBoundary();
      const source = new AbortController();
      f.prepare('armed', source.signal);
      await f.tool.execute('armed', { action: 'dialog', accept: true, headless: true });
      source.abort();
      expect(f.releases()).toEqual([]);

      f.settle(aborted);

      expect(f.releases()).toEqual([
        { name: 'released', payload: { run: f.run, reason: 'settled', discardPages: aborted } },
      ]);
      expect(f.options.releaseScope).toHaveBeenLastCalledWith('conversation', aborted);
      expect(() => f.effects[0]()).toThrow();
      f.service.stop();
      expect(f.releases()).toHaveLength(1);
    },
  );

  it('does not let an old native source or retired service revoke a replacement registry', async () => {
    const first = createBoundary();
    const oldSource = new AbortController();
    first.prepare('old', oldSource.signal);
    await first.tool.execute('old', { action: 'dialog', accept: true, headless: true });
    const second = createBoundary();
    second.prepare('current');
    await second.tool.execute('current', { action: 'dialog', accept: true, headless: true });
    first.service.stop();

    oldSource.abort();

    expect(second.releases()).toEqual([]);
    expect(second.options.execute.mock.calls[0][2].aborted).toBe(false);
    expect(() => second.effects[0]()).not.toThrow();
  });
});
