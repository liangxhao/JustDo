// @vitest-environment jsdom
import type { AppNativeHistoryState, AppViewContext } from '@app-plugin/sdk/browser';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  source: { id: 'source', title: 'Source', cwd: '/project', agentId: 'organizer', status: 'idle' },
  prepare: vi.fn(),
  props: undefined as unknown,
}));
vi.mock('./state', () => ({
  useSelector: (select: (value: unknown) => unknown) =>
    select({ cowork: { currentSession: fixture.source } }),
}));
vi.mock('./ports', async importOriginal => ({
  ...(await importOriginal<typeof import('./ports')>()),
  browserHost: () => ({ signal: new AbortController().signal, t: (key: string) => key }),
  teamApi: { collaboration: { prepareContinuation: fixture.prepare } },
  application: { stageAudio: vi.fn(), files: { readFileAsDataUrl: vi.fn() } },
}));
vi.mock('./display/AgentTeamPanel', () => ({
  default: (props: unknown) => {
    fixture.props = props;
    return null;
  },
}));
import { TeamWorkspace } from './workspace';
import type { ComponentProps } from 'react';
import type AgentTeamPanel from './display/AgentTeamPanel';

const member = { agentId: 'reviewer', sessionId: 'peer', sessionKey: 'agent:reviewer:justdo:peer' };
const room = { id: 'room', anchorSessionId: 'source', members: [member] };
const receipt = {
  sourceSessionId: 'source',
  sourceAgentId: 'organizer',
  roomId: 'room',
  targetAgentId: 'reviewer',
  targetSessionId: 'peer',
  targetSessionKey: member.sessionKey,
  controlGeneration: 'generation-1',
};
afterEach(cleanup);
beforeEach(() => {
  fixture.prepare.mockReset().mockResolvedValue({ success: true, value: receipt });
});
it('passes the current workspace visibility to its retained team panel', () => {
  const { rerender } = render(<TeamWorkspace session={fixture.source} active />);
  expect(fixture.props).toMatchObject({ active: true });
  rerender(<TeamWorkspace session={fixture.source} active={false} />);
  expect(fixture.props).toMatchObject({ active: false });
});
it('resets the selected member and internal team tab on a new summary opening', () => {
  const { rerender } = render(
    <TeamWorkspace
      session={fixture.source}
      selection={{ memberSessionId: 'peer', key: 'group:room' }}
      selectionRevision={1}
    />,
  );
  expect(fixture.props).toMatchObject({
    selectedMemberId: 'peer',
    selectionRequest: { key: 'group:room', version: 1 },
  });
  rerender(<TeamWorkspace session={fixture.source} selectionRevision={2} />);
  expect(fixture.props).toMatchObject({
    selectedMemberId: undefined,
    selectionRequest: { key: undefined, version: 2 },
  });
});

function setup(status: 'accepted' | 'unknown' = 'accepted') {
  const effect = vi.fn();
  const state: AppNativeHistoryState = {
    ready: true,
    connected: true,
    running: false,
    sessionKey: member.sessionKey,
    nativeSessionId: 'native-peer',
    send: vi.fn(async input => {
      input.assertCurrent();
      await input.beforeSend();
      effect();
      return status;
    }),
  };
  const submitUserTurn = {
    assertReady: vi.fn(),
    supportsImages: () => false,
    send: vi.fn(),
    outcomeUnknown: () => false,
  } as NonNullable<AppViewContext['submitUserTurn']>;
  render(<TeamWorkspace session={fixture.source} submitUserTurn={submitUserTurn} />);
  const invoke = () =>
    (fixture.props as ComponentProps<typeof AgentTeamPanel>).onRequestContinue!(
      room,
      member,
      undefined,
      { message: 'Review this', requestId: 'request' },
      state,
    );
  return { invoke, state, effect, submitUserTurn };
}
it('sends the member turn through its mounted port with the exact native identity and stop generation', async () => {
  const h = setup();
  expect(await h.invoke()).toBe('target_accepted');
  expect(h.submitUserTurn.send).not.toHaveBeenCalled();
  expect(h.state.send).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      message: 'Review this',
      images: [],
      clientTurnId: 'agent-team-member-request',
    }),
  );
  expect(fixture.prepare).toHaveBeenCalledTimes(3);
  expect(fixture.prepare).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ nativeSessionId: 'native-peer' }),
  );
  expect(fixture.prepare).toHaveBeenNthCalledWith(
    3,
    expect.objectContaining({ expectedControlGeneration: 'generation-1' }),
  );
  expect(h.effect).toHaveBeenCalledOnce();
});
it('retains an unknown member acknowledgement without retrying or using the source sender', async () => {
  const h = setup('unknown');
  expect(await h.invoke()).toBe('unknown');
  expect(h.state.send).toHaveBeenCalledOnce();
  expect(h.submitUserTurn.send).not.toHaveBeenCalled();
});
it('rejects a changed stop generation at the final native admission before any send effect', async () => {
  const h = setup();
  fixture.prepare
    .mockResolvedValueOnce({ success: true, value: receipt })
    .mockResolvedValueOnce({ success: true, value: receipt })
    .mockResolvedValueOnce({
      success: true,
      value: { ...receipt, controlGeneration: 'replacement' },
    });
  expect(await h.invoke()).toBe('rejected');
  expect(h.effect).not.toHaveBeenCalled();
  expect(h.submitUserTurn.send).not.toHaveBeenCalled();
});
it('rejects a disposed or replaced mounted member session', async () => {
  const h = setup();
  h.state.readCurrent = () => undefined;
  expect(await h.invoke()).toBe('rejected');
  expect(fixture.prepare).not.toHaveBeenCalled();
  expect(h.effect).not.toHaveBeenCalled();
});
