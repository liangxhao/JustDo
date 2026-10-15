import { expect, test } from 'vitest';

import { mergeNativeMcpOverrides } from './nativeMcpOverrides';

test('retains native extension overrides and disable markers without resurrecting deleted user definitions', () => {
  const native = {
    mcp: {
      servers: {
        extension: {
          command: 'node',
          args: ['changed.mjs'],
          env: { TOKEN: 'fixture' },
          requestTimeoutMs: 12000,
        },
        disabled: { enabled: false },
        removedUser: { command: 'old-user-command', enabled: false },
        user: { command: 'stale' },
      },
    },
  };
  const before = structuredClone(native);
  expect(
    mergeNativeMcpOverrides(native, { user: { command: 'current' } }, new Set(['extension'])),
  ).toEqual({
    extension: native.mcp.servers.extension,
    disabled: { enabled: false },
    user: { command: 'current' },
  });
  expect(native).toEqual(before);
  expect(
    mergeNativeMcpOverrides(native, {}, new Set(['extension', 'disabled']), new Set(['extension', 'disabled'])),
  ).toEqual({});
});
