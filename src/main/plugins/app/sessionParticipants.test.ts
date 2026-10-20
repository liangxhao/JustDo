import { describe, expect, it, vi } from 'vitest';

import type {
  AppMainRegistration,
  AppResourceParticipant,
  AppSubmissionParticipant,
} from '../../../../packages/app-plugin-sdk/main';
import { AppSessionParticipants, cancelSessionPluginsWithoutWaiting } from './sessionParticipants';

const participant = (overrides: Partial<AppResourceParticipant> = {}): AppResourceParticipant => ({
  expandResources: ids => [...ids],
  acquireDeletion: () => () => undefined,
  isDeleting: () => false,
  isManaged: () => false,
  prepareDelete: async () => undefined,
  deleteManaged: async () => false,
  ...overrides,
});
const coordinator = (...resources: AppResourceParticipant[]) =>
  new AppSessionParticipants({
    registrations: () =>
      resources.map(
        resource => ({ commands: [], resources: resource }) satisfies AppMainRegistration,
      ),
    submissionIdentity: () => ({ pluginId: 'fixture', epoch: 'first', mode: 'launch' }),
    assertResourceOwners: () => undefined,
    confirmResourceDeletion: () => undefined,
    runSubmission: (_participant, _submission, operation) => operation(),
  });

it('closes every local plugin admission before native Stop without awaiting remote cleanup', async () => {
  const events: string[] = [];
  let finish!: () => void;
  const cleanup = new Promise<void>(resolve => {
    finish = resolve;
  });
  const service = new AppSessionParticipants({
    registrations: () =>
      ['first', 'second'].map(id => ({
        commands: [],
        submission: {
          cancel: () => {
            events.push(id);
            return cleanup;
          },
        } as unknown as AppSubmissionParticipant,
      })),
  } as unknown as ConstructorParameters<typeof AppSessionParticipants>[0]);
  cancelSessionPluginsWithoutWaiting(() => service, 'source', 'turn');
  events.push('native-stop');
  expect(events).toEqual(['first', 'second', 'native-stop']);
  finish();
  await cleanup;
});

it('keeps native Stop available when plugin access or cleanup rejects', async () => {
  expect(() =>
    cancelSessionPluginsWithoutWaiting(() => {
      throw Error('unavailable');
    }, 'source'),
  ).not.toThrow();
  const cancel = vi.fn(async () => {
    throw Error('cleanup failed');
  });
  expect(() => cancelSessionPluginsWithoutWaiting(() => ({ cancel }), 'source')).not.toThrow();
  await Promise.resolve();
  expect(cancel).toHaveBeenCalledWith('source', undefined);
});

describe('app session resource participants', () => {
  it('expands the complete cohort and fences every plugin before any awaited preparation', async () => {
    const events: string[] = [];
    const first = participant({
      expandResources: ids => (ids.includes('source') ? [...ids, 'member'] : [...ids]),
      acquireDeletion: ids => {
        expect(ids).toEqual(['source', 'member', 'node']);
        events.push('team-fence');
        return () => events.push('team-release');
      },
      prepareDelete: async () => {
        events.push('team-prepare');
      },
      isManaged: id => id === 'source',
      deleteManaged: async () => {
        events.push('team-delete');
        return true;
      },
    });
    const second = participant({
      expandResources: ids => (ids.includes('member') ? [...ids, 'node'] : [...ids]),
      acquireDeletion: () => {
        events.push('flow-fence');
        return () => events.push('flow-release');
      },
      prepareDelete: async () => {
        events.push('flow-prepare');
      },
      deleteManaged: async () => {
        events.push('flow-delete');
        return false;
      },
    });
    const service = coordinator(first, second);
    const release = service.acquireDeletion(['source']);
    expect(events).toEqual(['team-fence', 'flow-fence']);
    expect(await service.deleteManaged('source')).toBe(true);
    expect(events).toEqual([
      'team-fence',
      'flow-fence',
      'team-prepare',
      'flow-prepare',
      'team-delete',
      'flow-delete',
    ]);
    release();
    release();
    expect(events.slice(-2)).toEqual(['flow-release', 'team-release']);
  });
  it('allows a non-owning participant to veto before the owning plugin deletes anything', async () => {
    const remove = vi.fn(async () => true);
    const service = coordinator(
      participant({ isManaged: () => true, deleteManaged: remove }),
      participant({
        prepareDelete: async () => {
          throw new Error('native work unresolved');
        },
      }),
    );
    const release = service.acquireDeletion(['source']);
    await expect(service.deleteManaged('source')).rejects.toThrow('native work unresolved');
    expect(remove).not.toHaveBeenCalled();
    release();
  });
  it('releases earlier fences if a later participant fails admission', async () => {
    const release = vi.fn();
    const service = coordinator(
      participant({ acquireDeletion: () => release }),
      participant({
        acquireDeletion: () => {
          throw new Error('closed');
        },
      }),
    );
    expect(() => service.acquireDeletion(['source'])).toThrow('closed');
    expect(release).toHaveBeenCalledOnce();
    await expect(service.withPackageMutation(async () => 'recovered')).resolves.toBe('recovered');
  });
});

describe('package mutation and session deletion exclusion', () => {
  it('protects an ordinary Core deletion even when no plugin participates', async () => {
    const service = coordinator();
    const operation = vi.fn(async () => 'changed');
    const release = service.acquireDeletion(['ordinary-session']);

    await expect(service.withPackageMutation(operation)).rejects.toThrow(
      'appPluginCleanupUnresolved',
    );
    expect(operation).not.toHaveBeenCalled();

    release();
    await expect(service.withPackageMutation(operation)).resolves.toBe('changed');
    expect(operation).toHaveBeenCalledOnce();
  });

  it('waits for both deletion leases and ignores duplicate releases', async () => {
    const service = coordinator();
    const operation = vi.fn(async () => undefined);
    const releaseFirst = service.acquireDeletion(['first']);
    const releaseSecond = service.acquireDeletion(['second']);

    releaseFirst();
    releaseFirst();
    await expect(service.withPackageMutation(operation)).rejects.toThrow(
      'appPluginCleanupUnresolved',
    );
    expect(operation).not.toHaveBeenCalled();

    releaseSecond();
    releaseSecond();
    await expect(service.withPackageMutation(operation)).resolves.toBeUndefined();
    expect(operation).toHaveBeenCalledOnce();
  });

  it('rejects deletion and nested package changes before consulting plugins while a package change waits', async () => {
    const expandResources = vi.fn((ids: readonly string[]) => [...ids]);
    const acquireDeletion = vi.fn(() => () => undefined);
    const assertResourceOwners = vi.fn();
    const registrations = vi.fn(() => [
      { commands: [], resources: participant({ expandResources, acquireDeletion }) },
    ]);
    const service = new AppSessionParticipants({
      registrations,
      assertResourceOwners,
      confirmResourceDeletion: () => undefined,
      submissionIdentity: () => ({ pluginId: 'fixture', epoch: 'first', mode: 'launch' }),
      runSubmission: (_participant, _submission, operation) => operation(),
    });
    let finish!: () => void;
    const pending = new Promise<void>(resolve => {
      finish = resolve;
    });
    const changing = service.withPackageMutation(async () => {
      await pending;
      return 'changed';
    });
    const nested = vi.fn(async () => undefined);

    try {
      expect(() => service.acquireDeletion(['source'])).toThrow('appPluginCleanupUnresolved');
      await expect(service.withPackageMutation(nested)).rejects.toThrow(
        'appPluginCleanupUnresolved',
      );
      expect(registrations).not.toHaveBeenCalled();
      expect(expandResources).not.toHaveBeenCalled();
      expect(assertResourceOwners).not.toHaveBeenCalled();
      expect(acquireDeletion).not.toHaveBeenCalled();
      expect(nested).not.toHaveBeenCalled();
    } finally {
      finish();
      await expect(changing).resolves.toBe('changed');
    }

    const release = service.acquireDeletion(['source']);
    expect(acquireDeletion).toHaveBeenCalledExactlyOnceWith(['source']);
    release();
  });

  it.each(['expansion', 'ownership', 'plugin-admission'] as const)(
    'occupies the deletion lease before the synchronous %s callback',
    async phase => {
      const operation = vi.fn(async () => 'changed');
      const attempts: Promise<unknown>[] = [];
      const attemptMutation = () => {
        attempts.push(service.withPackageMutation(operation));
      };
      const service = new AppSessionParticipants({
        registrations: () => [
          {
            commands: [],
            resources: participant({
              expandResources: ids => {
                if (phase === 'expansion') attemptMutation();
                return [...ids];
              },
              acquireDeletion: () => {
                if (phase === 'plugin-admission') attemptMutation();
                return () => undefined;
              },
            }),
          },
        ],
        assertResourceOwners: () => {
          if (phase === 'ownership') attemptMutation();
        },
        confirmResourceDeletion: () => undefined,
        submissionIdentity: () => ({ pluginId: 'fixture', epoch: 'first', mode: 'launch' }),
        runSubmission: (_participant, _submission, run) => run(),
      });

      const release = service.acquireDeletion(['source']);
      try {
        expect(attempts).toHaveLength(1);
        await expect(attempts[0]).rejects.toThrow('appPluginCleanupUnresolved');
        expect(operation).not.toHaveBeenCalled();
      } finally {
        release();
      }
      await expect(service.withPackageMutation(operation)).resolves.toBe('changed');
    },
  );

  it.each(['expansion', 'ownership'] as const)(
    'rolls back the deletion lease when %s fails before plugin admission',
    async phase => {
      const acquireDeletion = vi.fn(() => () => undefined);
      const service = new AppSessionParticipants({
        registrations: () => [
          {
            commands: [],
            resources: participant({
              expandResources: ids => {
                if (phase === 'expansion') throw new Error('admission failed');
                return [...ids];
              },
              acquireDeletion,
            }),
          },
        ],
        assertResourceOwners: () => {
          if (phase === 'ownership') throw new Error('admission failed');
        },
        confirmResourceDeletion: () => undefined,
        submissionIdentity: () => ({ pluginId: 'fixture', epoch: 'first', mode: 'launch' }),
        runSubmission: (_participant, _submission, operation) => operation(),
      });

      expect(() => service.acquireDeletion(['source'])).toThrow('admission failed');
      expect(acquireDeletion).not.toHaveBeenCalled();
      await expect(service.withPackageMutation(async () => 'recovered')).resolves.toBe('recovered');
    },
  );

  it.each(['synchronous', 'asynchronous'] as const)(
    'releases package exclusion after a %s operation failure',
    async phase => {
      const service = coordinator();
      const operation =
        phase === 'synchronous'
          ? () => {
              throw new Error('package failed');
            }
          : async () => {
              await Promise.resolve();
              throw new Error('package failed');
            };

      await expect(service.withPackageMutation(operation)).rejects.toThrow('package failed');
      const release = service.acquireDeletion(['source']);
      release();
      await expect(service.withPackageMutation(async () => 'recovered')).resolves.toBe('recovered');
    },
  );
});

const submissionParticipant = (
  overrides: Partial<AppSubmissionParticipant> = {},
): AppSubmissionParticipant => ({
  matches: () => true,
  register: async () => undefined,
  markSubmissionStarted: async () => undefined,
  abortBeforeSend: async () => false,
  cancel: async () => undefined,
  releaseIfSettled: async () => false,
  ...overrides,
});
function submissionFixture(...submissions: AppSubmissionParticipant[]) {
  const confirmResourceDeletion = vi.fn<(_ids: readonly string[]) => void>();
  const registrations: AppMainRegistration[] = submissions.map(submission => ({
    commands: [],
    submission,
  }));
  const service = new AppSessionParticipants({
    registrations: () => registrations,
    submissionIdentity: () => ({ pluginId: 'fixture', epoch: 'epoch', mode: 'launch' }),
    assertResourceOwners: () => undefined,
    confirmResourceDeletion,
    runSubmission: (_participant, _submission, operation) => operation(),
  });
  const register = (sessionId: string, clientTurnId = 'turn') =>
    service.register({
      sessionId,
      clientTurnId,
      prompt: 'Plugin input',
    });
  return { service, register, registrations, confirmResourceDeletion };
}

describe('temporary plugin submission admissions', () => {
  it('admits more than 1024 independent completed send gates without requiring another source message', async () => {
    const f = submissionFixture(submissionParticipant());
    for (let index = 0; index < 1025; index++) {
      const id = `source-${index}`;
      await f.register(id);
      await f.service.markSubmissionStarted(id, 'turn');
    }
    await expect(f.service.markSubmissionStarted('source-0', 'turn')).rejects.toThrow(
      'appPluginRetired',
    );
  });

  it('retains the admission until every mark succeeds and preserves an unknown mark', async () => {
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => {
      finish = resolve;
    });
    const unknown = new Error('Native mark outcome is unknown');
    const second = vi.fn(async () => {
      await waiting;
      throw unknown;
    });
    const f = submissionFixture(
      submissionParticipant(),
      submissionParticipant({ markSubmissionStarted: second }),
    );
    await f.register('source');
    const marking = f.service.markSubmissionStarted('source', 'turn');
    await Promise.resolve();
    await expect(f.register('source')).rejects.toThrow('appPluginInvalidRequest');
    finish();
    await expect(marking).rejects.toBe(unknown);
    await expect(f.service.markSubmissionStarted('source', 'turn')).rejects.toBe(unknown);
    expect(second).toHaveBeenCalledTimes(2);
    await expect(f.register('source')).rejects.toThrow('appPluginInvalidRequest');
  });

  it('reclaims only a confirmed deletion cohort and retains failed or unrelated admissions', async () => {
    const marked = vi.fn(async () => undefined);
    const f = submissionFixture(submissionParticipant({ markSubmissionStarted: marked }));
    const remove = vi.fn(async () => false);
    f.registrations[0].resources = participant({
      expandResources: ids => (ids.includes('source') ? [...ids, 'member'] : [...ids]),
      isManaged: id => id === 'source',
      deleteManaged: remove,
    });
    for (const id of ['source', 'member', 'source-other']) await f.register(id);
    expect(await f.service.deleteManaged('source')).toBe(false);
    await expect(f.register('source')).rejects.toThrow('appPluginInvalidRequest');
    f.confirmResourceDeletion.mockImplementationOnce(() => {
      throw new Error('Unconfirmed deletion');
    });
    expect(() => f.service.confirmDeleted(['source'])).toThrow('Unconfirmed deletion');
    await expect(f.register('source')).rejects.toThrow('appPluginInvalidRequest');
    remove.mockResolvedValueOnce(true);
    expect(await f.service.deleteManaged('source')).toBe(true);
    await expect(f.service.markSubmissionStarted('source', 'turn')).rejects.toThrow(
      'appPluginRetired',
    );
    await expect(f.service.markSubmissionStarted('member', 'turn')).rejects.toThrow(
      'appPluginRetired',
    );
    await expect(f.service.markSubmissionStarted('source-other', 'turn')).resolves.toBeUndefined();
    expect(marked).toHaveBeenCalledExactlyOnceWith('source-other', 'turn');
    await f.register('ordinary');
    f.service.confirmDeleted(['ordinary']);
    await expect(f.service.markSubmissionStarted('ordinary', 'turn')).rejects.toThrow(
      'appPluginRetired',
    );
  });

  it('does not let an old successful mark remove a later admission with the same key', async () => {
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => {
      finish = resolve;
    });
    const marked = vi.fn(async () => undefined).mockImplementationOnce(() => waiting);
    const f = submissionFixture(submissionParticipant({ markSubmissionStarted: marked }));
    await f.register('source');
    const old = f.service.markSubmissionStarted('source', 'turn');
    f.service.confirmDeleted(['source']);
    await f.register('source');
    finish();
    await old;
    await expect(f.service.markSubmissionStarted('source', 'turn')).resolves.toBeUndefined();
    expect(marked).toHaveBeenCalledTimes(2);
  });
});
