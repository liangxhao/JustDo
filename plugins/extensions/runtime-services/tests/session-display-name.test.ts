import { expect, test, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ getSessionEntry: vi.fn(), patchSessionEntry: vi.fn() }));
vi.mock('openclaw/plugin-sdk/session-store-runtime', () => sdk);

import { SESSION_DISPLAY_NAME_METHOD } from '../contracts/session-display-name';
import { registerSessionDisplayName } from '../session-display-name';

function fixture() {
  type Entry = {
    sessionId: string;
    lifecycleRevision: string;
    label?: string;
    displayName: string;
    updatedAt: number;
  };
  const entries = new Map<string, Entry>([
    [
      'agent:main:justdo:one',
      {
        sessionId: 'native-one',
        lifecycleRevision: 'r1',
        label: 'Explicit label',
        displayName: 'One',
        updatedAt: 42,
      },
    ],
    [
      'agent:main:justdo:two',
      { sessionId: 'native-two', lifecycleRevision: 'r1', displayName: 'Two', updatedAt: 43 },
    ],
  ]);
  const registerGatewayMethod = vi.fn();
  sdk.getSessionEntry.mockReset().mockImplementation(({ sessionKey }) => entries.get(sessionKey));
  sdk.patchSessionEntry
    .mockReset()
    .mockImplementation(({ sessionKey, assertCommitAllowed, update }) => {
      const next = { ...entries.get(sessionKey), ...update(entries.get(sessionKey)) };
      assertCommitAllowed();
      entries.set(sessionKey, next);
      return next;
    });
  registerSessionDisplayName({
    lifecycle: { signal: new AbortController().signal },
    registerGatewayMethod,
  } as never);
  expect(registerGatewayMethod).toHaveBeenCalledWith(
    SESSION_DISPLAY_NAME_METHOD,
    expect.any(Function),
    {
      scope: 'operator.admin',
      profileAccess: 'independent',
    },
  );

  async function write(id: string, extras: Record<string, unknown> = {}, confirmOnly?: true) {
    const respond = vi.fn();
    const params = {
      sessionKey: `agent:main:justdo:${id}`,
      nativeSessionId: `native-${id}`,
      lifecycleRevision: 'r1',
      displayName: 'Same title',
      ...(confirmOnly ? { confirmOnly } : {}),
    };
    await registerGatewayMethod.mock.calls[0][1]({
      params,
      respond,
      client: { connect: { client: { mode: 'backend' } } },
      hasCurrentClientAuthority: () => true,
      ...extras,
    });
    return respond;
  }

  return { entries, write };
}

test('allows duplicate display names and preserves an explicit native label and activity', async () => {
  const { entries, write } = fixture();
  expect(await write('one')).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ displayName: 'Same title' }),
  );
  expect(await write('two')).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ displayName: 'Same title' }),
  );
  expect(entries.get('agent:main:justdo:one')).toMatchObject({
    displayName: 'Same title',
    label: 'Explicit label',
    updatedAt: 42,
  });
  expect(entries.get('agent:main:justdo:two')?.displayName).toBe('Same title');
});

test('leaves the title alone if authorization expires before the native commit', async () => {
  const { entries, write } = fixture();
  const hasCurrentClientAuthority = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
  expect(await write('one', { hasCurrentClientAuthority })).toHaveBeenCalledWith(
    false,
    undefined,
    expect.anything(),
  );
  expect(entries.get('agent:main:justdo:one')?.displayName).toBe('One');
});

test('confirmation reads the stored name without writing a missing value', async () => {
  const { entries, write } = fixture();
  expect(await write('one', {}, true)).toHaveBeenCalledWith(false, undefined, expect.anything());
  expect(entries.get('agent:main:justdo:one')?.displayName).toBe('One');
  expect(sdk.patchSessionEntry).not.toHaveBeenCalled();
});
