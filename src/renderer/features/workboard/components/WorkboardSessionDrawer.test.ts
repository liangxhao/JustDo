// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import WorkboardSessionDrawer, { clampWorkboardSessionDrawerWidth } from './WorkboardSessionDrawer';

vi.mock('@/features/cowork/components/chat/ChatMessageDisplay', () => ({
  default: () => null,
}));

vi.mock('@/features/cowork/components/chat/JustDoChatWrapper', () => ({
  connectToGateway: vi.fn(async () => false),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Workboard session drawer sizing', () => {
  it('keeps the drawer readable without covering the full available width', () => {
    expect(clampWorkboardSessionDrawerWidth(200, 1200)).toBe(360);
    expect(clampWorkboardSessionDrawerWidth(700, 1200)).toBe(700);
    expect(clampWorkboardSessionDrawerWidth(1400, 1200)).toBe(1176);
  });

  it('adapts its lower bound to very narrow windows', () => {
    expect(clampWorkboardSessionDrawerWidth(700, 320)).toBe(296);
  });

  it('offers stop for a live card session and invokes the shared stop action', async () => {
    i18nService.setLanguage('zh', { persist: false });
    const onStop = vi.fn().mockResolvedValue(undefined);

    render(
      createElement(WorkboardSessionDrawer, {
        sessionKey: 'agent:main:subagent:workboard-default-card-1',
        cardTitle: '检查流式会话',
        canStop: true,
        busy: false,
        onStop,
        onClose: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: '停止执行' }));

    await waitFor(() => expect(onStop).toHaveBeenCalledOnce());
  });

  it('hides stop after the card execution is no longer live', () => {
    i18nService.setLanguage('zh', { persist: false });

    render(
      createElement(WorkboardSessionDrawer, {
        sessionKey: 'agent:main:subagent:workboard-default-card-1',
        cardTitle: '检查流式会话',
        canStop: false,
        busy: false,
        onStop: vi.fn().mockResolvedValue(undefined),
        onClose: vi.fn(),
      }),
    );

    expect(screen.queryByRole('button', { name: '停止执行' })).toBeNull();
  });
});
