import { afterEach, describe, expect, test, vi } from 'vitest';

import { AskUserTimeoutBehavior, AskUserWaitMode } from '../../../shared/openclaw/extensions';
import { AskUserRequestBroker } from './askUserRequestBroker';

const questions = [
  {
    id: 'continue',
    question: 'Continue?',
    options: [
      {
        id: 'yes',
        label: 'Yes',
        input: {
          label: 'What should happen next?',
          placeholder: 'Describe the next step',
        },
      },
      { id: 'no', label: 'No' },
    ],
  },
];
const requiredWait = { mode: AskUserWaitMode.REQUIRED } as const;

afterEach(() => {
  vi.useRealTimers();
});

describe('AskUserRequestBroker', () => {
  test('forwards a structured request and resolves it by request id', async () => {
    const broker = new AskUserRequestBroker();
    let requestId = '';
    broker.onRequest(request => {
      requestId = request.requestId;
      expect(request.questions).toEqual(questions);
      expect(request.sessionKey).toBe('justdo:session');
    });

    const pendingResponse = broker.request(questions, requiredWait, 'justdo:session').response;
    broker.resolve(requestId, {
      behavior: 'allow',
      answers: {
        continue: {
          selected: ['yes'],
          optionInputs: { yes: 'Run the validation suite' },
        },
      },
    });

    await expect(pendingResponse).resolves.toEqual({
      behavior: 'allow',
      answers: {
        continue: {
          selected: ['yes'],
          optionInputs: { yes: 'Run the validation suite' },
        },
      },
    });
  });

  test('denies immediately when no host request handler is registered', async () => {
    const broker = new AskUserRequestBroker();

    await expect(broker.request(questions, requiredWait).response).resolves.toEqual({
      behavior: 'deny',
    });
  });

  test('waits for an explicit response and denies pending requests on shutdown', async () => {
    const broker = new AskUserRequestBroker();
    const onDismiss = vi.fn();
    broker.onRequest(() => undefined);
    broker.onDismiss(onDismiss);

    const pending = broker.request(questions, requiredWait);
    const pendingResponse = pending.response;
    let settled = false;
    void pendingResponse.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(broker.get(pending.requestId)?.questions).toEqual(questions);
    expect(broker.list()).toHaveLength(1);

    expect(broker.cancel(pending.requestId)).toBe(true);

    await expect(pendingResponse).resolves.toEqual({ behavior: 'deny' });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  test('uses configured defaults and dismisses the interaction after timeout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'));
    const broker = new AskUserRequestBroker();
    const onDismiss = vi.fn();
    let receivedExpiresAt: number | undefined;
    broker.onRequest(request => {
      receivedExpiresAt = request.expiresAt;
    });
    broker.onDismiss(onDismiss);
    const questionsWithDefaults = [
      {
        ...questions[0],
        defaultOptionIds: ['no'],
      },
    ];

    const pending = broker.request(questionsWithDefaults, {
      mode: AskUserWaitMode.TIMEOUT,
      timeoutMinutes: 10,
      onTimeout: AskUserTimeoutBehavior.USE_DEFAULTS,
    });

    expect(receivedExpiresAt).toBe(Date.now() + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await expect(pending.response).resolves.toEqual({
      behavior: 'allow',
      answers: { continue: { selected: ['no'] } },
      timedOut: true,
    });
    expect(onDismiss).toHaveBeenCalledWith(pending.requestId);
    expect(broker.list()).toEqual([]);
  });

  test('returns control to the model when a timed request has no default answer', async () => {
    vi.useFakeTimers();
    const broker = new AskUserRequestBroker();
    broker.onRequest(() => undefined);

    const pending = broker.request(questions, {
      mode: AskUserWaitMode.TIMEOUT,
      timeoutMinutes: 1,
      onTimeout: AskUserTimeoutBehavior.MODEL_DECIDES,
    });
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(pending.response).resolves.toEqual({
      behavior: 'timeout',
      timedOut: true,
    });
  });

  test('settles even when the renderer dismissal callback throws', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broker = new AskUserRequestBroker();
    broker.onRequest(() => undefined);
    broker.onDismiss(() => {
      throw new Error('renderer disappeared');
    });
    const pending = broker.request(questions, requiredWait);

    expect(broker.cancel(pending.requestId)).toBe(true);

    await expect(pending.response).resolves.toEqual({ behavior: 'deny' });
    expect(broker.list()).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      '[AskUserRequestBroker] Failed to publish dismissal:',
      'renderer disappeared',
    );
    log.mockRestore();
  });

  test('denies and cleans up when publishing the request throws', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broker = new AskUserRequestBroker();
    broker.onRequest(() => {
      throw new Error('renderer unavailable');
    });

    const pending = broker.request(questions, requiredWait);

    await expect(pending.response).resolves.toEqual({ behavior: 'deny' });
    expect(broker.list()).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      '[AskUserRequestBroker] Failed to publish request:',
      'renderer unavailable',
    );
    log.mockRestore();
  });

  test('clears the timeout when the user response wins the race', async () => {
    vi.useFakeTimers();
    const broker = new AskUserRequestBroker();
    const onDismiss = vi.fn();
    broker.onRequest(() => undefined);
    broker.onDismiss(onDismiss);
    const pending = broker.request(questions, {
      mode: AskUserWaitMode.TIMEOUT,
      timeoutMinutes: 1,
      onTimeout: AskUserTimeoutBehavior.MODEL_DECIDES,
    });
    const userResponse = {
      behavior: 'allow' as const,
      answers: { continue: { selected: ['no'] } },
    };

    await vi.advanceTimersByTimeAsync(59_999);
    expect(broker.resolve(pending.requestId, userResponse)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending.response).resolves.toEqual(userResponse);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(broker.resolve(pending.requestId, { behavior: 'deny' })).toBe(false);
  });
});
