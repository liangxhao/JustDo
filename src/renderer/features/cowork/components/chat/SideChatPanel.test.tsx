// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { forwardRef, useImperativeHandle } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import SideChatPanel from './SideChatPanel';

vi.mock('@/features/cowork/components/composer/CoworkPromptInput', () => ({
  default: forwardRef<
    { focus: () => void },
    {
      disabled?: boolean;
      draftKeyOverride?: string;
      mode?: string;
      onSubmit: (value: string) => unknown;
      placeholder?: string;
      showModelSelector?: boolean;
      workingDirectory?: string;
    }
  >(({
    disabled, draftKeyOverride, mode, onSubmit, placeholder, showModelSelector, workingDirectory,
  }, ref) => {
    useImperativeHandle(ref, () => ({ focus: vi.fn() }));
    return (
      <button
        type="button"
        disabled={disabled}
        data-draft-key={draftKeyOverride}
        data-mode={mode}
        data-model-selector={showModelSelector}
        data-workspace={workingDirectory}
        onClick={() => onSubmit('side question')}
      >
        {placeholder}
      </button>
    );
  }),
}));

vi.mock('@/features/cowork/components/chat/ChatMessageDisplay', () => ({
  default: ({
    activeTurn,
    gatewayMessages,
    isStreaming,
    runTimings,
  }: {
    activeTurn?: { items?: Array<{ type: string }> } | null;
    gatewayMessages: Array<{ content?: string; modelName?: string; role: string }>;
    isStreaming?: boolean;
    runTimings?: Array<{
      endedAt?: number;
      modelRef?: string;
      startedAt: number;
      state: string;
    }>;
  }) => (
    <div
      data-testid="shared-chat"
      data-streaming={isStreaming}
      data-active-items={activeTurn?.items?.map(item => item.type).join(',') ?? ''}
      data-run-timings={JSON.stringify(runTimings ?? [])}
    >
      {gatewayMessages.map((message, index) => (
        <div key={index} data-role={message.role} data-model-name={message.modelName}>
          {message.content}
        </div>
      ))}
    </div>
  ),
}));

afterEach(cleanup);

describe('SideChatPanel', () => {
  it('shows the temporary-chat explanation and submits through the reused composer', () => {
    i18nService.setLanguage('en', { persist: false });
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(
      <SideChatPanel
        draftKey="side-chat:one"
        workingDirectory="C:/workspace/audio"
        messages={[]}
        onSubmit={onSubmit}
        sessionId="session-1"
      />,
    );

    expect(screen.getByRole('heading', { name: 'Side chat' })).toBeTruthy();
    expect(
      screen.getByText('Side chat is temporary. It disappears when you close the app.'),
    ).toBeTruthy();
    const composer = screen.getByRole('button', { name: 'Ask anything' });
    expect(composer.getAttribute('data-mode')).toBe('side-chat');
    expect(composer.getAttribute('data-workspace')).toBe('C:/workspace/audio');
    expect(composer.getAttribute('data-draft-key')).toBe('side-chat:one');
    expect(composer.getAttribute('data-model-selector')).toBe('true');
    fireEvent.click(composer);
    expect(onSubmit).toHaveBeenCalledWith('side question');
  });

  it('renders pending and completed side answers without a main transcript', () => {
    i18nService.setLanguage('en', { persist: false });
    render(
      <SideChatPanel
        draftKey="side-chat:two"
        messages={[
          { runId: 'pending', question: 'First?', askedAt: 1, status: 'pending' },
          {
            runId: 'done',
            question: 'Second?',
            answer: '**Only the sidebar.**',
            askedAt: 2_000,
            answeredAt: 3_000,
            modelRef: 'openai/gpt-5.6',
            status: 'complete',
          },
        ]}
        onSubmit={vi.fn()}
        sessionId="session-1"
      />,
    );

    expect(screen.getByText('First?')).toBeTruthy();
    expect(screen.getByText('Second?')).toBeTruthy();
    expect(screen.getByTestId('shared-chat')).toBeTruthy();
    expect(screen.getByTestId('shared-chat').getAttribute('data-streaming')).toBe('true');
    expect(screen.getByText('**Only the sidebar.**')).toBeTruthy();
    expect(screen.getByText('**Only the sidebar.**').getAttribute('data-model-name')).toBe(
      'openai/gpt-5.6',
    );
    expect(JSON.parse(screen.getByTestId('shared-chat').getAttribute('data-run-timings') ?? '[]'))
      .toEqual([
        expect.objectContaining({
          modelRef: 'openai/gpt-5.6',
          startedAt: 2_000,
          endedAt: 3_000,
          executionTiming: { startedAt: 2_000, endedAt: 3_000 },
          state: 'completed',
        }),
      ]);
    expect(screen.getByRole('button', { name: 'Ask anything' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('passes the pending side transcript to the shared chat renderer', () => {
    i18nService.setLanguage('en', { persist: false });
    render(
      <SideChatPanel
        draftKey="side-chat:streaming"
        messages={[
          {
            runId: 'streaming',
            question: 'What is happening?',
            askedAt: 1,
            status: 'pending',
            activeTurn: {
              id: 'turn-1',
              runId: 'streaming',
              sessionId: null,
              lifecycleGeneration: null,
              sessionKey: 'agent:main:justdo:session-1',
              status: 'running',
              lastAgentSeq: 2,
              startedAt: 1,
              items: [
                {
                  id: 'thinking-1',
                  runId: 'streaming',
                  firstSeq: 2,
                  lastSeq: 2,
                  startedAt: 2,
                  updatedAt: 2,
                  type: 'thinking',
                  status: 'running',
                  text: 'Checking context.',
                },
              ],
              toolById: new Map(),
            },
          },
        ]}
        onSubmit={vi.fn()}
        sessionId="session-1"
      />,
    );

    expect(screen.getByTestId('shared-chat').getAttribute('data-active-items')).toBe('thinking');
  });
});
