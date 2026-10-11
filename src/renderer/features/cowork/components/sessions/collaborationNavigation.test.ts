import type { CollaborationRoom } from '@shared/cowork/agent-team/collaboration';
import { describe, expect, it } from 'vitest';

import {
  resolveCollaborationNavigation,
  toggleVisibleSessionSelection,
} from './collaborationNavigation';
const room: CollaborationRoom = {
  id: 'room',
  anchorSessionId: 'main-session',
  members: [
    { agentId: 'main', sessionId: 'main-session', sessionKey: 'agent:main:justdo:main-session' },
    { agentId: 'review', sessionId: 'peer', sessionKey: 'agent:review:justdo:peer' },
  ],
};
describe('collaboration navigation', () => {
  it('opens a peer search hit as detail while retaining the main conversation', () => {
    expect(resolveCollaborationNavigation('peer', [room])).toEqual({
      sessionId: 'main-session',
      memberSessionId: 'peer',
    });
  });
  it('does not redirect ordinary or anchor conversations', () => {
    expect(resolveCollaborationNavigation('main-session', [room])).toEqual({
      sessionId: 'main-session',
    });
    expect(resolveCollaborationNavigation('ordinary', [room])).toEqual({ sessionId: 'ordinary' });
  });
  it('selects only visible rows rather than hidden peers or filtered conversations', () => {
    expect([
      ...toggleVisibleSessionSelection(new Set(['hidden-peer']), ['main-session', 'ordinary']),
    ]).toEqual(['main-session', 'ordinary']);
    expect(
      toggleVisibleSessionSelection(new Set(['main-session', 'ordinary']), [
        'main-session',
        'ordinary',
      ]).size,
    ).toBe(0);
  });
});
