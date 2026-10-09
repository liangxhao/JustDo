// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { CoworkInteractionRequest } from '@/features/cowork/coworkTypes';

import PlanApprovalDrawer from './PlanApprovalDrawer';

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => key,
    getLanguage: () => 'en',
  },
}));

const interaction: CoworkInteractionRequest = {
  sessionId: 'session-1',
  requestId: 'plan-1',
  toolName: 'PresentPlan',
  interactionKind: 'plan-approval',
  toolInput: {
    title: 'Ship the feature',
    plan: '# Steps\n\n1. Inspect\n2. Implement',
  },
};

describe('PlanApprovalDrawer', () => {
  afterEach(cleanup);

  test('renders a non-modal plan preview without file actions', () => {
    render(<PlanApprovalDrawer interaction={interaction} onRespond={vi.fn()} />);

    expect(screen.getByRole('complementary', { name: 'Ship the feature' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Steps' })).toBeTruthy();
    expect(screen.queryByText('coworkFilePreviewModeEdit')).toBeNull();
    expect(screen.queryByText('save')).toBeNull();
  });

  test('submits revision feedback and prevents an empty revision', async () => {
    const onRespond = vi.fn().mockResolvedValue(true);
    render(<PlanApprovalDrawer interaction={interaction} onRespond={onRespond} />);

    fireEvent.click(screen.getByRole('button', { name: 'planRequestRevision' }));
    const submit = screen.getByRole('button', { name: 'planSubmitRevision' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByRole('textbox', { name: 'planRequestRevision' }), {
      target: { value: 'Add a rollback step' },
    });
    fireEvent.click(submit);

    await waitFor(() =>
      expect(onRespond).toHaveBeenCalledWith({
        behavior: 'plan',
        decision: 'revise',
        feedback: 'Add a rollback step',
      }),
    );
  });

  test('keeps explicit cancel and implement decisions separate', () => {
    const onRespond = vi.fn().mockResolvedValue(true);
    render(<PlanApprovalDrawer interaction={interaction} onRespond={onRespond} />);

    fireEvent.click(screen.getByRole('button', { name: 'planCancel' }));
    expect(onRespond).toHaveBeenCalledWith({ behavior: 'plan', decision: 'cancel' });
  });

  test('renders an implemented plan as a closable read-only preview', () => {
    const onRespond = vi.fn();
    const onClose = vi.fn();
    render(
      <PlanApprovalDrawer
        interaction={interaction}
        onRespond={onRespond}
        readOnly
        onClose={onClose}
      />,
    );

    expect(screen.getByText('planReviewReadOnlyDescription')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'planImplement' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'planRequestRevision' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'planCancel' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onRespond).not.toHaveBeenCalled();
  });
});
