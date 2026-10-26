// @vitest-environment jsdom
import { teamDiscussionSessionKey } from '@shared/cowork/agent-team/teamDiscussion';
import { CoworkInteractionKind } from '@shared/cowork/interactions/interactions';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { coworkService } from '@/features/cowork/coworkService';
import { OwnerDocumentContext } from '@/shared/dom/ownerDocument';
import { store } from '@/store';

import {
  deleteDiscussionDraft,
  getDiscussionDraft,
  settleDiscussionDraft,
  updateDiscussionDraft,
} from './teamDiscussionDraft';
import TeamDiscussionView from './TeamDiscussionView';

const pending = vi.hoisted(() => ({ requests: [] as Record<string, unknown>[] }));
const speech = vi.hoisted(() => ({ callbacks: [] as Array<(text: string) => void> }));

vi.mock('../collaboration/CollaborationMemberHistory', () => ({
  default: ({
    name,
    member,
    backAction,
    headerAction,
    headerMenu,
  }: {
    name: string;
    member: { sessionKey: string };
    backAction?: { label: string; onClick: () => void };
    headerAction?: ReactNode;
    headerMenu?: ReactNode;
  }) => (
    <div>
      <header>
        {backAction && <button aria-label={backAction.label} onClick={backAction.onClick} />}
        {headerAction}
        {headerMenu}
      </header>
      <div data-session-key={member.sessionKey}>Internal history: {name}</div>
    </div>
  ),
}));
vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
vi.mock('@/services/config', () => ({
  configService: { getConfig: () => ({ shortcuts: { sendMessage: 'Enter' } }) },
}));
vi.mock('../composer/speech/LocalSpeechInputButton', () => ({
  LocalSpeechInputButton: ({
    disabled,
    onTranscript,
  }: {
    disabled: boolean;
    onTranscript: (text: string) => void;
  }) => {
    speech.callbacks.push(onTranscript);
    return (
      <button
        aria-label="speech-input"
        disabled={disabled}
        onClick={() => onTranscript('Voice draft')}
      >
        Mic
      </button>
    );
  },
}));
vi.mock('@/store', () => ({ store: { dispatch: vi.fn() } }));
vi.mock('@/features/cowork/coworkService', () => ({ coworkService: { loadSession: vi.fn() } }));
vi.mock('react-redux', () => ({
  useSelector: (select: (state: unknown) => unknown) =>
    select({
      cowork: {
        sessions: [{ id: 'source', agentId: 'alice' }],
        pendingInteractions: pending.requests,
      },
      agent: {
        agents: [
          { id: 'alice', name: 'Alice', enabled: true },
          { id: 'bob', name: 'Bob', enabled: true },
        ],
      },
    }),
}));
vi.mock('../preview/PreviewMarkdown', () => ({
  default: ({ html }: { html: string }) => <div>{html}</div>,
}));
vi.mock('@/libs/openclaw-chat/components/markdown/markdown', () => ({
  toSanitizedMarkdownHtml: (text: string) => text,
}));
const room = {
  id: 'room',
  title: 'Existing discussion',
  members: [
    { agentId: 'alice', name: 'Alice' },
    { agentId: 'bob', name: 'Bob' },
  ],
  rounds: 2,
  revision: 1,
  state: 'ready',
  cwd: '/project',
  permissionMode: 'ask',
};
const create = vi.fn();
const send = vi.fn();
const enqueue = vi.fn();
const cancelPending = vi.fn();
const read = vi.fn();
const stop = vi.fn();
async function openSummaryAction() {
  fireEvent.click(await screen.findByRole('button', { name: 'teamMore' }));
  return screen.findByRole('menuitem', { name: 'teamSummarizeInSource' });
}
beforeEach(() => {
  pending.requests = [];
  speech.callbacks = [];
  deleteDiscussionDraft('room');
  create.mockReset().mockResolvedValue({ success: true, value: room });
  send.mockReset().mockImplementation(async input => ({
    success: true,
    value: {
      ...room,
      state: 'running',
      activeDiscussionId: 'discussion',
      latestRun: { discussionId: 'discussion', requestId: input.requestId, state: 'running' },
    },
  }));
  enqueue.mockReset();
  cancelPending.mockReset();
  stop.mockReset().mockResolvedValue({ success: true, value: room });
  read
    .mockReset()
    .mockResolvedValue({ success: true, value: { room, messages: [], historyUnavailable: false } });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      teamDiscussion: { create, send, read, enqueue, cancelPending, stop },
      extensions: {
        list: vi
          .fn()
          .mockResolvedValue({ success: true, extensions: [{ id: 'agent-team', enabled: true }] }),
        onChanged: () => () => {},
      },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.querySelectorAll('iframe').forEach(frame => frame.remove());
});

it('preserves the scroll position on unchanged polls and follows new replies only near the bottom', async () => {
  vi.useFakeTimers();
  try {
    const messages = [
      {
        id: 'first',
        discussionId: 'batch',
        role: 'user',
        text: 'First message',
        sequence: 1,
        timestamp: 1,
        mediaUrls: [],
      },
    ];
    read.mockImplementation(async () => ({
      success: true,
      value: { room, messages: structuredClone(messages), historyUnavailable: false },
    }));
    await act(async () => {
      render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
    });
    const scroll = vi.mocked(HTMLElement.prototype.scrollTo);
    scroll.mockClear();
    const reads = read.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1501);
    });
    expect(read.mock.calls.length).toBeGreaterThan(reads);
    expect(scroll).not.toHaveBeenCalled();
    messages.push({ ...messages[0], id: 'second', sequence: 2, text: 'New message' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1501);
    });
    expect(scroll).toHaveBeenCalledOnce();
    scroll.mockClear();
    const timeline = screen.getByText('First message').closest('[data-discussion-message]')!
      .parentElement!.parentElement!;
    Object.defineProperties(timeline, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
    });
    timeline.scrollTop = 10;
    fireEvent.scroll(timeline);
    messages.push({ ...messages[0], id: 'third', sequence: 3, text: 'Later message' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1501);
    });
    expect(screen.getByText('Later message')).toBeTruthy();
    expect(scroll).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it('focuses voice insertion in the detached group and sends through the original IPC owner', async () => {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const ownerDocument = frame.contentDocument!;
  const ownerWindow = frame.contentWindow! as Window & typeof globalThis;
  const container = ownerDocument.createElement('div');
  ownerDocument.body.append(container);
  Object.defineProperty(ownerWindow.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: vi.fn(),
  });
  let focusFrame!: FrameRequestCallback;
  const raf = vi.fn((callback: FrameRequestCallback) => {
    focusFrame = callback;
    return 1;
  });
  Object.defineProperty(ownerWindow, 'requestAnimationFrame', { configurable: true, value: raf });
  updateDiscussionDraft('room', { text: 'Draft', selected: ['bob'] });
  render(
    <OwnerDocumentContext.Provider value={ownerDocument}>
      <TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />
    </OwnerDocumentContext.Provider>,
    { container },
  );
  const host = within(ownerDocument.body);
  await host.findByRole('heading', { name: room.title });
  const input = host.getByRole('textbox') as HTMLTextAreaElement;
  input.setSelectionRange(5, 5);
  fireEvent.click(host.getByRole('button', { name: 'speech-input' }));
  expect(raf).toHaveBeenCalledOnce();
  act(() => focusFrame(0));
  expect(ownerDocument.activeElement).toBe(input);
  expect(input.value).toBe('Draft Voice draft');
  expect(input.selectionStart).toBe(17);
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(host.getByRole('button', { name: 'teamSend' }));
  await waitFor(() =>
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Draft Voice draft', selectedAgentIds: ['bob'] }),
    ),
  );
  expect(ownerWindow.electron).toBeUndefined();
});

it.each(['unknown', 'stopping'] as const)(
  'keeps an editable draft but does not send while its source summary is %s',
  async state => {
    read.mockResolvedValue({
      success: true,
      value: { room, messages: [], summary: { discussionId: 'old', state } },
    });
    updateDiscussionDraft('room', { text: 'Next topic', selected: ['bob'] });
    render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
    const input = await screen.findByRole('textbox');
    await screen.findByText('teamSummaryLabel_' + state);
    expect((screen.getByRole('button', { name: 'teamSend' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(input, { target: { value: 'Keep this new topic' } });
    expect(getDiscussionDraft('room').text).toBe('Keep this new topic');
    expect(send).not.toHaveBeenCalled();
  },
);

it.each(['pending', 'running'] as const)(
  'offers explicit queue admission while a confirmed source summary is %s',
  async state => {
    read.mockResolvedValue({
      success: true,
      value: { room, messages: [], summary: { discussionId: 'old', state } },
    });
    updateDiscussionDraft('room', { text: 'Next topic', selected: ['bob'] });
    render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
    await screen.findByText('teamSummaryLabel_' + state);
    expect(
      (screen.getByRole('button', { name: 'teamEnqueue' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(send).not.toHaveBeenCalled();
  },
);

it('inserts speech into the group draft without sending or clearing its recipients', async () => {
  updateDiscussionDraft('room', { text: 'Before after', selected: ['bob'] });
  render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
  const input = (await screen.findByRole('textbox', {
    name: 'teamMessage',
  })) as HTMLTextAreaElement;
  input.setSelectionRange(7, 7);
  fireEvent.click(screen.getByRole('button', { name: 'speech-input' }));
  expect(input.value).toBe('Before Voice draft after');
  expect(getDiscussionDraft('room').selected).toEqual(['bob']);
  expect(send).not.toHaveBeenCalled();
  expect(screen.queryByText('teamOrganizerAutoHelp')).toBeNull();
  expect(screen.queryByText('teamStandaloneHelp')).toBeNull();
});

it('shows a pending native room question and clears attention after it is answered', async () => {
  pending.requests = [
    {
      requestId: 'question',
      sessionId: 'native',
      toolName: 'ask_user_question',
      interactionKind: CoworkInteractionKind.STRUCTURED_QUESTION,
      toolInput: { sessionKey: teamDiscussionSessionKey('room', 'bob') },
    },
  ];
  const { rerender } = render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
  await screen.findByRole('heading', { name: 'Existing discussion' });
  expect(screen.getByText(/teamNeedsResponse:/)).toBeTruthy();
  expect(screen.getByRole('status').closest('header')).toBeTruthy();
  expect(screen.getByRole('status').title).toContain('teamNeedsResponseHelp');
  pending.requests = [];
  rerender(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
  expect(screen.queryByText(/teamNeedsResponse:/)).toBeNull();
});

it.each(['preparing', 'prepare_failed'] as const)(
  'distinguishes room %s from an execution failure and retries only failed preparation',
  async state => {
    read.mockResolvedValue({
      success: true,
      value: { room: { ...room, state }, messages: [], historyUnavailable: false },
    });
    render(<TeamDiscussionView entry={{ roomId: 'room' }} embedded onClose={vi.fn()} />);
    await screen.findByRole('heading', { name: room.title });
    expect(screen.getByRole('status')).toHaveProperty(
      'textContent',
      state === 'preparing' ? 'teamRecordPreparing' : 'teamRecordPrepareFailed',
    );
    expect(screen.queryByText('teamPreparationFailed')).toBeNull();
    expect(screen.getByRole('status').closest('header')).toBeTruthy();
    if (state === 'preparing') {
      expect(screen.queryByRole('button', { name: 'teamRetryPreparation' })).toBeNull();
    } else {
      const retry = screen.getByRole('button', { name: 'teamRetryPreparation' });
      await waitFor(() => expect(retry).toHaveProperty('disabled', false));
      fireEvent.click(retry);
      await waitFor(() => expect(create).toHaveBeenCalledOnce());
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ id: room.id }));
    }
    expect(send).not.toHaveBeenCalled();
  },
);

it.each(['discussion', 'summary', 'queue'] as const)(
  'stops the exact room from a single header control during %s activity',
  async activity => {
    read.mockResolvedValue({
      success: true,
      value: {
        room: {
          ...room,
          ...(activity === 'discussion' ? { state: 'running', activeDiscussionId: 'batch' } : {}),
          ...(activity === 'queue'
            ? {
                pendingInputs: [
                  { requestId: 'queued', state: 'queued', rounds: 1, selectedAgentIds: [] },
                ],
              }
            : {}),
        },
        ...(activity === 'summary' ? { summary: { discussionId: 'batch', state: 'running' } } : {}),
        messages: [],
        historyUnavailable: false,
      },
    });
    render(<TeamDiscussionView entry={{ roomId: 'room' }} embedded onClose={vi.fn()} />);
    const stopping = await screen.findByRole('button', {
      name: activity === 'summary' ? 'teamStopSummary' : 'teamStop',
    });
    expect(stopping.closest('header')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /teamStop/ })).toHaveLength(1);
    fireEvent.click(stopping);
    await waitFor(() => expect(stop).toHaveBeenCalledExactlyOnceWith(room.id));
    expect(send).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  },
);

it('keeps a failed group Stop visible in member history and preserves the group draft', async () => {
  updateDiscussionDraft('room', { text: 'Keep draft', selected: ['bob'] });
  read.mockResolvedValue({
    success: true,
    value: {
      room: {
        ...room,
        state: 'running',
        activeDiscussionId: 'batch',
        members: room.members.map(member => ({ ...member, sessionId: `native-${member.agentId}` })),
      },
      messages: [
        {
          id: 'answer',
          discussionId: 'batch',
          agentId: 'bob',
          role: 'assistant',
          text: 'Bob reply',
          timestamp: 1,
          mediaUrls: [],
        },
      ],
      historyUnavailable: false,
    },
  });
  stop.mockResolvedValue({ success: false, error: 'teamDiscussionUnavailable' });
  render(<TeamDiscussionView entry={{ roomId: 'room' }} embedded onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'teamInspectAgent · Bob' }));
  fireEvent.click(screen.getByRole('button', { name: 'teamStop' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'teamDiscussionUnavailable',
  );
  expect(stop).toHaveBeenCalledExactlyOnceWith(room.id);
  expect(getDiscussionDraft('room')).toMatchObject({ text: 'Keep draft', selected: ['bob'] });
  expect(
    screen.getByRole('button', { name: 'teamBackToDiscussion' }).closest('header'),
  ).toBeTruthy();
});

it('replies to an exact assistant by quoting the message and selecting only that member without sending', async () => {
  const message = {
    id: 'reply-message',
    discussionId: 'batch',
    sequence: 1,
    agentId: 'bob',
    role: 'assistant',
    text: 'A finding to discuss',
    timestamp: 1,
    mediaUrls: [],
  };
  read.mockResolvedValue({
    success: true,
    value: { room, messages: [message], historyUnavailable: false },
  });
  updateDiscussionDraft('room', {
    text: 'Existing draft',
    attachments: ['/project/notes.txt'],
    selected: ['alice'],
  });
  render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
  const reply = await screen.findByRole('button', { name: 'teamReplyToAgent · Bob' });
  fireEvent.click(reply);
  expect(getDiscussionDraft('room')).toMatchObject({
    text: 'Existing draft',
    attachments: ['/project/notes.txt'],
    selected: ['bob'],
    quotes: [{ id: 'reply-message', discussionId: 'batch' }],
  });
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'teamMessage' }));
  fireEvent.click(reply);
  expect(getDiscussionDraft('room').quotes).toHaveLength(1);
  expect(send).not.toHaveBeenCalled();
});

it('does not offer directed replies for a historical source that has left the group', async () => {
  read.mockResolvedValue({
    success: true,
    value: {
      room,
      messages: [
        {
          id: 'old',
          discussionId: 'batch',
          sequence: 1,
          agentId: 'former',
          role: 'assistant',
          text: 'Old reply',
          timestamp: 1,
          mediaUrls: [],
        },
      ],
      historyUnavailable: false,
    },
  });
  render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
  await screen.findByText('Old reply');
  expect(screen.queryByRole('button', { name: /teamReplyToAgent/ })).toBeNull();
});

it('preserves a full quote draft instead of silently losing a reference when replying', async () => {
  read.mockResolvedValue({
    success: true,
    value: {
      room,
      messages: [
        {
          id: 'new',
          discussionId: 'batch',
          sequence: 1,
          agentId: 'bob',
          role: 'assistant',
          text: 'New reply',
          timestamp: 1,
          mediaUrls: [],
        },
      ],
      historyUnavailable: false,
    },
  });
  const quotes = Array.from({ length: 5 }, (_, i) => ({
    id: `existing-${i}`,
    discussionId: 'old',
  }));
  updateDiscussionDraft('room', { quotes, selected: ['alice'] });
  render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
  const reply = await screen.findByRole('button', { name: 'teamReplyToAgent · Bob' });
  expect((reply as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(reply);
  expect(getDiscussionDraft('room')).toMatchObject({ quotes, selected: ['alice'] });
});

it.each(['capacity', 'submitting', 'pending'] as const)(
  'uses the current %s draft boundary even before the reply button has rerendered',
  async boundary => {
    read.mockResolvedValue({
      success: true,
      value: {
        room,
        messages: [
          {
            id: 'reply-message',
            discussionId: 'batch',
            sequence: 1,
            agentId: 'bob',
            role: 'assistant',
            text: 'Reply',
            timestamp: 1,
            mediaUrls: [],
          },
        ],
        historyUnavailable: false,
      },
    });
    updateDiscussionDraft('room', { selected: ['alice'], text: 'Preserved' });
    render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
    const reply = await screen.findByRole('button', { name: 'teamReplyToAgent · Bob' });
    act(() => {
      if (boundary === 'capacity')
        updateDiscussionDraft('room', {
          quotes: Array.from({ length: 5 }, (_, index) => ({
            id: `existing-${index}`,
            discussionId: 'old',
          })),
        });
      if (boundary === 'submitting')
        updateDiscussionDraft('room', { submissionAttemptId: 'in-flight' });
      if (boundary === 'pending')
        updateDiscussionDraft('room', {
          pending: {
            roomId: 'room',
            requestId: 'unknown',
            expectedRevision: 1,
            message: 'Pending',
            selectedAgentIds: [],
            quotes: [],
            attachmentPaths: [],
            rounds: 2,
          },
        });
      fireEvent.click(reply);
    });
    expect(getDiscussionDraft('room')).toMatchObject({ selected: ['alice'], text: 'Preserved' });
    expect(getDiscussionDraft('room').quotes).toHaveLength(boundary === 'capacity' ? 5 : 0);
    expect(send).not.toHaveBeenCalled();
  },
);

it.each(['completed', 'failed'])(
  'prepares an exact %s summary request with a public question without sending it',
  async state => {
    const prepareSource = vi.fn().mockResolvedValue(undefined);
    read.mockResolvedValue({
      success: true,
      value: {
        room: { ...room, sourceSessionId: 'source' },
        messages: [
          {
            id: 'public-input',
            discussionId: 'batch',
            role: 'user',
            text: 'Public question',
            mediaUrls: [],
            sequence: 1,
            timestamp: 1,
          },
        ],
        historyUnavailable: false,
        organizer: { agentId: 'alice', name: 'Alice', sourceSessionId: 'source' },
        latestRun: { discussionId: 'batch', requestId: 'request', state },
        runs: [{ discussionId: 'batch', requestId: 'request', state }],
      },
    });
    render(
      <TeamDiscussionView
        entry={{ roomId: 'room' }}
        onClose={vi.fn()}
        onPrepareSourceDraft={prepareSource}
      />,
    );
    const button = await openSummaryAction();
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() =>
      expect(prepareSource).toHaveBeenCalledWith(
        'source',
        expect.stringContaining('"discussionIds":["batch"]'),
      ),
    );
    expect(read).toHaveBeenCalledWith('room', undefined, ['batch']);
    expect(send).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  },
);

it('does not prepare a summary when the source disappears during the history refresh', async () => {
  const prepareSource = vi.fn();
  read.mockResolvedValue({
    success: true,
    value: {
      room: { ...room, sourceSessionId: 'source' },
      messages: [
        {
          id: 'public-input',
          discussionId: 'batch',
          role: 'user',
          text: 'Public question',
          mediaUrls: [],
          sequence: 1,
          timestamp: 1,
        },
      ],
      historyUnavailable: false,
      organizer: { agentId: 'alice', name: 'Alice', sourceSessionId: 'source' },
      latestRun: { discussionId: 'batch', requestId: 'request', state: 'completed' },
    },
  });
  render(
    <TeamDiscussionView
      entry={{ roomId: 'room' }}
      onClose={vi.fn()}
      onPrepareSourceDraft={prepareSource}
    />,
  );
  const button = await openSummaryAction();
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  read.mockResolvedValue({
    success: true,
    value: { room, messages: [], historyUnavailable: false },
  });
  fireEvent.click(button);
  await screen.findByRole('alert');
  expect(prepareSource).not.toHaveBeenCalled();
});

it('does not render a summary action or empty status row after successful automatic delivery', async () => {
  const prepareSource = vi.fn();
  read.mockResolvedValue({
    success: true,
    value: {
      room: { ...room, sourceSessionId: 'source' },
      messages: [],
      historyUnavailable: false,
      organizer: { agentId: 'alice', name: 'Alice', sourceSessionId: 'source' },
      latestRun: { discussionId: 'batch', requestId: 'request', state: 'completed' },
      summary: { discussionId: 'batch', state: 'delivered' },
    },
  });
  const view = render(
    <TeamDiscussionView
      entry={{ roomId: 'room' }}
      onClose={vi.fn()}
      onPrepareSourceDraft={prepareSource}
    />,
  );
  await screen.findByRole('heading', { name: room.title });
  expect(screen.queryByRole('button', { name: 'teamViewSummary' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'teamSummarizeInSource' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'teamMore' }));
  expect(screen.queryByRole('menuitem', { name: 'teamSummarizeInSource' })).toBeNull();
  expect(view.container.querySelector('section')).toBeNull();
  expect(prepareSource).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it('references an exact batch in the source composer without a second input, copying text or sending', async () => {
  const prepareSource = vi.fn().mockResolvedValue(undefined);
  read.mockResolvedValue({
    success: true,
    value: {
      room: {
        ...room,
        sourceSessionId: 'source',
        summarySource: {
          agentId: 'alice',
          sessionKey: 'agent:alice:justdo:source',
          sessionId: 'native-source',
          lifecycleRevision: 'revision',
        },
      },
      messages: [
        {
          id: 'public-input',
          discussionId: 'batch',
          role: 'user',
          text: 'Public question',
          mediaUrls: [],
          sequence: 1,
          timestamp: 1,
        },
      ],
      historyUnavailable: false,
      organizer: { agentId: 'alice', name: 'Alice', sourceSessionId: 'source' },
      latestRun: { discussionId: 'batch', requestId: 'request', state: 'completed' },
    },
  });
  render(
    <TeamDiscussionView
      entry={{ roomId: 'room' }}
      onClose={vi.fn()}
      onReferenceSource={prepareSource}
    />,
  );
  const composer = await screen.findByRole('textbox', { name: 'teamMessage' });
  fireEvent.change(composer, { target: { value: 'Keep this group question' } });
  fireEvent.click(screen.getByRole('button', { name: 'teamReferenceInSource' }));
  await waitFor(() =>
    expect(prepareSource).toHaveBeenCalledWith('source', {
      kind: 'discussion',
      id: 'discussion:room:batch',
      roomId: 'room',
      discussionId: 'batch',
      text: 'Existing discussion',
    }),
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getAllByRole('textbox')).toHaveLength(1);
  expect(composer).toHaveProperty('value', 'Keep this group question');
  expect(getDiscussionDraft('room').text).toBe('Keep this group question');
  expect(create).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it.each([true, false])(
  'creates a discussion reference and closes only after its task loads (loaded=%s)',
  async loaded => {
    const close = vi.fn();
    const createTask = vi.fn().mockResolvedValue({ success: true, value: 'new-task' });
    Object.assign(window.electron.teamDiscussion, { createTask });
    vi.mocked(coworkService.loadSession).mockResolvedValueOnce(
      loaded ? ({ id: 'new-task' } as Awaited<ReturnType<typeof coworkService.loadSession>>) : null,
    );
    read.mockResolvedValue({
      success: true,
      value: {
        room,
        messages: [
          {
            id: 'public-input',
            discussionId: 'batch',
            role: 'user',
            text: 'Public question',
            mediaUrls: [],
            sequence: 1,
            timestamp: 1,
          },
        ],
        historyUnavailable: false,
        latestRun: { discussionId: 'batch', requestId: 'request', state: 'completed' },
      },
    });
    render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={close} />);
    fireEvent.click(await screen.findByRole('button', { name: 'teamReferenceInNewTask' }));
    await waitFor(() =>
      expect(coworkService.loadSession).toHaveBeenCalledWith('new-task', {
        canSelect: expect.any(Function),
      }),
    );
    expect(store.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'cowork/addDraftMessageQuote',
        payload: {
          draftKey: 'new-task',
          quote: {
            kind: 'discussion',
            id: 'discussion:room:batch',
            text: room.title,
            roomId: 'room',
            discussionId: 'batch',
          },
        },
      }),
    );
    if (loaded) await waitFor(() => expect(close).toHaveBeenCalledOnce());
    else {
      expect(await screen.findByRole('alert')).toHaveProperty(
        'textContent',
        'teamDiscussionNotFound',
      );
      expect(close).not.toHaveBeenCalled();
    }
    expect(send).not.toHaveBeenCalled();
  },
);

it('does not navigate after leaving a discussion while a linked task is being created', async () => {
  let resolveTask!: (value: { success: true; value: string }) => void;
  const createTask = vi.fn(
    () =>
      new Promise(resolve => {
        resolveTask = resolve;
      }),
  );
  Object.assign(window.electron.teamDiscussion, { createTask });
  read.mockResolvedValue({
    success: true,
    value: {
      room,
      messages: [
        {
          id: 'public-input',
          discussionId: 'batch',
          role: 'user',
          text: 'Public question',
          mediaUrls: [],
          sequence: 1,
          timestamp: 1,
        },
      ],
      historyUnavailable: false,
      latestRun: { discussionId: 'batch', requestId: 'request', state: 'completed' },
    },
  });
  const close = vi.fn();
  const view = render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={close} />);
  fireEvent.click(await screen.findByRole('button', { name: 'teamReferenceInNewTask' }));
  await waitFor(() => expect(createTask).toHaveBeenCalledOnce());
  view.unmount();
  await act(async () => {
    resolveTask({ success: true, value: 'new-task' });
  });
  expect(coworkService.loadSession).not.toHaveBeenCalled();
  expect(store.dispatch).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

it('does not offer a reference until a native discussion batch exists', async () => {
  render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
  const composer = await screen.findByRole('textbox', { name: 'teamMessage' });
  fireEvent.change(composer, { target: { value: 'Keep this group question' } });
  expect(screen.getByRole('button', { name: 'teamReferenceInNewTask' })).toHaveProperty(
    'disabled',
    true,
  );
  expect(screen.getByRole('textbox', { name: 'teamMessage' })).toHaveProperty(
    'value',
    'Keep this group question',
  );
  expect(getDiscussionDraft('room').text).toBe('Keep this group question');
  expect(send).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

it('does not replace a deleted source with a new task when referencing a discussion', async () => {
  const prepareSource = vi.fn();
  read.mockResolvedValue({
    success: true,
    value: {
      room: { ...room, sourceSessionId: 'source' },
      messages: [],
      historyUnavailable: false,
      latestRun: { discussionId: 'batch', requestId: 'request', state: 'completed' },
    },
  });
  render(
    <TeamDiscussionView
      entry={{ roomId: 'room' }}
      onClose={vi.fn()}
      onReferenceSource={prepareSource}
    />,
  );
  const reference = await screen.findByRole('button', { name: 'teamReferenceInSource' });
  expect(reference).toHaveProperty('disabled', true);
  fireEvent.click(reference);
  expect(prepareSource).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

async function prepare() {
  render(
    <TeamDiscussionView entry={{ cwd: '/project', draft: 'Please discuss' }} onClose={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'teamGroup' }));
  fireEvent.click(screen.getByLabelText('Alice'));
  fireEvent.click(screen.getByLabelText('Bob'));
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'teamSend' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
}

it('creates independent groups with their selected permissions and no read-only switch', async () => {
  await prepare();
  expect(screen.queryByText('teamReadOnly')).toBeNull();
  const permission = screen.getByRole('combobox', { name: 'teamPermission' });
  expect(permission).toHaveProperty('disabled', false);
  fireEvent.change(permission, { target: { value: 'full' } });

  fireEvent.click(screen.getByRole('button', { name: 'teamSend' }));

  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  expect(create.mock.calls[0][0]).toMatchObject({ permissionMode: 'full' });
  expect(create.mock.calls[0][0]).not.toHaveProperty('readOnly');
});

it('shows source settings inheritance instead of a separate permission choice for linked groups', async () => {
  render(
    <TeamDiscussionView entry={{ sourceSessionId: 'source', cwd: '/project' }} onClose={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'teamGroup' }));

  expect(screen.getByText('teamInheritSourceSettings')).toBeTruthy();
  expect(screen.queryByRole('combobox', { name: 'teamPermission' })).toBeNull();
  expect(screen.queryByText('teamReadOnly')).toBeNull();
});

it('preserves a directed group draft across task and discussion mode views without starting work', async () => {
  await prepare();
  const mentionInput = screen.getByRole('textbox', { name: 'teamMessage' }) as HTMLTextAreaElement;
  fireEvent.change(mentionInput, { target: { value: mentionInput.value + ' @' } });
  fireEvent.click(screen.getByRole('option', { name: /Bob/ }));
  fireEvent.change(screen.getByRole('textbox', { name: 'teamMessage' }), {
    target: { value: 'Only Bob, after I send this' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'teamTask' }));
  expect(screen.queryByRole('textbox', { name: 'teamMessage' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'teamGroup' }));
  expect((screen.getByRole('textbox', { name: 'teamMessage' }) as HTMLTextAreaElement).value).toBe(
    'Only Bob, after I send this',
  );
  expect(screen.getByRole('button', { name: 'teamMentionRemove Bob' })).toBeTruthy();
  expect(create).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it('keeps task collaboration available without creating a discussion', async () => {
  const close = vi.fn();
  render(<TeamDiscussionView entry={{ draft: 'Keep my original task' }} onClose={close} />);
  fireEvent.click(screen.getByRole('button', { name: 'teamTask' }));
  fireEvent.click(screen.getByRole('button', { name: 'teamContinueTask' }));
  expect(close).toHaveBeenCalledOnce();
  expect(create).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it.each([
  '@missing Please discuss',
  '请@missing 检查',
  '`@scope/package` then @missing Please discuss',
  '```ts\n@literal\n```\n@missing Please discuss',
])('blocks unbound mentions instead of broadcasting: %s', async text => {
  await prepare();
  fireEvent.change(screen.getByRole('textbox', { name: 'teamMessage' }), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole('button', { name: 'teamSend' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'teamMentionUseSelector');
  expect(create).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it.each([
  '解释 @ 的含义',
  '检查 `@scope/package` 的版本',
  '检查 ``const value = `@literal` ``',
  '检查代码\n```ts\n@decorator\nclass Example {}\n```',
  '检查代码\n~~~ts\n@decorator\n~~~',
  '> @someone 的原话\n\n请讨论上面的引用',
])('sends literal @ content unchanged without selecting recipients: %s', async text => {
  await prepare();
  fireEvent.change(screen.getByRole('textbox', { name: 'teamMessage' }), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole('button', { name: 'teamSend' }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0][0]).toMatchObject({ message: text, selectedAgentIds: [] });
  expect(screen.queryByRole('alert')).toBeNull();
});

it('serializes double clicks and preserves explicitly selected recipients', async () => {
  await prepare();
  let resolve!: (value: unknown) => void;
  create.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const mentionInput = screen.getByRole('textbox', { name: 'teamMessage' }) as HTMLTextAreaElement;
  fireEvent.change(mentionInput, { target: { value: mentionInput.value + ' @' } });
  fireEvent.click(screen.getByRole('option', { name: /Bob/ }));
  const submit = screen.getByRole('button', { name: 'teamSend' });
  fireEvent.click(submit);
  fireEvent.click(submit);
  expect(create).toHaveBeenCalledOnce();
  resolve({ success: true, value: room });
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0][0]).toMatchObject({ selectedAgentIds: ['bob'], rounds: 2 });
});

it('does not show a disabled warning while initial extension enablement is still unknown', async () => {
  updateDiscussionDraft('room', { text: 'Next topic' });
  let resolve!: (value: Awaited<ReturnType<typeof window.electron.extensions.list>>) => void;
  vi.mocked(window.electron.extensions.list).mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  render(<TeamDiscussionView entry={{ roomId: 'room' }} embedded onClose={vi.fn()} />);
  expect(screen.queryByText('teamDiscussionDisabled')).toBeNull();
  await screen.findByRole('heading', { name: room.title });
  expect(screen.queryByText('teamDiscussionDisabled')).toBeNull();
  expect(screen.getByRole('button', { name: 'teamSend' })).toHaveProperty('disabled', true);
  await act(async () =>
    resolve({
      success: true,
      extensions: [
        {
          id: 'agent-team',
          name: 'Agent Team',
          description: '',
          enabled: true,
          missingRequirements: [],
          configurationFields: [],
        },
      ],
    }),
  );
  expect(screen.queryByText('teamDiscussionDisabled')).toBeNull();
  expect(screen.getByRole('button', { name: 'teamSend' })).toHaveProperty('disabled', false);
});

it('does not claim the extension is disabled when the initial catalog read fails', async () => {
  vi.mocked(window.electron.extensions.list).mockRejectedValueOnce(new Error('unavailable'));
  render(<TeamDiscussionView entry={{ roomId: 'room' }} embedded onClose={vi.fn()} />);
  await screen.findByRole('heading', { name: room.title });
  expect(screen.queryByText('teamDiscussionDisabled')).toBeNull();
  expect(screen.getByRole('button', { name: 'teamSend' })).toHaveProperty('disabled', true);
});

it('renders native public history while the extension is disabled', async () => {
  vi.mocked(window.electron.extensions.list).mockResolvedValue({ success: true, extensions: [] });
  read.mockResolvedValue({
    success: true,
    value: {
      room,
      historyUnavailable: false,
      messages: [
        {
          id: 'native-entry',
          discussionId: 'discussion',
          sequence: 1,
          agentId: 'alice',
          role: 'assistant',
          text: 'Durable native answer',
          timestamp: 1,
          mediaUrls: [],
        },
      ],
    },
  });
  render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
  expect(await screen.findByText('Durable native answer')).toBeTruthy();
  expect(screen.getByText('teamDiscussionDisabled')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'teamMore' }));
  expect(screen.queryByRole('menuitem', { name: 'agentTeamLocalSettings' })).toBeNull();
  expect((screen.getByRole('button', { name: 'teamSend' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(send).not.toHaveBeenCalled();
});

it('opens the clicked member native history and returns to the group input', async () => {
  read.mockResolvedValue({
    success: true,
    value: {
      room: {
        ...room,
        members: room.members.map(member => ({ ...member, sessionId: `native-${member.agentId}` })),
      },
      historyUnavailable: false,
      messages: [
        {
          id: 'reply',
          discussionId: 'round',
          role: 'assistant',
          agentId: 'bob',
          text: 'Public reply',
          timestamp: 1,
          mediaUrls: [],
        },
      ],
    },
  });
  render(<TeamDiscussionView entry={{ roomId: 'room' }} embedded onClose={vi.fn()} />);
  await screen.findByText('Public reply');
  fireEvent.click(screen.getByRole('button', { name: 'teamInspectAgent · Bob' }));
  expect(screen.getByText('Internal history: Bob')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'teamBackToDiscussion' }));
  expect(screen.getByRole('textbox', { name: 'teamMessage' })).toBeTruthy();
});

it('distinguishes the organizer conversation from its separate member execution', async () => {
  updateDiscussionDraft('room', { text: 'Keep this draft', selected: ['bob'] });
  read.mockResolvedValue({
    success: true,
    value: {
      room: {
        ...room,
        sourceSessionId: 'source',
        members: room.members.map(member => ({ ...member, sessionId: `native-${member.agentId}` })),
      },
      historyUnavailable: false,
      messages: [
        {
          id: 'relay',
          discussionId: 'round',
          role: 'assistant',
          origin: 'organizer',
          agentId: 'alice',
          text: 'Organizing topic',
          timestamp: 1,
          mediaUrls: [],
        },
      ],
    },
  });
  render(<TeamDiscussionView entry={{ roomId: 'room' }} embedded onClose={vi.fn()} />);
  await screen.findByText('Organizing topic');
  fireEvent.click(screen.getByRole('button', { name: 'teamInspectAgent · Alice' }));
  expect(screen.getByText('Internal history: Alice').getAttribute('data-session-key')).toBe(
    'agent:alice:justdo:source',
  );
  fireEvent.click(screen.getByRole('button', { name: 'teamBackToDiscussion' }));
  fireEvent.click(screen.getByRole('button', { name: 'teamMembers' }));
  const memberList = screen.getByRole('complementary', { name: 'teamMembers' });
  fireEvent.click(within(memberList).getByRole('button', { name: 'teamInspectAgent · Alice' }));
  expect(screen.getByText('Internal history: Alice').getAttribute('data-session-key')).toBe(
    teamDiscussionSessionKey(room.id, 'alice'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'teamBackToDiscussion' }));
  expect(screen.queryByRole('complementary', { name: 'teamMembers' })).toBeNull();
  expect(screen.getByRole('textbox', { name: 'teamMessage' })).toHaveProperty(
    'value',
    'Keep this draft',
  );
  expect(getDiscussionDraft('room')).toMatchObject({ text: 'Keep this draft', selected: ['bob'] });
  expect(send).not.toHaveBeenCalled();
});

it('uses plugin defaults for a new draft and restores explicitly selected rounds and recipients', async () => {
  read.mockResolvedValue({
    success: true,
    value: { room: { ...room, rounds: 4 }, messages: [], historyUnavailable: false },
  });
  const first = render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
  await screen.findByRole('textbox', { name: 'teamMessage' });
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('2');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '4' } });
  const mentionInput = screen.getByRole('textbox', { name: 'teamMessage' }) as HTMLTextAreaElement;
  fireEvent.change(mentionInput, { target: { value: mentionInput.value + ' @' } });
  fireEvent.click(screen.getByRole('option', { name: /Bob/ }));
  fireEvent.change(screen.getByRole('textbox', { name: 'teamMessage' }), {
    target: { value: 'Only Bob should receive this' },
  });
  first.unmount();
  render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
  await screen.findByRole('button', { name: 'teamMentionRemove Bob' });
  expect((screen.getByRole('textbox', { name: 'teamMessage' }) as HTMLTextAreaElement).value).toBe(
    'Only Bob should receive this',
  );
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('4');
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'teamSend' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'teamMessage' }), { key: 'Enter' });
  await waitFor(() => expect(send).toHaveBeenCalled());
  expect(send.mock.calls[0][0]).toMatchObject({ selectedAgentIds: ['bob'], rounds: 4 });
});

it('keeps uncertain request identity across unmount and clears all submitted fields on confirmation', async () => {
  updateDiscussionDraft('room', {
    text: 'Review',
    selected: ['bob'],
    rounds: 3,
    quotes: [{ id: 'quoted', discussionId: 'earlier' }],
  });
  send.mockResolvedValue({ success: false, error: 'teamDiscussionOutcomeUnknown' });
  const first = render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'teamSend' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'teamSend' }));
  await screen.findByRole('button', { name: 'teamRetry' });
  const submitted = send.mock.calls[0][0];
  first.unmount();
  const second = render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'teamRetry' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'teamRetry' }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(send.mock.calls[1][0]).toEqual(submitted);
  await screen.findByRole('alert');
  second.unmount();
  read.mockResolvedValue({
    success: true,
    value: {
      room,
      messages: [],
      historyUnavailable: false,
      latestRun: { requestId: submitted.requestId, state: 'completed' },
    },
  });
  render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
  await screen.findByRole('textbox', { name: 'teamMessage' });
  expect(getDiscussionDraft('room')).toMatchObject({
    text: '',
    selected: [],
    quotes: [],
    attachments: [],
    pending: null,
  });
});

it('shows the frozen pending rounds after defaults tighten and retries the original payload', async () => {
  const { defaultAgentTeamSettings } = await import('@shared/cowork/agent-team/agentTeamSettings');
  const value = defaultAgentTeamSettings();
  Object.assign(value.discussion, { defaultRounds: 1, maxRounds: 1 });
  const readTeam = vi.fn().mockResolvedValue({
    success: true,
    value: {
      global: { version: 1, revision: 1, value },
      team: { revision: 0, value: {} },
      memberCount: 2,
    },
  });
  Object.assign(window.electron, { agentTeamSettings: { readTeam } });
  const frozen = {
    roomId: 'room',
    requestId: 'uncertain',
    expectedRevision: 1,
    message: 'Review',
    selectedAgentIds: [],
    rounds: 2,
  };
  updateDiscussionDraft('room', { text: 'Review', pending: frozen });
  render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
  await screen.findByRole('button', { name: 'teamRetry' });
  await waitFor(() =>
    expect(screen.getByRole('combobox').querySelectorAll('option')).toHaveLength(2),
  );
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('2');
  expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'teamRetry' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(frozen));
});

it('shows uncertainty in an occupied room without presenting awaiting replies or allowing a fresh send', async () => {
  read.mockResolvedValue({
    success: true,
    value: {
      room: { ...room, state: 'interrupted', activeDiscussionId: 'batch' },
      messages: [],
      historyUnavailable: false,
    },
  });
  render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
  await screen.findByRole('button', { name: 'teamStop' });
  expect(screen.queryByRole('button', { name: 'teamSend' })).toBeNull();
  expect(screen.queryByText('teamAwaitingMembers')).toBeNull();
  expect(screen.getByRole('status')).toHaveProperty('textContent', 'teamRecordUnconfirmed');
  expect(screen.getByRole('status')).toHaveProperty('title', 'teamState_interrupted');
});

it('rejects a restored recipient that is no longer a member instead of broadcasting', async () => {
  updateDiscussionDraft('room', { text: 'Directed draft', selected: ['removed-agent'] });
  render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'teamSend' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'teamSend' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'teamDiscussionInvalidInput',
  );
  expect(send).not.toHaveBeenCalled();
  expect(getDiscussionDraft('room').selected).toEqual(['removed-agent']);
});

it.each(['failed', 'cancelled'])(
  'preserves a %s pre-Start receipt on direct retry and requires an explicit new submission',
  async state => {
    const payload = {
      text: 'Keep this request',
      selected: ['bob'],
      attachments: ['/project/input.txt'],
      quotes: [{ id: 'quoted', discussionId: 'earlier' }],
    };
    updateDiscussionDraft('room', payload);
    send.mockRejectedValueOnce(new Error('IPC response lost'));
    send.mockImplementationOnce(async input => ({
      success: true,
      value: {
        ...room,
        latestRun: { discussionId: 'before-start', requestId: input.requestId, state },
      },
    }));
    render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
    const submit = await screen.findByRole('button', { name: 'teamSend' });
    await waitFor(() => expect(submit).toHaveProperty('disabled', false));
    fireEvent.click(submit);
    const retry = await screen.findByRole('button', { name: 'teamRetry' });
    await waitFor(() => expect(retry).toHaveProperty('disabled', false));
    const original = send.mock.calls[0][0];
    fireEvent.click(retry);
    await waitFor(() => expect(getDiscussionDraft('room').pending).toBeNull());
    expect(send.mock.calls[1][0]).toEqual(original);
    expect(getDiscussionDraft('room')).toMatchObject(payload);
    expect(send).toHaveBeenCalledTimes(2);
    const freshSend = await screen.findByRole('button', { name: 'teamSend' });
    await waitFor(() => expect(freshSend).toHaveProperty('disabled', false));
    fireEvent.click(freshSend);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls[2][0]).toMatchObject({
      message: payload.text,
      attachmentPaths: payload.attachments,
      selectedAgentIds: payload.selected,
      quotes: [{ messageId: 'quoted', discussionId: 'earlier' }],
    });
    expect(send.mock.calls[2][0].requestId).not.toBe(original.requestId);
    await waitFor(() => expect(getDiscussionDraft('room').text).toBe(''));
  },
);

it.each(['failed', 'cancelled'])(
  'keeps a visibly submitted native %s payload available without automatically sending it again',
  async state => {
    updateDiscussionDraft('room', { text: 'Native input', selected: ['bob'] });
    send.mockImplementationOnce(async input => {
      const latestRun = { discussionId: 'native-batch', requestId: input.requestId, state };
      const resultRoom = { ...room, latestRun };
      read.mockResolvedValue({
        success: true,
        value: {
          room: resultRoom,
          latestRun,
          historyUnavailable: false,
          messages: [
            {
              id: 'public-input',
              discussionId: 'native-batch',
              sequence: 1,
              role: 'user',
              text: input.message,
              timestamp: 1,
              mediaUrls: [],
            },
          ],
          executions: [
            { discussionId: 'native-batch', agentId: 'bob', runId: 'native-run', outcome: state },
          ],
        },
      });
      return { success: true, value: resultRoom };
    });
    render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
    const submit = await screen.findByRole('button', { name: 'teamSend' });
    await waitFor(() => expect(submit).toHaveProperty('disabled', false));
    fireEvent.click(submit);
    await screen.findByText(state === 'failed' ? 'teamRecordFailed' : 'teamRecordStopped');
    await waitFor(() => expect(getDiscussionDraft('room').pending).toBeNull());
    expect(getDiscussionDraft('room')).toMatchObject({ text: 'Native input', selected: ['bob'] });
    expect(document.querySelector('[data-discussion-message="public-input"]')).toBeTruthy();
    expect(send).toHaveBeenCalledOnce();
  },
);

it.each(['absent', 'different'])(
  'keeps direct-send identity frozen when the successful response latest run is %s',
  async evidence => {
    updateDiscussionDraft('room', { text: 'Await exact evidence', selected: ['bob'] });
    const responseRoom = {
      ...room,
      ...(evidence === 'different'
        ? {
            latestRun: { discussionId: 'other', requestId: 'another-request', state: 'completed' },
          }
        : {}),
    };
    send.mockResolvedValue({ success: true, value: responseRoom });
    render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
    const submit = await screen.findByRole('button', { name: 'teamSend' });
    await waitFor(() => expect(submit).toHaveProperty('disabled', false));
    fireEvent.click(submit);
    const retry = await screen.findByRole('button', { name: 'teamRetry' });
    await waitFor(() => expect(retry).toHaveProperty('disabled', false));
    const original = send.mock.calls[0][0];
    expect(getDiscussionDraft('room')).toMatchObject({
      text: 'Await exact evidence',
      selected: ['bob'],
      pending: original,
    });
    read.mockResolvedValue({
      success: true,
      value: {
        room: responseRoom,
        latestRun: responseRoom.latestRun,
        messages: [],
        historyUnavailable: false,
        runs: [{ discussionId: 'confirmed', requestId: original.requestId, state: 'completed' }],
      },
    });
    fireEvent.click(retry);
    await waitFor(() => expect(getDiscussionDraft('room').pending).toBeNull());
    expect(send.mock.calls[1][0]).toEqual(original);
    expect(getDiscussionDraft('room')).toMatchObject({ text: '', selected: [] });
  },
);

it('does not erase a newer draft when a previously confirmed request acknowledges late', () => {
  const submitted = {
    roomId: 'room',
    requestId: 'first',
    expectedRevision: 1,
    message: 'First',
    rounds: 2,
    selectedAgentIds: [],
  };
  updateDiscussionDraft('room', { text: 'First', pending: submitted });
  settleDiscussionDraft('room', 'first', true);
  updateDiscussionDraft('room', { text: 'Next message', selected: ['bob'] });
  settleDiscussionDraft('room', 'first', true);
  expect(getDiscussionDraft('room')).toMatchObject({ text: 'Next message', selected: ['bob'] });
});

it('locks the shared draft while initial room preparation survives a view remount', async () => {
  let finishPreparation!: (value: unknown) => void;
  create.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishPreparation = resolve;
      }),
  );
  await prepare();
  fireEvent.click(screen.getByRole('button', { name: 'teamSend' }));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  const id = create.mock.calls[0][0].id;
  const preparedRoom = { ...room, id };
  expect(getDiscussionDraft(id).submissionAttemptId).toBeTruthy();
  cleanup();
  read.mockResolvedValue({
    success: true,
    value: {
      room: { ...preparedRoom, state: 'preparing' },
      messages: [],
      historyUnavailable: false,
    },
  });
  render(<TeamDiscussionView entry={{ roomId: id }} onClose={vi.fn()} />);
  const input = await screen.findByRole('textbox', { name: 'teamMessage' });
  expect((input as HTMLTextAreaElement).disabled).toBe(true);
  expect((input as HTMLTextAreaElement).value).toBe('Please discuss');
  expect(screen.queryByRole('listbox')).toBeNull();
  read.mockResolvedValue({
    success: true,
    value: { room: preparedRoom, messages: [], historyUnavailable: false },
  });
  finishPreparation({ success: true, value: preparedRoom });
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  await waitFor(() => expect(getDiscussionDraft(id).submissionAttemptId).toBeUndefined());
  expect(getDiscussionDraft(id)).toMatchObject({ text: '', pending: null });
});

it('releases the shared submission lock when initial preparation fails', async () => {
  create.mockResolvedValueOnce({ success: false, error: 'teamPreparationFailed' });
  await prepare();
  fireEvent.click(screen.getByRole('button', { name: 'teamSend' }));
  await screen.findByRole('alert');
  const id = create.mock.calls[0][0].id;
  expect(getDiscussionDraft(id)).toMatchObject({ text: 'Please discuss', pending: null });
  expect(getDiscussionDraft(id).submissionAttemptId).toBeUndefined();
  expect(
    (screen.getByRole('textbox', { name: 'teamMessage' }) as HTMLTextAreaElement).disabled,
  ).toBe(false);
});

it('does not add a new quote while an uncertain submission is pending', async () => {
  updateDiscussionDraft('room', {
    text: 'Pending',
    pending: {
      roomId: 'room',
      requestId: 'uncertain',
      expectedRevision: 1,
      message: 'Pending',
      selectedAgentIds: [],
      rounds: 2,
    },
  });
  read.mockResolvedValue({
    success: true,
    value: {
      room,
      historyUnavailable: false,
      messages: [
        {
          id: 'reply',
          discussionId: 'round',
          role: 'assistant',
          agentId: 'bob',
          text: 'Public reply',
          timestamp: 1,
          mediaUrls: [],
        },
      ],
    },
  });
  render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
  const quote = await screen.findByRole('button', { name: 'teamQuote' });
  expect((quote as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(quote);
  expect(getDiscussionDraft('room').quotes).toEqual([]);
});

it('queues a running discussion draft with exact recipients, quotes, attachments and rounds', async () => {
  const activeRoom = { ...room, state: 'running', activeDiscussionId: 'prior' };
  read.mockResolvedValue({ success: true, value: { room: activeRoom, messages: [] } });
  enqueue.mockImplementationOnce(async input => {
    const next = {
      ...activeRoom,
      pendingInputs: [
        {
          requestId: input.requestId,
          state: 'queued',
          createdAt: 1,
          rounds: input.rounds,
          selectedAgentIds: input.selectedAgentIds,
        },
      ],
    };
    read.mockResolvedValue({ success: true, value: { room: next, messages: [] } });
    return { success: true, value: next };
  });
  updateDiscussionDraft('room', {
    text: 'Review',
    selected: ['bob'],
    rounds: 3,
    attachments: ['/project/image.png'],
    quotes: [{ id: 'quoted', discussionId: 'older' }],
  });
  render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'teamEnqueue' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  expect((screen.getByRole('button', { name: 'speech-input' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(false);
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'teamMessage' }), { key: 'Enter' });
  await screen.findByRole('button', { name: /teamPendingInputs/ });
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      roomId: 'room',
      message: 'Review',
      selectedAgentIds: ['bob'],
      rounds: 3,
      attachmentPaths: ['/project/image.png'],
      quotes: [{ messageId: 'quoted', discussionId: 'older' }],
    }),
  );
  expect(send).not.toHaveBeenCalled();
  expect(getDiscussionDraft('room')).toMatchObject({
    text: '',
    selected: [],
    attachments: [],
    quotes: [],
    pending: null,
  });
});

it('counts receiving and unknown entries, renders a compact queue, and cancels only the exact queued request', async () => {
  const waiting = [
    {
      requestId: 'first',
      state: 'queued',
      createdAt: 1,
      rounds: 2,
      selectedAgentIds: ['bob'],
      message: '<img src=x> Native pending input',
    },
    { requestId: 'second', state: 'receiving', createdAt: 2, rounds: 1, selectedAgentIds: [] },
    { requestId: 'third', state: 'unknown', createdAt: 3, rounds: 2, selectedAgentIds: [] },
  ];
  const activeRoom = {
    ...room,
    state: 'running',
    activeDiscussionId: 'prior',
    pendingInputs: waiting,
  };
  read.mockResolvedValue({ success: true, value: { room: activeRoom, messages: [] } });
  updateDiscussionDraft('room', { text: 'Next draft' });
  cancelPending.mockResolvedValue({ success: true, value: activeRoom });
  render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
  const expand = await screen.findByRole('button', { name: /teamPendingInputs/ });
  expect(expand.textContent).toContain('3/3');
  expect(screen.queryByText(/teamQueue_queued/)).toBeNull();
  expect(screen.queryByText('<img src=x> Native pending input')).toBeNull();
  expect((screen.getByRole('button', { name: 'teamEnqueue' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'teamMessage' }), { key: 'Enter' });
  expect(enqueue).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(expand);
  await screen.findByText(/teamQueue_unknown/);
  expect(screen.getByText('<img src=x> Native pending input')).toBeTruthy();
  expect(screen.getAllByText('teamQueuePreviewUnavailable')).toHaveLength(2);
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.queryByRole('button', { name: 'teamQueueCancel 3' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'teamQueueCancel 1' }));
  await waitFor(() =>
    expect(cancelPending).toHaveBeenCalledWith({ roomId: 'room', requestId: 'first' }),
  );
  expect(getDiscussionDraft('room').text).toBe('Next draft');
  expect(enqueue).not.toHaveBeenCalled();
});

it('checks an uncertain queue append after remount without resending it or clearing a newer draft', async () => {
  const activeRoom = { ...room, state: 'running', activeDiscussionId: 'prior' };
  read.mockResolvedValue({ success: true, value: { room: activeRoom, messages: [] } });
  enqueue.mockResolvedValue({ success: false, error: 'teamDiscussionOutcomeUnknown' });
  updateDiscussionDraft('room', { text: 'Original', selected: ['bob'] });
  const view = render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'teamEnqueue' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'teamEnqueue' }));
  await screen.findByRole('button', { name: 'teamRetry' });
  const original = enqueue.mock.calls[0][0];
  view.unmount();
  render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
  await screen.findByRole('button', { name: 'teamRetry' });
  fireEvent.click(screen.getByRole('button', { name: 'teamRetry' }));
  await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(2));
  expect(enqueue).toHaveBeenCalledOnce();
  expect(getDiscussionDraft('room').pending?.requestId).toBe(original.requestId);
  cleanup();
  updateDiscussionDraft('room', { text: 'Newer', selected: ['alice'] });
  read.mockResolvedValue({
    success: true,
    value: {
      room: {
        ...activeRoom,
        pendingInputs: [
          {
            requestId: original.requestId,
            state: 'queued',
            createdAt: 1,
            rounds: 2,
            selectedAgentIds: ['bob'],
          },
        ],
      },
      messages: [],
    },
  });
  render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
  await waitFor(() =>
    expect(getDiscussionDraft('room')).toMatchObject({
      text: 'Newer',
      selected: ['alice'],
      pending: null,
    }),
  );
  expect(enqueue).toHaveBeenCalledOnce();
});

it('ignores an old file picker and speech result after the submitted queue draft has settled', async () => {
  const activeRoom = { ...room, state: 'running', activeDiscussionId: 'prior' };
  read.mockResolvedValue({ success: true, value: { room: activeRoom, messages: [] } });
  enqueue.mockImplementationOnce(async input => {
    const next = {
      ...activeRoom,
      pendingInputs: [
        {
          requestId: input.requestId,
          state: 'queued',
          createdAt: 1,
          rounds: 2,
          selectedAgentIds: [],
        },
      ],
    };
    read.mockResolvedValue({ success: true, value: { room: next, messages: [] } });
    return { success: true, value: next };
  });
  let finishFiles!: (value: { success: true; paths: string[] }) => void;
  Object.assign(window.electron, {
    dialog: {
      selectFiles: vi.fn(
        () =>
          new Promise(resolve => {
            finishFiles = resolve;
          }),
      ),
    },
  });
  updateDiscussionDraft('room', { text: 'Original' });
  render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'teamEnqueue' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  const oldSpeech = speech.callbacks[speech.callbacks.length - 1];
  fireEvent.click(screen.getByRole('button', { name: 'coworkAddFile' }));
  fireEvent.click(screen.getByRole('button', { name: 'teamEnqueue' }));
  await waitFor(() => expect(getDiscussionDraft('room').text).toBe(''));
  act(() => updateDiscussionDraft('room', { text: 'Next draft' }));
  await act(async () => {
    finishFiles({ success: true, paths: ['/old-picker'] });
    oldSpeech('old recording');
  });
  expect(getDiscussionDraft('room')).toMatchObject({ text: 'Next draft', attachments: [] });
});

it('retains the draft when a cancellation wins before the queue save acknowledgement', async () => {
  const activeRoom = { ...room, state: 'running', activeDiscussionId: 'prior' };
  read.mockResolvedValue({ success: true, value: { room: activeRoom, messages: [] } });
  enqueue.mockImplementationOnce(async input => {
    const next = {
      ...activeRoom,
      pendingInputs: [
        {
          requestId: input.requestId,
          state: 'cancelled',
          createdAt: 1,
          rounds: 2,
          selectedAgentIds: ['bob'],
        },
      ],
    };
    read.mockResolvedValue({ success: true, value: { room: next, messages: [] } });
    return { success: true, value: next };
  });
  updateDiscussionDraft('room', {
    text: 'Preserve the cancelled input',
    selected: ['bob'],
    attachments: ['/project/file'],
  });
  render(<TeamDiscussionView entry={{ roomId: 'room' }} onClose={vi.fn()} />);
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'teamEnqueue' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'teamEnqueue' }));
  await waitFor(() =>
    expect(getDiscussionDraft('room')).toMatchObject({
      text: 'Preserve the cancelled input',
      selected: ['bob'],
      attachments: ['/project/file'],
      pending: null,
    }),
  );
  expect(send).not.toHaveBeenCalled();
});

it.each([false, true])(
  'does not reference an empty failed batch even with older visible messages=%s',
  async hasOlderMessages => {
    const prepareSource = vi.fn();
    read.mockResolvedValue({
      success: true,
      value: {
        room: { ...room, sourceSessionId: 'source' },
        messages: hasOlderMessages
          ? [
              {
                id: 'old',
                discussionId: 'old-batch',
                role: 'assistant',
                agentId: 'alice',
                text: 'Earlier answer',
                mediaUrls: [],
                sequence: 1,
                timestamp: 1,
              },
            ]
          : [],
        historyUnavailable: false,
        organizer: { agentId: 'alice', name: 'Alice', sourceSessionId: 'source' },
        latestRun: { discussionId: 'failed-empty', requestId: 'request', state: 'failed' },
      },
    });
    render(
      <TeamDiscussionView
        entry={{ roomId: 'room' }}
        onClose={vi.fn()}
        onReferenceSource={prepareSource}
        onPrepareSourceDraft={prepareSource}
      />,
    );
    const button = await screen.findByRole('button', { name: 'teamReferenceInSource' });
    expect(button).toHaveProperty('disabled', true);
    if (hasOlderMessages) expect(screen.getByText('Earlier answer')).toBeTruthy();
    const summaryButton = await openSummaryAction();
    expect(summaryButton).toHaveProperty('disabled', true);
    fireEvent.click(summaryButton);
    fireEvent.click(button);
    expect(prepareSource).not.toHaveBeenCalled();
  },
);
