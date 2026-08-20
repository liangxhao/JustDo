import { describe, expect, test, vi } from 'vitest';

import { OpenClawExtensionHostLifecycle } from './openclawExtensionHostLifecycle';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

describe('OpenClawExtensionHostLifecycle pending interaction replay', () => {
  test('reconstructs renderer interactions from broker-owned requests', () => {
    const lifecycle = new OpenClawExtensionHostLifecycle({
      askUserSessionByRequestId: new Map(),
    });
    const controller = lifecycle.getController();
    vi.spyOn(controller, 'listPendingAskUserRequests').mockReturnValue([
      {
        requestId: 'request-1',
        waitPolicy: { mode: 'required' },
        questions: [
          {
            id: 'continue',
            question: 'Continue?',
            options: [
              { id: 'yes', label: 'Yes' },
              { id: 'no', label: 'No' },
            ],
          },
        ],
      },
    ]);

    expect(lifecycle.listPendingInteractions()).toEqual([
      {
        sessionId: '__askuser__',
        request: {
          requestId: 'request-1',
          toolName: 'AskUserQuestion',
          interactionKind: 'structured-question',
          toolInput: {
            questions: [
              {
                id: 'continue',
                question: 'Continue?',
                options: [
                  { id: 'yes', label: 'Yes' },
                  { id: 'no', label: 'No' },
                ],
              },
            ],
            waitPolicy: { mode: 'required' },
            sessionKey: undefined,
            sessionId: '__askuser__',
          },
        },
      },
    ]);
  });
});
