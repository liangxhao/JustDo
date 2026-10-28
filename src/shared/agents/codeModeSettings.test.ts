import { expect, test } from 'vitest';

import {
  createDefaultAgentRuntimeSettings,
  validateAgentRuntimeSettings,
} from './agentRuntimeSettings';

test('keeps the current Code Mode default independent between profiles', () => {
  const settings = createDefaultAgentRuntimeSettings();
  const second = createDefaultAgentRuntimeSettings();
  settings.codeMode.mode = 'on';
  expect(second.codeMode.mode).toBe('off');
});

test.each(['off', 'auto', 'on'] as const)('round trips Code Mode %s', mode => {
  const settings = createDefaultAgentRuntimeSettings();
  settings.codeMode.mode = mode;
  expect(validateAgentRuntimeSettings(settings)).toEqual({ ok: true, settings });
});

test.each([undefined, null, false, {}, { mode: true }, { mode: 'enabled' }])(
  'rejects malformed Code Mode %j',
  codeMode => {
    expect(
      validateAgentRuntimeSettings({ ...createDefaultAgentRuntimeSettings(), codeMode }).ok,
    ).toBe(false);
  },
);
