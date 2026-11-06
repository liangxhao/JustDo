import { randomUUID } from 'node:crypto';
import os from 'node:os';

import { expect, it, vi } from 'vitest';

import {
  ExternalSessionSource,
  ExternalSessionStatus,
} from '../../../shared/integrations/externalSession';
import type { CoworkStore } from '../../data/coworkStore';
import { ExternalAgentBackendFactory } from './externalAgentBackend';
import type { ExternalAgentExecution } from './externalAgentTypes';
import { ExternalExecutionState, type ExternalSessionStore } from './externalSessionStore';

it.each([false, true])(
  'preserves only an explicitly declared interactive approval surface through receipt hooks (%s)',
  async interactive => {
    const id = randomUUID();
    const thread = { id, agentId: 'main', cwd: os.tmpdir(), modelRef: 'provider/model' };
    const session = { id: randomUUID(), agentId: thread.agentId, cwd: thread.cwd };
    const external = {
      externalSessionKey: id,
      coworkSessionId: session.id,
      agentId: thread.agentId,
      cwd: thread.cwd,
      openclawSessionKey: '',
      status: ExternalSessionStatus.Completed,
      executionState: ExternalExecutionState.Settled,
    };
    const receipts = {
      source: ExternalSessionSource.Cli,
      get: vi.fn(() => external),
      beginExecution: vi.fn(),
      bindExecution: vi.fn(),
      finishExecution: vi.fn(),
    };
    const store = {
      getSession: vi.fn(() => session),
      getAgent: vi.fn(() => ({ enabled: true })),
      getSessionRunByClientTurnId: vi.fn(),
    };
    const execute = vi.fn<ExternalAgentExecution>(async input => {
      await input.hooks?.onPrepared?.({
        localSessionId: session.id,
        runId: input.runId,
        sessionKey: 'native-key',
        sessionId: 'native-id',
        lifecycleRevision: '1',
        client: {} as never,
      });
      return 'answer';
    });
    const backend = new ExternalAgentBackendFactory({
      getCoworkStore: () => store as unknown as CoworkStore,
      getExternalSessionStore: () => receipts as unknown as ExternalSessionStore,
      getModels: () => [{ id: thread.modelRef, name: 'Model', isDefault: true }],
      execute,
      onSessionsChanged: () => {},
    }).connect();
    const onPrepared = vi.fn(async () => {});
    await expect(
      backend.run(
        thread,
        randomUUID(),
        'task',
        () => {},
        new AbortController().signal,
        interactive ? { interactiveApprovals: true, onPrepared } : undefined,
      ),
    ).resolves.toBe('answer');
    const hooks = execute.mock.calls[0][0].hooks;
    expect(hooks?.onPrepared).toBeTypeOf('function');
    expect(hooks?.interactiveApprovals).toBe(interactive ? true : undefined);
    expect(receipts.bindExecution).toHaveBeenCalledOnce();
    expect(onPrepared).toHaveBeenCalledTimes(interactive ? 1 : 0);
  },
);
