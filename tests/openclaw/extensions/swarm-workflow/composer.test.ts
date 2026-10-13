import { expect, it, vi } from 'vitest';

import { prepareWorkflowComposerSubmission } from '../../../../openclaw-extensions/swarm-workflow/browser/composer';

function fixture() {
  return {
    options: { mode: 'auto' as const, verify: true },
    sessionId: 'chat',
    prompt: 'Review this project',
    planModeEnabled: false,
    isSelectionCurrent: vi.fn(() => true),
    isDraftCurrent: vi.fn(() => true),
    prepare: vi
      .fn()
      .mockResolvedValue({ success: true, instruction: '<swarm-workflow mode="auto"/>' }),
  };
}

it('does not prepare a retired selection, planning turn or slash command', async () => {
  for (const state of [
    { isSelectionCurrent: () => false },
    { planModeEnabled: true },
    { prompt: ' /help' },
  ]) {
    const f = { ...fixture(), ...state };
    expect((await prepareWorkflowComposerSubmission(f)).success).toBe(false);
    expect(f.prepare).not.toHaveBeenCalled();
  }
});

it('prepares the exact product session but retires the result after draft or selection changes', async () => {
  const f = fixture();
  expect(await prepareWorkflowComposerSubmission(f)).toEqual({
    success: true,
    instruction: '<swarm-workflow mode="auto"/>',
  });
  expect(f.prepare).toHaveBeenCalledWith(f.options, 'chat');
  f.isDraftCurrent.mockReturnValue(false);
  expect(await prepareWorkflowComposerSubmission(f)).toEqual({ success: false });
  f.isDraftCurrent.mockReturnValue(true);
  f.isSelectionCurrent.mockReturnValueOnce(true).mockReturnValueOnce(false);
  expect(await prepareWorkflowComposerSubmission(f)).toEqual({ success: false });
});

it('reports unavailable preparation without retrying or sending a source turn', async () => {
  const f = fixture();
  f.prepare.mockRejectedValue(new Error('offline'));
  expect(await prepareWorkflowComposerSubmission(f)).toEqual({
    success: false,
    messageKey: 'swarmWorkflowPrepareUnavailable',
  });
  expect(f.prepare).toHaveBeenCalledTimes(1);
});

it.each([
  ['disabled', 'swarmWorkflowDisabled'],
  ['plan', 'swarmWorkflowPlan'],
  ['invalid', 'swarmWorkflowInvalid'],
  ['unavailable', 'swarmWorkflowPrepareUnavailable'],
])('projects the %s rejection using the plugin message key', async (reason, messageKey) => {
  const f = fixture();
  f.prepare.mockResolvedValue({ success: false, reason });
  expect(await prepareWorkflowComposerSubmission(f)).toEqual({ success: false, messageKey });
});
