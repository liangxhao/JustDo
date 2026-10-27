import { describe, expect, test } from 'vitest';

import { projectScheduledTaskHistoryMessage } from '../scheduled-task-history-display';
import { createNestedToolActivity } from './fixtures/nested-tool-activity';

describe('scheduled task nested tool display', () => {
  test.each([false, true])('preserves exact child ownership and payloads (failed: %s)', isError => {
    const message = {
      ...createNestedToolActivity(1, isError),
      id: 'native-entry',
      __openclaw: { id: 'native-entry', runId: 'old-fallback', seq: 7 },
    };
    const original = structuredClone(message);

    const projected = projectScheduledTaskHistoryMessage(message);

    expect(projected).toMatchObject({
      id: 'native-entry',
      role: 'custom',
      customType: 'openclaw.nested-tool.v1',
      display: true,
      excludeFromContext: true,
      runId: 'native-run',
      __openclaw: { id: 'native-entry', runId: 'native-run', seq: 7 },
      content: [
        {
          type: 'toolCall',
          id: 'nested-1',
          name: 'browser',
          runId: 'native-run',
          parentToolCallId: 'outer-1',
          arguments: message.details.input,
          timestamp: 1_001,
        },
        {
          type: 'toolResult',
          role: 'toolResult',
          toolCallId: 'nested-1',
          toolName: 'browser',
          runId: 'native-run',
          parentToolCallId: 'outer-1',
          isError,
          timestamp: 1_101,
          content: message.details.result.content,
          details: message.details.result.details,
        },
      ],
    });
    expect(projected).not.toHaveProperty('details');
    expect(message).toEqual(original);
    expect(projectScheduledTaskHistoryMessage(projected)).toBe(projected);
  });

  test('preserves identity strings exactly and accepts native optional parent and root anchor', () => {
    const message = createNestedToolActivity() as Record<string, unknown>;
    const activity = message.details as Record<string, unknown>;
    delete activity.parentToolCallId;
    activity.afterEntryId = null;
    activity.toolCallId = 'native:call/with exact identity';
    const projected = projectScheduledTaskHistoryMessage(message);
    expect(projected.content).toMatchObject([
      { id: activity.toolCallId },
      { toolCallId: activity.toolCallId },
    ]);
    for (const block of projected.content as Record<string, unknown>[]) {
      expect(block).not.toHaveProperty('parentToolCallId');
    }
  });

  test.each([
    ['role', 'assistant'],
    ['customType', 'other-custom'],
    ['display', false],
    ['excludeFromContext', false],
    ['content', 'Assistant-authored JSON'],
    ['content', [{ type: 'text', text: 'already projected' }]],
    ['timestamp', Infinity],
    ['details', null],
  ])('does not promote an invalid outer field: %s = %j', (key, value) => {
    const message = { ...createNestedToolActivity(), [key as string]: value };
    expect(projectScheduledTaskHistoryMessage(message)).toBe(message);
  });

  test.each([
    ['runId', ''],
    ['scopeId', 'x'.repeat(1025)],
    ['afterEntryId', undefined],
    ['parentToolCallId', ''],
    ['toolCallId', 'x'.repeat(1025)],
    ['toolName', 'x'.repeat(257)],
    ['startOrder', -1],
    ['startOrder', 0.5],
    ['startedAt', NaN],
    ['timestamp', '1100'],
    ['isError', 'false'],
    ['result', { content: 'not a block array' }],
    ['status', 'running'],
  ])('does not promote an invalid activity field: %s = %j', (key, value) => {
    const message = createNestedToolActivity();
    Object.assign(message.details, { [key as string]: value });
    expect(projectScheduledTaskHistoryMessage(message)).toBe(message);
  });

  test('does not promote an incomplete activity without its input field', () => {
    const message = createNestedToolActivity();
    Reflect.deleteProperty(message.details, 'input');
    expect(projectScheduledTaskHistoryMessage(message)).toBe(message);
  });

  test('only publishes safe result metadata and never promotes arbitrary interactive descriptors', () => {
    const message = createNestedToolActivity();
    Object.assign(message.details.result.details, {
      exitCode: 1,
      ok: false,
      changed: true,
      created: false,
      privateDiagnostic: 'internal diagnostic',
      mcpAppPreview: { viewId: 'unverified-view' },
      status: 'running',
    });
    const projected = projectScheduledTaskHistoryMessage(message);
    const result = (projected.content as Record<string, unknown>[])[1];
    expect(result.details).toEqual({
      browserTab: message.details.result.details.browserTab,
      durationMs: 12,
      exitCode: 1,
      ok: false,
      changed: true,
      created: false,
    });
    expect(JSON.stringify(projected)).not.toContain('privateDiagnostic');
    expect(JSON.stringify(projected)).not.toContain('unverified-view');
    expect(result).not.toHaveProperty('status');
  });

  test.each([
    { targetId: 'tab', profile: 'embedded', target: 'host', node: 'unexpected' },
    { targetId: 'x'.repeat(129), profile: 'embedded', target: 'host' },
    { targetId: 'tab', profile: ' embedded', target: 'host' },
    { targetId: 'tab', profile: 'embedded', target: 'node' },
  ])('does not publish a malformed browser route: %j', browserTab => {
    const message = createNestedToolActivity();
    Object.assign(message.details.result.details, { browserTab });
    const projected = projectScheduledTaskHistoryMessage(message);
    expect((projected.content as Record<string, unknown>[])[1].details).toEqual({ durationMs: 12 });
  });
});
