import { expect, it, vi } from 'vitest';

import { registerDiscussionHistory } from '../../../../plugins/extensions/agent-team/discussion/discussion-history';
import { TeamDiscussionGateway } from '../../../../plugins/extensions/agent-team/contracts/teamDiscussion';

const sdk = vi.hoisted(() => ({ transcript: vi.fn() }));
vi.mock('openclaw/plugin-sdk/session-transcript-runtime', () => ({
  readVisibleSessionTranscriptMessageEntries: sdk.transcript,
}));

it('rejects a retained history handler after disable and restores native history on re-enable', async () => {
  let enabled = true;
  const methods = new Map<
    string,
    (call: { params: unknown; respond: ReturnType<typeof vi.fn> }) => Promise<void>
  >();
  registerDiscussionHistory({
    runtime: {
      config: { current: () => ({ plugins: { entries: { 'agent-team': { enabled } } } }) },
    },
    registerGatewayMethod: (name: string, handler: never) => methods.set(name, handler),
  } as never);
  expect(methods.has(TeamDiscussionGateway.OfflineControl)).toBe(false);
  sdk.transcript.mockClear().mockResolvedValue([]);
  const handler = methods.get(TeamDiscussionGateway.History)!;
  const respond = vi.fn();
  const params = {
    roomId: 'room',
    discussionIds: ['batch'],
    members: [{ agentId: 'alice', sessionId: 'native' }],
  };
  enabled = false;
  await handler({ params, respond });
  expect(respond).toHaveBeenLastCalledWith(false, undefined, {
    code: 'invalid_request',
    message: 'teamDiscussionHistoryUnavailable',
  });
  expect(sdk.transcript).not.toHaveBeenCalled();
  enabled = true;
  await handler({ params, respond });
  expect(respond).toHaveBeenLastCalledWith(true, { messages: [] });
  expect(sdk.transcript).toHaveBeenCalledWith({
    agentId: 'alice',
    sessionId: 'native',
    sessionKey: 'agent:alice:justdo-team:group:room',
  });
});

it('retains native inbound attachments and public delivery attachments without leaking other turns', async () => {
  const methods = new Map<
    string,
    (call: { params: unknown; respond: ReturnType<typeof vi.fn> }) => Promise<void>
  >();
  registerDiscussionHistory({
    runtime: {
      config: { current: () => ({ plugins: { entries: { 'agent-team': { enabled: true } } } }) },
    },
    registerGatewayMethod: (name: string, handler: never) => methods.set(name, handler),
  } as never);
  sdk.transcript.mockResolvedValue([
    {
      entryId: 'input',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Review these files' }],
        timestamp: 1,
        __openclaw: {
          transport: { channel: 'justdo-team', messageId: 'justdo-team:room:batch' },
          media: [
            { path: '/project/report.pdf' },
            { url: 'https://example.test/chart.png' },
            null,
            { path: 12 },
          ],
        },
      },
    },
    {
      entryId: 'output',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Reviewed' }],
        timestamp: 2,
        openclawDeliveryMirror: {
          kind: 'channel-final',
          sourceMessageId: 'justdo-team:room:batch:1',
        },
        openclawDelivery: { mediaUrls: ['/project/result.pdf'], speakerAgentId: 'alice' },
      },
    },
    {
      entryId: 'other',
      message: {
        role: 'user',
        __openclaw: {
          transport: { channel: 'justdo-team', messageId: 'justdo-team:other:batch' },
          media: [{ path: '/private/other.pdf' }],
        },
      },
    },
  ]);
  const respond = vi.fn();
  await methods.get(TeamDiscussionGateway.History)!({
    params: {
      roomId: 'room',
      discussionIds: ['batch'],
      members: [{ agentId: 'alice', sessionId: 'native' }],
    },
    respond,
  });
  expect(respond).toHaveBeenCalledWith(true, {
    messages: [
      expect.objectContaining({
        id: 'alice:input',
        mediaUrls: ['/project/report.pdf', 'https://example.test/chart.png'],
      }),
      expect.objectContaining({ id: 'alice:output', mediaUrls: ['/project/result.pdf'] }),
    ],
  });
});
