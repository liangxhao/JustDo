import { describe, expect, test, vi } from 'vitest';

import { AskUserRequestBroker } from './askUserRequestBroker';

const questions = [
  {
    question: 'Continue?',
    options: [{ label: 'Yes' }, { label: 'No' }],
  },
];

describe('AskUserRequestBroker', () => {
  test('forwards a structured request and resolves it by request id', async () => {
    const broker = new AskUserRequestBroker();
    let requestId = '';
    broker.onRequest(request => {
      requestId = request.requestId;
      expect(request.questions).toEqual(questions);
      expect(request.sessionKey).toBe('justdo:session');
    });

    const pendingResponse = broker.request(questions, 'justdo:session');
    broker.resolve(requestId, {
      behavior: 'allow',
      answers: { 'Continue?': 'Yes' },
    });

    await expect(pendingResponse).resolves.toEqual({
      behavior: 'allow',
      answers: { 'Continue?': 'Yes' },
    });
  });

  test('denies immediately when no host request handler is registered', async () => {
    const broker = new AskUserRequestBroker();

    await expect(broker.request(questions)).resolves.toEqual({ behavior: 'deny' });
  });

  test('denies and dismisses a request after timeout', async () => {
    vi.useFakeTimers();
    const broker = new AskUserRequestBroker();
    const onDismiss = vi.fn();
    broker.onRequest(() => undefined);
    broker.onDismiss(onDismiss);

    const pendingResponse = broker.request(questions);
    await vi.advanceTimersByTimeAsync(120_000);

    await expect(pendingResponse).resolves.toEqual({ behavior: 'deny' });
    expect(onDismiss).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
