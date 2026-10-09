import { expect, test } from 'vitest';

import {
  createDefaultAgentRuntimeSettings,
  parseAgentRuntimeSettings,
  validateAgentRuntimeSettings,
} from './agentRuntimeSettings';

test('fills missing Code Mode preferences without resetting existing settings', () => {
  const settings = createDefaultAgentRuntimeSettings();
  settings.subagents.maxConcurrent = 7;
  const { codeMode, ...legacy } = settings;
  expect(parseAgentRuntimeSettings(legacy)).toEqual({ ...legacy, codeMode });
  const second = createDefaultAgentRuntimeSettings();
  settings.codeMode.mode = 'on';
  expect(second.codeMode.mode).toBe('off');
});

test.each(['off', 'auto', 'on'] as const)('round trips Code Mode %s', mode => {
  const settings = createDefaultAgentRuntimeSettings();
  settings.codeMode.mode = mode;
  expect(validateAgentRuntimeSettings(settings)).toEqual({ ok: true, settings });
});

test.each([null, false, {}, { mode: true }, { mode: 'enabled' }])(
  'rejects malformed Code Mode %j',
  codeMode => {
    expect(
      validateAgentRuntimeSettings({ ...createDefaultAgentRuntimeSettings(), codeMode }).ok,
    ).toBe(false);
  },
);
