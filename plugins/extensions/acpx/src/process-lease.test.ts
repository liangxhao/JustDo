// ACPX tests cover process lease plugin behavior.
import { describe, expect, it } from 'vitest';

import {
  type AcpxProcessLease,
  createAcpxProcessLeaseStore,
  openAcpxProcessLeaseStateStore,
  OPENCLAW_ACPX_LEASE_ID_ARG,
  OPENCLAW_GATEWAY_INSTANCE_ID_ARG,
  readAcpxProcessLeaseIdentity,
  withAcpxLeaseArgs,
} from './process-lease.js';
import { ACPX_PROCESS_LEASE_MAX_ENTRIES } from './state.js';

function makeLease(index: number): AcpxProcessLease {
  return {
    leaseId: `lease-${index}`,
    gatewayInstanceId: 'gateway-test',
    sessionKey: `agent:codex:acp:${index}`,
    wrapperRoot: '/tmp/openclaw/acpx',
    wrapperPath: '/tmp/openclaw/acpx/codex-acp-wrapper.mjs',
    rootPid: 1000 + index,
    commandHash: `hash-${index}`,
    startedAt: index,
    state: 'open',
  };
}

describe('createAcpxProcessLeaseStore', () => {
  function createStore() {
    const entries = new Map<string, unknown>();
    return createAcpxProcessLeaseStore({
      store: openAcpxProcessLeaseStateStore(options => {
        // The host owns persistence. Exercise this adapter's explicit bounded,
        // reject-new contract against a keyed-store dependency fixture.
        expect(options).toMatchObject({
          namespace: 'process-leases',
          maxEntries: ACPX_PROCESS_LEASE_MAX_ENTRIES,
          overflowPolicy: 'reject-new',
        });
        return {
          lookup: async (key: string) => entries.get(key),
          entries: async () => [...entries].map(([key, value]) => ({ key, value })),
          register: async (key: string, value: unknown) => {
            if (!entries.has(key) && entries.size >= options.maxEntries!) {
              throw Object.assign(new Error('capacity exceeded'), {
                code: 'PLUGIN_STATE_LIMIT_EXCEEDED',
              });
            }
            entries.set(key, value);
          },
          delete: async (key: string) => {
            entries.delete(key);
          },
        } as never;
      }),
    });
  }

  it('serializes concurrent lease saves without dropping records', async () => {
    const store = createStore();
    await Promise.all(Array.from({ length: 25 }, (_, index) => store.save(makeLease(index))));

    const leases = await store.listOpen('gateway-test');
    expect(leases.map(lease => lease.leaseId).toSorted()).toEqual(
      Array.from({ length: 25 }, (_, index) => `lease-${index}`).toSorted(),
    );
  });

  it('removes terminal leases from the live lease namespace', async () => {
    const store = createStore();
    const openLease = makeLease(1);
    const closedLease = makeLease(2);
    await store.save(openLease);
    await store.save(closedLease);

    await store.markState(closedLease.leaseId, 'closed');

    await expect(store.load(closedLease.leaseId)).resolves.toBeUndefined();
    await expect(store.listOpen('gateway-test')).resolves.toEqual([openLease]);
  });

  it('rejects capacity overflow without evicting existing process ownership', async () => {
    const store = createStore();
    await Promise.all(
      Array.from({ length: ACPX_PROCESS_LEASE_MAX_ENTRIES }, (_, index) =>
        store.save(makeLease(index)),
      ),
    );

    await expect(store.save(makeLease(ACPX_PROCESS_LEASE_MAX_ENTRIES))).rejects.toMatchObject({
      code: 'PLUGIN_STATE_LIMIT_EXCEEDED',
    });
    await expect(store.load('lease-0')).resolves.toEqual(makeLease(0));
    await expect(store.listOpen('gateway-test')).resolves.toHaveLength(
      ACPX_PROCESS_LEASE_MAX_ENTRIES,
    );
  });
});

describe('withAcpxLeaseArgs', () => {
  it('preserves portable lease wrapper args', () => {
    const command = withAcpxLeaseArgs({
      command: ['node', 'C:/openclaw/acpx/codex-acp-wrapper.mjs', ''],
      leaseId: 'lease test',
      gatewayInstanceId: 'gateway-test',
    });

    expect(command).toEqual([
      'node',
      'C:/openclaw/acpx/codex-acp-wrapper.mjs',
      '',
      OPENCLAW_ACPX_LEASE_ID_ARG,
      'lease test',
      OPENCLAW_GATEWAY_INSTANCE_ID_ARG,
      'gateway-test',
    ]);
  });
});

describe('readAcpxProcessLeaseIdentity', () => {
  it('reads quoted portable lease wrapper args', () => {
    expect(
      readAcpxProcessLeaseIdentity(
        [
          "node /tmp/openclaw/acpx/codex-acp-wrapper.mjs --label owner's-choice",
          OPENCLAW_ACPX_LEASE_ID_ARG,
          "'lease test'",
          OPENCLAW_GATEWAY_INSTANCE_ID_ARG,
          '"gateway test"',
        ].join(' '),
      ),
    ).toEqual({
      leaseId: 'lease test',
      gatewayInstanceId: 'gateway test',
    });
  });

  it('rejects incomplete lease identity', () => {
    expect(
      readAcpxProcessLeaseIdentity(`node wrapper.mjs ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-test`),
    ).toBeUndefined();
    expect(readAcpxProcessLeaseIdentity(undefined)).toBeUndefined();
  });
});
