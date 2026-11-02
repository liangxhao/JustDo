import { describe, expect, test } from 'vitest';

import { isHiddenNativeMessage } from './messageVisibility';

describe('native message display visibility', () => {
  test('hides internal user inputs regardless of known, missing or future source tools', () => {
    for (const sourceTool of ['exec', 'plugin', 'heartbeat', 'restart-sentinel', 'cron', 'sessions.recover', 'future-source', undefined]) {
      expect(isHiddenNativeMessage({
        role: 'user', content: 'Internal instruction',
        provenance: { kind: 'internal_system', ...(sourceTool ? { sourceTool } : {}) },
      })).toBe(true);
    }
  });

  test('keeps human quotes, voice input and peer collaboration even with the same body', () => {
    const content = 'Plugin reload result: Continue the original task.';
    for (const provenance of [
      undefined,
      { kind: 'external_user', sourceTool: 'gateway.voice.transcript' },
      { kind: 'external_user', sourceTool: 'exec_approval_followup' },
      { kind: 'inter_session', sourceTool: 'sessions_send' },
      { kind: 'inter_session', sourceTool: 'collaboration_send' },
      { kind: 'unknown', sourceTool: 'plugin' },
    ]) expect(isHiddenNativeMessage({ role: 'user', content, provenance })).toBe(false);
  });

  test('hides the native inter-session command approval control input', () => {
    expect(isHiddenNativeMessage({
      role: 'user', provenance: { kind: 'inter_session', sourceTool: 'exec_approval_followup' },
    })).toBe(true);
  });

  test('keeps projected cron results and actual assistant or system errors', () => {
    for (const role of ['assistant', 'system', 'toolResult']) {
      expect(isHiddenNativeMessage({
        role, content: 'Result or error', provenance: { kind: 'internal_system', sourceTool: 'cron' },
      })).toBe(false);
    }
  });

  test('honors only the native boolean display false flag across roles', () => {
    for (const role of ['user', 'assistant', 'system', 'custom', 'toolResult']) {
      expect(isHiddenNativeMessage({ role, display: false })).toBe(true);
      expect(isHiddenNativeMessage({ role, display: 'false' })).toBe(false);
    }
  });

  test('hides structured runtime carriers and keeps visible updates, tools and cards', () => {
    expect(isHiddenNativeMessage({ role: 'custom', customType: 'openclaw.runtime-context' })).toBe(true);
    expect(isHiddenNativeMessage({
      role: 'custom', customType: 'openclaw.system-update', details: { kind: 'runtime-context' },
    })).toBe(true);
    for (const message of [
      { role: 'custom', customType: 'openclaw.system-update', details: { kind: 'prompt-update' } },
      { role: 'custom', customType: 'openclaw.nested-tool.v1', display: true },
      { role: 'custom', customType: 'compaction', display: true },
      { role: 'custom', customType: 'plugin-card', details: { kind: 'runtime-context' } },
      { role: 'user', content: 'openclaw.runtime-context' },
    ]) expect(isHiddenNativeMessage(message)).toBe(false);
  });

  test('handles native entry envelopes without interpreting authored JSON as metadata', () => {
    const internal = { role: 'user', provenance: { kind: 'internal_system' } };
    expect(isHiddenNativeMessage({ message: internal })).toBe(true);
    expect(isHiddenNativeMessage({ role: 'user', content: JSON.stringify(internal), message: internal })).toBe(false);
  });

  test('ignores malformed records and provenance', () => {
    for (const message of [null, undefined, false, [], 'internal_system', { role: 'user', provenance: 'internal_system' }]) {
      expect(isHiddenNativeMessage(message)).toBe(false);
    }
  });
});
