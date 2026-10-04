import { describe, expect, it } from 'vitest';

import { projectDiagnosticEnvironment } from './environment';

describe('native stability context', () => {
  it('projects only closed global failure counts and the actual retained time range', () => {
    const result = projectDiagnosticEnvironment(
      {
        count: 8,
        dropped: 23,
        events: [
          {
            ts: 100,
            type: 'tool.execution.error',
            toolName: 'secret-tool',
            sessionKey: 'secret-session',
          },
          { ts: 200, type: 'model.call.error', error: 'secret-error' },
          { ts: 300, type: 'exec.process.completed', exitCode: 0 },
          { ts: 400, type: 'exec.process.completed', exitCode: 2 },
          { ts: 500, type: 'session.long_running' },
          { ts: 600, type: 'session.stuck' },
          { ts: 700, type: 'diagnostic.liveness.warning', level: 'info' },
          { ts: 800, type: 'diagnostic.liveness.warning', level: 'warning' },
        ],
      },
      900,
    );
    expect(result).toEqual({
      status: 'available',
      collectedAt: 900,
      stabilityCount: 8,
      stabilityDropped: 23,
      firstAt: 100,
      lastAt: 800,
      signals: { tool: 1, model: 1, command: 1, stuck: 1, liveness: 1 },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('rejects invalid counters and ignores arbitrary event types and malformed metrics', () => {
    expect(projectDiagnosticEnvironment({ count: -1, dropped: 0 }, 1).status).toBe('unavailable');
    expect(
      projectDiagnosticEnvironment(
        {
          count: 2,
          dropped: 0,
          events: [
            { type: 'exec.process.completed', exitCode: '1' },
            { type: 'private-error', ts: 'bad' },
          ],
        },
        1,
      ),
    ).toMatchObject({ status: 'available', signals: {} });
  });
});
