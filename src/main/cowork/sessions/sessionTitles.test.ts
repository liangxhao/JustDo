import { expect, test, vi } from 'vitest';

import {
  SESSION_DISPLAY_NAME_METHOD,
  type SessionDisplayNameRequest,
} from '../../../../plugins/extensions/runtime-services/contracts/session-display-name';
import type { CoworkSession } from '../../data/coworkStore';
import { createSessionTitleOperations, type SessionTitleGateway } from './sessionTitles';

const identity = {
  sessionKey: 'agent:main:justdo:session',
  nativeSessionId: 'native',
  lifecycleRevision: 'r1',
};
const generate = {
  sessionId: 'session',
  expectedTitle: 'Initial title',
  userInput: 'Initial request',
  nativeTarget: identity,
};

function fixture() {
  let row = {
    id: generate.sessionId,
    agentId: 'main',
    title: generate.expectedTitle,
    createdAt: 1,
  } as CoworkSession;
  const entry = {
    key: identity.sessionKey,
    sessionId: identity.nativeSessionId,
    lifecycleRevision: identity.lifecycleRevision,
    displayName: row.title,
  };
  const request = vi.fn(async (method: string, input: unknown) => {
    if (method === 'sessions.describe') return { session: { ...entry } };
    if (method !== SESSION_DISPLAY_NAME_METHOD) throw new Error(method);
    const params = input as SessionDisplayNameRequest;
    if (params.lifecycleRevision !== entry.lifecycleRevision) throw new Error('Session reset');
    if (params.confirmOnly) {
      if (entry.displayName !== params.displayName) throw new Error('Title unavailable');
    } else entry.displayName = params.displayName;
    return params;
  });
  const generateTitle = vi.fn(async () => 'Generated title');
  const onChanged = vi.fn();
  const operations = createSessionTitleOperations({
    getStore: () => ({
      getSession: () => row,
      updateSession: (_id, changes) => {
        row = { ...row, ...changes };
      },
    }),
    getGateway: () => ({
      request: request as SessionTitleGateway['request'],
      isCurrent: () => true,
    }),
    generateTitle,
    onChanged,
  });
  return { operations, entry, request, generateTitle, onChanged, readTitle: () => row.title };
}

test('saves the automatic title for the admitted native conversation', async () => {
  const f = fixture();
  await expect(f.operations.generate(generate)).resolves.toBe('Generated title');
  expect(f.entry.displayName).toBe('Generated title');
  expect(f.readTitle()).toBe('Generated title');
  expect(f.onChanged).toHaveBeenCalledOnce();
});

test('publishes a manual title while automatic generation is still running', async () => {
  const f = fixture();
  const pendingTitle = Promise.withResolvers<string>();
  f.generateTitle.mockReturnValueOnce(pendingTitle.promise);
  const automatic = f.operations.generate(generate);
  await vi.waitFor(() => expect(f.generateTitle).toHaveBeenCalledOnce());

  await expect(f.operations.rename(generate.sessionId, 'Manual title')).resolves.toBe(
    'Manual title',
  );
  pendingTitle.resolve('Late automatic title');
  await expect(automatic).resolves.toBeNull();
  expect(f.entry.displayName).toBe('Manual title');
  expect(f.readTitle()).toBe('Manual title');
});

test('ignores an old first-turn title after a same-ID reset', async () => {
  const f = fixture();
  f.entry.lifecycleRevision = 'r2';
  await expect(f.operations.generate(generate)).resolves.toBeNull();
  expect(f.generateTitle).not.toHaveBeenCalled();
  expect(f.entry.displayName).toBe('Initial title');
});

test('uses the confirmed native value after a lost write reply without resending', async () => {
  const f = fixture();
  f.request.mockImplementationOnce(async () => ({ session: { ...f.entry } }));
  f.request.mockImplementationOnce(async () => {
    f.entry.displayName = 'Saved title';
    throw new Error('request timeout: native title');
  });
  await expect(f.operations.rename(generate.sessionId, 'Saved title')).resolves.toBe('Saved title');
  expect(f.readTitle()).toBe('Saved title');
  expect(f.request.mock.calls.map(([method, params]) => [method, params])).toEqual([
    ['sessions.describe', { key: identity.sessionKey }],
    [SESSION_DISPLAY_NAME_METHOD, { ...identity, displayName: 'Saved title' }],
    [SESSION_DISPLAY_NAME_METHOD, { ...identity, displayName: 'Saved title', confirmOnly: true }],
  ]);
});
