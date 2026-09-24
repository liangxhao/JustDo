import { createHash } from 'node:crypto';

import { describe, expect, test, vi } from 'vitest';

import type { SkillProposalInspection } from '../../../shared/plugins/skillWorkshop';
import { SkillWorkshopService } from './skillWorkshopService';

const revision = 'a'.repeat(64);
const draft: SkillProposalInspection = {
  record: {
    id: 'proposal-1',
    kind: 'create',
    status: 'pending',
    title: 'Reusable procedure',
    description: 'A procedure',
    target: { skillName: 'procedure', skillKey: 'procedure' },
    origin: { agentId: 'main' },
    scan: { state: 'clean', findings: [] },
  },
  revisionHash: revision,
  content: '# Full instructions\nStep one\nStep two',
  currentContent: '',
  supportFiles: [{ path: 'scripts/run.py', content: 'print("hello")' }],
};

function setup() {
  const request = vi.fn(async (method: string) => {
    if (method === 'skills.proposals.list') return { proposals: [] };
    if (method === 'skills.proposals.inspect') return structuredClone(draft);
    if (method === 'skills.workshop.read') return { content: 'Old full instructions' };
    return {};
  });
  const service = new SkillWorkshopService(request as never);
  return { service, request };
}

describe('proposal review ownership and revisions', () => {
  test('rejects another agent before reading or writing native state', async () => {
    const { service, request } = setup();
    await expect(service.list('research')).rejects.toThrow('skillWorkshopMainOnly');
    await expect(service.inspect('research', 'proposal-1')).rejects.toThrow(
      'skillWorkshopMainOnly',
    );
    await expect(
      service.decide({
        agentId: 'research',
        proposalId: 'proposal-1',
        expectedRevisionHash: revision,
        action: 'apply',
      }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  test('returns complete current and proposed instructions and support files', async () => {
    const { service, request } = setup();
    const currentContent = 'Old full instructions';
    request.mockResolvedValueOnce({
      ...draft,
      record: {
        ...draft.record,
        kind: 'update',
        target: {
          ...draft.record.target,
          currentContentHash: createHash('sha256').update(currentContent).digest('hex'),
        },
      },
    } as never);
    const result = await service.inspect('main', 'proposal-1');
    expect(result).toMatchObject({
      content: draft.content,
      currentContent,
      targetChanged: false,
      supportFiles: draft.supportFiles,
    });
    expect(request).toHaveBeenLastCalledWith('skills.workshop.read', {
      agentId: 'main',
      name: 'procedure',
    });
  });

  test.each(['applied', 'stale', 'rejected'] as const)(
    'does not apply a proposal already %s',
    async status => {
      const { service, request } = setup();
      request.mockResolvedValueOnce({ ...draft, record: { ...draft.record, status } } as never);
      await expect(
        service.decide({
          agentId: 'main',
          proposalId: 'proposal-1',
          expectedRevisionHash: revision,
          action: 'apply',
        }),
      ).rejects.toThrow('skillWorkshopRefreshRequired');
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  test('does not apply a different revision than the user inspected', async () => {
    const { service, request } = setup();
    await expect(
      service.decide({
        agentId: 'main',
        proposalId: 'proposal-1',
        expectedRevisionHash: 'b'.repeat(64),
        action: 'apply',
      }),
    ).rejects.toThrow('skillWorkshopRefreshRequired');
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('blocks changed or unreadable update targets instead of approving a blind comparison', async () => {
    const { service, request } = setup();
    request.mockResolvedValueOnce({
      ...draft,
      record: {
        ...draft.record,
        kind: 'update',
        target: { ...draft.record.target, currentContentHash: 'b'.repeat(64) },
      },
    } as never);
    await expect(
      service.decide({
        agentId: 'main',
        proposalId: 'proposal-1',
        expectedRevisionHash: revision,
        action: 'apply',
      }),
    ).rejects.toThrow('skillWorkshopTargetChanged');
    expect(request.mock.calls.map(([method]) => method)).not.toContain('skills.proposals.apply');
  });

  test('reject calls only native reject and binds the reviewed revision', async () => {
    const { service, request } = setup();
    await service.decide({
      agentId: 'main',
      proposalId: 'proposal-1',
      expectedRevisionHash: revision,
      action: 'reject',
    });
    expect(request).toHaveBeenLastCalledWith('skills.proposals.reject', {
      agentId: 'main',
      proposalId: 'proposal-1',
      expectedRevisionHash: revision,
      correlationId: expect.any(String),
    });
    expect(request.mock.calls.map(([method]) => method)).not.toContain('skills.proposals.apply');
  });

  test('deduplicates concurrent decisions and does not replay an uncertain write', async () => {
    const { service, request } = setup();
    let reject!: (reason: Error) => void;
    request.mockImplementation(async method => {
      if (method === 'skills.proposals.inspect') return structuredClone(draft) as never;
      return new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise;
      });
    });
    const input = {
      agentId: 'main',
      proposalId: 'proposal-1',
      expectedRevisionHash: revision,
      action: 'apply' as const,
    };
    const first = service.decide(input);
    await expect(service.decide(input)).rejects.toThrow('skillWorkshopBusy');
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
    reject(new Error('timeout'));
    await expect(first).rejects.toThrow('timeout');
    expect(
      request.mock.calls.filter(([method]) => method === 'skills.proposals.apply'),
    ).toHaveLength(1);
  });
});
