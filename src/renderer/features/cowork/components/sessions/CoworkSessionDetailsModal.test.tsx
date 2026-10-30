// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { coworkService } from '@/features/cowork/coworkService';
import type { AppView } from '@/features/plugins/app/browserRegistry';
import { i18nService } from '@/services/i18n';

import CoworkSessionDetailsModal from './CoworkSessionDetailsModal';

const team = vi.hoisted(() => ({ views: [] as AppView[], revision: 0 }));
vi.mock('@/features/plugins/app/AppPluginSlot', () => ({
  useAppViews: () => team.views,
  AppPluginSlot: ({
    contributionId,
    context,
  }: {
    contributionId?: string;
    context: import('../../../../../../plugins/sdk/app-plugin-sdk/browser').AppViewContext;
  }) => {
    const view = team.views.find(item => item.id === contributionId);
    return view ? <view.component {...context} /> : null;
  },
}));
vi.mock('@/features/plugins/app/runtime', () => ({
  appBrowserRegistry: {
    subscribe: () => () => undefined,
    getViews: () => team.views,
    getContextRevision: () => team.revision,
  },
}));
beforeEach(() => {
  team.views = [];
  team.revision = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.getElementById('details-return-focus')?.remove();
});

describe('CoworkSessionDetailsModal', () => {
  it('withdraws plugin detail contributions while retaining ordinary source details', async () => {
    vi.spyOn(coworkService, 'getSessionDetails').mockResolvedValue({
      session: {
        id: 'source',
        title: 'Source task',
        status: 'completed',
        pinned: false,
        executionMode: 'local',
        permissionMode: 'full',
        activeSkillIds: [],
        cwd: '',
        agentId: 'main',
        createdAt: 1,
        updatedAt: 2,
      },
      gatewaySessionId: 'native-source',
      stats: {
        summary: '',
        messageCount: 0,
        userMessageCount: 0,
        assistantMessageCount: 0,
        toolCallCount: 0,
        models: [],
        tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        totalTokens: 0,
        hasTokenUsage: false,
      },
    });
    const props = {
      sessionSummary: {
        id: 'source',
        title: 'Source task',
        status: 'completed' as const,
        pinned: false,
        createdAt: 1,
        updatedAt: 2,
      },
      groups: [],
      isRuntimeRunning: false,
      onClose: vi.fn(),
    };
    const view = render(<CoworkSessionDetailsModal {...props} />);
    expect(screen.queryByRole('button', { name: 'Plugin details' })).toBeNull();
    await screen.findByText('native-source');
    team.views = [
      {
        id: 'details',
        pluginId: 'example',
        epoch: 'first',
        slot: 'session.details',
        labelKey: 'details',
        component: () => <button>Plugin details</button>,
      },
    ];
    view.rerender(<CoworkSessionDetailsModal {...props} />);
    expect(screen.getByRole('button', { name: 'Plugin details' })).toBeTruthy();
    team.views = [];
    team.revision++;
    view.rerender(<CoworkSessionDetailsModal {...props} />);
    expect(screen.queryByRole('button', { name: 'Plugin details' })).toBeNull();
    expect(screen.queryByRole('button', { name: i18nService.t('back') })).toBeNull();
    expect(screen.getByRole('button', { name: i18nService.t('close') })).toBeTruthy();
  });

  it('replaces anchor statistics, inspects authoritative member details, and withdraws with its owner', async () => {
    i18nService.setLanguage('en', { persist: false });
    const nativeDetails = (id: string) => ({
      session: {
        id,
        title: id === 'member' ? 'Authoritative member' : 'Anchor',
        status: 'completed' as const,
        pinned: false,
        executionMode: 'local' as const,
        permissionMode: 'full' as const,
        activeSkillIds: [],
        cwd: '',
        agentId: 'main',
        createdAt: 1,
        updatedAt: 2,
      },
      gatewaySessionId: `native-${id}`,
      stats: {
        summary: `Statistics for ${id}`,
        messageCount: 7,
        userMessageCount: 2,
        assistantMessageCount: 5,
        toolCallCount: 3,
        models: [],
        tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        totalTokens: 0,
        hasTokenUsage: false,
      },
    });
    vi.spyOn(coworkService, 'getSessionDetails').mockImplementation(async id => nativeDetails(id));
    const loadSession = vi.spyOn(coworkService, 'loadSession');
    const detailsView: AppView = {
      id: 'details',
      pluginId: 'example',
      epoch: 'first',
      slot: 'session.details',
      labelKey: 'details',
      detailsPresentation: id => (id === 'anchor' ? 'replace' : 'hidden'),
      component: ({ onInspectSession }) => (
        <button
          onClick={() =>
            onInspectSession?.({
              id: 'member',
              title: 'Untrusted plugin title',
              status: 'error',
              pinned: false,
              createdAt: 0,
              updatedAt: 0,
            })
          }
        >
          Inspect member
        </button>
      ),
    };
    team.views = [detailsView];
    const props = {
      sessionSummary: nativeDetails('anchor').session,
      groups: [],
      isRuntimeRunning: false,
      onClose: vi.fn(),
    };
    const returnFocus = document.createElement('button');
    returnFocus.id = 'details-return-focus';
    document.body.append(returnFocus);
    returnFocus.focus();
    const view = render(<CoworkSessionDetailsModal {...props} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText('native-anchor')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect member' }));
    expect(await screen.findByText('native-member')).toBeTruthy();
    expect(screen.getByText('Authoritative member')).toBeTruthy();
    expect(screen.queryByText('Untrusted plugin title')).toBeNull();
    expect(screen.getByText('Statistics for member')).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: i18nService.t('close') }),
      ),
    );
    expect(loadSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('back') }));
    expect(screen.getByRole('button', { name: 'Inspect member' })).toBeTruthy();
    expect(screen.queryByText('native-member')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Inspect member' }));
    await screen.findByText('native-member');
    team.views = [];
    team.revision++;
    view.rerender(<CoworkSessionDetailsModal {...props} />);
    expect(await screen.findByText('native-anchor')).toBeTruthy();
    expect(screen.queryByRole('button', { name: i18nService.t('back') })).toBeNull();
    team.views = [{ ...detailsView, epoch: 'second' }];
    view.rerender(<CoworkSessionDetailsModal {...props} />);
    expect(screen.getByRole('button', { name: 'Inspect member' })).toBeTruthy();
    expect(screen.queryByText('native-member')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect member' }));
    await screen.findByText('native-member');
    view.unmount();
    await waitFor(() => expect(document.activeElement).toBe(returnFocus));
  });
  it('keeps returning to the assistant list separate from closing details', () => {
    vi.spyOn(coworkService, 'getSessionDetails').mockReturnValue(new Promise(() => undefined));
    const onBack = vi.fn();
    const onClose = vi.fn();
    render(
      <CoworkSessionDetailsModal
        sessionSummary={{
          id: 'peer',
          title: 'Reviewer',
          status: 'completed',
          pinned: false,
          createdAt: 1,
          updatedAt: 2,
        }}
        groups={[]}
        isRuntimeRunning={false}
        onBack={onBack}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('back') }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('close') }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows a waiting animation while details are loading', () => {
    i18nService.setLanguage('zh', { persist: false });
    vi.spyOn(coworkService, 'getSessionDetails').mockReturnValue(new Promise(() => undefined));

    render(
      <CoworkSessionDetailsModal
        sessionSummary={{
          id: 'local-session-id',
          title: 'Session title',
          status: 'completed',
          pinned: false,
          createdAt: 1_000,
          updatedAt: 2_000,
        }}
        groups={[]}
        isRuntimeRunning={false}
        onClose={vi.fn()}
      />,
    );

    const loadingStatus = screen.getByRole('status');
    expect(loadingStatus.textContent).toContain('查询中...');
    expect(loadingStatus.querySelector('.querying-spinner')).toBeTruthy();
  });

  it('renders authoritative details and copies the Gateway Session ID', async () => {
    i18nService.setLanguage('zh', { persist: false });
    vi.spyOn(coworkService, 'getSessionDetails').mockResolvedValue({
      session: {
        id: 'local-session-id',
        title: 'Session title',
        status: 'completed',
        pinned: false,
        cwd: 'E:\\workspace',
        executionMode: 'local',
        permissionMode: 'full',
        activeSkillIds: [],
        agentId: 'main',
        createdAt: 1_000,
        updatedAt: 2_000,
      },
      gatewaySessionId: 'gateway-session-id',
      stats: {
        summary: 'First prompt',
        messageCount: 7,
        userMessageCount: 2,
        assistantMessageCount: 5,
        toolCallCount: 3,
        models: ['openai/gpt-5'],
        tokenUsage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 4 },
        totalTokens: 154,
        hasTokenUsage: true,
      },
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(
      <CoworkSessionDetailsModal
        sessionSummary={{
          id: 'local-session-id',
          title: 'Session title',
          status: 'completed',
          pinned: false,
          createdAt: 1_000,
          updatedAt: 2_000,
        }}
        groups={[]}
        isRuntimeRunning={false}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText('gateway-session-id')).toBeTruthy();
    expect(screen.queryByText('local-session-id')).toBeNull();
    expect(screen.getByText('Session ID')).toBeTruthy();
    expect(screen.getByText('openai/gpt-5')).toBeTruthy();
    expect(screen.getByText('总 Token')).toBeTruthy();
    const aggregateTokensButton = screen.getByRole('button', { name: '汇总 Token' });
    expect(aggregateTokensButton).toBeTruthy();
    expect(aggregateTokensButton.getAttribute('title')).toBe(
      '统计主会话与所有 Subagent 当前 Session 实例的 Token 总量',
    );
    expect(screen.getByText('154')).toBeTruthy();
    expect(screen.getByText('100')).toBeTruthy();
    const tokenScopeNote = screen.getByText(
      '统计当前 Session 实例的普通对话，不含压缩与审批 Review；总量可能不等于分项之和。',
    );
    expect(tokenScopeNote.className).toContain('text-right');
    expect(tokenScopeNote.className).toContain('text-[10px]');

    fireEvent.click(screen.getByRole('button', { name: '复制 Session ID' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('gateway-session-id'));
  });

  it('schedules an active refresh only after the previous request settles', async () => {
    i18nService.setLanguage('en', { persist: false });
    vi.useFakeTimers();
    let resolveDetails:
      ((value: Awaited<ReturnType<typeof coworkService.getSessionDetails>>) => void) | undefined;
    const pendingDetails = new Promise<Awaited<ReturnType<typeof coworkService.getSessionDetails>>>(
      resolve => {
        resolveDetails = resolve;
      },
    );
    const details = {
      session: {
        id: 'local-session-id',
        title: 'Session title',
        status: 'running' as const,
        pinned: false,
        cwd: 'E:\\workspace',
        executionMode: 'local' as const,
        permissionMode: 'full' as const,
        activeSkillIds: [],
        agentId: 'main',
        createdAt: 1_000,
        updatedAt: 2_000,
      },
      stats: {
        summary: null,
        messageCount: 0,
        userMessageCount: 0,
        assistantMessageCount: 0,
        toolCallCount: 0,
        models: [],
        tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        totalTokens: 0,
        hasTokenUsage: false,
      },
    };
    const getSessionDetails = vi
      .spyOn(coworkService, 'getSessionDetails')
      .mockReturnValueOnce(pendingDetails)
      .mockResolvedValue(details);

    render(
      <CoworkSessionDetailsModal
        sessionSummary={{
          id: 'local-session-id',
          title: 'Session title',
          status: 'running',
          pinned: false,
          createdAt: 1_000,
          updatedAt: 2_000,
        }}
        groups={[]}
        isRuntimeRunning
        onClose={vi.fn()}
      />,
    );

    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    });
    expect(getSessionDetails).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(getSessionDetails).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDetails?.(details);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
    });
    expect(getSessionDetails).toHaveBeenCalledTimes(2);
  });
});
