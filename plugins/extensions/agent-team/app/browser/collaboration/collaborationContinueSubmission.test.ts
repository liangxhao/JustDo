import { expect, it, vi } from 'vitest';

vi.mock('../../../tests/fixtures/coworkService', () => ({ coworkService: {} }));

import { submitCollaborationContinuation } from './collaborationContinueSubmission';

const target = {
  sourceSessionId: 'source',
  sourceAgentId: 'organizer',
  roomId: 'room',
  targetAgentId: 'alice',
  targetSessionId: 'peer',
  targetSessionKey: 'agent:alice:justdo:peer',
  priorDeliveryId: 'prior',
};
const context = () => ({
  target,
  cwd: 'E:/project',
  assertCurrent: vi.fn(),
  supportsImages: () => true,
  stageAudio: vi.fn().mockResolvedValue({ success: true, path: 'E:/project/chosen.wav' }),
  readImage: vi.fn().mockResolvedValue({ success: true, dataUrl: 'data:image/png;base64,eA==' }),
  beforeSubmit: vi.fn().mockResolvedValue(undefined),
  submit: vi.fn().mockResolvedValue('target_accepted' as const),
});

it('submits the exact member with an independent user identity and attachments, without a source handoff prompt', async () => {
  const deps = context();
  expect(
    await submitCollaborationContinuation(
      {
        requestId: 'next',
        message: 'Continue review',
        attachmentPaths: ['E:/picked.wav', 'E:/diagram.png', 'E:/notes.txt'],
      },
      deps,
    ),
  ).toBe('target_accepted');
  expect(deps.submit).toHaveBeenCalledWith(
    target,
    'Continue review\nMEDIA:E:/project/chosen.wav\nMEDIA:E:/notes.txt',
    [{ name: 'diagram.png', mimeType: 'image/png', base64Data: 'eA==' }],
    'agent-team-member-next',
  );
  expect(deps.stageAudio).toHaveBeenCalledWith('E:/picked.wav', 'E:/project');
  expect(deps.beforeSubmit).toHaveBeenCalledOnce();
});

it('preserves an unknown member submission without retrying', async () => {
  const deps = context();
  deps.submit.mockResolvedValue('unknown' as never);
  expect(
    await submitCollaborationContinuation({ requestId: 'next', message: 'Continue' }, deps),
  ).toBe('unknown');
  expect(deps.submit).toHaveBeenCalledTimes(1);
});

it('rejects slash execution before reading attachments or starting a member turn', async () => {
  const deps = context();
  expect(
    await submitCollaborationContinuation({ requestId: 'next', message: ' /goal create' }, deps),
  ).toBe('rejected');
  expect(deps.submit).not.toHaveBeenCalled();
  expect(deps.stageAudio).not.toHaveBeenCalled();
  expect(deps.beforeSubmit).not.toHaveBeenCalled();
});

it('does not submit after a source switch during attachment staging', async () => {
  const deps = context();
  let changed = false;
  deps.assertCurrent = vi.fn(() => {
    if (changed) throw new Error('changed');
  });
  deps.stageAudio.mockImplementation(async () => {
    changed = true;
    return { success: true, path: 'E:/project/audio.wav' };
  });
  await expect(
    submitCollaborationContinuation(
      { requestId: 'next', message: 'Continue', attachmentPaths: ['E:/picked.wav'] },
      deps,
    ),
  ).rejects.toThrow('changed');
  expect(deps.submit).not.toHaveBeenCalled();
});

it('revalidates admission after a slow attachment and preserves rejection without a member send', async () => {
  const deps = context();
  let finishImage!: () => void;
  deps.readImage.mockImplementation(async () => {
    await new Promise<void>(resolve => {
      finishImage = resolve;
    });
    return { success: true, dataUrl: 'data:image/png;base64,eA==' };
  });
  deps.beforeSubmit.mockRejectedValue(new Error('collaborationInvalidRecipient'));
  const submitted = submitCollaborationContinuation(
    { requestId: 'next', message: 'Continue', attachmentPaths: ['E:/diagram.png'] },
    deps,
  );
  await vi.waitFor(() => expect(finishImage).toBeDefined());
  expect(deps.beforeSubmit).not.toHaveBeenCalled();
  expect(deps.submit).not.toHaveBeenCalled();
  finishImage();
  await expect(submitted).rejects.toThrow('collaborationInvalidRecipient');
  expect(deps.beforeSubmit).toHaveBeenCalledOnce();
  expect(deps.submit).not.toHaveBeenCalled();
});

it('closes a source switch during the final admission recheck before invoking the sender', async () => {
  const deps = context();
  let changed = false;
  deps.assertCurrent.mockImplementation(() => {
    if (changed) throw new Error('changed');
  });
  deps.beforeSubmit.mockImplementation(async () => {
    changed = true;
  });
  await expect(
    submitCollaborationContinuation({ requestId: 'next', message: 'Continue' }, deps),
  ).rejects.toThrow('changed');
  expect(deps.beforeSubmit).toHaveBeenCalledOnce();
  expect(deps.submit).not.toHaveBeenCalled();
});

it('rejects an image for a text-only member before sending', async () => {
  const deps = context();
  deps.supportsImages = () => false;
  await expect(
    submitCollaborationContinuation(
      { requestId: 'next', message: 'Continue', attachmentPaths: ['E:/diagram.png'] },
      deps,
    ),
  ).rejects.toThrow('imageInputNotSupported');
  expect(deps.readImage).not.toHaveBeenCalled();
  expect(deps.submit).not.toHaveBeenCalled();
});
