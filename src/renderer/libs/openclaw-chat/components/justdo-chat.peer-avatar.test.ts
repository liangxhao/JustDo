/** @vitest-environment jsdom */
import './justdo-chat';

import { afterEach, expect, test } from 'vitest';

import { i18nService } from '@/services/i18n';

import { ChatController } from '../gateway/chat-controller';
import type { JustDoChatElement } from './justdo-chat';
import { materializeDisclosureContents } from './timeline/disclosure-content';

afterEach(() => document.body.replaceChildren());

function setHistory(controller: ChatController, messages: unknown[]): void {
  (
    controller as unknown as {
      setCurrentSessionMessages(messages: unknown[], options: { resetLoadedHistory: boolean }): void;
    }
  ).setCurrentSessionMessages(messages, { resetLoadedHistory: true });
}

test.each([
  ['legacy', 'main', 'M'],
  ['wrapped', 'main', 'M'],
  ['markerless', 'main', 'M'],
  ['markerless', 'reviewer', 'R'],
] as const)('shows the parent as the sender of a %s delegated task and a follow-up from %s', async (format, sender, initial) => {
  const parent = `agent:${sender}:justdo:parent`;
  const taskHeader = '[Subagent Context] You are running as a subagent (depth 1/5).\n\n[Subagent Task]\n\n';
  const task = format === 'wrapped'
    ? `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n\n${taskHeader}<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\n\nWrite one line.`
    : `${format === 'legacy' ? taskHeader : ''}Write one line.`;
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.peerPerspective = true;
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:worker:subagent:child';
  setHistory(controller, [
    { __openclaw: { id: 'task', seq: 1 }, role: 'user', timestamp: 1, content: task },
    { id: 'reply-1', role: 'assistant', timestamp: 2, content: 'First reply.' },
    {
      id: 'follow-up', role: 'assistant', timestamp: 3, content: 'Try a second line.',
      provenance: { kind: 'inter_session', sourceTool: 'sessions_send', sourceSessionKey: parent },
    },
    { id: 'reply-2', role: 'assistant', timestamp: 4, content: 'Second reply.' },
    { id: 'human', role: 'user', timestamp: 5, content: task },
  ]);
  chat.controller = controller;
  document.body.append(chat);
  await chat.updateComplete;
  chat.subagentParentSessionKey = parent;
  await chat.updateComplete;
  if (format === 'markerless') {
    expect(chat.shadowRoot!.querySelector('.chat-group--user .chat-group__sender')?.textContent)
      .toBe(i18nService.t('coworkYouLabel'));
    chat.subagentTaskEntryId = 'task';
    await chat.updateComplete;
  }

  const root = chat.shadowRoot!;
  const avatars = [...root.querySelectorAll('.chat-group--user .chat-avatar.peer')];
  expect(avatars.map(avatar => [avatar.getAttribute('title'), avatar.textContent?.trim()])).toEqual([
    [sender, initial],
    [sender, initial],
  ]);
  expect([...root.querySelectorAll('.chat-group--user .chat-group__sender')].map(label => label.textContent)).toEqual([
    sender, sender, i18nService.t('coworkYouLabel'),
  ]);
  expect(root.querySelectorAll('.chat-group--user .chat-avatar.user')).toHaveLength(1);
});

test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  'attributes native group input only in member history (peer perspective: %s, transport only: %s)',
  async (peerPerspective, transportOnly) => {
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.peerPerspective = peerPerspective;
    chat.assistantName = '研究助手';
    const controller = new ChatController();
    setHistory(controller, [
      { id: 'real-user', role: 'user', timestamp: 1, content: 'A real user question.' },
      {
        id: 'group-input',
        __fixtureInput: true,
        role: 'user',
        timestamp: 2,
        content: 'Group thread round 2. These are sibling replies.',
        senderLabel: 'You',
        ...(transportOnly
          ? {
              __openclaw: {
                transport: { channel: 'agent-team', messageId: 'group-thread:round2' },
              },
            }
          : {
              provenance: {
                kind: 'inter_session',
                sourceSessionKey: 'agent:main:team-discussion:room',
                sourceChannel: 'agent-team',
                sourceTool: 'team_discussion',
              },
            }),
      },
      { id: 'reply', role: 'assistant', timestamp: 3, content: 'The actual assistant reply.' },
    ]);
    chat.controller = controller;
    document.body.append(chat);
    await chat.updateComplete;
    const root = chat.shadowRoot!;
    expect(root.querySelectorAll('.chat-group--user .chat-avatar.user')).toHaveLength(1);
    const dispatchers = [...root.querySelectorAll('.chat-group--user .chat-avatar.peer')];
    expect(dispatchers).toHaveLength(peerPerspective ? 1 : 0);
    if (peerPerspective) {
      const label = i18nService.t('teamDiscussionDispatcher');
      expect(dispatchers[0].getAttribute('title')).toBe(label);
      expect(dispatchers[0].textContent?.trim()).toBe(Array.from(label)[0]);
      expect(dispatchers[0].querySelector('svg')).toBeNull();
      expect(root.textContent).toContain('Group thread round 2.');
      expect(root.textContent).toContain(label);
    } else {
      expect(root.textContent).not.toContain('Group thread round 2.');
    }
    expect(root.textContent).toContain('The actual assistant reply.');
  },
);

test.each([false, true])(
  'keeps one matching assistant avatar per reply group (process first: %s)',
  async processFirst => {
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.peerPerspective = true;
    chat.assistantName = '实现助手';
    chat.assistantId = 'implement';
    chat.peerColors = { implement: '#d97706', review: '#0d9488' };
    chat.peerNames = { review: '审查助手' };
    const incoming = (id: string) => ({
      id,
      role: 'assistant',
      content: 'Please review this change',
      provenance: {
        kind: 'inter_session',
        sourceTool: 'sessions_send',
        sourceSessionKey: 'agent:review:justdo:review-session',
      },
    });
    const controller = new ChatController();
    setHistory(controller, [
      incoming('in-1'),
      ...(processFirst
        ? [
            {
              id: 'thinking-1',
              role: 'assistant',
              content: [{ type: 'thinking', thinking: 'Planning the change' }],
            },
          ]
        : []),
      { id: 'out-1', role: 'assistant', content: 'First reply' },
      { id: 'out-2', role: 'assistant', content: 'Second reply' },
      incoming('in-2'),
      { id: 'out-3', role: 'assistant', content: 'Next reply' },
    ]);
    chat.controller = controller;
    document.body.append(chat);
    await chat.updateComplete;
    materializeDisclosureContents(chat.shadowRoot!);
    const groups = [
      ...chat.shadowRoot!.querySelectorAll('.chat-group--assistant.chat-group--content'),
    ];
    expect(groups).toHaveLength(3);
    expect(groups.map(group => !!group.querySelector('.chat-avatar'))).toEqual(
      processFirst ? [false, false, true] : [true, false, true],
    );
    const process = chat.shadowRoot!.querySelector('.completed-process')!;
    expect(groups[0].closest('.completed-process')).toBe(process);
    expect(groups[1].closest('.completed-process')).toBeNull();
    expect(process.querySelector('summary > .chat-group__avatar .chat-avatar')).not.toBeNull();
    const avatars = [
      ...chat.shadowRoot!.querySelectorAll('.chat-group--assistant .chat-avatar'),
    ].filter(avatar => !avatar.closest('.completed-process__items'));
    expect(avatars).toHaveLength(2);
    for (const avatar of avatars) {
      expect(avatar.getAttribute('title')).toBe('实现助手');
      expect(avatar.textContent?.trim()).toBe('实');
      expect(avatar.getAttribute('style')).toContain('#d97706');
      expect(avatar.querySelector('svg')).toBeNull();
    }
    expect(chat.shadowRoot!.querySelectorAll('.chat-group--user .chat-avatar')).toHaveLength(2);
  },
);
