import { describe, expect, test, vi } from 'vitest';

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

describe('AskUserRequestBroker', () => {
  test('forwards a structured request and resolves it by request id', async () => {
    const broker = new AskUserRequestBroker();
    let requestId = '';
    broker.onRequest(request => {
      requestId = request.requestId;
      expect(request.questions).toEqual(questions);
      expect(request.sessionKey).toBe('justdo:session');
    });

    const pendingResponse = broker.request(questions, 'justdo:session').response;
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

    await expect(broker.request(questions).response).resolves.toEqual({ behavior: 'deny' });
  });

  test('waits for an explicit response and denies pending requests on shutdown', async () => {
    const broker = new AskUserRequestBroker();
    const onDismiss = vi.fn();
    broker.onRequest(() => undefined);
    broker.onDismiss(onDismiss);

    const pending = broker.request(questions);
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
});
