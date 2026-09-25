// @vitest-environment jsdom

import type { WorkboardCard } from '@shared/openclaw/workboard';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import WorkboardCardModal from './WorkboardCardModal';

const linkedCard: WorkboardCard = {
  id: 'card-1',
  title: 'Review result',
  status: 'review',
  priority: 'normal',
  labels: [],
  agentId: 'main',
  sessionKey: 'agent:main:subagent:workboard-default-card-1',
  position: 1,
  createdAt: 1,
  updatedAt: 2,
};

afterEach(cleanup);

describe('WorkboardCardModal', () => {
  it('lets an operator explicitly clear a linked execution session', async () => {
    i18nService.setLanguage('zh', { persist: false });
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<WorkboardCardModal card={linkedCard} agents={[]} onClose={vi.fn()} onSave={onSave} />);

    fireEvent.click(screen.getByText('更多设置'));
    screen.getByText('更多设置').closest('details')!.open = true;
    fireEvent.click(screen.getByRole('button', { name: '解除关联' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'review',
          sessionKey: '',
        }),
      ),
    );
  });
});

it.each(['triage', 'scheduled', 'review', 'blocked'] as const)(
  'preserves native %s state when editing task text',
  async status => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <WorkboardCardModal
        card={{ ...linkedCard, status }}
        agents={[]}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );
    expect(screen.queryByRole('combobox', { name: i18nService.t('workboardStatus') })).toBeNull();
    expect(screen.getByText(i18nService.t('workboardMoreSettings')).closest('details')!.open).toBe(
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('save') }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ status, sessionKey: linkedCard.sessionKey }),
      ),
    );
  },
);
