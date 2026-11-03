import { describe, expect, it } from 'vitest';

import {
  readBrowserCancelledEvent,
  readBrowserExecutionRun,
  readBrowserReleasedEvent,
  readBrowserRequestedEvent,
  readBrowserRevokedEvent,
} from '../browserExecutionContract';

const run = {
  sessionKey: 'agent:main:cron:job:run:session',
  sessionId: 'session',
  runId: 'run',
  workspaceDir: 'E:\\workspace\\项目 with spaces',
  trigger: 'cron',
  jobId: 'job',
};
const requested = {
  requestId: 'request',
  sessionKey: run.sessionKey,
  run,
  admissionRevision: 1,
  toolCallId: 'call',
  command: { action: 'open', headless: true },
  policy: { allowLocalFiles: false },
};

describe('browser execution transport contract', () => {
  it('accepts bounded native metadata and preserves Unicode workspace paths', () => {
    expect(readBrowserExecutionRun(run)).toEqual(run);
    expect(readBrowserRequestedEvent(requested)).toEqual(requested);
    expect(readBrowserCancelledEvent(requested)).toEqual({
      requestId: requested.requestId,
      sessionKey: run.sessionKey,
      run,
      admissionRevision: 1,
      toolCallId: requested.toolCallId,
    });
    expect(readBrowserRevokedEvent({ run, admissionRevision: 1 })).toEqual({
      run,
      admissionRevision: 1,
    });
    expect(readBrowserReleasedEvent({ run, reason: 'settled', discardPages: false })).toEqual({
      run,
      reason: 'settled',
      discardPages: false,
    });
    expect(readBrowserReleasedEvent({ run, reason: 'revoked', discardPages: true })).toEqual({
      run,
      reason: 'revoked',
      discardPages: true,
    });
  });

  it.each([
    { run: undefined },
    { run: { ...run, trigger: 'cron', jobId: undefined } },
    { run: { ...run, trigger: 'user' } },
    { run: { ...run, sessionId: '' } },
    { run: { ...run, sessionKey: ' key' } },
    { run: { ...run, workspaceDir: 'path\u0000injection' } },
    { run: { ...run, runId: 'r'.repeat(513) } },
    { sessionKey: 'other-session' },
    { toolCallId: '' },
    { admissionRevision: undefined },
    { admissionRevision: 0 },
    { admissionRevision: 1.5 },
    { admissionRevision: Number.MAX_SAFE_INTEGER + 1 },
    { command: [] },
    { policy: undefined },
    { policy: { allowLocalFiles: 'true' } },
  ])('rejects malformed or conflicting request identity %j', overrides => {
    expect(readBrowserRequestedEvent({ ...requested, ...overrides })).toBeNull();
  });

  it('does not accept model command fields as native execution identity', () => {
    expect(
      readBrowserRequestedEvent({
        requestId: 'r',
        sessionKey: run.sessionKey,
        command: { run, toolCallId: 'call' },
      }),
    ).toBeNull();
    expect(readBrowserReleasedEvent({ run, reason: 'idle' })).toBeNull();
    expect(readBrowserReleasedEvent({ ...run, reason: 'settled' })).toBeNull();
    expect(readBrowserReleasedEvent({ run, reason: 'settled' })).toBeNull();
    expect(readBrowserReleasedEvent({ run, reason: 'settled', discardPages: 'false' })).toBeNull();
    expect(readBrowserRevokedEvent({ ...run })).toBeNull();
    expect(readBrowserRevokedEvent({ run })).toBeNull();
    expect(readBrowserRevokedEvent({ run, admissionRevision: -1 })).toBeNull();
    expect(readBrowserRevokedEvent({ run: { ...run, runId: '' } })).toBeNull();
  });
});
