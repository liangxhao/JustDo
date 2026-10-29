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
        role: 'user',
        timestamp: 2,
        content: 'Group thread round 2. These are sibling replies.',
        senderLabel: 'You',
        ...(transportOnly
          ? {
              __openclaw: {
                transport: { channel: 'justdo-team', messageId: 'group-thread:round2' },
              },
            }
          : {
              provenance: {
                kind: 'inter_session',
                sourceSessionKey: 'agent:main:team-discussion:room',
                sourceChannel: 'justdo-team',
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
