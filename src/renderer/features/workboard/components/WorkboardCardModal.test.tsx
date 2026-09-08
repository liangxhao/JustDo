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
