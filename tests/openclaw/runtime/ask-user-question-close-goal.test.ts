// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => Promise<{ success: boolean }>>(),
  sendToRenderer: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    getVersion: () => 'test-version',
  },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: mocks.sendToRenderer } },
    ],
  },
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => Promise<{ success: boolean }>) => {
        mocks.ipcHandlers.set(channel, handler);
      },
    ),
  },
}));

vi.mock('../../../src/main/cowork/coworkLogger', () => ({ coworkLog: vi.fn() }));

import questionPlugin, {
  type AskUserRequest,
} from '../../../plugins/extensions/ask-user-question/index';
import type { GatewayClientLike, SessionTurn } from '../../../src/main/engine/gateway/types';
import { OpenClawRuntimeAdapter } from '../../../src/main/engine/openclaw/openclawRuntimeAdapter';
import { registerCoworkInteractionHandlers } from '../../../src/main/ipc/cowork/interactions';
import type { GoalContinuationCoordinator } from '../../../src/main/openclaw/goals/goalContinuationCoordinator';
import CoworkQuestionFloatingWindow from '../../../src/renderer/features/cowork/components/questions/CoworkQuestionFloatingWindow';
import type {
  CoworkInteractionRequest,
  CoworkInteractionResult,
} from '../../../src/renderer/features/cowork/coworkTypes';
import { createDefaultAgentRuntimeSettings } from '../../../src/shared/agents/agentRuntimeSettings';
import { AskUserQuestionGateway } from '../../../src/shared/cowork/interactions/askUserQuestion';
import { CoworkInteractionIpc } from '../../../src/shared/cowork/interactions/interactions';
import { GoalExecutionPhase, type SessionGoal } from '../../../src/shared/cowork/sessionGoal';

const sessionId = 'session-1';
const sessionKey = 'agent:main:justdo:session-1';
const nativeIdentity = { sessionId: 'native-session-1', lifecycleRevision: 'revision-1' };
const runIdentity = { sessionKey, sessionId: nativeIdentity.sessionId, runId: 'parent-run' };

type RuntimeInternals = {
  gatewayClient: GatewayClientLike;
  activeTurns: Map<string, SessionTurn>;
  goalContinuationCoordinator: GoalContinuationCoordinator;
  ensureGatewayClientReady: () => Promise<void>;
  rememberSessionKey: (id: string, key: string) => void;
  handleGatewayEvent: (event: { event: string; payload: unknown }) => void;
  handleAgentEvent: (delivery: 'agent' | 'session.tool', payload: unknown) => void;
  cancelGoalRecovery: () => void;
};

const createHarness = () => {
  mocks.sendToRenderer.mockClear();
  mocks.ipcHandlers.clear();
  let goal: SessionGoal = {
    schemaVersion: 1,
    id: 'goal-1',
    objective: 'Write the report',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    tokenStart: 0,
    tokensUsed: 0,
    continuationTurns: 0,
  };
  const store = {
    getSession: () => ({
      id: sessionId,
      agentId: 'main',
      cwd: process.cwd(),
      permissionMode: 'full',
    }),
    getConfig: () => ({ maxGoalContinuationTurns: 25 }),
    getAgentRuntimeSettings: () => createDefaultAgentRuntimeSettings(),
    updateSession: vi.fn(),
  };
  const adapter = new OpenClawRuntimeAdapter(store as never, {} as never);
  const runtime = adapter as unknown as RuntimeInternals;
  const registerService = vi.fn();
  const registerTool = vi.fn();
  const registerGatewayMethod = vi.fn();
  questionPlugin.register({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registerService,
    registerTool,
    registerGatewayMethod,
  } as never);
  const emit = vi.fn((name: string, payload: unknown) => {
    runtime.handleGatewayEvent({ event: `plugin.ask-user-question.${name}`, payload });
  });
  const service = registerService.mock.calls[0][0];
  service.start({ gatewayEvents: { emit } });
  const callPlugin = (method: string, params: Record<string, unknown>) => {
    const respond = vi.fn();
    const registration = registerGatewayMethod.mock.calls.find(([name]) => name === method);
    if (!registration) throw new Error(`Unexpected plugin method: ${method}`);
    registration[1]({ params, respond });
    const [success, result, error] = respond.mock.calls[0];
    if (!success) throw new Error(error.message);
    return result;
  };
  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === AskUserQuestionGateway.LIST || method === AskUserQuestionGateway.RESOLVE) {
      return callPlugin(method, params);
    }
    if (method === 'sessions.describe') {
      return { session: { key: sessionKey, ...nativeIdentity, goal } };
    }
    if (method === 'agent') {
      goal = { ...goal, continuationTurns: goal.continuationTurns + 1 };
      return {
        runId: params.idempotencyKey,
        status: 'accepted',
        goalContinuation: {
          goalId: goal.id,
          predecessorRunId: runIdentity.runId,
          continuationTurns: goal.continuationTurns,
          acceptedAt: Date.now(),
        },
      };
    }
    throw new Error(`Unexpected Gateway method: ${method}`);
  });
  runtime.gatewayClient = { request } as unknown as GatewayClientLike;
  runtime.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(adapter, 'prepareSession').mockResolvedValue({
    sessionKey,
    gatewaySessionId: nativeIdentity.sessionId,
  } as never);
  runtime.rememberSessionKey(sessionId, sessionKey);
  runtime.activeTurns.set(sessionId, {
    sessionId,
    sessionKey,
    runId: runIdentity.runId,
    gatewaySessionId: nativeIdentity.sessionId,
    lifecycleGeneration: null,
    lastAgentSeq: 0,
    status: 'running',
    turnToken: 1,
    stopRequested: false,
    knownRunIds: new Set([runIdentity.runId]),
  });
  runtime.goalContinuationCoordinator.restoreRunning(sessionId, goal.id, runIdentity.runId);
  runtime.handleAgentEvent('agent', {
    ...runIdentity,
    seq: 1,
    stream: 'lifecycle',
    data: { phase: 'start' },
  });
  registerCoworkInteractionHandlers({ getRuntime: () => adapter });

  return {
    adapter,
    runtime,
    request,
    emit,
    service,
    tool: registerTool.mock.calls[0][0]({ sessionKey }),
    list: (): AskUserRequest[] => callPlugin(AskUserQuestionGateway.LIST, {}).requests,
  };
};

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test.each([
  { timeoutEnabled: true, questionCount: 1 },
  { timeoutEnabled: false, questionCount: 1 },
  { timeoutEnabled: true, questionCount: 2 },
  { timeoutEnabled: false, questionCount: 2 },
])(
  'closing the question window lets Goal continue (timeout: $timeoutEnabled, questions: $questionCount)',
  async ({ timeoutEnabled, questionCount }) => {
    vi.useFakeTimers();
    const harness = createHarness();
    const stopSession = vi.spyOn(harness.adapter, 'stopSession');
    const stopGoal = vi.spyOn(harness.runtime.goalContinuationCoordinator, 'stop');
    const controller = new AbortController();
    const questions = Array.from({ length: questionCount }, (_, index) => ({
      id: `report_${index + 1}`,
      question: `Which format should section ${index + 1} use?`,
      options: [
        { id: 'markdown', label: 'Markdown' },
        { id: 'html', label: 'HTML' },
      ],
      multiSelect: questionCount > 1,
      defaultOptionIds: ['markdown'],
    }));
    const execution = harness.tool.execute(
      'call-question',
      { questions, timeoutEnabled },
      controller.signal,
    );
    const consumed = vi.fn();
    const continuation = execution.then((result: unknown) => {
      consumed(result);
      harness.runtime.handleAgentEvent('session.tool', {
        ...runIdentity,
        seq: 2,
        stream: 'tool',
        data: { phase: 'result', name: 'ask_user_question', toolCallId: 'call-question', result },
      });
      return result;
    });
    try {
      const pending = harness.list()[0];
      expect(pending.waitPolicy.mode).toBe(timeoutEnabled ? 'timeout' : 'required');
      const streamed = mocks.sendToRenderer.mock.calls.find(
        ([channel]) => channel === CoworkInteractionIpc.Stream,
      )![1];
      const interaction: CoworkInteractionRequest = {
        sessionId: streamed.sessionId,
        ...streamed.request,
      };
      const respond = vi.fn(async (result: CoworkInteractionResult) => {
        const response = await mocks.ipcHandlers.get(CoworkInteractionIpc.Respond)!(
          {},
          {
            requestId: interaction.requestId,
            result,
          },
        );
        return response.success;
      });
      const view = render(
        React.createElement(CoworkQuestionFloatingWindow, {
          interaction,
          isVisible: true,
          onRespond: respond,
        }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 60_000);
      });
      expect(consumed).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole(questionCount > 1 ? 'checkbox' : 'radio', { name: 'HTML' }));

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^Close$|^关闭$/ }));
        await expect(respond.mock.results[0].value).resolves.toBe(true);
        const resolution = await continuation;
        expect(JSON.parse(resolution.content[0].text)).toMatchObject({
          askUserQuestion: { version: 1, response: { status: 'cancelled' } },
          summary: 'The question was cancelled; proceed with best judgment.',
        });
        expect(resolution.details.askUserQuestion.questions).toHaveLength(questionCount);
      });

      expect(harness.request).toHaveBeenCalledWith(AskUserQuestionGateway.RESOLVE, {
        requestId: pending.requestId,
        behavior: 'cancel',
      });
      expect(harness.list()).toEqual([]);
      expect(mocks.sendToRenderer).toHaveBeenCalledWith(CoworkInteractionIpc.Dismiss, {
        requestId: pending.requestId,
      });
      expect(controller.signal.aborted).toBe(false);
      expect(stopSession).not.toHaveBeenCalled();
      expect(stopGoal).not.toHaveBeenCalled();
      expect(harness.runtime.activeTurns.get(sessionId)?.runId).toBe(runIdentity.runId);
      expect(harness.runtime.goalContinuationCoordinator.getSnapshot(sessionId)?.phase).toBe(
        GoalExecutionPhase.Running,
      );
      expect(harness.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(0);
      view.unmount();

      harness.runtime.handleAgentEvent('agent', {
        ...runIdentity,
        seq: 3,
        stream: 'lifecycle',
        data: { phase: 'end' },
      });
      expect(harness.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(0);
      harness.runtime.handleAgentEvent('agent', {
        ...runIdentity,
        seq: 4,
        stream: 'lifecycle',
        data: { phase: 'end', executionSettled: true },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_600);
      });

      expect(harness.request).toHaveBeenCalledWith(
        'agent',
        expect.objectContaining({
          expectedExistingSessionId: nativeIdentity.sessionId,
          expectedExistingSessionLifecycleRevision: nativeIdentity.lifecycleRevision,
          goalContinuation: {
            goalId: 'goal-1',
            predecessorRunId: runIdentity.runId,
            maxAutomaticContinuations: 25,
            automatic: true,
          },
        }),
      );
      const successorRunId = harness.runtime.activeTurns.get(sessionId)?.runId;
      expect(successorRunId).toBeTruthy();
      expect(successorRunId).not.toBe(runIdentity.runId);
      expect(harness.runtime.goalContinuationCoordinator.getSnapshot(sessionId)).toMatchObject({
        runId: successorRunId,
        phase: GoalExecutionPhase.Running,
        continuationCount: 1,
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10 * 60_000);
      });

      expect(consumed).toHaveBeenCalledOnce();
      expect(harness.emit.mock.calls.filter(([name]) => name === 'resolved')).toEqual([
        [
          'resolved',
          { requestId: pending.requestId, status: 'cancelled' },
          { scope: 'operator.read' },
        ],
      ]);
      expect(harness.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(1);
      expect(stopSession).not.toHaveBeenCalled();
      expect(stopGoal).not.toHaveBeenCalled();
      expect(harness.runtime.goalContinuationCoordinator.getSnapshot(sessionId)).toMatchObject({
        runId: successorRunId,
        phase: GoalExecutionPhase.Running,
        continuationCount: 1,
      });
    } finally {
      harness.service.stop();
      await continuation;
      harness.runtime.cancelGoalRecovery();
      harness.runtime.goalContinuationCoordinator.clear();
    }
  },
);
