import { describe, expect, it } from 'vitest';

import { ExternalSessionStatus } from '../../../../shared/integrations/externalSession';
import type { ExternalAgentThreadMetadata } from '../../shared/externalAgentTypes';
import { AppServerErrorCode, type AppServerParams, AppServerRpcError } from '../protocol/appServerProtocol';
import { paginateIds, paginateThreads } from './codexAppServerPagination';

const metadata = (
  index: number,
  overrides: Partial<ExternalAgentThreadMetadata> = {},
): ExternalAgentThreadMetadata => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  name: 'Build release',
  cwd: 'E:/workspace/project',
  agentId: 'main',
  modelRef: 'provider/model',
  createdAt: 1_000,
  updatedAt: 2_000,
  permissionMode: 'full',
  status: ExternalSessionStatus.Completed,
  ...overrides,
});

const expectInvalidParams = (operation: () => unknown) => {
  expect(operation).toThrow(AppServerRpcError);
  expect(operation).toThrow(expect.objectContaining({ code: AppServerErrorCode.InvalidParams }));
};

describe('app-server thread pagination', () => {
  it('pages equal timestamps deterministically without mutating the supplied metadata', () => {
    const rows = [metadata(2), metadata(1), metadata(3)];
    const originalOrder = rows.map(row => row.id);

    const first = paginateThreads(rows, { limit: 1 });
    const second = paginateThreads(rows, { limit: 1, cursor: first.nextCursor });
    const third = paginateThreads(rows, { limit: 1, cursor: second.nextCursor });

    expect([first, second, third].flatMap(page => page.data.map(row => row.id))).toEqual([
      rows[2].id, rows[0].id, rows[1].id,
    ]);
    expect(third.nextCursor).toBeNull();
    expect(rows.map(row => row.id)).toEqual(originalOrder);
  });

  it('continues after a deleted anchor and ignores rows inserted before the cursor', () => {
    const original = [metadata(1), metadata(2), metadata(3), metadata(4, { createdAt: 2_000 })];
    const first = paginateThreads(original, { limit: 2, sortDirection: 'asc' });
    const changed = [
      metadata(0, { createdAt: 500 }), original[0], original[2], original[3],
      metadata(5, { createdAt: 3_000 }),
    ];

    const second = paginateThreads(changed, {
      limit: 2, sortDirection: 'asc', cursor: first.nextCursor,
    });
    const third = paginateThreads(changed, {
      limit: 2, sortDirection: 'asc', cursor: second.nextCursor,
    });

    expect(first.data.map(row => row.id)).toEqual([original[0].id, original[1].id]);
    expect(second.data.map(row => row.id)).toEqual([original[2].id, original[3].id]);
    expect(third.data.map(row => row.id)).toEqual([changed[4].id]);
    expect(third.nextCursor).toBeNull();
  });

  it('binds a cursor to the query and rejects cursors from model or loaded-thread lists', () => {
    const rows = [metadata(1), metadata(2), metadata(3)];
    const query = { limit: 1, searchTerm: 'Build', modelProviders: ['provider'] };
    const page = paginateThreads(rows, query);
    for (const changed of [
      { ...query, searchTerm: 'release' },
      { ...query, modelProviders: ['other'] },
      { ...query, sortDirection: 'asc' },
    ]) {
      expectInvalidParams(() => paginateThreads(rows, { ...changed, cursor: page.nextCursor }));
    }
    const models = paginateIds(['provider/first', 'provider/second'], { limit: 1 }, 'models', id => id);
    const loaded = paginateIds(rows.map(row => row.id), { limit: 1 }, 'loaded', id => id);
    expectInvalidParams(() => paginateThreads(rows, { ...query, cursor: models.nextCursor }));
    expectInvalidParams(() => paginateThreads(rows, { ...query, cursor: loaded.nextCursor }));
    expectInvalidParams(() => paginateIds(rows, { cursor: page.nextCursor }, 'models', row => row.id));
    expectInvalidParams(() => paginateIds(rows, { cursor: models.nextCursor }, 'loaded', row => row.id));
  });

  it('combines title, provider, source, directory and exclusion filters before paging', () => {
    const rows = [
      metadata(1), metadata(2), metadata(3, { modelRef: 'other/model' }),
      metadata(4, { cwd: 'E:/workspace/elsewhere' }), metadata(5, { name: 'Investigate issue' }),
    ];
    const page = paginateThreads(rows, {
      searchTerm: 'BUILD',
      modelProviders: ['provider'],
      sourceKinds: ['cli'],
      cwd: ['E:/workspace/project'],
      excludedThreadIds: [rows[1].id],
      sortDirection: 'asc',
      limit: 1,
    });

    expect(page.data.map(row => row.id)).toEqual([rows[0].id]);
    expect(page.nextCursor).toBeNull();
    expect(paginateThreads(rows, { sourceKinds: ['appServer'] }).data).toEqual([]);
    expect(paginateThreads(rows, { archived: true }).data).toEqual([]);
    expect(paginateThreads(rows, { cwd: 'E:/workspace/elsewhere' }).data).toEqual([rows[3]]);
  });

  it('sorts updated metadata rather than creation timestamps when requested', () => {
    const rows = [
      metadata(1, { createdAt: 5_000, updatedAt: 3_000 }),
      metadata(2, { createdAt: 3_000, updatedAt: 8_000 }),
    ];
    const page = paginateThreads(rows, { sortKey: 'updated_at', limit: 1 });

    expect(page.data.map(row => row.id)).toEqual([rows[1].id]);
    expect(paginateThreads(rows, {
      sortKey: 'updated_at', limit: 1, cursor: page.nextCursor,
    }).data.map(row => row.id)).toEqual([rows[0].id]);
  });

  it('accepts an explicit empty page but rejects malformed page and filter parameters', () => {
    const rows = [metadata(1), metadata(2)];
    expect(paginateThreads(rows, { limit: 0 })).toMatchObject({ data: [], nextCursor: null });
    expect(paginateIds(rows, { limit: 0 }, 'loaded', row => row.id)).toEqual({ data: [], nextCursor: null });
    const invalid: AppServerParams[] = [
      { limit: -1 }, { limit: 0.5 }, { limit: 201 }, { limit: '1' },
      { cursor: 'not a cursor?' }, { sortDirection: 'reverse' },
      { sourceKinds: ['unrecognized'] }, { cwd: true },
      { excludedThreadIds: ['not-a-thread-id'] }, { originators: ['client-name'] },
    ];
    for (const params of invalid) expectInvalidParams(() => paginateThreads(rows, params));
  });
});
